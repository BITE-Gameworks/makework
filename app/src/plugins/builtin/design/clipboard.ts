// Copying layers as text, so they paste between documents, servers and windows.
import type { NewNode } from "./data";
import type { Editor } from "./editor";
import { boxAt, identity, localTransform, type Props } from "./model";

const marker = "makework-design:";

// The layers with everything inside them. Top layers carry their page position, the rest stay inside their parent.
export function serialize(editor: Editor, ids: number[]): NewNode[] {
  const nodes: NewNode[] = [];
  // Copies taken without their instance stop following a main.
  const add = (id: number, parentRef?: string, inInstance = false) => {
    const n = editor.node(id)!;
    const box = parentRef === undefined ? boxAt(editor.world(id), identity, n.width, n.height) : n;
    const props = JSON.parse(JSON.stringify(n.props)) as Props;
    if (!inInstance) Object.assign(props, { master: null, overrides: props.instanceOf === null ? [] : props.overrides });
    nodes.push({
      ref: String(id), parent_ref: parentRef, kind: n.kind, name: n.name, z: n.z,
      x: box.x, y: box.y, width: n.width, height: n.height, rotation: box.rotation,
      props, url: n.url, thumb: n.thumb,
    });
    for (const child of editor.children(id)) add(child, String(id), inInstance || props.instanceOf !== null);
  };
  ids.forEach((id) => add(id));
  return nodes;
}

export const toClipboardText = (nodes: NewNode[]) => marker + JSON.stringify(nodes);

export function fromClipboardText(text: string): NewNode[] | null {
  if (!text.startsWith(marker)) return null;
  try {
    const nodes = JSON.parse(text.slice(marker.length)) as unknown;
    return Array.isArray(nodes) ? nodes as NewNode[] : null;
  } catch {
    return null;
  }
}

const inPlace: Readonly<{ x: number; y: number }> = { x: 0, y: 0 };

// Puts copied layers inside `parent`, at their page position moved by `offset`, on top of what is there.
export function placeCopies(editor: Editor, nodes: NewNode[], parent: number | null, offset = inPlace): NewNode[] {
  const target = editor.world(parent);
  let top = Math.max(0, ...editor.children(parent).map((c) => editor.node(c)!.z));
  return nodes.map((n) => {
    if (n.parent_ref !== undefined) return { ...n, parent_id: undefined };
    const page = localTransform({ x: n.x + offset.x, y: n.y + offset.y, width: n.width, height: n.height, rotation: n.rotation ?? 0 });
    return { ...n, ...boxAt(page, target, n.width, n.height), parent_id: parent, z: ++top };
  });
}
