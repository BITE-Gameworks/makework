// Agent skills of tasks channels.
import { decodeEmoji, encodeEmoji } from "../../../markdown/emoji";
import { claimOrBusy } from "../../../agents/locks";
import { findChannel, rowsOfChannels } from "../../../agents/skillKit";
import type { AgentIndexer, AgentSkill, BotContext } from "../../types";
import { compareText } from "../../../core/text";

const lower = (value: unknown) => String(value ?? "").trim().toLowerCase();
// ---- tasks
type Column = { id: number; name: string; done: boolean };
type Task = { id: number; title: string; notes: string; column: number };

async function board(context: BotContext, channelId: number): Promise<{ columns: Column[]; tasks: Task[] }> {
  // A board gets its default columns when first opened; opening it here is a change, so only for bots that may make one.
  if (context.granted("write:tasks") && (await context.read("tasks", "tasks_columns", { channel_id: channelId })).length === 0)
    await context.write("tasks").call("list-board", { channel_id: channelId });
  const columns = (await context.read("tasks", "tasks_columns", { channel_id: channelId })).filter((r) => r.deleted !== true)
    .sort((a, b) => Number(a.position) - Number(b.position)).map((r) => ({ id: Number(r.id), name: decodeEmoji(String(r.name)), done: r.is_done === true }));
  const tasks = (await context.read("tasks", "tasks_tasks", { channel_id: channelId })).filter((r) => r.deleted !== true && !r.archived_at)
    .map((r) => ({ id: Number(r.id), title: decodeEmoji(String(r.title ?? "")), notes: decodeEmoji(String(r.notes ?? "")), column: Number(r.column_id) }));
  return { columns, tasks };
}

const findTask = (tasks: Task[], title: string) => tasks.find((t) => lower(t.title) === lower(title)) ?? tasks.find((t) => lower(t.title).includes(lower(title)));
const findColumn = (columns: Column[], name: string) => columns.find((c) => lower(c.name) === lower(name)) ?? columns.find((c) => lower(c.name).includes(lower(name)));

export const tasksSkills: AgentSkill[] = [{
  name: "tasks_list",
  description: "Lists the columns of a task board with their tasks.",
  args: { channel: "string" },
  permissions: ["read:tasks"], channelType: "tasks",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "tasks");
    const { columns, tasks } = await board(context, channel.id);
    return columns.map((c) => `${c.name}${c.done ? " (done)" : ""}:\n${tasks.filter((t) => t.column === c.id).map((t) => `- ${t.title}`).join("\n") || "- (none)"}`).join("\n");
  },
}, {
  name: "tasks_add",
  description: "Adds a task to a task board. Column may be empty for the first column.",
  args: { channel: "string", title: "string", notes: "string", column: "string" },
  permissions: ["read:tasks", "write:tasks"], channelType: "tasks",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "tasks");
    const { columns } = await board(context, channel.id);
    const column = String(args.column).trim() ? findColumn(columns, String(args.column)) : columns[0];
    if (!column) throw new Error(`There is no column '${args.column}'. Columns: ${columns.map((c) => c.name).join(", ")}.`);
    const tasks = context.write("tasks");
    const { id } = await tasks.call<{ id: number }>("add-task", { channel_id: channel.id, title: encodeEmoji(String(args.title)), column_id: column.id });
    if (String(args.notes).trim()) await tasks.call("edit-task", { task_id: id, title: encodeEmoji(String(args.title)), notes: encodeEmoji(String(args.notes)) });
    return `Added '${args.title}' to ${column.name} on #${channel.name}.`;
  },
}, {
  name: "tasks_move",
  description: "Moves a task (found by its title) to another column of the board.",
  args: { channel: "string", task: "string", column: "string" },
  permissions: ["read:tasks", "write:tasks"], channelType: "tasks",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "tasks");
    const { columns, tasks } = await board(context, channel.id);
    const task = findTask(tasks, String(args.task));
    if (!task) throw new Error(`There is no task '${args.task}'.`);
    const column = findColumn(columns, String(args.column));
    if (!column) throw new Error(`There is no column '${args.column}'. Columns: ${columns.map((c) => c.name).join(", ")}.`);
    claimOrBusy(context, channel.id, `task:${task.id}`, `The task '${task.title}'`);
    await context.write("tasks").call("move-task", { task_id: task.id, column_id: column.id });
    return `Moved '${task.title}' to ${column.name}.`;
  },
}, {
  name: "tasks_assigned",
  description: "Lists the tasks and issues assigned to you on every task board you can see, with their column or status, tags and notes.",
  args: {},
  permissions: ["read:tasks"], channelType: "tasks",
  async run(context) {
    const me = context.bot.id;
    const boards = (await context.channels()).filter((c) => c.type === "tasks");
    const [rows, assignees, links, tags, columns] = await Promise.all([
      rowsOfChannels(context, "tasks", "tasks_tasks", boards), context.read("tasks", "tasks_assignees"), context.read("tasks", "tasks_task_tags"),
      context.read("tasks", "tasks_tags"), context.read("tasks", "tasks_columns"),
    ]);
    // Tasks from before multiple assignees name one person in assignee_id.
    const mine = new Set(assignees.filter((a) => Number(a.user_id) === me).map((a) => Number(a.task_id)));
    const assigned = rows.filter((r) => mine.has(Number(r.id)) || Number(r.assignee_id) === me);
    if (!assigned.length) return "Nothing is assigned to you.";
    const tagName = new Map(tags.filter((t) => t.deleted !== true).map((t) => [Number(t.id), String(t.name)]));
    const column = new Map(columns.map((c) => [Number(c.id), { name: decodeEmoji(String(c.name)), done: c.is_done === true }]));
    const line = (r: Record<string, unknown>) => {
      const where = r.kind === "issue" ? `issue, ${String(r.status ?? "open")}` : (() => {
        const c = column.get(Number(r.column_id));
        return c ? `${c.name}${c.done ? ", done" : ""}` : "task";
      })();
      const tagged = links.filter((l) => Number(l.task_id) === Number(r.id)).map((l) => tagName.get(Number(l.tag_id))).filter(Boolean).map((t) => ` #${t}`).join("");
      const notes = decodeEmoji(String(r.notes ?? "")).trim();
      return `- ${decodeEmoji(String(r.title ?? ""))} (${where})${tagged}${notes ? `\n  ${notes.slice(0, 400).replaceAll("\n", "\n  ")}` : ""}`;
    };
    return boards.map((b) => {
      const own = assigned.filter((r) => Number(r.channel_id) === b.id);
      return own.length ? `#${b.name}:\n${own.map(line).join("\n")}` : "";
    }).filter(Boolean).join("\n\n");
  },
}, {
  name: "tasks_tag",
  description: "Puts a tag on a task or issue (found by its title). A tag the board doesn't have yet is made. Tag names are a-z, digits and '-'.",
  args: { channel: "string", task: "string", tag: "string" },
  permissions: ["read:tasks", "write:tasks"], channelType: "tasks",
  run: (context, args) => setTag(context, args, true),
}, {
  name: "tasks_untag",
  description: "Takes a tag off a task or issue (found by its title).",
  args: { channel: "string", task: "string", tag: "string" },
  permissions: ["read:tasks", "write:tasks"], channelType: "tasks",
  run: (context, args) => setTag(context, args, false),
}];

