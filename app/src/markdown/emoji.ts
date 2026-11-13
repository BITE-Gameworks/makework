// The backend rejects emoji in text, so they travel as shortcodes: a name from this list (:smile:), or
// the code points of any other emoji sequence (:u1f9d1_200d_1f4bb:). Decoding restores the exact text.
import { emojiCategories } from "./emojiData";

// Names stored before the picker had categories; they keep their exact emoji.
const earlier: Record<string, string> = {
  smile: "\u{1F604}", grin: "\u{1F601}", joy: "\u{1F602}", wink: "\u{1F609}", sunglasses: "\u{1F60E}",
  thinking: "\u{1F914}", sob: "\u{1F62D}", scream: "\u{1F631}", heart: "\u{2764}\u{FE0F}", thumbsup: "\u{1F44D}",
  thumbsdown: "\u{1F44E}", clap: "\u{1F44F}", pray: "\u{1F64F}", ok_hand: "\u{1F44C}", wave: "\u{1F44B}",
  eyes: "\u{1F440}", fire: "\u{1F525}", zap: "\u{26A1}", tada: "\u{1F389}", rocket: "\u{1F680}", star: "\u{2B50}",
  100: "\u{1F4AF}", white_check_mark: "\u{2705}", x: "\u{274C}", warning: "\u{26A0}\u{FE0F}", bug: "\u{1F41B}",
  coffee: "\u{2615}", pizza: "\u{1F355}", black_joker: "\u{1F0CF}", hammer: "\u{1F528}", wrench: "\u{1F527}",
  bulb: "\u{1F4A1}", memo: "\u{1F4DD}", lock: "\u{1F512}", ship: "\u{1F6A2}", party: "\u{1F973}",
};

export const namedEmoji: Record<string, string> = {
  ...Object.fromEntries(emojiCategories.flatMap((c) => c.emoji)),
  ...earlier,
};

const nameByEmoji = new Map(Object.entries(namedEmoji).map(([name, emoji]) => [emoji, name]));

// The emoji ranges text values may hold (system/values.ts).
const emojiRanges: [number, number][] = [
  [0x1f000, 0x1faff], [0x2600, 0x27bf], [0x2b00, 0x2bff],
  [0x231a, 0x231b], [0x2328, 0x2328], [0x23cf, 0x23cf], [0x23e9, 0x23fa],
  [0x200d, 0x200d], [0xfe0e, 0xfe0f], [0x20e3, 0x20e3], [0xe0020, 0xe007f],
];

function isEmoji(code: number): boolean {
  return emojiRanges.some(([first, last]) => code >= first && code <= last);
}

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

function graphemes(text: string): string[] {
  return segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : [...text];
}

// One shortcode per emoji (grapheme), so known ones keep their names. Emoji code points inside an otherwise
// plain grapheme (a keycap's selector, say) are encoded on their own and the plain part kept.
export function encodeEmoji(text: string): string {
  let out = "";
  for (const grapheme of graphemes(text)) {
    const points = [...grapheme];
    if (!points.some((c) => isEmoji(c.codePointAt(0)!))) {
      out += grapheme;
      continue;
    }
    const named = nameByEmoji.get(grapheme);
    if (named) {
      out += `:${named}:`;
      continue;
    }
    let run = "";
    const flush = () => {
      if (run) out += `:u${[...run].map((c) => c.codePointAt(0)!.toString(16)).join("_")}:`;
      run = "";
    };
    for (const c of points) {
      if (isEmoji(c.codePointAt(0)!)) run += c;
      else {
        flush();
        out += c;
      }
    }
    flush();
  }
  return out;
}

const shortcode = /:([a-z0-9_+-]+):/g;
const codePoints = /^u([0-9a-f]{1,6}(?:_[0-9a-f]{1,6})*)$/;

export function emojiFor(code: string): string | undefined {
  const named = namedEmoji[code];
  if (named) return named;
  const match = codePoints.exec(code);
  if (!match) return undefined;
  const points = match[1].split("_").map((hex) => Number.parseInt(hex, 16));
  return points.every((p) => p <= 0x10ffff) ? String.fromCodePoint(...points) : undefined;
}

export type EmojiPart = { text: string } | { emoji: string; code: string } | { custom: string; code: string };

// A workspace's custom emoji share the shortcode syntax but keep their name: the renderer draws their image.
// Names stay inside the shortcode alphabet and are never one the standard picker already uses.
export const customEmojiName = /^[a-z0-9_]{2,32}$/;

export function emojiNameProblem(name: string): string | null {
  if (!customEmojiName.test(name)) return "Emoji names are 2-32 characters: a-z, 0-9 and _.";
  if (emojiFor(name)) return `:${name}: is a standard emoji name.`;
  return null;
}

// Splits text into plain parts and known shortcodes; unknown :words: stay text. With `custom`, a name that names
// one of the workspace's emoji becomes a custom part, so the caller can draw its image.
export function splitEmoji(text: string, custom?: (name: string) => boolean): EmojiPart[] {
  const parts: EmojiPart[] = [];
  let last = 0;
  for (const match of text.matchAll(shortcode)) {
    const emoji = emojiFor(match[1]);
    const isCustom = !emoji && custom?.(match[1]);
    if (!emoji && !isCustom) continue;
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    parts.push(emoji ? { emoji, code: match[1] } : { custom: match[1], code: match[1] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

export function decodeEmoji(text: string): string {
  return splitEmoji(text).map((p) => ("emoji" in p ? p.emoji : "custom" in p ? `:${p.code}:` : p.text)).join("");
}

// The shortcode for one emoji, for reactions.
export function codeFor(emoji: string): string {
  return encodeEmoji(emoji).slice(1, -1);
}
