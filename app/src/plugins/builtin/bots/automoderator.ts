import { automoderatorLook, copName } from "./identity";
import type { BotContext, BotType } from "../../types";
import { parseWords, reasonFor, type ModSettings, type Seen } from "./modLogic";

const warnCooldownMs = 30_000;
const historyKeep = 30;

type Warnings = { count: number; last: string };

const warnings = (context: BotContext, user: number): Warnings => {
  try { return JSON.parse(context.memory.get(`warn:${user}`) ?? "") as Warnings; } catch { return { count: 0, last: "" }; }
};

const forbiddenList = (context: BotContext): string[] => {
  let own: string[] = [];
  try { own = JSON.parse(context.memory.get("words") ?? "[]"); } catch { own = []; }
  return [...new Set([...parseWords(String(context.bot.config.words ?? "")), ...own])];
};

const settingsOf = (context: BotContext): ModSettings => ({
  words: forbiddenList(context),
  spamCount: Math.max(2, Number(context.bot.config.spamCount ?? 5)),
  spamSeconds: Math.max(2, Number(context.bot.config.spamSeconds ?? 10)),
  repeats: Math.max(2, Number(context.bot.config.repeats ?? 3)),
  maxMentions: Math.max(1, Number(context.bot.config.maxMentions ?? 8)),
});

const mayModerate = (context: BotContext, user: number) => context.can(user, "manage_messages");

export const automoderator: BotType = {
  look: automoderatorLook,
  randomName: copName,
  label: "Automoderator",
  description: "Warns about spam, forbidden words and mention floods. It only warns; moderators decide what follows.",
  permissions: ["read:chat", "memory"],
  settings: {
    channels: { label: "Watch these channels (empty: all)", type: "channels" },
    words: { label: "Forbidden words (comma separated)", type: "text" },
    spamCount: { label: "Most messages per window", type: "number", default: 5 },
    spamSeconds: { label: "Window (seconds)", type: "number", default: 10 },
    repeats: { label: "Warn at this many identical messages in a minute", type: "number", default: 3 },
    maxMentions: { label: "Most mentions in one message", type: "number", default: 8 },
  },
  commands: {
    warnings: {
      usage: "/warnings [@member]", help: "Shows how many warnings someone has (yours by default).",
      run: (context, call) => {
        const who = call.mentioned[0] ?? call.message.authorId;
        if (who !== call.message.authorId && !mayModerate(context, call.message.authorId)) return "Only moderators can see other members' warnings.";
        const w = warnings(context, who);
        return `${context.member(who).displayName} has ${w.count} warning${w.count === 1 ? "" : "s"}.`;
      },
    },
    forgive: {
      usage: "/forgive @member", help: "Moderators: clears someone's warnings.",
      run: async (context, call) => {
        if (!mayModerate(context, call.message.authorId)) return "Only moderators can do that.";
        const who = call.mentioned[0];
        if (!who) return "Mention the member: `/forgive @name`.";
        await context.memory.delete(`warn:${who}`);
        return `Cleared the warnings of ${context.member(who).displayName}.`;
      },
    },
    forbid: {
      usage: "/forbid word", help: "Moderators: adds a forbidden word.",
      run: async (context, call) => {
        if (!mayModerate(context, call.message.authorId)) return "Only moderators can do that.";
        const word = call.args.trim().toLowerCase();
        if (!word) return "Say which word: `/forbid word`.";
        let own: string[] = [];
        try { own = JSON.parse(context.memory.get("words") ?? "[]"); } catch { own = []; }
        await context.memory.set("words", JSON.stringify([...new Set([...own, word])]));
        return `Added \`${word}\`. I will warn about it.`;
      },
    },
    allow: {
      usage: "/allow word", help: "Moderators: removes a word added with /forbid.",
      run: async (context, call) => {
        if (!mayModerate(context, call.message.authorId)) return "Only moderators can do that.";
        const word = call.args.trim().toLowerCase();
        let own: string[] = [];
        try { own = JSON.parse(context.memory.get("words") ?? "[]"); } catch { own = []; }
        await context.memory.set("words", JSON.stringify(own.filter((w) => w !== word)));
        return `Removed \`${word}\`.`;
      },
    },
  },
  start(context) {
    const seen = new Map<number, Seen[]>();
    const lastWarn = new Map<number, number>();
    let stopped = false;
    const stop = context.onEvent("chat", async (event) => {
      if (event.table !== "chat_messages" || event.change !== "insert") return;
      for (const id of event.ids) {
        if (stopped) return;
        try {
          const [row] = await context.read("chat", "chat_messages", { id });
          if (row?.kind !== "message" || row.deleted === true) continue;
          const author = Number(row.author_id);
          const channelId = Number(row.channel_id);
          if (author === context.bot.id || !context.inChannel(channelId)) continue;
          if (Date.now() - Date.parse(String(row.created_at)) > 60_000) continue;
          if (context.member(author).bot || mayModerate(context, author)) continue;
          const text = String(row.body ?? "");
          const history = [...(seen.get(author) ?? []), { at: Date.parse(String(row.created_at)) || Date.now(), text }].slice(-historyKeep);
          seen.set(author, history);
          const reason = reasonFor(text, history, settingsOf(context));
          if (!reason || Date.now() - (lastWarn.get(author) ?? 0) < warnCooldownMs) continue;
          lastWarn.set(author, Date.now());
          const w = warnings(context, author);
          const next = { count: w.count + 1, last: new Date().toISOString() };
          await context.memory.set(`warn:${author}`, JSON.stringify(next));
          await context.send(channelId, `<@${author}> warning ${next.count}: ${reason}.`, { threadId: row.thread_id === null ? null : Number(row.thread_id) });
        } catch (e) {
          await context.log(`Check failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    });
    return () => { stopped = true; stop(); };
  },
};
