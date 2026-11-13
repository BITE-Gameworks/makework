// Resolving a merge's conflicts line by line: a file's three versions (the last commit both branches share, the
// receiving branch's and the incoming branch's) split into regions that merge by themselves and conflicts the member
// decides, and the merged text made from their choices. Plain data, no git: electron/gitOps.js `mergeResolved` writes
// the result.
import type { DiffLine } from "./diff";

// Lines split on "\n" only, so joining them gives the text back exactly (a final newline is a last empty line, a
// "\r" stays on its line).
export const splitLines = (text: string): string[] => text.split("\n");
export const joinLines = (lines: readonly string[]): string => lines.join("\n");

// Above this many units of work (about a tenth of a second, it runs on the page) a file is too big to merge line by
// line here; it is then decided as a whole.
const workBudget = 15_000_000;

class TooBig extends Error {}

// The lines a and b have in common, as index pairs in order (a longest common subsequence: Myers' linear-space
// algorithm, with common starts and ends taken first).
function commonLines(a: readonly number[], b: readonly number[]): [number, number][] {
  const pairs: [number, number][] = [];
  const max = a.length + b.length + 1;
  const off = max + 1;
  const vf = new Int32Array(2 * max + 3);
  const vb = new Int32Array(2 * max + 3);
  let work = 0;

  // The middle snake of a[aLo..aHi) against b[bLo..bHi): [x, y, u, v], the diagonal run from (x, y) to (u, v) halfway
  // along a shortest edit path.
  const middle = (aLo: number, aHi: number, bLo: number, bHi: number): [number, number, number, number] => {
    const n = aHi - aLo;
    const m = bHi - bLo;
    const delta = n - m;
    const odd = (delta & 1) !== 0;
    const maxD = Math.ceil((n + m) / 2);
    vf[off + 1] = 0;
    vb[off + 1] = 0;
    for (let d = 0; d <= maxD; d++) {
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && vf[off + k - 1] < vf[off + k + 1]) ? vf[off + k + 1] : vf[off + k - 1] + 1;
        let y = x - k;
        const x0 = x;
        const y0 = y;
        while (x < n && y < m && a[aLo + x] === b[bLo + y]) (x++, y++);
        work += x - x0 + 1;
        vf[off + k] = x;
        if (odd && k >= delta - (d - 1) && k <= delta + (d - 1) && x + vb[off + delta - k] >= n)
          return [aLo + x0, bLo + y0, aLo + x, bLo + y];
      }
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && vb[off + k - 1] < vb[off + k + 1]) ? vb[off + k + 1] : vb[off + k - 1] + 1;
        let y = x - k;
        const x0 = x;
        const y0 = y;
        while (x < n && y < m && a[aHi - 1 - x] === b[bHi - 1 - y]) (x++, y++);
        work += x - x0 + 1;
        vb[off + k] = x;
        if (!odd && delta - k >= -d && delta - k <= d && x + vf[off + delta - k] >= n)
          return [aLo + n - x, bLo + m - y, aLo + n - x0, bLo + m - y0];
      }
      if (work > workBudget) throw new TooBig();
    }
    throw new Error("No middle snake.");
  };

  const walk = (aLo: number, aHi: number, bLo: number, bHi: number) => {
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) pairs.push([aLo++, bLo++]);
    let aEnd = aHi;
    let bEnd = bHi;
    while (aLo < aEnd && bLo < bEnd && a[aEnd - 1] === b[bEnd - 1]) (aEnd--, bEnd--);
    if (aLo < aEnd && bLo < bEnd) {
      const [x, y, u, v] = middle(aLo, aEnd, bLo, bEnd);
      walk(aLo, x, bLo, y);
      for (let i = x, j = y; i < u; i++, j++) pairs.push([i, j]);
      walk(u, aEnd, v, bEnd);
    }
    for (let i = aEnd, j = bEnd; i < aHi; i++, j++) pairs.push([i, j]);
  };
  walk(0, a.length, 0, b.length);
  return pairs;
}

// One run of changed lines: base[baseStart..baseEnd) became side[start..end).
interface Change {
  baseStart: number;
  baseEnd: number;
  start: number;
  end: number;
}

function changes(pairs: [number, number][], baseLength: number, sideLength: number): Change[] {
  const out: Change[] = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [baseLength, sideLength] as [number, number]]) {
    if (pi > i || pj > j) out.push({ baseStart: i, baseEnd: pi, start: j, end: pj });
    i = pi + 1;
    j = pj + 1;
  }
  return out;
}

// Lines as numbers, the same line the same number in all versions (comparing numbers is much faster).
function numbered(...versions: string[][]): number[][] {
  const ids = new Map<string, number>();
  return versions.map((lines) => lines.map((line) => {
    let id = ids.get(line);
    if (id === undefined) ids.set(line, (id = ids.size));
    return id;
  }));
}

