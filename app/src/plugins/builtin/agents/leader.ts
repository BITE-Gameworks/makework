import { dispatch } from "../../../agents/dispatch";
import { llmComplete, llmContextSize, llmJson, llmSeesPictures } from "../../../core/llm";
import { skillsFor } from "../../../agents/skills";
import { withLinks } from "../../../agents/links";
import { runTask } from "../../../agents/loop";
import { leaderLook, superAiName } from "../bots/identity";
import type { BotCommand, BotContext, BotMessage, BotType } from "../../types";
import { beginJob, JobEnded, type Job } from "../../../agents/jobs";
import { agent, attachedImages, defaultPersona, fit, plain, record, recent, serverOf, stepLimitOf, tokenCapOf } from "./agent";
import { beginWork, endWork } from "../../../agents/work";
import { botParent } from "../../../core/botConfig";

const maxHelpers = 4;
const maxTasks = 6;

type Plan = { tasks: { title: string; channel: string; instruction: string }[] };
const planSchema = {
  type: "object",
  properties: {
    tasks: {
      type: "array", maxItems: maxTasks,
      items: { type: "object", properties: { title: { type: "string" }, channel: { type: "string" }, instruction: { type: "string" } }, required: ["title", "channel", "instruction"], additionalProperties: false },
    },
  },
  required: ["tasks"], additionalProperties: false,
};

const assistantName = (leader: string, index: number) => `${leader}'s Assistant #${index + 1}`;

const parentOf = botParent;

type Decision = { kind: "approve" } | { kind: "reject" } | { kind: "instead"; text: string };
// The plan each leader is waiting on, one per channel.
const waiting = new Map<string, { asker: number; resolve: (decision: Decision, by: number) => void }>();
const waitKey = (botId: number, channelId: number) => `${botId}:${channelId}`;
const approvalMs = 10 * 60_000;

