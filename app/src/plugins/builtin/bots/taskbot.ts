import { taskbotLook, butlerName } from "./identity";
import type { BotContext, BotType } from "../../types";
import { ageDays, dueReminders, milestoneSize, nextMilestone, openTasks, staleTasks, toTask, type TaskRow } from "./tasksLogic";

const checkMs = 30 * 60_000;
const listed = 6;

async function loadTasks(context: BotContext): Promise<TaskRow[]> {
  const [rows, assigned] = await Promise.all([context.read("tasks", "tasks_tasks"), context.read("tasks", "tasks_assignees")]);
  const byTask = new Map<number, number[]>();
  for (const a of assigned) byTask.set(Number(a.task_id), [...(byTask.get(Number(a.task_id)) ?? []), Number(a.user_id)]);
  return rows.map((row) => toTask(row, byTask)).filter((task): task is TaskRow => task !== null);
}

const list = (tasks: TaskRow[], more = listed) =>
  tasks.slice(0, more).map((t) => `- ${t.title || "(untitled)"}`).join("\n") + (tasks.length > more ? `\n- and ${tasks.length - more} more` : "");

async function channelName(context: BotContext, id: number): Promise<string> {
  return `#${(await context.channel(id))?.name ?? id}`;
}

// Tasks of the channel the command was typed in when it is a tasks channel, else of the whole workspace.
async function scoped(context: BotContext, channelId: number): Promise<{ tasks: TaskRow[]; where: string }> {
  const all = await loadTasks(context);
  const here = all.filter((t) => t.channelId === channelId);
  const channel = await context.channel(channelId);
  return channel?.type === "tasks" ? { tasks: here, where: ` in ${await channelName(context, channelId)}` } : { tasks: all, where: "" };
}