// How `after` changed `before`, as numbered diff lines with three lines of context (DiffView's `DiffLines` shows
// them); null when the file is too big to compare.
export function toDiffLines(before: string, after: string): DiffLine[] | null {
  // A final newline isn't a line of its own here, as in git's diffs.
  const lines = (t: string) => (t === "" ? [] : splitLines(t.endsWith("\n") ? t.slice(0, -1) : t));
  const [a, b] = [lines(before), lines(after)];
  let found: Change[];
  try {
    found = changes(commonLines(...(numbered(a, b) as [number[], number[]])), a.length, b.length);
  } catch (e) {
    if (e instanceof TooBig) return null;
    throw e;
  }
  const context = 3;
  const out: DiffLine[] = [];
  for (let n = 0; n < found.length;) {
    // Changes closer than twice the context share a hunk.
    const start = n;
    while (n + 1 < found.length && found[n + 1].baseStart - found[n].baseEnd <= 2 * context) n++;
    const hunk = found.slice(start, ++n);
    const first = hunk[0];
    const last = hunk.at(-1)!;
    const from = Math.max(first.baseStart - context, 0);
    const to = Math.min(last.baseEnd + context, a.length);
    const newFrom = from + (first.start - first.baseStart);
    const newTo = to + (last.end - last.baseEnd);
    // Git numbers an empty side by the line before it.
    const range = (lo: number, hi: number) => `${hi > lo ? lo + 1 : lo},${hi - lo}`;
    out.push({ kind: "hunk", text: `@@ -${range(from, to)} +${range(newFrom, newTo)} @@` });
    let i = from;
    let j = newFrom;
    for (const change of hunk) {
      for (; i < change.baseStart; i++, j++) out.push({ kind: "context", text: a[i], oldNo: i + 1, newNo: j + 1 });
      for (; i < change.baseEnd; i++) out.push({ kind: "del", text: a[i], oldNo: i + 1 });
      for (; j < change.end; j++) out.push({ kind: "add", text: b[j], newNo: j + 1 });
    }
    for (; i < to; i++, j++) out.push({ kind: "context", text: a[i], oldNo: i + 1, newNo: j + 1 });
  }
  return out;
}

// A row of a conflict as it is shown: a line both sides have (`shared`), or a line of either side, side by side.
export interface Row {
  receiving: string | null;
  incoming: string | null;
  shared: boolean;
}

export type Region =
  // Unchanged on both sides.
  | { kind: "same"; lines: string[] }
  // Changed on one side only, or the same way on both: merged by itself.
  | { kind: "receiving" | "incoming" | "both"; base: string[]; lines: string[] }
  | { kind: "conflict"; base: string[]; receiving: string[]; incoming: string[]; rows: Row[] };

// The regions of a three-way merge; null when the file is too big to merge line by line.
export function diff3(base: string, receiving: string, incoming: string): Region[] | null {
  const [b, r, i] = [splitLines(base), splitLines(receiving), splitLines(incoming)];
  const [nb, nr, ni] = numbered(b, r, i);
  let byReceiving: Change[];
  let byIncoming: Change[];
  try {
    byReceiving = changes(commonLines(nb, nr), b.length, r.length);
    byIncoming = changes(commonLines(nb, ni), b.length, i.length);
  } catch (e) {
    if (e instanceof TooBig) return null;
    throw e;
  }
  const all = [...byReceiving.map((c) => ({ ...c, side: "receiving" as const })), ...byIncoming.map((c) => ({ ...c, side: "incoming" as const }))]
    .sort((x, y) => x.baseStart - y.baseStart || x.baseEnd - y.baseEnd);

  const regions: Region[] = [];
  let at = 0;
  // A side's lines over base[from..to), given its changes there (none: the base's own lines).
  const sideLines = (lines: string[], own: Change[], from: number, to: number) => {
    if (!own.length) return b.slice(from, to);
    const first = own[0];
    const last = own.at(-1)!;
    return lines.slice(first.start - (first.baseStart - from), last.end + (to - last.baseEnd));
  };
  for (let n = 0; n < all.length;) {
    // Changes that overlap or touch in the base form one group: two sides changing next to each other conflict.
    const group = [all[n++]];
    let end = group[0].baseEnd;
    const start = group[0].baseStart;
    while (n < all.length && all[n].baseStart <= end) {
      end = Math.max(end, all[n].baseEnd);
      group.push(all[n++]);
    }
    if (start > at) regions.push({ kind: "same", lines: b.slice(at, start) });
    at = end;
    const mine = group.filter((c) => c.side === "receiving");
    const theirs = group.filter((c) => c.side === "incoming");
    const base0 = b.slice(start, end);
    const rLines = sideLines(r, mine, start, end);
    const iLines = sideLines(i, theirs, start, end);
    if (!theirs.length) regions.push({ kind: "receiving", base: base0, lines: rLines });
    else if (!mine.length) regions.push({ kind: "incoming", base: base0, lines: iLines });
    else if (joinLines(rLines) === joinLines(iLines)) regions.push({ kind: "both", base: base0, lines: rLines });
    else regions.push({ kind: "conflict", base: base0, receiving: rLines, incoming: iLines, rows: alignRows(rLines, iLines) });
  }
  if (at < b.length) regions.push({ kind: "same", lines: b.slice(at) });
  return regions;
}

