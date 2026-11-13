// Agent skills of docs channels.
import * as Y from "yjs";
import { fromBase64, toBase64 } from "../../../core/liveText";
import { decodeEmoji, encodeEmoji } from "../../../markdown/emoji";
import { claimOrBusy } from "../../../agents/locks";
import { clip, findChannel, rowsOfChannels } from "../../../agents/skillKit";
import type { AgentIndexer, AgentSkill, BotContext } from "../../types";

const lower = (value: unknown) => String(value ?? "").trim().toLowerCase();
// ---- docs
type Page = { id: number; title: string; body: string };

async function pages(context: BotContext, channelId: number): Promise<Page[]> {
  return (await context.read("docs", "docs_pages", { channel_id: channelId })).filter((r) => r.deleted !== true)
    .map((r) => ({ id: Number(r.id), title: decodeEmoji(String(r.title ?? "")), body: decodeEmoji(String(r.body ?? "")) }));
}

const findPage = (all: Page[], title: string) => all.find((p) => lower(p.title) === lower(title)) ?? all.find((p) => lower(p.title).includes(lower(title)));

// Replaces the text of an existing page; when it was edited together before, through the shared text so open pages follow.
async function setBody(context: BotContext, channelId: number, page: Page, newText: string): Promise<void> {
  claimOrBusy(context, channelId, `page:${page.id}`, `The page '${page.title}'`);
  const docs = context.write("docs");
  const body = encodeEmoji(newText);
  const updates = (await context.read("docs", "docs_updates", { page_id: page.id })).sort((a, b) => Number(a.id) - Number(b.id));
  if (!updates.length) return void await docs.call("update-page", { page_id: page.id, body });
  const doc = new Y.Doc();
  for (const row of updates) Y.applyUpdate(doc, fromBase64(String(row.data)));
  const text = doc.getText("body");
  const before = Y.encodeStateVector(doc);
  doc.transact(() => {
    text.delete(0, text.length);
    text.insert(0, newText);
  });
  await docs.call("add-update", { page_id: page.id, data: toBase64(Y.encodeStateAsUpdate(doc, before)), body });
}

export const docsSkills: AgentSkill[] = [{
  name: "docs_list",
  description: "Lists the pages of a docs channel.",
  args: { channel: "string" },
  permissions: ["read:docs"], channelType: "docs",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "docs");
    const all = await pages(context, channel.id);
    return all.length ? all.map((p) => p.title).join("\n") : "The channel has no pages.";
  },
}, {
  name: "docs_read",
  description: "Reads one page of a docs channel by its title.",
  args: { channel: "string", title: "string" },
  permissions: ["read:docs"], channelType: "docs",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "docs");
    const page = findPage(await pages(context, channel.id), String(args.title));
    if (!page) throw new Error(`There is no page '${args.title}'.`);
    return clip(page.body) || "(empty)";
  },
}, {
  name: "docs_write",
  description: "Creates a page in a docs channel with markdown text, or replaces the text of the page with that title.",
  args: { channel: "string", title: "string", text: "string" },
  permissions: ["read:docs", "write:docs"], channelType: "docs",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "docs");
    const docs = context.write("docs");
    const body = encodeEmoji(String(args.text));
    const page = findPage(await pages(context, channel.id), String(args.title));
    if (!page) {
      await docs.call("add-page", { channel_id: channel.id, title: encodeEmoji(String(args.title)), body });
      return `Created the page '${args.title}' in #${channel.name}.`;
    }
    await setBody(context, channel.id, page, String(args.text));
    return `Replaced the text of '${page.title}' in #${channel.name}.`;
  },
}, {
  name: "docs_replace_text",
  description: "Changes part of an existing page: every occurrence of the exact words in find is replaced by replace. Use it for small edits (a number, a name, a sentence) so the rest of the page stays untouched; never rewrite a whole page for a small change.",
  args: { channel: "string", title: "string", find: "string", replace: "string" },
  permissions: ["read:docs", "write:docs"], channelType: "docs",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "docs");
    const page = findPage(await pages(context, channel.id), String(args.title));
    if (!page) throw new Error(`There is no page '${args.title}'.`);
    const find = String(args.find);
    if (!find) throw new Error("Say which text to find.");
    const count = page.body.split(find).length - 1;
    if (count === 0) throw new Error(`The page does not contain "${find}". Read the page and copy the exact words.`);
    await setBody(context, channel.id, page, page.body.split(find).join(String(args.replace)));
    return `Replaced ${count} ${count === 1 ? "occurrence" : "occurrences"} in '${page.title}' of #${channel.name}.`;
  },
}, {
  name: "docs_append",
  description: "Adds markdown text at the end of an existing page (a new section, a log line, a list item), keeping everything already there. Creates the page if it does not exist.",
  args: { channel: "string", title: "string", text: "string" },
  permissions: ["read:docs", "write:docs"], channelType: "docs",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "docs");
    const page = findPage(await pages(context, channel.id), String(args.title));
    if (!page) {
      await context.write("docs").call("add-page", { channel_id: channel.id, title: encodeEmoji(String(args.title)), body: encodeEmoji(String(args.text)) });
      return `Created the page '${args.title}' in #${channel.name}.`;
    }
    await setBody(context, channel.id, page, `${page.body.trimEnd()}\n\n${String(args.text).trim()}\n`);
    return `Added text at the end of '${page.title}' in #${channel.name}.`;
  },
}];


export const docsIndex: AgentIndexer = {
  permissions: ["read:docs"], noun: "pages", cards: { kind: "page" },
  async items(context, channels) {
    return (await rowsOfChannels(context, "docs", "docs_pages", channels)).map((r) => ({
      channelId: Number(r.channel_id), id: Number(r.id), label: decodeEmoji(String(r.title ?? "")), text: decodeEmoji(String(r.body ?? "")),
    }));
  },
};
