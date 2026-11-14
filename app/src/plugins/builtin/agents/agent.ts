import { agentLook, robotName } from "../bots/identity";
import { defaultImageSide, imageForModel } from "../../../agents/images";
import { lastWork, lastWorkDone } from "../../../agents/work";
// /push belongs to git channels; the git plugin exposes it.
import { pushLocal } from "../git/agentSkills";
import { indexPass } from "../../../agents/library";
import { defaultMaxSteps, runTask } from "../../../agents/loop";
import { askerOf, beginJob, defaultTokenCap, isWorking, stopJob } from "../../../agents/jobs";
import { registerWorker } from "../../../agents/dispatch";
import { serverUrlOf, stepsDefaultKey, workspaceDefault } from "./settings";
import { llmContextSize, llmModels, textOf, type LlmMessage, type LlmServer } from "../../../core/llm";
import type { BotContext, BotMessage, BotType } from "../../types";

const historyLines = 12;
const replyTokens = 400;
const charsPerToken = 4;
export const defaultPersona = "You are a helpful assistant in a team workspace.";

export const tokenCapOf = (context: BotContext): number => {
  const cap = Number(context.bot.config.tokenCap);
  return Number.isFinite(cap) && context.bot.config.tokenCap !== "" && context.bot.config.tokenCap !== undefined ? Math.max(0, cap) : defaultTokenCap;
};

// Tool calls per task: this bot's setting, else the workspace default (Workspace settings > Plugins), else the built-in one.
export const stepLimitOf = async (context: BotContext): Promise<number> => {
  const own = Number(context.bot.config.maxSteps);
  if (Number.isFinite(own) && own > 0) return own;
  const shared = Number(await workspaceDefault(context.api, stepsDefaultKey));
  return Number.isFinite(shared) && shared > 0 ? shared : defaultMaxSteps;
};

export const serverOf = async (context: BotContext): Promise<LlmServer> => ({
  baseUrl: await serverUrlOf(context.bot.config, context.api),
  apiKey: (await context.secret("apiKey")) ?? undefined,
  model: String(context.bot.config.model ?? ""),
});

type Usage = { requests: number; promptTokens: number; completionTokens: number; ms: number; lastTokens: number; lastSpeed: number | null };
const usage = new Map<number, Usage>();

export function record(botId: number, reply: { promptTokens: number; completionTokens: number; ms: number; tokensPerSecond: number | null }): void {
  const u = usage.get(botId) ?? { requests: 0, promptTokens: 0, completionTokens: 0, ms: 0, lastTokens: 0, lastSpeed: null };
  usage.set(botId, {
    requests: u.requests + 1, promptTokens: u.promptTokens + reply.promptTokens, completionTokens: u.completionTokens + reply.completionTokens,
    ms: u.ms + reply.ms, lastTokens: reply.promptTokens, lastSpeed: reply.tokensPerSecond,
  });
}

// The pictures attached to a message, shrunk for the model (at most three).
export async function attachedImages(context: BotContext, message: BotMessage): Promise<string[]> {
  const side = Number(context.bot.config.imageSize) || defaultImageSide;
  const found: string[] = [];
  for (const a of (message.attachments ?? []).filter((x) => x.mime.startsWith("image/")).slice(0, 3))
    found.push(await imageForModel(a.url, a.mime, a.thumb, side).catch(() => ""));
  return found.filter(Boolean);
}

export const plain = (context: BotContext, text: string) =>
  text.replace(/<@(\d+)>/g, (_, id) => `@${context.member(Number(id)).displayName}`);

const systemPrompt = (context: BotContext) =>
  `${String(context.bot.config.persona || defaultPersona)}\nYour name is ${context.bot.nickname}. You are chatting in a workspace channel `
  + `with several people, each message starts with the speaker's name. Answer briefly and plainly.`;

export async function recent(context: BotContext, message: BotMessage): Promise<LlmMessage[]> {
  const all = await context.messages(message.channelId);
  return all
    .filter((m) => m.id !== message.id && !m.action && (message.threadId === null ? m.thread_id === null : m.thread_id === message.threadId || m.id === message.threadId))
    .slice(-historyLines)
    .map((m) => m.author_id === context.bot.id
      ? { role: "assistant" as const, content: plain(context, m.body) }
      : { role: "user" as const, content: `${context.member(m.author_id).displayName}: ${plain(context, m.body)}` });
}

// Drops the oldest history until the prompt fits the server's context, leaving room for the reply.
export function fit(system: string, history: LlmMessage[], last: string, contextTokens: number | null): LlmMessage[] {
  if (!contextTokens) return [{ role: "system", content: system }, ...history, { role: "user", content: last }];
  const budget = (contextTokens - replyTokens - 64) * charsPerToken - system.length - last.length;
  const kept: LlmMessage[] = [];
  let used = 0;
  for (const m of [...history].reverse()) {
    used += textOf(m).length;
    if (used > budget) break;
    kept.unshift(m);
  }
  return [{ role: "system", content: system }, ...kept, { role: "user", content: last }];
}