async function setTag(context: BotContext, args: Record<string, string | number>, on: boolean): Promise<string> {
  const channel = await findChannel(context, String(args.channel), "tasks");
  const { tasks } = await board(context, channel.id);
  const task = findTask(tasks, String(args.task));
  if (!task) throw new Error(`There is no task or issue '${args.task}' on #${channel.name}.`);
  const name = lower(args.tag).replace(/^#/, "");
  const write = context.write("tasks");
  const tags = (await context.read("tasks", "tasks_tags", { channel_id: channel.id })).filter((t) => t.deleted !== true);
  let tagId = tags.find((t) => lower(t.name) === name)?.id as number | undefined;
  if (tagId === undefined) {
    if (!on) return `'${task.title}' doesn't have #${name}.`;
    tagId = (await write.call<{ id: number }>("add-tag", { channel_id: channel.id, name })).id;
  }
  const has = (await context.read("tasks", "tasks_task_tags", { task_id: task.id, tag_id: tagId })).length > 0;
  if (has === on) return `'${task.title}' ${on ? "already has" : "doesn't have"} #${name}.`;
  claimOrBusy(context, channel.id, `task:${task.id}`, `The task '${task.title}'`);
  // tag-task toggles: it puts the tag on, or takes it off when it is there.
  await write.call("tag-task", { task_id: task.id, tag_id: tagId });
  return on ? `Tagged '${task.title}' with #${name}.` : `Took #${name} off '${task.title}'.`;
}


export const tasksIndex: AgentIndexer = {
  permissions: ["read:tasks"], noun: "tasks",
  async items(context, channels) {
    return (await rowsOfChannels(context, "tasks", "tasks_tasks", channels)).map((r) => ({
      channelId: Number(r.channel_id), id: Number(r.id), label: decodeEmoji(String(r.title ?? "")), text: decodeEmoji(String(r.notes ?? "")),
    }));
  },
  cardText: (items) => items.slice(0, 300).map((i) => `${i.label} ${i.text ?? ""}`.trim()).sort(compareText).join("\n"),
};
