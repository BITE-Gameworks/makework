// Block structure of markdown: fenced code, headings, rules, quotes, nested lists, tables, paragraphs.
// The line patterns run on text from other members, so none lets two neighbouring parts take the same characters
// (two `\s*` in a row, `.*?` before `\s*`): on a long crafted line that costs quadratic time or worse.
import { trimEnd } from "../core/text";

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { type: "code"; lang: string; code: string }
  | { type: "heading"; level: number; text: string }
  | { type: "hr" }
  | { type: "quote"; children: Block[] }
  | { type: "list"; ordered: boolean; start: number; items: Block[][] }
  | { type: "table"; head: string[]; align: Align[]; rows: string[][] }
  | { type: "paragraph"; lines: string[] };

// The language (group 2) is missing for a fence without one.
const fence = /^\s{0,3}(`{3,}|~{3,})\s*(?:([\w+#.-]+)\s*)?$/;
const headingStart = /^\s{0,3}(#{1,6})\s+/;
const rule = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const quote = /^\s{0,3}>\s?/;
// The item's text (group 3) is missing for an empty item.
const listItem = /^(\s*)([-*+]|\d{1,9}[.)])\s+(\S.*)?$/;
const tableSeparator = /^\s*(?:\|\s*)?:?-+:?\s*(?:\|\s*:?-+:?\s*)*(?:\|\s*)?$/;

const indentOf = (line: string) => line.length - line.trimStart().length;

// A heading line's level and text, without the closing #s ("## Title ##" is "Title"); null for any other line.
function headingOf(line: string): { level: number; text: string } | null {
  const start = headingStart.exec(line);
  if (!start) return null;
  const text = trimEnd(line.slice(start[0].length).trimEnd(), "#").trimEnd();
  // `.` stops at a line break character (a lone carriage return, say): such a line is no heading.
  return /^.*$/.test(text) ? { level: start[1].length, text } : null;
}

function startsBlock(line: string, next: string | undefined): boolean {
  return fence.test(line) || headingOf(line) !== null || rule.test(line) || quote.test(line) || listItem.test(line) ||
    (line.includes("|") && next !== undefined && tableSeparator.test(next));
}

export function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  const trimmed = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === "\\" && trimmed[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (trimmed[i] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else cell += trimmed[i];
  }
  cells.push(cell.trim());
  return cells;
}

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const open = fence.exec(line);
    if (open) {
      const close = new RegExp(`^\\s{0,3}\\${open[1][0]}{${open[1].length},}\\s*$`);
      const code: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({ type: "code", lang: open[2] ?? "", code: code.join("\n") });
      continue;
    }

    const h = headingOf(line);
    if (h) {
      blocks.push({ type: "heading", level: h.level, text: h.text });
      i++;
      continue;
    }

    if (rule.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    if (quote.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && lines[i].trim() && (quote.test(lines[i]) || !startsBlock(lines[i], lines[i + 1]))) {
        inner.push(lines[i].replace(quote, ""));
        i++;
      }
      blocks.push({ type: "quote", children: parseBlocks(inner.join("\n")) });
      continue;
    }

    const first = listItem.exec(line);
    if (first) {
      const indent = first[1].length;
      const ordered = /\d/.test(first[2]);
      const items: Block[][] = [];
      while (i < lines.length) {
        const item = listItem.exec(lines[i]);
        if (item?.[1].length !== indent ||/\d/.test(item[2]) !== ordered) break;
        const contentIndent = indent + item[2].length + 1;
        const content = [item[3] ?? ""];
        i++;
        while (i < lines.length) {
          const next = lines[i];
          if (!next.trim()) {
            if (i + 1 < lines.length && lines[i + 1].trim() && indentOf(lines[i + 1]) > indent) {
              content.push("");
              i++;
              continue;
            }
            break;
          }
          if (indentOf(next) > indent) content.push(next.slice(Math.min(indentOf(next), contentIndent)));
          else if (listItem.test(next) || startsBlock(next, lines[i + 1])) break;
          else content.push(next.trim());
          i++;
        }
        items.push(parseBlocks(content.join("\n")));
      }
      blocks.push({ type: "list", ordered, start: ordered ? Number.parseInt(first[2], 10) : 1, items });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && tableSeparator.test(lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c): Align =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ type: "table", head, align, rows });
      continue;
    }

    const paragraph = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) {
      paragraph.push(lines[i]);
      i++;
    }
    blocks.push({ type: "paragraph", lines: paragraph });
  }
  return blocks;
}