const botRow = async (context: BotContext) => (await context.api.read("bots_bots", { user_id: context.bot.id }))[0];

async function changeSetting(context: BotContext, call: { message: BotMessage }, key: string, value: string): Promise<string | null> {
  if (!context.can(call.message.authorId, "manage_bots")) return "Only members who manage bots can change that.";
  const row = await botRow(context);
  if (!row) return "I can't find my own settings.";
  await context.api.call("update", { id: row.id, config: JSON.stringify({ ...context.bot.config, [key]: value }) });
  return null;
}

const librarianFirstMs = 2 * 60_000;
const librarianEveryMs = 20 * 60_000;

// While idle, brings the workspace index up to date a few entries at a time. Off unless the agent's setting asks for it.
function startLibrarian(context: BotContext): () => void {
  if (context.bot.config.librarian !== true || !context.granted("memory")) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const pass = async () => {
    if (!isWorking(context.bot.id)) {
      const job = beginJob(context.bot.id, 0, tokenCapOf(context));
      try {
        const { written } = await indexPass(context, await serverOf(context), 5, job.signal);
        if (written) await context.log(`Indexed ${written} ${written === 1 ? "entry" : "entries"}.`);
      } catch (e) {
        await context.log(`Indexing stopped: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        job.end();
      }
    }
    if (!stopped) timer = setTimeout(() => void pass(), librarianEveryMs);
  };
  timer = setTimeout(() => void pass(), librarianFirstMs);
  return () => { stopped = true; clearTimeout(timer); };
}

export const agent: BotType = {
  look: agentLook,
  randomName: robotName,
  label: "Agent",
  description: "Answers when mentioned, thinking with a language model on a llama.cpp (or OpenAI-compatible) server.",
  permissions: [
    "memory",
    ...["code", "files", "docs", "tasks", "sheets", "diagram", "design", "browser"].flatMap((plugin) => [`read:${plugin}`, `write:${plugin}`] as const),
    "read:git", "write:git", "read:channels", "write:channels", "web",
    "write:chat",
  ],
  isBusy: isWorking,
  stop: stopJob,
  settings: {
    server: { label: "Server address (empty: the workspace default)", type: "text", placeholder: "http://localhost:8080" },
    apiKey: { label: "Server key (if it needs one)", type: "credential" },
    model: {
      label: "Model", type: "text", placeholder: "The server's own model",
      suggest: async (config, secret, bots) => llmModels({ baseUrl: await serverUrlOf(config, bots), apiKey: secret ?? undefined }),
    },
    persona: { label: "What this agent is for", type: "text", default: defaultPersona },
    maxSteps: { label: "Most steps per task (empty: the workspace default)", type: "number", placeholder: "12" },
    tokenCap: { label: "Most tokens per job (0 for no limit)", type: "number", default: defaultTokenCap },
    embedServer: { label: "Embedding server for meaning-based recall (optional)", type: "text", placeholder: "http://localhost:8081" },
    embedModel: { label: "Embedding model (if the server needs a name)", type: "text", placeholder: "" },
    librarian: { label: "Keep the workspace index up to date when idle (needs the memory permission)", type: "bool", default: false },
    imageSize: { label: "Picture size sent to the model (px, longest side)", type: "number", default: 512 },
  },
  commands: {
    model: {
      usage: "/model [name]", help: "Shows the model, or switches to another one the server offers.",
      run: async (context, call) => {
        const server = await serverOf(context);
        const models = await llmModels(server).catch(() => null);
        const name = call.args.trim();
        if (!name) {
          const list = models?.length ? `\nOn the server: ${models.map((m) => `\`${m}\``).join(", ")}` : "";
          return `I use ${server.model ? `\`${server.model}\`` : "the server's own model"} at ${server.baseUrl}.${list}`;
        }
        if (models && !models.includes(name)) return `The server doesn't list \`${name}\`. It has: ${models.map((m) => `\`${m}\``).join(", ") || "nothing"}.`;
        return (await changeSetting(context, call, "model", name)) ?? `Now using \`${name}\`.`;
      },
    },
    server: {
      usage: "/server [address]", help: "Shows the server I use, or points me to another one.",
      run: async (context, call) => {
        const address = call.args.trim();
        if (!address) return `I use ${(await serverOf(context)).baseUrl}.`;
        if (!/^https?:\/\//i.test(address)) return "The address should start with http:// or https://.";
        try {
          await llmModels({ ...(await serverOf(context)), baseUrl: address });
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
        return (await changeSetting(context, call, "server", address)) ?? `Now using ${address}.`;
      },
    },
    context: {
      usage: "/context", help: "Shows the context size and how much of it a chat takes.",
      run: async (context, call) => {
        const size = await llmContextSize(await serverOf(context));
        const used = usage.get(context.bot.id)?.lastTokens;
        if (!size) return "The server doesn't say how large its context is.";
        const history = (await recent(context, call.message)).reduce((sum, m) => sum + m.content.length, 0);
        const estimate = Math.round((history + systemPrompt(context).length) / charsPerToken);
        return `Context: ${size} tokens per request. This chat would use about ${estimate} of them before my answer`
          + `${used ? `; my last request used ${used}` : ""}. Older messages are left out when it doesn't fit.`;
      },
    },
    wave: {
      usage: "/wave", help: "Moves my cursor around in this channel for a few seconds (to see how it looks).",
      run: async (context, call) => {
        const channel = call.message.channelId;
        const path = [[80, 80], [520, 80], [520, 320], [80, 320], [300, 200]];
        context.typing(channel, null, true);
        try {
          for (const [x, y] of path) await context.cursor(channel, { x, y }, 600);
          await new Promise((resolve) => setTimeout(resolve, 800));
        } finally {
          context.typing(channel, null, false);
          context.leave();
        }
        return "Did you see me? The cursor shows in boards (designs, diagrams) that someone has open.";
      },
    },
    undo: {
      usage: "/undo", help: "Undoes what I changed in my last job.",
      run: async (context, call) => {
        const work = lastWork(context.bot.id);
        if (!work) return "I have no job to undo.";
        if (!work.to) return "I am still working on it.";
        if (call.message.authorId !== work.asker && !context.can(call.message.authorId, "manage_bots")) return "Only the person who asked, or someone who manages bots, can undo that.";
        const { undone, skipped } = await context.undoWork(work.bots, work.from, work.to);
        lastWorkDone(context.bot.id);
        if (!undone && !skipped) return "I changed nothing.";
        return `Undone: ${undone} ${undone === 1 ? "change" : "changes"}${skipped ? `; ${skipped} left alone because they were edited since` : ""}.`;
      },
    },
    push: {
      usage: "/push <git channel> [submodule]", help: "Pushes the current branch of this device's local copy of a git channel, or of one of its submodules (a member who may, after the Push button).",
      run: async (context, call) => {
        if (call.message.authorId !== context.userId && !context.can(call.message.authorId, "manage_bots")) return "Only the member whose device I run on, or someone who manages bots, can push.";
        try {
          const [channel = "", ...sub] = call.args.trim().split(/\s+/);
          return await pushLocal(context, channel, sub.join(" "));
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      },
    },
    stop: {
      usage: "/stop", help: "Stops the job I am working on.",
      run: (context, call) => {
        if (askerOf(context.bot.id) === undefined) return "I am not working on anything.";
        // Someone who manages bots stops everything; anyone else only what they asked for.
        const all = context.can(call.message.authorId, "manage_bots");
        if (!stopJob(context.bot.id, all ? undefined : call.message.authorId)) return "Only the person who asked, or someone who manages bots, can stop that.";
        return "Stopping. Use /undo to take back what I changed.";
      },
    },
    usage: {
      usage: "/usage", help: "Shows tokens, requests and speed since this device started me.",
      run: (context) => {
        const u = usage.get(context.bot.id);
        if (!u) return "I haven't used the model yet.";
        const speed = u.lastSpeed ? `, last reply ${u.lastSpeed.toFixed(1)} tokens/s` : "";
        return `${u.requests} requests: ${u.promptTokens} tokens read, ${u.completionTokens} written, ${(u.ms / 1000).toFixed(1)} s of model time${speed}.`;
      },
    },
  },
  async mention(context, message, text) {
    const server = await serverOf(context);
    const contextTokens = await llmContextSize(server);
    const history = fit("", await recent(context, message), "", contextTokens ? contextTokens - 1500 : null).slice(1, -1);
    await runTask(context, {
      server, persona: String(context.bot.config.persona || defaultPersona), asker: context.member(message.authorId).displayName,
      askerId: message.authorId, request: plain(context, text), history, images: await attachedImages(context, message),
      imageSide: Number(context.bot.config.imageSize) || defaultImageSide, channelId: message.channelId, threadId: message.threadId,
      onUsage: (reply) => record(context.bot.id, reply), tokenCap: tokenCapOf(context), maxSteps: await stepLimitOf(context),
    });
    return null;
  },
  // Runs tasks a leader hands over (agents/dispatch.ts).
  start(context) {
    const stopLibrarian = startLibrarian(context);
    const stopWorker = registerWorker(context.bot.id, async (task) => {
      const result = await runTask(context, {
        server: await serverOf(context), persona: String(context.bot.config.persona || defaultPersona), asker: task.leader.name, askerId: task.leader.id,
        request: task.instruction, history: [], channelId: task.channelId, threadId: task.threadId, role: "helper", leader: task.leader, parentJob: task.parent,
        imageSide: Number(context.bot.config.imageSize) || undefined,
        onUsage: (reply) => record(context.bot.id, reply), tokenCap: tokenCapOf(context), maxSteps: await stepLimitOf(context),
      });
      return { ok: result.ok, report: result.text };
    });
    return () => { stopLibrarian(); stopWorker(); };
  },
};
