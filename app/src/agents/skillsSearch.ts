// Finding things: one search over every channel the agent may read, and a rundown of the workspace. Both are made from
// what each channel type's plugin says it holds (`AgentIndexer`), so a new plugin is searched without changes here.
// Names, titles and text are matched word by word (all words first, then any), and each hit says its channel and
// kind, so the agent can pick the right place to work.
import type { AgentItem, BotContext } from "../plugins/types";
import { agentSource } from "./source";
import type { AgentSkill } from "./skillKit";

interface Hit { channel: string; type: string; label: string; text: string }

const maxHits = 14;

const snippet = (text: string, words: string[]): string => {
  const flat = text.replace(/\s+/g, " ");
  const at = Math.max(0, flat.toLowerCase().search(new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)).join("|"), "i")) - 30);
  return flat.slice(at, at + 110);
};

// A score of how many of the words appear in the labels and text; 0 means no match.
const scoreOf = (words: string[], label: string, text: string): number => {
  const l = label.toLowerCase();
  const t = text.toLowerCase();
  const inLabel = words.filter((w) => l.includes(w)).length;
  const inText = words.filter((w) => l.includes(w) || t.includes(w)).length;
  return inText === words.length ? 100 + inLabel * 10 + inText : inText;
};

type Channel = { id: number; name: string; type: string };

// The items of every channel type that has an indexer the bot may use: one read per type, never one per channel.
export async function itemsByType(context: BotContext, channels: Channel[]): Promise<Map<string, { noun: string; items: AgentItem[]; channels: Channel[] }>> {
  const found = new Map<string, { noun: string; items: AgentItem[]; channels: Channel[] }>();
  for (const type of new Set(channels.map((c) => c.type))) {
    const indexer = agentSource().indexer(type);
    if (!indexer?.permissions.every(context.granted)) continue;
    const ofType = channels.filter((c) => c.type === type);
    try {
      found.set(type, { noun: indexer.noun, items: await indexer.items(context, ofType), channels: ofType });
    } catch { /* not available here */ }
  }
  return found;
}

export const searchSkills: AgentSkill[] = [{
  name: "workspace_overview",
  description: "A rundown of the whole workspace in one step: every channel with what it holds (counts and a few names). Use it only for 'what is in this workspace' requests.",
  args: {},
  permissions: [],
  async run(context) {
    const channels = await context.channels();
    const byType = await itemsByType(context, channels);
    return channels.map((c) => {
      const group = byType.get(c.type);
      const indexer = agentSource().indexer(c.type);
      const items = group?.items.filter((i) => i.channelId === c.id) ?? [];
      const line = !group ? "nothing I can read here"
        : indexer?.overview ? indexer.overview(items, context)
          : `${items.length} ${group.noun}${items.length ? `: ${items.slice(0, 5).map((i) => i.label).join(", ")}${items.length > 5 ? ", ..." : ""}` : ""}`;
      return `#${c.name} (${c.type}): ${line}`;
    }).join("\n");
  },
}, {
  name: "search",
  description: "Searches every channel you can read for words (names, titles, file and page text, tasks, messages, cells, shapes). Use it to find where something is, before reading or changing it.",
  args: { words: "string" },
  permissions: [],
  async run(context, args) {
    const words = String(args.words).toLowerCase().split(/[\s,]+/).filter((w) => w.length > 1).slice(0, 6);
    if (!words.length) throw new Error("Give some words to search for.");
    const channels = await context.channels();
    const byId = new Map(channels.map((c) => [c.id, c]));
    const hits: (Hit & { score: number })[] = [];
    const add = (channelId: number, label: string, text: string) => {
      const channel = byId.get(channelId);
      const score = channel ? scoreOf(words, label, text) : 0;
      if (channel && score > 0) hits.push({ channel: channel.name, type: channel.type, label, text: snippet(text || label, words), score });
    };
    for (const c of channels) add(c.id, `#${c.name}`, `${c.type} channel`);
    for (const { items } of (await itemsByType(context, channels)).values())
      for (const item of items) add(item.channelId, item.label, item.text ?? "");
    hits.sort((a, b) => b.score - a.score);
    const best = hits.slice(0, maxHits);
    return best.length ? best.map((h) => `[${h.type} #${h.channel}] ${h.label}${h.text && h.text !== h.label ? `: ${h.text}` : ""}`).join("\n") : "Nothing found.";
  },
}];
