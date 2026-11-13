// The workspace index as tools: look things up in it, write notes into it, bring it up to date.
import { describeEntry, findEntries, hashOf, indexPass } from "./library";
import { isScratchpadName } from "./scratchpad";
import { findChannel, type AgentSkill } from "./skillKit";
import { agentSource } from "./source";

// The docs plugin's own skills do the reading and writing, so this works with whatever docs channel type is installed.
const docsSkill = (name: string): AgentSkill => {
  const skill = agentSource().skills().find((s) => s.name === name);
  if (!skill) throw new Error("There are no docs channels to write notes in.");
  return skill;
};

// The first docs channel in the bot scratchpad category (Workspace settings > Plugins makes it).
async function scratchpadChannel(context: Parameters<AgentSkill["run"]>[0]) {
  const channel = (await context.channels()).find((c) => c.type === "docs" && c.category && isScratchpadName(c.category));
  if (!channel) throw new Error("There is no bot scratchpad. A member with the channel permission can create it in Workspace settings > Plugins.");
  return channel;
}

// Adds a dated line to a page of a docs channel (made on first use), for notes people can read and edit.
async function appendToPage(context: Parameters<AgentSkill["run"]>[0], channelName: string, title: string, line: string, env: Parameters<AgentSkill["run"]>[2]) {
  const channel = channelName === "scratchpad" ? await scratchpadChannel(context) : await findChannel(context, channelName, "docs");
  if (channelName !== "scratchpad" && channel.name.trim().toLowerCase() !== channelName) throw new Error(`There is no docs channel named '${channelName}'. A member can create one, then this works.`);
  const old = await docsSkill("docs_read").run(context, { channel: channel.name, title }, env).then((t) => (typeof t === "string" ? t : t.text)).catch(() => "");
  const text = `${old && old !== "(empty)" ? `${old.replace(/\n\[cut:.*$/s, "").trimEnd()}\n\n` : ""}${new Date().toISOString().slice(0, 10)} ${line}`;
  await docsSkill("docs_write").run(context, { channel: channel.name, title, text }, env);
  return channel;
}

const noteRef = (title: string) => `note:${hashOf(title.trim().toLowerCase())}`;

export const memorySkills: AgentSkill[] = [{
  name: "recall",
  description: "Looks up the workspace index: short summaries of channels, pages and notes written earlier. Use it to find where something is or what was decided, before searching.",
  args: { words: "string" },
  permissions: ["memory"],
  async run(context, args) {
    const found = await findEntries(context, await context.library.entries(), String(args.words), 8);
    return found.length ? (await Promise.all(found.map((e) => describeEntry(context, e)))).join("\n") : "The index has nothing about that. Try search.";
  },
}, {
  name: "remember",
  description: "Writes a note into the workspace index for later: a decision, a fact or where something is. Same title replaces the old note.",
  args: { title: "string", note: "string", tags: "string" },
  permissions: ["memory"],
  async run(context, args) {
    const title = String(args.title).trim();
    if (!title) throw new Error("A note needs a title.");
    await context.library.save({
      channelId: null, kind: "note", ref: noteRef(title), title, summary: String(args.note).trim().slice(0, 600),
      tags: String(args.tags).split(/[,\s]+/).map((t) => t.toLowerCase()).filter(Boolean).slice(0, 6), sourceHash: "",
    });
    return `Noted "${title}".`;
  },
}, {
  name: "forget",
  description: "Removes a note from the workspace index by its title.",
  args: { title: "string" },
  permissions: ["memory"],
  async run(context, args) {
    const ref = noteRef(String(args.title));
    if (!(await context.library.entries()).some((e) => e.ref === ref)) return `There is no note titled "${String(args.title)}".`;
    await context.library.remove(ref);
    return `Forgot "${String(args.title)}".`;
  },
}, {
  name: "record_decision",
  description: "Writes a lasting decision or agreement into the page 'Decisions' of the docs channel named 'decisions' (people can read and edit it). Use it only when the users settled something.",
  args: { decision: "string" },
  permissions: ["memory", "read:docs", "write:docs"], channelType: "docs",
  async run(context, args, env) {
    const channel = await appendToPage(context, "decisions", "Decisions", `- ${String(args.decision).trim()}`, env);
    return `Recorded in #${channel.name}.`;
  },
}, {
  name: "scratchpad",
  description: "Appends a working note to the page 'Agent notes' in the bot scratchpad (a category for bots' own notes that members can read), to keep track of a long job or hand over to another agent.",
  args: { note: "string" },
  permissions: ["memory", "read:docs", "write:docs"], channelType: "docs",
  async run(context, args, env) {
    const channel = await appendToPage(context, "scratchpad", "Agent notes", `- ${context.bot.nickname}: ${String(args.note).trim()}`, env);
    return `Noted in #${channel.name}.`;
  },
}, {
  name: "update_index",
  description: "Reads the docs pages and chat channels that are new or changed and writes their summaries into the workspace index. Slow: use it only when asked to index or refresh.",
  args: {},
  permissions: ["memory"],
  async run(context, _args, env) {
    const { written, waiting } = await indexPass(context, env.server, 6, env.signal);
    return `Indexed ${written} ${written === 1 ? "entry" : "entries"}${waiting ? `; ${waiting} more are waiting, run it again` : "; the index is up to date"}.`;
  },
}];
