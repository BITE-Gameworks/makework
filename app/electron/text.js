// Small text helpers for the main process, the same as the app's src/core/text.ts. Trimming is done with a loop,
// not with a pattern like /x+$/: without a start anchor such a pattern is tried again from every position, so a
// long run of `x` that doesn't reach the end costs quadratic time. No Electron imports, so tests can load this.

// `text` without the run of characters from `chars` at its end.
export function trimEnd(text, chars) {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1])) end--;
  return text.slice(0, end);
}

// Orders text by UTF-16 code units: what `sort()` does without a function, and the same on every device.
export function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
