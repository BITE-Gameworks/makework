// One agent task: the model picks a tool, code runs it, the result goes back, until it replies or the step limit.
import { withLinks } from "./links";
import { beginWork, endWork } from "./work";
import { beginJob, defaultTokenCap, JobEnded, type Job } from "./jobs";
import { defaultImageSide } from "./images";
import { llmJson, llmSeesPictures, type LlmMessage, type LlmReply, type LlmServer } from "../core/llm";
import { channelTypeHints, isLookup } from "./skillKit";
import { lockedAbilities, skillsFor } from "./skills";
import { agentSource } from "./source";
import { relevantNotes } from "./library";
import { releaseAll } from "./locks";
import type { BotContext } from "../plugins/types";

export const defaultMaxSteps = 12;

type Step = { tool: string; args: Record<string, string | number> };

const failSkill = { name: "fail", description: "Ends your task because you can't do it with your tools. Say why, briefly.", args: { reason: "string" as const } };
const replySkill = { name: "reply", description: "Answers the user and ends your turn. Use it for questions and when the work is done.", args: { text: "string" as const } };

function schemaFor(skills: { name: string; args: Record<string, "string" | "number"> }[]) {
  return {
    anyOf: skills.map((skill) => ({
      type: "object",
      properties: {
        tool: { const: skill.name },
        args: {
          type: "object",
          properties: Object.fromEntries(Object.entries(skill.args).map(([key, type]) => [key, { type }])),
          required: Object.keys(skill.args),
          additionalProperties: false,
        },
      },
      required: ["tool", "args"],
      additionalProperties: false,
    })),
  };
}

const describeSkill = (s: { name: string; description: string; args: Record<string, string> }) =>
  `- ${s.name}(${Object.keys(s.args).join(", ")}): ${s.description}`;

export interface TaskOptions {
  server: LlmServer;
  persona: string;
  asker: string;
  askerId: number;
  request: string;
  history: LlmMessage[];
  // Pictures that came with the request (already shrunk data URLs).
  images?: string[];
  imageSide?: number;
  channelId: number;
  threadId: number | null;
  onUsage: (reply: LlmReply) => void;
  // "helper": a task from a leader. The report is posted to the leader and returned.
  role?: "helper";
  leader?: { id: number; name: string; request: string };
  // More for the system prompt (what only this kind of bot knows about itself).
  extraSystem?: string;
  // The job this task belongs to (a leader's). Without one the task makes its own.
  job?: Job;
  // A helper's: the leader's job that handed it the task, so stopping that job stops this one too.
  parentJob?: Job;
  tokenCap?: number;
  // Tool calls a task may take before it stops (the bot's setting, else the workspace default).
  maxSteps?: number;
}

export interface TaskResult { ok: boolean; text: string }

// What a channel type holds: the built-in wording, else what its plugin's indexer calls its items.
const hintOf = (type: string): string | undefined => channelTypeHints[type] ?? agentSource().indexer(type)?.noun;

// What the bot may do and sees: channels by name and type, so the model can name them.
async function overview(context: BotContext): Promise<string> {
  const channels = await context.channels();
  return channels.slice(0, 60).map((c) => `#${c.name} (${c.type}${hintOf(c.type) ? `: ${hintOf(c.type)}` : ""})`).join(", ");
}