// "yes", "go ahead", "no": what a person types instead of pressing a plan button.
const plainAnswer = (text: string): "approve" | "reject" | null => {
  const words = text.trim().toLowerCase().replace(/[^a-z' ]+/g, " ").trim();
  if (/^(yes|yep|yeah|ok|okay|sure|go|go ahead|go on|do it|start|approved?|looks good|sounds good|yes please|yes go|yes go ahead|please do)$/.test(words)) return "approve";
  if (/^(no|nope|stop|cancel|reject|dont|don't|never mind|nevermind)$/.test(words)) return "reject";
  return null;
};

const planButtons = [
  { label: "Approve", command: "/approve" },
  { label: "Reject", command: "/reject" },
  { label: "Do this instead...", command: "/instead", input: true },
];

// Answers the plan this leader waits on in the channel; only the person who asked, or someone who manages bots.
function answerPlan(decide: (call: Parameters<BotCommand["run"]>[1]) => Decision | null): BotCommand["run"] {
  return (context, call) => {
    const pending = waiting.get(waitKey(context.bot.id, call.message.channelId));
    if (!pending) return "There is no plan waiting for an answer here.";
    if (call.message.authorId !== pending.asker && !context.can(call.message.authorId, "manage_bots")) return "Only the person who asked, or someone who manages bots, can answer the plan.";
    const decision = decide(call);
    if (!decision) return "Tell me what to do instead after the button, for example `/instead only do the first file`.";
    pending.resolve(decision, call.message.authorId);
    return null;
  };
}

const leaderNote = "You are an agent leader. For a request with several independent jobs you split it into tasks, show the plan, and "
  + "power on helper agents that do them; you can do that, so never say you can't. Right now you are answering directly, with your own tools.";

const leaderCommands: Record<string, BotCommand> = {
  ...agent.commands,
  approve: { usage: "/approve", help: "Lets me start the planned work.", run: answerPlan(() => ({ kind: "approve" })) },
  reject: { usage: "/reject", help: "Drops the plan.", run: answerPlan(() => ({ kind: "reject" })) },
  instead: {
    usage: "/instead <what to do>", help: "Replaces the plan with a new instruction.",
    run: answerPlan((call) => (call.args.trim() ? { kind: "instead", text: call.args.trim() } : null)),
  },
};

export const leader: BotType = {
  look: leaderLook,
  randomName: superAiName,
  label: "Agent leader",
  description: "Splits a request into tasks, shows the plan for approval, powers on helper agents to do them, then reviews their work and answers.",
  permissions: [...agent.permissions!, "spawn"],
  isBusy: agent.isBusy,
  stop: agent.stop,
  settings: {
    ...Object.fromEntries(Object.entries(agent.settings ?? {}).filter(([key]) => key !== "librarian")),
    helpers: { label: "Helpers at most (1 to 4)", type: "number", default: 2 },
    helperServer: { label: "Helpers' server address (empty: same as mine)", type: "text", placeholder: "http://localhost:8081" },
    helperModel: { label: "Helpers' model (empty: same as mine)", type: "text", placeholder: "" },
    approve: { label: "Ask before starting helpers", type: "bool", default: true },
  },
  commands: leaderCommands,
  async mention(context, message, text) {
    const answer = plainAnswer(text);
    const pending = answer && waiting.get(waitKey(context.bot.id, message.channelId));
    if (answer && pending) return answerPlan(() => ({ kind: answer }))(context, { message, args: text, words: [], mentioned: [] }) as null | string | Promise<null | string>;
    const job = beginJob(context.bot.id, message.authorId, tokenCapOf(context));
    try {
      return await lead(context, message, text, job);
    } catch (e) {
      if (!(e instanceof JobEnded)) throw e;
      await context.post(message.channelId, await withLinks(context, `<@${message.authorId}> I stopped. ${e.message}`, [message.authorId]),
        { threadId: message.threadId, buttons: [{ label: "Undo this", command: "/undo" }] });
      return null;
    } finally {
      job.end();
    }
  },
  start: () => {},
};

async function lead(context: BotContext, message: BotMessage, text: string, job: Job): Promise<null> {
  const server = await serverOf(context);
  const want = Math.min(maxHelpers, Math.max(1, Number(context.bot.config.helpers) || 2));
  const asker = context.member(message.authorId).displayName;
  const channels = (await context.channels()).slice(0, 40).map((c) => `#${c.name} (${c.type})`).join(", ");
  const onUsage = (reply: Parameters<typeof record>[1]) => { record(context.bot.id, reply); job.add(reply.promptTokens + reply.completionTokens); };
  const sees = await llmSeesPictures(server);
  const tools = (await skillsFor(context, sees)).map((s) => `${s.name}: ${s.description}`).join("\n");
  const wantsHelpers = /\b(sub-?agents?|helpers?|delegate|spin up|your team|assistants?)\b/i;
  const plan = async (request: string) => {
    const planned = await llmJson<Plan>(server, [
      { role: "system", content: `You lead a small team of helper agents in a team workspace. Channels: ${channels}.\n`
        + `Each helper has exactly these tools and nothing else:\n${tools}\n`
        + `If the request asks for changes in the workspace that split into independent tasks, list the tasks (at most ${maxTasks}), `
        + `each one something the tools above can do. Make each task a real job of a few steps in one place, not one task per tool call, `
        + `and skip channels no tool can work in. For a summary of the workspace, return no tasks (workspace_overview does it in one step). `
        + `Each instruction must be complete on its own: say which channel, file names and exactly what to put or do, since a helper sees nothing else. `
        + (wantsHelpers.test(request) ? `The user asked you to use helpers, so give at least one task. ` : "")
        + `Returning no tasks is the normal answer: one person can do most requests, in any number of steps, so do not split them. `
          + `Split only when there are at least two big jobs in different channels that do not depend on each other (for example a report in docs and a board in tasks). `
          + `Questions, single edits, anything in one channel, and anything a few tool calls can do get no tasks. Name the channel of each task.` },
      { role: "user", content: `${asker}: ${request}` },
    ], planSchema, { maxTokens: 1200 });
    onUsage(planned.reply);
    job.check();
    return planned.value.tasks.filter((t) => t.instruction.trim());
  };

  let request = plain(context, text);
  let tasks = await plan(request);
  await context.log(`Plan for "${request}": ${tasks.length ? tasks.map((t, i) => `${i + 1}. ${t.title}`).join("; ") : "no tasks, answering directly"}`);
  const minimum = () => (wantsHelpers.test(request) ? 1 : 2);
  // Helpers are for work in several places: tasks in one channel are one person's job.
  const worthHelpers = () => tasks.length >= minimum() && (wantsHelpers.test(request) || new Set(tasks.map((t) => t.channel.trim().toLowerCase().replace(/^#/, ''))).size >= 2);
  const common = {
    server, persona: String(context.bot.config.persona || defaultPersona), asker, askerId: message.authorId,
    channelId: message.channelId, threadId: message.threadId, onUsage: (reply: Parameters<typeof record>[1]) => record(context.bot.id, reply), job, maxSteps: await stepLimitOf(context),
  };
  const single = async () => {
    const contextTokens = await llmContextSize(server);
    const history = fit("", await recent(context, message), "", contextTokens ? contextTokens - 1500 : null).slice(1, -1);
    await runTask(context, { ...common, extraSystem: leaderNote, request, history, images: await attachedImages(context, message), imageSide: Number(context.bot.config.imageSize) || undefined });
  };
  if (!worthHelpers()) { await single(); return null; }

  // Helpers may think with another server or model than the leader (a small fast one for simple tasks).
  const helperServer = String(context.bot.config.helperServer ?? "").trim() || context.bot.config.server;
  const helperModel = String(context.bot.config.helperModel ?? "").trim() || context.bot.config.model;
  // Helpers are bots of their own, kept between jobs and powered on only while they work.
  const count = Math.min(want, tasks.length);
  let rows = (await context.api.read("bots_bots")).filter((row) => parentOf(row) === context.bot.id);
  for (let i = rows.length; i < count; i++)
    await context.createBot("agent", assistantName(context.bot.nickname, i), {
      server: helperServer, model: helperModel, apiKey: context.bot.config.apiKey,
      persona: "You are a careful helper. You do exactly the task you are given.",
    });
  rows = (await context.api.read("bots_bots")).filter((row) => parentOf(row) === context.bot.id).slice(0, count);
  const nameOfTask = (i: number) => context.member(Number(rows[i % rows.length].user_id)).displayName;
  const planText = () => `**Plan**\n${tasks.map((t, i) => `${i + 1}. ${t.title} (${nameOfTask(i)})`).join("\n")}`;

  const ask = context.bot.config.approve !== false;
  let planId = await context.post(message.channelId, await withLinks(context, ask ? `${planText()}\n\nShall I start?` : planText()), { threadId: message.threadId, buttons: ask ? planButtons : undefined });
  const thread = message.threadId ?? planId;
  while (ask) {
    const decision = await new Promise<{ decision: Decision; by: number } | null>((resolve) => {
      const key = waitKey(context.bot.id, message.channelId);
      waiting.get(key)?.resolve({ kind: "reject" }, 0);
      const timer = setTimeout(() => { waiting.delete(key); resolve(null); }, approvalMs);
      waiting.set(key, { asker: message.authorId, resolve: (decision, by) => { clearTimeout(timer); waiting.delete(key); resolve({ decision, by }); } });
    });
    const settle = async (note: string) => context.edit(planId, await withLinks(context, `${planText()}\n\n_${note}_`), []);
    if (!decision) { await settle("No answer, so I dropped this plan."); return null; }
    const by = context.member(decision.by).displayName;
    if (decision.decision.kind === "reject") { await settle(`Rejected by ${by}.`); return null; }
    if (decision.decision.kind === "approve") { await settle(`Approved by ${by}.`); break; }
    await settle(`${by} asked for something else: ${decision.decision.text}`);
    request = decision.decision.text;
    tasks = await plan(request);
    if (!worthHelpers()) { await single(); return null; }
    planId = await context.post(message.channelId, await withLinks(context, `${planText()}\n\nShall I start?`), { threadId: thread === planId ? null : message.threadId, buttons: planButtons });
  }
  const helperIds = rows.map((row) => Number(row.user_id));
  beginWork(context.bot.id, message.authorId, [context.bot.id, ...helperIds]);
  // Helpers kept from earlier jobs take their server and model from the leader's helper settings (else its own) and its permissions (they are off, so this is safe).
  const wantedPermissions = (agent.permissions ?? []).filter((p) => p !== "spawn" && context.granted(p));
  for (const [i, row] of rows.entries()) {
    if (String(row.nickname) !== assistantName(context.bot.nickname, i)) await context.renameBot(Number(row.user_id), assistantName(context.bot.nickname, i));
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(String(row.config || "{}")); } catch { config = {}; }
    const next = { ...config, server: helperServer, model: helperModel, apiKey: context.bot.config.apiKey, _permissions: wantedPermissions };
    if (JSON.stringify(next) !== JSON.stringify(config)) await context.api.call("update", { id: row.id, config: JSON.stringify(next) });
    await context.api.call("set-status", { id: row.id, status: "enabled" });
  }

  try {
    const reports = new Map<number, { title: string; helper: string; report: string; ok: boolean }>();
    await Promise.all(rows.map(async (row, h) => {
      const helper = Number(row.user_id);
      for (const [i, task] of tasks.entries()) {
        if (i % rows.length !== h) continue;
        // Every report is waited for; a helper that fails or doesn't answer counts as a failure instead of blocking.
        const result = await dispatch(helper, {
          instruction: task.instruction, channelId: message.channelId, threadId: thread,
          leader: { id: context.bot.id, name: context.bot.nickname, request }, parent: job,
        });
        reports.set(i, { title: task.title, helper: context.member(helper).displayName, report: result.report, ok: result.ok });
      }
    }));
    job.check();
    for (const [i, r] of reports) await context.log(`Report ${i + 1} from ${r.helper}${r.ok ? "" : " (failed)"}: ${r.report.replace(/\s+/g, " ")}`);
    const summary = [...reports.entries()].sort(([a], [b]) => a - b).map(([, r]) => `- ${r.title} (${r.helper})${r.ok ? "" : " FAILED"}: ${r.report}`).join("\n");
    const review = await llmComplete(server, [
      { role: "system", content: `You lead a team of helper agents. They finished the tasks you gave them. Check their reports against the request, `
        + `then tell the user briefly what was done and what failed or looks wrong (reports marked FAILED, or reports that don't match the task). Plain text, no tool calls.` },
      { role: "user", content: `${asker} asked: ${request}\n\nReports:\n${summary}` },
    ], { maxTokens: 400 });
    onUsage(review);
    job.check();
    await context.log(`Review: ${review.text.replace(/\s+/g, " ")}`);
    endWork(context.bot.id);
    await context.post(message.channelId, await withLinks(context, `<@${message.authorId}> ${review.text}\n\n**Reports**\n${summary}`, [message.authorId]),
      { threadId: thread, buttons: [{ label: "Undo all of it", command: "/undo" }] });
  } finally {
    endWork(context.bot.id);
    for (const row of rows) {
      await context.api.call("set-status", { id: row.id, status: "disabled" }).catch(() => {});
      await context.api.call("memory-clear", { bot_id: row.id }).catch(() => {});
    }
  }
  return null;
}
