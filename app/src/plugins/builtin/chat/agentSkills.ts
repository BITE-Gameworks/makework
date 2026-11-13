// Agent skills of chat channels.
import { decodeEmoji } from "../../../markdown/emoji";
import { clip, findChannel } from "../../../agents/skillKit";
import type { AgentIndexer, AgentItem, AgentSkill } from "../../types";

// ---- chat
export const chatSkills: AgentSkill[] = [{
  name: "chat_read",
  description: "Reads the latest messages of a chat channel.",
  args: { channel: "string", count: "number" },
  permissions: [], channelType: "chat",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "chat");
    // People's messages only: bots' notes about their own work are noise, and mentions are shown as names.
    const rows = (await context.messages(channel.id)).filter((m) => m.thread_id === null && !m.action).slice(-Math.min(30, Math.max(1, Number(args.count) || 10)));
    const quote = (body: string) => clip(decodeEmoji(body).replace(/<@(\d+)>/g, (_, id: string) => `@${context.member(Number(id)).displayName}`), 300);
    return rows.length ? rows.map((m) => `${context.member(m.author_id).displayName}: ${quote(m.body)}`).join("\n") : "The channel has no messages.";
  },
}, {
  name: "chat_post",
  description: "Posts a message in a chat channel as yourself.",
  args: { channel: "string", text: "string" },
  permissions: ["write:chat"], channelType: "chat",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "chat");
    await context.post(channel.id, String(args.text));
    return `Posted in #${channel.name}.`;
  },
}];


const maxChannels = 20;
const maxMessages = 200;

export const chatIndex: AgentIndexer = {
  permissions: [], noun: "messages", minItems: 5,
  async items(context, channels) {
    const found: AgentItem[] = [];
    for (const c of channels.slice(0, maxChannels))
      for (const m of (await context.messages(c.id)).filter((x) => !x.action).slice(-maxMessages))
        found.push({
          channelId: c.id, id: m.id, label: context.member(m.author_id).displayName,
          text: decodeEmoji(m.body).replace(/<@(\d+)>/g, (_, id: string) => `@${context.member(Number(id)).displayName}`),
        });
    return found;
  },
  overview: (items) => `${items.length} messages${items.length ? `, latest: ${(items.at(-1)!.text ?? "").slice(0, 80)}` : ""}`,
  cardText: (items) => items.slice(-60).map((i) => `${i.label}: ${i.text}`).join("\n"),
};