export const taskbot: BotType = {
  look: taskbotLook,
  randomName: butlerName,
  label: "Task-bot",
  description: "Reports open tasks, announces every 10 finished tasks and reminds about old ones.",
  permissions: ["read:tasks", "memory"],
  settings: {
    announce: { label: "Announce in (empty: the task's own channel)", type: "channel" },
    staleDays: { label: "Remind about tasks older than (days)", type: "number", default: 14 },
    remindDays: { label: "Remind again after (days)", type: "number", default: 7 },
  },
  commands: {
    todo: {
      usage: "/todo", help: "Lists the tasks that are still open.",
      run: async (context, call) => {
        const { tasks, where } = await scoped(context, call.message.channelId);
        const open = openTasks(tasks);
        if (!open.length) return `No open tasks${where}.`;
        const columns = new Map((await context.read("tasks", "tasks_columns")).map((c) => [Number(c.id), String(c.name)]));
        const byColumn = new Map<number, TaskRow[]>();
        for (const t of open) byColumn.set(t.columnId, [...(byColumn.get(t.columnId) ?? []), t]);
        const sections = [...byColumn].map(([id, group]) => `**${columns.get(id) ?? "Tasks"}** (${group.length})\n${list(group, 5)}`);
        return `**${open.length} open task${open.length === 1 ? "" : "s"}${where}**\n${sections.join("\n")}`;
      },
    },
    mine: {
      usage: "/mine", help: "Lists the open tasks assigned to you.",
      run: async (context, call) => {
        const mine = openTasks((await scoped(context, call.message.channelId)).tasks).filter((t) => t.assignees.includes(call.message.authorId));
        return mine.length ? `**Your open tasks (${mine.length})**\n${list(mine, 10)}` : "Nothing is assigned to you.";
      },
    },
    old: {
      usage: "/old", help: "Lists the open tasks that have waited longest.",
      run: async (context, call) => {
        const days = Number(context.bot.config.staleDays ?? 14);
        const now = Date.now();
        const { tasks } = await scoped(context, call.message.channelId);
        const stale = staleTasks(tasks, now, days);
        if (!stale.length) return `No open task is older than ${days} days.`;
        return `**Open for more than ${days} days (${stale.length})**\n${stale.slice(0, listed).map((t) => `- ${t.title} (${ageDays(t, now)} days)`).join("\n")}`;
      },
    },
    done: {
      usage: "/done", help: "Lists the tasks finished most recently.",
      run: async (context, call) => {
        const { tasks, where } = await scoped(context, call.message.channelId);
        const done = tasks.filter((t) => t.doneAt).sort((a, b) => b.doneAt!.localeCompare(a.doneAt!));
        return done.length ? `**Recently finished${where}**\n${list(done, 8)}` : `No finished tasks${where}.`;
      },
    },
  },
  start(context) {
    let stopped = false;
    let busy = false;
    let again = false;
    const target = (fallback: number) => {
      const wanted = Number(context.bot.config.announce ?? 0);
      return wanted > 0 ? wanted : fallback;
    };

    const milestone = async () => {
      const tasks = await loadTasks(context);
      let since = context.memory.get("milestone:since");
      if (!since) {
        // First run: only tasks finished from now on count.
        since = new Date().toISOString();
        await context.memory.set("milestone:since", since);
      }
      for (let guard = 0; guard < 20; guard++) {
        const group = nextMilestone(tasks, since);
        if (!group) return;
        since = group.at(-1)!.doneAt!;
        await context.memory.set("milestone:since", since);
        const channelId = target(group.at(-1)!.channelId);
        if (context.inChannel(channelId))
          await context.send(channelId, `**${milestoneSize} more tasks are done!**\n${group.map((t) => `- ${t.title}`).join("\n")}`);
      }
    };

    const stale = async () => {
      const now = Date.now();
      const days = Number(context.bot.config.staleDays ?? 14);
      const again = Number(context.bot.config.remindDays ?? 7);
      const tasks = await loadTasks(context);
      const reminded = new Map(context.memory.keys("reminded:").map((key) => [Number(key.slice(9)), Number(context.memory.get(key))]));
      const due = dueReminders(staleTasks(tasks, now, days), reminded, now, again);
      const byChannel = new Map<number, TaskRow[]>();
      for (const t of due) byChannel.set(target(t.channelId), [...(byChannel.get(target(t.channelId)) ?? []), t]);
      for (const [channelId, group] of byChannel) {
        if (!context.inChannel(channelId)) continue;
        await context.send(channelId, `**Still open after more than ${days} days.** Finish or remove ${group.length === 1 ? "it" : "them"}:\n`
          + group.slice(0, listed).map((t) => `- ${t.title} (${ageDays(t, now)} days)`).join("\n")
          + (group.length > listed ? `\n- and ${group.length - listed} more` : ""));
      }
      for (const t of due) await context.memory.set(`reminded:${t.id}`, String(now));
      // Reminders about tasks that no longer exist are forgotten.
      const known = new Set(tasks.map((t) => t.id));
      for (const [id] of reminded) if (!known.has(id)) await context.memory.delete(`reminded:${id}`);
    };

    const guarded = (work: () => Promise<void>) => async () => {
      if (stopped) return;
      if (busy) { again = true; return; }
      busy = true;
      try { await work(); } catch (e) { await context.log(`Task check failed: ${e instanceof Error ? e.message : String(e)}`); }
      busy = false;
      if (again) { again = false; void guarded(work)(); }
    };
    const runMilestone = guarded(milestone);
    const runStale = guarded(stale);

    let debounce: ReturnType<typeof setTimeout> | undefined;
    const stopEvents = context.onEvent("tasks", (event) => {
      if (event.table !== "tasks_tasks" || event.change !== "update") return;
      clearTimeout(debounce);
      debounce = setTimeout(() => void runMilestone(), 2000);
    });
    const timer = setInterval(() => void runStale(), checkMs);
    // Catch up on what was finished while no device ran the bot, then look for old tasks.
    void runMilestone().then(() => runStale());
    return () => { stopped = true; clearTimeout(debounce); clearInterval(timer); stopEvents(); };
  },
};
