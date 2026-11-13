// Automoderator's checks, as functions over a message and what was seen before from the same member.
export interface ModSettings { words: string[]; spamCount: number; spamSeconds: number; repeats: number; maxMentions: number }
export interface Seen { at: number; text: string }

export const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

export function parseWords(text: string): string[] {
  return [...new Set(text.split(/[,\n]/).map((word) => word.trim().toLowerCase()).filter(Boolean))];
}

const escapeRegex = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

// The forbidden word a text contains as a whole word (so "class" is fine for "ass"), or null.
export function forbiddenWord(text: string, words: string[]): string | null {
  const flat = text.toLowerCase().replace(/<@\d+>/g, " ");
  return words.find((word) => new RegExp(String.raw`(^|[^\p{L}\p{N}])${escapeRegex(word)}($|[^\p{L}\p{N}])`, "u").test(flat)) ?? null;
}

// Why a new message looks like abuse, given the member's earlier messages (newest last, including this one).
export function reasonFor(text: string, history: Seen[], settings: ModSettings): string | null {
  const bad = forbiddenWord(text, settings.words);
  if (bad) return "that language isn't allowed here";
  const mentions = (text.match(/<@\d+>|@everyone|@here/g) ?? []).length;
  if (mentions > settings.maxMentions) return "too many mentions in one message";
  const now = history.at(-1)?.at ?? 0;
  if (history.filter((m) => now - m.at <= settings.spamSeconds * 1000).length > settings.spamCount) return "that's too many messages too fast";
  const same = normalize(text);
  if (same.length > 3 && history.filter((m) => now - m.at <= 60_000 && normalize(m.text) === same).length >= settings.repeats)
    return "please don't repeat the same message";
  return null;
}
