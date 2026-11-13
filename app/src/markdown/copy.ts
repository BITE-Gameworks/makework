// Copying from rendered messages keeps what the editor needs to paste it back: a link chip copies as [title](address) and a
// mention as <@id>, instead of the bare words shown. Other selections copy as usual.
const blocks = new Set(["P", "DIV", "LI", "UL", "OL", "BLOCKQUOTE", "PRE", "H1", "H2", "H3", "H4", "H5", "H6", "TR"]);

function text(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof HTMLElement)) return Array.from(node.childNodes, text).join("");
  if (node.classList.contains("mw-link-chip")) {
    const href = node.getAttribute("href") ?? node.dataset.href ?? "";
    const label = node.querySelector(".mw-link-chip-title")?.textContent ?? node.textContent ?? "";
    return href ? `[${label.replace(/[[\]]/g, "")}](${href})` : label;
  }
  if (node.classList.contains("md-mention")) return node.getAttribute("title") || node.textContent || "";
  if (node.tagName === "A" && /^https?:/i.test(node.getAttribute("href") ?? "")) {
    const href = node.getAttribute("href")!;
    const label = node.textContent ?? "";
    return !label || label === href ? href : `[${label.replace(/[[\]]/g, "")}](${href})`;
  }
  if (node.tagName === "BR") return "\n";
  const inner = Array.from(node.childNodes, text).join("");
  return blocks.has(node.tagName) ? `${inner}\n` : inner;
}

// The selection as markdown, or null when it holds nothing but plain text (the browser copies that itself).
export function selectionMarkdown(range: Range): string | null {
  const fragment = range.cloneContents();
  const holder = document.createElement("div");
  holder.append(fragment);
  if (!holder.querySelector(".mw-link-chip, .md-mention, a[href]")) return null;
  return text(holder).replace(/\n{3,}/g, "\n\n").trimEnd();
}

export function watchCopy(): void {
  document.addEventListener("copy", (event) => {
    const selection = getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !event.clipboardData) return;
    const range = selection.getRangeAt(0);
    const start = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    // Only text shown by Markdown; the editor copies by itself.
    if (!start?.closest(".md") && !start?.querySelector(".md")) return;
    if (start.closest(".mw-editor")) return;
    const markdown = selectionMarkdown(range);
    if (markdown === null) return;
    event.clipboardData.setData("text/plain", markdown);
    event.preventDefault();
  });
}
