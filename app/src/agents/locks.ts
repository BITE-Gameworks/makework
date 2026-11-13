// Soft locks so two agents don't change the same object at once. A claim is a short-lived marker: kept here for the
// bots on this device (a leader and its helpers) and shown through presence for bots on other devices. Nobody is
// blocked for long: a claim lapses after `claimMs`, and a task releases its own when it ends.
import type { BotContext } from "../plugins/types";

const claimMs = 45_000;
const prefix = "lock:";

const local = new Map<string, { bot: number; name: string; until: number }>();
const held = new Map<number, Map<string, { channelId: number; object: string | number }>>();

const keyOf = (context: BotContext, channelId: number, object: string | number) => `${context.workspaceId}:${channelId}:${object}`;

// Takes the object for this bot. Returns the name of whoever holds it already, or null when it is now this bot's.
export function claim(context: BotContext, channelId: number, object: string | number): string | null {
  const now = Date.now();
  const key = keyOf(context, channelId, object);
  const other = local.get(key);
  if (other && other.bot !== context.bot.id && other.until > now) return other.name;
  for (const mark of context.marks(channelId))
    if (mark.key === `${prefix}${object}` && typeof mark.value === "number" && mark.value > now && mark.userId !== context.bot.id)
      return context.member(mark.userId).displayName;
  local.set(key, { bot: context.bot.id, name: context.bot.nickname, until: now + claimMs });
  (held.get(context.bot.id) ?? held.set(context.bot.id, new Map()).get(context.bot.id)!).set(key, { channelId, object });
  context.mark(channelId, `${prefix}${object}`, now + claimMs);
  return null;
}

// Claims or throws a message the model can act on (do something else, or tell the user).
export function claimOrBusy(context: BotContext, channelId: number, object: string | number, label: string): void {
  const holder = claim(context, channelId, object);
  if (holder) throw new Error(`${label} is being changed by ${holder} right now. Work on something else or try again later.`);
}

// Gives back everything this bot claimed (when its task ends).
export function releaseAll(context: BotContext): void {
  for (const [key, { channelId, object }] of held.get(context.bot.id) ?? []) {
    local.delete(key);
    context.mark(channelId, `${prefix}${object}`, null);
  }
  held.delete(context.bot.id);
}
