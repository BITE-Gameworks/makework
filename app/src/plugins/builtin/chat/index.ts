import { solidView } from "../../solid";
import type { ClientPlugin } from "../../types";
import { chatSkills, chatIndex } from "./agentSkills";
import ChatView from "./ChatView";
import { getMessage, listMessages, snippet } from "./data";

export const chatPlugin: ClientPlugin = {
  manifest: {
    id: "makework.chat",
    icon: "channel-chat",
    name: "Chat",
    version: "1.0.0",
    description: "Text channels with markdown, code, threads, reactions, polls and attachments.",
    author: "MakeWork",
  },
  agentSkills: { chat: [...chatSkills] },
  agentIndex: { chat: chatIndex },
  channelViews: { chat: solidView(ChatView) },
  links: {
    chat: {
      async resolve(target, ctx) {
        if (target.kind !== "message") return null;
        const m = await getMessage(ctx.api, Number(target.id));
        if (m.deleted) return null;
        return { title: `${ctx.users.get(m.authorId).displayName}: ${snippet(m.body, 40)}`, icon: m.kind === "poll" ? "poll" : "comment" };
      },
      async search(query, ctx) {
        const messages = await listMessages(ctx.api, ctx.channel.id);
        return messages.filter((m) => m.body.toLowerCase().includes(query)).slice(-5).reverse().map((m) => ({
          kind: "message", id: m.id, icon: m.kind === "poll" ? "poll" : "comment",
          title: snippet(m.body, 50), detail: ctx.users.get(m.authorId).displayName,
        }));
      },
    },
  },
};
