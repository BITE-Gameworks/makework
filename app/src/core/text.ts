// Small text helpers used all over. Trimming is done with loops, not with patterns like /x+$/: without a start
// anchor such a pattern is tried again from every position, so a long run of `x` that doesn't reach the end costs
// quadratic time (text here often comes from other members).

// `text` without the run of characters from `chars` at its end.
export function trimEnd(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1])) end--;
  return text.slice(0, end);
}

// `text` without the run of characters from `chars` at its start.
export function trimStart(text: string, chars: string): string {
  let start = 0;
  while (start < text.length && chars.includes(text[start])) start++;
  return text.slice(start);
}

// `text` without the runs of characters from `chars` at both ends.
export function trimChars(text: string, chars: string): string {
  return trimStart(trimEnd(text, chars), chars);
}

// Orders text by UTF-16 code units: what `sort()` does without a function, and the same on every device (unlike
// `localeCompare`, which follows the device's language). Use it for any order that members or files must share.
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
