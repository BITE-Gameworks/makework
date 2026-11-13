// Converts between markdown and the rich editor's DOM. The editor holds one block element per line
// (div), lists, quotes and code blocks; chips stand for makework:// links and for member mentions (`<@id>`, made
// with the url "mention:<id>"). Built with createElement and
// text nodes only, never innerHTML, so text can't inject markup.
import { parseBlocks, type Block } from "../markdown/parse";
import { appLink, isLink, parseLink } from "../core/links";
import { trimStart } from "../core/text";

export type MakeChip = (url: string, label: string, embed?: boolean) => HTMLElement;

const inlinePattern = new RegExp([
  String.raw`(\x60[^\x60\n]+\x60)`,
  String.raw`(<@\d+>)`,
  String.raw`(!?\[[^\]\n]*\]\((?:https?:\/\/|mailto:|makework:\/\/)[^\s)]+\))`,
  String.raw`(\*\*[^*\n]+\*\*|__[^_\n]+__)`,
  String.raw`(~~[^~\n]+~~)`,
  String.raw`(\*[^*\n]+\*|(?<![\w:])_[^_\n]+_(?![\w:]))`,
  String.raw`(makework:\/\/[^\s<>()]+[^\s<>().,;:!?'"])`,
].join("|"), "g");

function el(tag: string, children: Node[] = []): HTMLElement {
  const node = document.createElement(tag);
  node.append(...children);
  return node;
}

export function inlineNodes(text: string, chip: MakeChip): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const match of text.matchAll(inlinePattern)) {
    if (match.index > last) out.push(document.createTextNode(text.slice(last, match.index)));
    const [whole, code, mention, link, bold, strike, italic, bare] = match;
    if (code) out.push(el("code", [document.createTextNode(code.slice(1, -1))]));
    else if (mention) out.push(chip(`mention:${mention.slice(2, -1)}`, ""));
    else if (link) {
      const [, image, label, href] = /^(!?)\[([^\]]*)\]\(([^)\s]+)\)$/.exec(link)!;
      if (isLink(href)) out.push(chip(appLink(href), label, image === "!" && parseLink(href)?.target?.kind === "export"));
      else {
        const a = el("a", inlineNodes(label || href, chip));
        a.setAttribute("href", href);
        out.push(a);
      }
    } else if (bold) out.push(el("b", inlineNodes(bold.slice(2, -2), chip)));
    else if (strike) out.push(el("s", inlineNodes(strike.slice(2, -2), chip)));
    else if (italic) out.push(el("i", inlineNodes(italic.slice(1, -1), chip)));
    else if (bare) out.push(chip(bare, ""));
    last = match.index + whole.length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

function line(text: string, chip: MakeChip): HTMLElement {
  const nodes = inlineNodes(text, chip);
  return el("div", nodes.length ? nodes : [el("br")]);
}

function blockNodes(block: Block, chip: MakeChip): HTMLElement[] {
  switch (block.type) {
    case "paragraph":
      return block.lines.map((l) => line(l, chip));
    case "heading":
      return [line(`${"#".repeat(block.level)} ${block.text}`, chip)];
    case "hr":
      return [line("---", chip)];
    case "code":
      return [el("pre", [document.createTextNode(block.code)])];
    case "quote":
      return [el("blockquote", blocksToNodes(block.children, chip))];
    case "list": {
      const list = el(block.ordered ? "ol" : "ul");
      for (const item of block.items) {
        const li = el("li");
        item.forEach((child, i) => {
          if (child.type === "paragraph") {
            if (i > 0) li.append(el("br"));
            li.append(...inlineNodes(child.lines.join(" "), chip));
          } else li.append(...blockNodes(child, chip));
        });
        if (!li.firstChild) li.append(el("br"));
        list.append(li);
      }
      return [list];
    }
    case "table": {
      const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
      return [row(block.head), row(block.head.map(() => "---")), ...block.rows.map(row)].map((l) => line(l, chip));
    }
  }
}

function blocksToNodes(blocks: Block[], chip: MakeChip): HTMLElement[] {
  // A blank line between blocks becomes an empty line, so it survives the trip back.
  return blocks.flatMap((b, i) => [...(i > 0 ? [el("div", [el("br")])] : []), ...blockNodes(b, chip)]);
}

