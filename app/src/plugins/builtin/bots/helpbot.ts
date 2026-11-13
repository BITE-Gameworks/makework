import { butlerName, helpbotLook } from "./identity";
import type { BotType } from "../../types";
import { describeRoll, roll } from "./dice";
import { clockIn, findZone, parseClock, parseDuration, zoneTime } from "./time";

const defaultZones = ["UTC", "America/New_York", "Europe/London", "Europe/Berlin", "Asia/Tokyo", "Australia/Sydney"];
const maxReminders = 20;
const checkMs = 10_000;

type Reminder = { at: number; channelId: number; threadId: number | null; user: number; text: string };

const label = (zone: string) => (zone === "UTC" ? "UTC" : zone.split("/").pop()!.replaceAll("_", " "));

function when(args: string[]): string {
  let clock = parseClock(args[0] ?? "");
  let used = 1;
  if (!clock && args[1] && /^(am|pm)$/i.test(args[1])) {
    clock = parseClock(`${args[0]} ${args[1]}`);
    used = 2;
  }
  if (!clock) return "Try `/when 15:00 Berlin` or `/when 3pm New York to Tokyo, London`.";
  const rest = args.slice(used).join(" ");
  const [from = "", to = ""] = rest.split(/\sto\s/i);
  const source = from.trim() ? findZone(from) : "UTC";
  if (!source) return `I don't know the place \`${from.trim()}\`. Use a city or a zone like \`Europe/Berlin\`.`;
  const targetNames = to.split(/,|\band\b/i).map((name) => name.trim()).filter(Boolean);
  const targets = targetNames.length ? targetNames.map((name) => ({ name, zone: findZone(name) })) : defaultZones.map((zone) => ({ name: label(zone), zone }));
  const unknown = targets.find((t) => !t.zone);
  if (unknown) return `I don't know the place \`${unknown.name}\`.`;
  const now = new Date();
  const at = clock === "now" ? now : zoneTime(source, clock.hour, clock.minute, now);
  const lines = targets.map((t) => `${t.name.replace(/\b\w/g, (c) => c.toUpperCase())} ${clockIn(t.zone!, at)}`);
  const lead = clock === "now" ? "Now" : `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")} in ${label(source)}`;
  return `${lead}: ${lines.join(" · ")}`;
}

export const helpbot: BotType = {
  look: helpbotLook,
  randomName: butlerName,
  label: "Help-bot",
  description: "Rolls dice, converts times between places, sets reminders and shows who is online.",
  permissions: ["memory", "presence"],
  commands: {
    roll: {
      usage: "/roll [2d6+1 | 20]", help: "Rolls dice (a plain number is one die with that many sides, default 6).",
      run: (_context, call) => {
        const words = call.words.length ? call.words : ["6"];
        const results = words.slice(0, 5).map((word) => ({ word, result: roll(word) }));
        const bad = results.find((r) => !r.result);
        if (bad) return `\`${bad.word}\` is not dice. Try \`2d6+1\` or \`20\`.`;
        return results.map((r) => `${r.word}: ${describeRoll(r.result!)}`).join("\n");
      },
    },
    when: {
      usage: "/when 15:00 Berlin [to Tokyo, London]", help: "Shows a time in other places (cities or zones like Europe/Berlin).",
      run: (_context, call) => when(call.words),
    },
    remind: {
      usage: "/remind 20m text", help: "Mentions you with the text after the time (like 20m, 2h, 1d).",
      run: async (context, call) => {
        const [time, ...rest] = call.words;
        const delay = parseDuration(time ?? "");
        const text = rest.join(" ");
        if (delay === null || !text) return "Try `/remind 20m stretch your legs`. Times look like `30s`, `20m`, `2h`, `1d`.";
        const own = context.memory.keys("remind:").filter((key) => {
          try { return (JSON.parse(context.memory.get(key) ?? "{}") as Reminder).user === call.message.authorId; } catch { return false; }
        });
        if (own.length >= maxReminders) return `You already have ${maxReminders} reminders waiting.`;
        const reminder: Reminder = {
          at: Date.now() + delay, channelId: call.message.channelId, threadId: call.message.threadId, user: call.message.authorId, text: text.slice(0, 500),
        };
        await context.memory.set(`remind:${reminder.at}:${call.message.id}`, JSON.stringify(reminder));
        return `Okay, I will remind you ${new Date(reminder.at).toLocaleString()} (your time, as I see it) about: ${reminder.text}`;
      },
    },
    online: {
      usage: "/online", help: "Lists the members who are online.",
      run: (context) => {
        const names = context.online().map((id) => context.member(id)).filter((m) => !m.bot).map((m) => m.displayName);
        return names.length ? `${names.length} online: ${names.join(", ")}` : "Nobody is online.";
      },
    },
  },
  start(context) {
    try { context.memory.keys(); } catch { return; }
    let stopped = false;
    const check = async () => {
      if (stopped) return;
      for (const key of context.memory.keys("remind:")) {
        let reminder: Reminder;
        try { reminder = JSON.parse(context.memory.get(key) ?? ""); } catch { await context.memory.delete(key); continue; }
        if (reminder.at > Date.now()) continue;
        await context.memory.delete(key);
        // A reminder that is days late (the bot was off) still arrives.
        if (context.inChannel(reminder.channelId))
          await context.send(reminder.channelId, `<@${reminder.user}> reminder: ${reminder.text}`, { threadId: reminder.threadId });
      }
    };
    const timer = setInterval(() => void check().catch((e) => context.log(`Reminder check failed: ${e instanceof Error ? e.message : String(e)}`)), checkMs);
    return () => { stopped = true; clearInterval(timer); };
  },
};