// Returns the final reply text (or why it stopped).
export async function runTask(context: BotContext, options: TaskOptions): Promise<TaskResult> {
  const sees = await llmSeesPictures(options.server);
  const skills = await skillsFor(context, sees);
  const env = { server: options.server, imageSide: options.imageSide ?? defaultImageSide, channelId: options.channelId, threadId: options.threadId };
  const usable: { name: string; description: string; args: Record<string, "string" | "number"> }[] = [...skills, replySkill, ...(options.role === "helper" ? [failSkill] : [])];
  const system = `${options.persona}\nYour name is ${context.bot.nickname}. You work in a team workspace with several people, `
    + `each chat message starts with the speaker's name.\nWorkspace channels: ${await overview(context)}\n`
    + `Write a channel as #name, a link to it is added for you. Choose the channel by what it holds: a text or other file goes in a files channel, `
    + `source code in a code channel, notes in docs. If you don't know where something is, search first. `
    + `Each turn you choose exactly one tool and its arguments. Only change things in the workspace when asked to. `
    + `Do exactly what was asked. If none of your tools can do it, say so with reply and name what you can do instead; never do a different job that is merely close (for example arranging pictures when asked to change a design). `
    + `When you look at pictures, say what each one shows (not just how many there are). `
    + (options.role === "helper"
      ? `You are a helper agent. Your leader is ${options.leader?.name ?? options.asker}, who is answering this request from the user: "${options.leader?.request ?? ""}". `
        + `The leader gave you exactly one task, which you do with your tools, and the leader waits for your report. Do only that task. `
        + `If your tools can't do it, use fail right away and say why; never do something else instead. When done, reply with a one or two sentence report of what you did.\n`
      : `Questions and small talk get a short, plain reply. When you used tools, finish with reply and say what you did.\n`)
    + await lockedNote(context)
    + await relevantNotes(context, options.request)
    + (options.extraSystem ? `${options.extraSystem}\n` : "")
    + `Tools:\n`
    + usable.map(describeSkill).join("\n");
  const messages: LlmMessage[] = [
    { role: "system", content: system },
    ...options.history,
    {
      role: "user",
      content: sees && options.images?.length
        ? [{ type: "text", text: `${options.asker}: ${options.request}` }, ...options.images.map((url) => ({ type: "image_url" as const, image_url: { url } }))]
        : `${options.asker}: ${options.request}`,
    },
  ];
  const stepLimit = Math.max(1, Math.min(50, Math.round(options.maxSteps ?? defaultMaxSteps)));
  const schema = schemaFor(usable);
  const target = { threadId: options.threadId };
  // What was done, one line per operation: posted folded under the final answer, so a task is one message.
  const lines: string[] = [];
  let changes = 0;
  // Pictures to show with the answer (exports of a design layer).
  const embeds: string[] = [];
  let failures = 0;
  let repeats = 0;
  const seen = new Set<string>();

  // The one message of the task: the text, the operations it took and (after changes) an Undo button.
  const finish = async (text: string, keep: number[] = [options.leader?.id ?? options.askerId]) => {
    const steps = await Promise.all(lines.map((line) => withLinks(context, line)));
    await context.post(options.channelId, `${await withLinks(context, text, keep)}${embeds.length ? `\n\n${embeds.join("\n")}` : ""}`, {
      ...target, ...(steps.length ? { steps } : {}),
      ...(options.role !== "helper" && changes ? { buttons: [{ label: "Undo this", command: "/undo" }] } : {}),
    });
  };

  await context.log(`${options.role === "helper" ? `Task from ${options.asker}` : `Request from ${options.asker}`}: ${options.request}`);
  context.typing(options.channelId, options.threadId, true);
  if (options.role !== "helper") beginWork(context.bot.id, options.askerId);
  const job = options.job ?? beginJob(context.bot.id, options.askerId, options.tokenCap ?? defaultTokenCap, options.parentJob);
  try {
    return await steps();
  } catch (e) {
    if (!(e instanceof JobEnded)) throw e;
    const stopped = options.role === "helper" ? e.message : `I stopped. ${e.message}${lines.length ? " What I did so far is listed above." : ""}`;
    if (options.role !== "helper") await finish(`<@${options.askerId}> ${stopped}`, [options.askerId]);
    return { ok: false, text: stopped };
  } finally {
    releaseAll(context);
    if (!options.job) job.end();
    if (options.role !== "helper") endWork(context.bot.id);
    context.typing(options.channelId, options.threadId, false);
    context.leave();
  }

  async function steps(): Promise<TaskResult> {
    // A helper reports to its leader by name, in the thread everyone can read.
    const speak = (text: string) => (options.role === "helper" && options.leader ? `<@${options.leader.id}> ${text}` : options.role === "helper" ? text : `<@${options.askerId}> ${text}`);
    for (let step = 0; step < stepLimit; step++) {
      job.check();
      const { value, reply } = await llmJson<Step>(options.server, messages, schema, { maxTokens: 1500, signal: job.signal }).catch((e) => { job.check(); throw e; });
      options.onUsage(reply);
      job.add(reply.promptTokens + reply.completionTokens);
      job.check();
      messages.push({ role: "assistant", content: reply.text });
      await context.log(`Thinking (${reply.completionTokens} tokens, ${(reply.ms / 1000).toFixed(1)} s): ${reply.text.replace(/\s+/g, " ")}`);
      if (value.tool === "reply" || (value.tool === "fail" && options.role === "helper")) {
        const failed = value.tool === "fail";
        const text = String(value.args.text ?? value.args.reason ?? "");
        await finish(speak(failed ? `I could not do it: ${text}` : text));
        return { ok: !failed, text };
      }
      const skill = skills.find((s) => s.name === value.tool);
      // The same call again gives the same answer: say so instead of running it, and stop a model that keeps looping.
      // After a change the same call may give another result (draw, delete, draw again), so only repeats since the last change count.
      const call = `${changes}|${value.tool} ${JSON.stringify(value.args)}`;
      if (seen.has(call)) {
        await context.log(`Skipped a repeated call: ${call.slice(call.indexOf("|") + 1)}`);
        messages.push({ role: "user", content: `You already did exactly that and have its result above. Do the next step, or use reply now.` });
        if (++repeats >= 2) {
          const done = lines.length ? `I did what I could. ${lines.join(" ")}` : "I could not find a way to do that.";
          await finish(speak(lines.length ? "I did what I could; the operations are listed above." : done));
          return { ok: lines.length > 0, text: done };
        }
        continue;
      }
      seen.add(call);
      try {
        if (!skill) throw new Error(`There is no tool '${value.tool}'.`);
        await context.log(`${skill.name} ${JSON.stringify(value.args).slice(0, 200)}`);
        const result = await skill.run(context, value.args, { ...env, signal: job.signal });
        job.check();
        const text = typeof result === "string" ? result : result.text;
        const pictures = typeof result === "string" ? [] : result.images ?? [];
        if (typeof result !== "string") for (const embed of result.embeds ?? []) if (!embeds.includes(embed)) embeds.push(embed);
        failures = 0;
        await context.log(`Result: ${text.replace(/\s+/g, " ")}`);
        if (isLookup(skill.name)) lines.push(`Looked: ${skill.name.replaceAll("_", " ")} ${Object.values(value.args).join(" ").slice(0, 80)}`.trimEnd());
        else {
          lines.push(text);
          changes++;
        }
        forgetOldPictures(messages);
        messages.push({
          role: "user",
          content: pictures.length
            ? [{ type: "text", text: `Result of ${skill.name}: ${text}` }, ...pictures.map((url) => ({ type: "image_url" as const, image_url: { url } }))]
            : `Result of ${skill.name}: ${text}`,
        });
      } catch (e) {
        if (e instanceof JobEnded) throw e;
        const text = e instanceof Error ? e.message : String(e);
        await context.log(`${value.tool} failed: ${text}`);
        messages.push({ role: "user", content: `Error from ${value.tool}: ${text}` });
        if (++failures >= 3) {
          const stopped = `I could not finish: ${text}`;
          await finish(speak(stopped));
          return { ok: false, text: stopped };
        }
      }
    }
    const stopped = `I stopped after ${stepLimit} steps. What I did so far: ${lines.join(" ")}`;
    await finish(options.role === "helper" ? speak(stopped) : `<@${options.askerId}> I stopped after ${stepLimit} steps. What I did so far is listed above.`);
    return { ok: false, text: stopped };
  }
}

// Keeps only the newest pictures in the conversation: each one costs hundreds of tokens of a small context.
function forgetOldPictures(messages: LlmMessage[]) {
  const withPictures = messages.filter((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"));
  for (const m of withPictures.slice(0, -1))
    if (Array.isArray(m.content)) m.content = m.content.map((p) => (p.type === "image_url" ? { type: "text" as const, text: "[an earlier picture]" } : p));
}

// What is switched off for this bot, so a request for it gets "a member can allow that", not "I can't".
async function lockedNote(context: BotContext): Promise<string> {
  const locked = await lockedAbilities(context);
  return locked.length
    ? `Not allowed for you right now: ${locked.join("; ")}. If asked for one of these, say a member who manages bots can allow it in Workspace settings > Bots.\n`
    : "";
}
