// Parsing and wording for the media bot, apart from the bot itself so it can be tested without a call.
import { trimEnd } from "../../../core/text";

// The first web address in a message (the mentions in it ignored).
export function findLink(text: string): string | null {
  const match = /https?:\/\/[^\s<>"']+/i.exec(text.replace(/<@\d+>/g, " "));
  return match ? trimEnd(match[0], ").,;:!?]") : null;
}

export type SeekTarget = { relative: boolean; seconds: number };

// "1:30", "1:02:03", "90", "1m30s", "2h", and "+30" / "-10" for a step from where it is now.
export function parseSeek(text: string): SeekTarget | null {
  const word = text.trim().toLowerCase();
  const relative = word.startsWith("+") || word.startsWith("-");
  const sign = word.startsWith("-") ? -1 : 1;
  const body = relative ? word.slice(1) : word;
  const clock = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(body);
  if (clock) return { relative, seconds: sign * (Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3])) };
  const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(body);
  if (!parts || !body || !(parts[1] || parts[2] || parts[3])) return null;
  return { relative, seconds: sign * (Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0)) };
}

export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export function describePlayback(title: string, position: number, duration: number | null, state: "playing" | "paused" | "ended" | "loading"): string {
  const where = duration ? `${formatTime(position)} / ${formatTime(duration)}` : formatTime(position);
  return `**${title}** · ${where} · ${state}`;
}

// Whether a link names a list of media (a playlist, an album, a set) rather than one item. A video link that also names
// the list it was opened from is the one video.
export function looksLikePlaylist(link: string): boolean {
  let url: URL;
  try { url = new URL(link); } catch { return false; }
  if (/\/(playlists?|sets|albums?)(\/|$)/i.test(url.pathname)) return true;
  return url.searchParams.has("list") && !url.searchParams.has("v") && !/^youtu\.be$/i.test(url.hostname);
}

export type Loop = "off" | "one" | "queue";

export function parseLoop(text: string): Loop | null {
  const word = text.trim().toLowerCase();
  if (word === "off" || word === "none") return "off";
  if (word === "one" || word === "song" || word === "track") return "one";
  if (word === "queue" || word === "all" || word === "list") return "queue";
  return null;
}

// The item to play when the one at `index` is over (or skipped); null when the list is done.
export function nextIndex(index: number, length: number, loop: Loop, skipped = false): number | null {
  if (length === 0) return null;
  if (loop === "one" && !skipped) return index;
  if (index + 1 < length) return index + 1;
  return loop === "queue" ? 0 : null;
}

// The items after `index` in another order; the ones up to it stay.
export function shuffledAfter<T>(items: T[], index: number, random: () => number = Math.random): T[] {
  const rest = items.slice(index + 1);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [...items.slice(0, index + 1), ...rest];
}

const shownUpcoming = 10;

export function queueText(items: { title: string }[], index: number, loop: Loop): string {
  if (items.length === 0) return "The queue is empty.";
  const line = (i: number) => `${i === index ? "▶" : `${i + 1}.`} ${items[i].title || "(not loaded yet)"}`;
  const from = Math.max(0, index);
  const shown = Array.from({ length: Math.min(items.length - from, shownUpcoming) }, (_, k) => line(from + k));
  const more = items.length - from - shown.length;
  const lead = `**Queue** (${items.length}${loop === "off" ? "" : `, looping ${loop === "one" ? "this one" : "the queue"}`})`;
  return `${lead}\n${shown.join("\n")}${more > 0 ? `\nand ${more} more` : ""}`;
}