// A conflict's two sides as rows: lines both have once (`shared`), the different lines between them side by side.
export function alignRows(receiving: readonly string[], incoming: readonly string[]): Row[] {
  const [nr, ni] = numbered([...receiving], [...incoming]);
  let pairs: [number, number][];
  try {
    pairs = commonLines(nr, ni);
  } catch (e) {
    if (!(e instanceof TooBig)) throw e;
    pairs = [];
  }
  const rows: Row[] = [];
  let x = 0;
  let y = 0;
  for (const [pi, pj] of [...pairs, [receiving.length, incoming.length] as [number, number]]) {
    for (let k = 0; k < Math.max(pi - x, pj - y); k++)
      rows.push({ receiving: x + k < pi ? receiving[x + k] : null, incoming: y + k < pj ? incoming[y + k] : null, shared: false });
    if (pi < receiving.length) rows.push({ receiving: receiving[pi], incoming: incoming[pj], shared: true });
    x = pi + 1;
    y = pj + 1;
  }
  return rows;
}

// What the member chose for one conflict: lines ticked ("<row>:r", "<row>:i"; a shared row is kept by either), or
// the result written by hand. A conflict without a choice is undecided.
export type ConflictChoice = { picks: string[] } | { text: string };

// The conflicts' resulting lines, then the whole file; null while a conflict is undecided.
export function resolvedText(regions: readonly Region[], choices: readonly (ConflictChoice | undefined)[]): string | null {
  const out: string[] = [];
  let conflict = 0;
  for (const region of regions) {
    if (region.kind !== "conflict") {
      out.push(...region.lines);
      continue;
    }
    const choice = choices[conflict++];
    if (!choice) return null;
    out.push(...pickedLines(region.rows, choice));
  }
  return joinLines(out);
}

export type Side = "receiving" | "incoming";
export const pickKey = (row: number, side: Side) => `${row}:${side === "receiving" ? "r" : "i"}`;
const key = pickKey;

// For one line; a view showing many lines checks a Set of the picks instead (a conflict can have thousands).
export const isPicked = (choice: ConflictChoice, row: number, side: Side) => "picks" in choice && choice.picks.includes(key(row, side));

// Where an undecided conflict starts: the lines both sides share ticked, the changed ones not.
export const startPicks = (rows: readonly Row[]): string[] => rows.flatMap((row, n) => (row.shared ? [key(n, "receiving"), key(n, "incoming")] : []));

// One side's lines, both sides' (the receiving block first), or only the lines both share.
export function preset(rows: readonly Row[], which: Side | "both" | "neither"): ConflictChoice {
  const picks = startPicks(rows);
  rows.forEach((row, n) => {
    if (row.shared) return;
    if (row.receiving !== null && (which === "receiving" || which === "both")) picks.push(key(n, "receiving"));
    if (row.incoming !== null && (which === "incoming" || which === "both")) picks.push(key(n, "incoming"));
  });
  return { picks };
}

// Ticks or unticks one line; a shared line is one line on both sides. A hand-written result starts over from the ticks.
export function togglePick(rows: readonly Row[], choice: ConflictChoice | undefined, row: number, side: Side): ConflictChoice {
  const picks = new Set(choice && "picks" in choice ? choice.picks : startPicks(rows));
  const keys = rows[row].shared ? [key(row, "receiving"), key(row, "incoming")] : [key(row, side)];
  const on = !picks.has(key(row, side));
  for (const k of keys) {
    if (on) picks.add(k);
    else picks.delete(k);
  }
  return { picks: [...picks] };
}

// A text box shows and gives lines without "\r" (browsers turn every line break into "\n"). A result written by hand
// gets the conflict's own line ending back: "\r" on each line when most of its lines have one.
export const editorText = (lines: readonly string[]) => lines.map((l) => l.replace(/\r$/, "")).join("\n");

export function writtenChoice(rows: readonly Row[], value: string): ConflictChoice {
  const lines = rows.flatMap((r) => [r.receiving, r.incoming]).filter((l): l is string => !!l);
  const crlf = lines.filter((l) => l.endsWith("\r")).length * 2 > lines.length;
  return { text: crlf && value !== "" ? value.split("\n").map((l) => `${l}\r`).join("\n") : value };
}

export function pickedLines(rows: readonly Row[], choice: ConflictChoice): string[] {
  // An empty result written by hand is no lines at all.
  if ("text" in choice) return choice.text === "" ? [] : splitLines(choice.text);
  const picked = new Set(choice.picks);
  const out: string[] = [];
  let mine: string[] = [];
  let theirs: string[] = [];
  // Between two shared lines the receiving branch's ticked lines come first, then the incoming ones.
  const flush = () => {
    out.push(...mine, ...theirs);
    mine = [];
    theirs = [];
  };
  rows.forEach((row, n) => {
    if (row.shared) {
      flush();
      if (picked.has(`${n}:r`) || picked.has(`${n}:i`)) out.push(row.receiving!);
      return;
    }
    if (row.receiving !== null && picked.has(`${n}:r`)) mine.push(row.receiving);
    if (row.incoming !== null && picked.has(`${n}:i`)) theirs.push(row.incoming);
  });
  flush();
  return out;
}