export function markdownToNodes(markdown: string, chip: MakeChip): HTMLElement[] {
  return blocksToNodes(parseBlocks(markdown), chip);
}

const blockTags = new Set(["DIV", "P", "UL", "OL", "BLOCKQUOTE", "PRE", "H1", "H2", "H3", "H4", "H5", "H6", "LI"]);
const isBlock = (node: Node) => node instanceof HTMLElement && blockTags.has(node.tagName);

// Moves spaces outside the markers: "** bold **" is not bold in markdown.
function wrap(text: string, marker: string): string {
  const start = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  return start < end ? `${text.slice(0, start)}${marker}${text.slice(start, end)}${marker}${text.slice(end)}` : text;
}

export function inlineMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replaceAll(" ", " ");
  if (!(node instanceof HTMLElement)) return "";
  if (node.dataset.mention) return `<@${node.dataset.mention}>`;
  if (node.dataset.href) return `${node.dataset.embed ? "!" : ""}[${(node.textContent ?? "").trim().replace(/[[\]]/g, "")}](${node.dataset.href})`;
  const inner = () => [...node.childNodes].map((child, i, all) =>
    // A trailing <br> only keeps an empty line open.
    child.nodeName === "BR" && i === all.length - 1 ? "" : child.nodeName === "BR" ? "\n" : inlineMarkdown(child)).join("");
  switch (node.tagName) {
    case "B": case "STRONG": return wrap(inner(), "**");
    case "I": case "EM": return wrap(inner(), "*");
    case "S": case "STRIKE": case "DEL": return wrap(inner(), "~~");
    case "CODE": return node.textContent ? `\`${node.textContent}\`` : "";
    case "A": {
      const href = node.getAttribute("href") ?? "";
      return /^(https?:|mailto:)/.test(href) ? `[${inner()}](${href})` : inner();
    }
    default: return inner();
  }
}

function preText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node.nodeName === "BR") return "\n";
  const text = [...node.childNodes].map(preText).join("");
  return node !== null && isBlock(node) && node.nodeName !== "PRE" ? `${text}\n` : text;
}

function listLines(list: HTMLElement, depth: number): string[] {
  const ordered = list.tagName === "OL";
  const lines: string[] = [];
  let n = 1;
  for (const item of list.children) {
    if (item.tagName === "UL" || item.tagName === "OL") {
      lines.push(...listLines(item as HTMLElement, depth + 1));
      continue;
    }
    const nested = [...item.childNodes].filter((c) => c.nodeName === "UL" || c.nodeName === "OL");
    const text = [...item.childNodes].filter((c) => !nested.includes(c)).map(inlineMarkdown).join("").trim();
    lines.push(`${"  ".repeat(depth)}${ordered ? `${n++}.` : "-"} ${text.replaceAll("\n", " ")}`);
    for (const sub of nested) lines.push(...listLines(sub as HTMLElement, depth + 1));
  }
  return lines;
}

function blockLines(container: Node): string[] {
  const lines: string[] = [];
  let pending: string | null = null;
  const flush = () => {
    if (pending !== null) lines.push(...pending.split("\n"));
    pending = null;
  };
  for (const child of container.childNodes) {
    if (child.nodeName === "BR") {
      lines.push(pending ?? "");
      pending = null;
    } else if (!isBlock(child)) {
      pending = (pending ?? "") + inlineMarkdown(child);
    } else {
      flush();
      const tag = (child as HTMLElement).tagName;
      if (tag === "UL" || tag === "OL") lines.push(...listLines(child as HTMLElement, 0));
      else if (tag === "BLOCKQUOTE") lines.push(...blockLines(child).map((l) => (l ? `> ${l}` : ">")));
      else if (tag === "PRE") lines.push("```", ...preText(child).replace(/\n$/, "").split("\n"), "```");
      else if ([...child.childNodes].some(isBlock)) lines.push(...blockLines(child));
      else lines.push(...inlineMarkdown(child).split("\n"));
    }
  }
  flush();
  return lines;
}

export function nodesToMarkdown(root: Node): string {
  return trimStart(blockLines(root).join("\n"), "\n").trimEnd();
}
