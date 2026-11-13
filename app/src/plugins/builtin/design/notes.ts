// Sticky notes: a group of a colored paper and a text that wraps on it. Made from the design view and by agents.
import type { NewNode } from "./data";
import { defaultProps, solid, type Box, type DesignNode, type Props } from "./model";
import { measureText } from "./render";

export const noteColors = ["#ffe58f", "#ffb8a1", "#b7eb8f", "#91d5ff", "#d3adf7", "#ffadd2", "#d9d9d9"];
export const noteSize = { width: 200, height: 160 };
const pad = 12;

// Measured where there is a page; elsewhere (tests) a line per 30 characters.
const textHeight = (props: Props, width: number) => typeof document === "undefined"
  ? Math.ceil(Math.max(1, props.text.length) / 30) * Math.round(props.textStyle.size * 1.3)
  : measureText(props, width).height;

// The note's three layers; `box` places the group in its parent, the paper and text sit inside it.
export function noteNodes(name: string, parentId: number | null, box: Box, text = "", color = noteColors[0]): NewNode[] {
  const props: Props = { ...defaultProps("text"), fills: [solid("#262626")], sizing: "height", text };
  const width = box.width - pad * 2;
  return [
    { ref: "note", kind: "group", name, parent_id: parentId, ...box, props: defaultProps("group") },
    { parent_ref: "note", kind: "rect", name: "Paper", x: 0, y: 0, width: box.width, height: box.height, props: { ...defaultProps("rect"), fills: [solid(color)], radius: 2 } },
    { parent_ref: "note", kind: "text", name: "Text", x: pad, y: pad, width, height: textHeight(props, width), props },
  ];
}

// A note's text: kept even when emptied, so the note can be written on again.
export function isNoteText(n: DesignNode, siblings: DesignNode[], parent: DesignNode | undefined): boolean {
  return n.kind === "text" && parent?.kind === "group" && siblings.length === 2
    && siblings.some((s) => s.kind === "rect" && s.name === "Paper");
}
