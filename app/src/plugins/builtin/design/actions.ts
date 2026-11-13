// Changes to the selection used by the panels, menus and shortcuts.
import { removeNodes, restoreNodes, updateNodes } from "./data";
import { layers, type Editor } from "./editor";
import { fromClipboardText, placeCopies, serialize, toClipboardText } from "./clipboard";
import { copyProps, pickVariant, variantName, variantValues } from "./components";
import {
  apply, boundsOf, boxAt, cornersOf, defaultProps, rotate, union,
  type Change, type DesignNode, type Props, type Point, type Rect, type Rigid,
} from "./model";
import { mirrorVector } from "./vector";
import { measureText } from "./render";
import { alignShift, distributeShifts, type Align } from "../canvas/geometry";
import { arrange, normalize, type Arrangement, type Normalization } from "../canvas/arrange";
import { isNoteText, noteColors, noteNodes, noteSize } from "./notes";

export type { Align } from "../canvas/geometry";

// Lines layers up with the selection's box, or a single layer with its frame.
export function align(ed: Editor, how: Align) {
  const ids = ed.topSelected();
  if (ids.length === 0) return;
  const lone = ids.length === 1 ? ed.node(ids[0])! : null;
  if (lone?.parentId === null) return;
  const target: Rect = lone
    ? boundsOf(cornersOf(ed.world(lone.parentId), ed.node(lone.parentId)!.width, ed.node(lone.parentId)!.height))
    : ed.selectionBounds()!;
  const changes = new Map<number, Change>();
  for (const id of ids) {
    const shift = alignShift(ed.worldBounds(id), target, how);
    if (Math.abs(shift.x) > 1e-6 || Math.abs(shift.y) > 1e-6) changes.set(id, moveBy(ed, id, shift));
  }
  if (changes.size) ed.update(changes, `Align ${layers(changes.size)}`, `align-${how}`);
}

// Equal gaps between three or more layers, keeping the outer two in place.
export function distribute(ed: Editor, axis: "x" | "y") {
  const ids = ed.topSelected();
  if (ids.length < 3) return;
  const shifts = distributeShifts(ids.map((id) => ({ id, rect: ed.worldBounds(id) })), axis);
  const changes = new Map<number, Change>();
  for (const [id, d] of shifts) changes.set(id, moveBy(ed, id, axis === "x" ? { x: d, y: 0 } : { x: 0, y: d }));
  if (changes.size) ed.update(changes, `Distribute ${layers(ids.length)}`, axis === "x" ? "distribute-h" : "distribute-v");
}

// A layer's own drawing mirrored in its box: path points and corner sizes. Null when nothing changes.
export function mirroredProps(props: Props, axis: "x" | "y"): Props | null {
  const r = props.radii;
  if (!props.vector && !r) return null;
  return {
    ...props,
    vector: props.vector ? mirrorVector(props.vector, axis) : null,
    radii: r && (axis === "x" ? [r[1], r[0], r[3], r[2]] : [r[3], r[2], r[1], r[0]]),
  };
}

// Mirrors the selection across its middle, sideways or upside down. Turns are reversed, and paths, corners and
// what is inside frames and groups are mirrored too. Text and pictures keep reading the right way.
export function flip(ed: Editor, axis: "x" | "y") {
  const ids = ed.topSelected();
  const b = ed.selectionBounds();
  if (ids.length === 0 || !b) return;
  const mirror = (p: Point): Point => (axis === "x" ? { x: b.left + b.right - p.x, y: p.y } : { x: p.x, y: b.top + b.bottom - p.y });
  const worlds = new Map<number, Rigid>();
  const changes = new Map<number, Change>();
  const visit = (id: number) => {
    const n = ed.node(id)!;
    // The mirrored layer's top left is where its far corner lands.
    const world = { origin: mirror(apply(ed.world(id), axis === "x" ? { x: n.width, y: 0 } : { x: 0, y: n.height })), angle: -ed.world(id).angle };
    worlds.set(id, world);
    const parent = (n.parentId !== null && worlds.get(n.parentId)) || ed.world(n.parentId);
    const props = mirroredProps(n.props, axis);
    changes.set(id, { ...boxAt(world, parent, n.width, n.height), ...(props ? { props } : {}) });
    ed.children(id).forEach(visit);
  };
  ids.forEach(visit);
  ed.update(changes, `Flip ${layers(ids.length)}`, axis === "x" ? "flip-h" : "flip-v");
}

// Turns the selection about its middle by a number of degrees.
export function rotateBy(ed: Editor, degrees: number) {
  const ids = ed.topSelected();
  const b = ed.selectionBounds();
  if (ids.length === 0 || !b) return;
  const c = { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
  const changes = new Map<number, Change>(ids.map((id) => {
    const n = ed.node(id)!;
    const t = ed.world(id);
    const o = rotate({ x: t.origin.x - c.x, y: t.origin.y - c.y }, degrees);
    return [id, boxAt({ origin: { x: c.x + o.x, y: c.y + o.y }, angle: t.angle + degrees }, ed.world(n.parentId), n.width, n.height)];
  }));
  ed.update(changes, `Rotate ${layers(ids.length)}`, "rotate");
}

const arrangeBox = (ed: Editor, id: number) => {
  const r = ed.worldBounds(id);
  return { id, left: r.left, top: r.top, width: r.right - r.left, height: r.bottom - r.top };
};

export function arrangeSelection(ed: Editor, how: Arrangement) {
  const ids = ed.topSelected();
  if (ids.length < 2) return;
  const boxes = ids.map((id) => arrangeBox(ed, id));
  const places = arrange(boxes, how);
  const changes = new Map<number, Change>();
  for (const b of boxes) {
    const to = places.get(b.id)!;
    changes.set(b.id, moveBy(ed, b.id, { x: to.left - b.left, y: to.top - b.top }));
  }
  ed.update(changes, `Arrange ${layers(ids.length)}`, how === "horizontal" ? "arrange-row" : how === "vertical" ? "arrange-column" : "layout-grid");
}

// Only layers that scale as a whole: text keeps its font size, groups and frames their contents.
const scalable = new Set(["image", "svg", "rect", "ellipse", "path"]);
export const normalizable = (ed: Editor) => ed.topSelected().filter((id) => scalable.has(ed.node(id)!.kind));

// Same height, width or area for the selected images and shapes; each keeps its middle.
export function normalizeSelection(ed: Editor, what: Normalization) {
  const ids = normalizable(ed);
  if (ids.length < 2) return;
  const scales = normalize(ids.map((id) => arrangeBox(ed, id)), what);
  const changes = new Map<number, Change>(ids.map((id) => {
    const n = ed.node(id)!;
    const t = ed.world(id);
    const f = scales.get(id)!;
    const c = apply(t, { x: n.width / 2, y: n.height / 2 });
    const half = rotate({ x: (n.width * f) / 2, y: (n.height * f) / 2 }, t.angle);
    return [id, boxAt({ origin: { x: c.x - half.x, y: c.y - half.y }, angle: t.angle }, ed.world(n.parentId), n.width * f, n.height * f)];
  }));
  ed.update(changes, `Same ${what} for ${layers(ids.length)}`, `normalize-${what}`);
}

// A sticky note where asked, inside the frame there; starts with its text being typed.
export async function addNote(ed: Editor, at: Point, color = noteColors[0]) {
  const parent = ed.frameAt(at);
  const box = boxAt({ origin: { x: at.x - noteSize.width / 2, y: at.y - noteSize.height / 2 }, angle: 0 }, ed.world(parent),
    noteSize.width, noteSize.height);
  const count = ed.live.value.filter((n) => n.kind === "group" && n.name.startsWith("Note")).length + 1;
  await ed.run(async () => {
    const ids = await ed.add(noteNodes(`Note ${count}`, parent, box, "", color), "Add note");
    if (ids.length < 3) return;
    ed.select([ids[0]]);
    ed.setEditing(ids[2]);
  });
}

// A move by a page distance, as a change of the layer's position in its parent.
export function moveBy(ed: Editor, id: number, d: Point): Change {
  const n = ed.node(id)!;
  const l = rotate(d, -ed.world(n.parentId).angle);
  return { x: n.x + l.x, y: n.y + l.y };
}

export function nudge(ed: Editor, d: Point) {
  const ids = ed.topSelected();
  if (ids.length) ed.update(new Map(ids.map((id) => [id, moveBy(ed, id, d)])), `Move ${layers(ids.length)}`, "forward");
}

// Text keeps the size of its content (natural width, or wrapped at its width), unless its box is fixed.
export function textSize(props: Props, width: number, height: number): { width: number; height: number } {
  if (props.sizing === "fixed") return { width, height };
  return props.sizing === "width" ? measureText(props) : measureText(props, width);
}

// Changes props of every selected layer; text layers are measured again.
export function propsChanges(ed: Editor, change: (n: DesignNode) => Partial<Props> | null, ids = ed.topSelected()): Map<number, Change> {
  const changes = new Map<number, Change>();
  for (const id of ids) {
    const n = ed.node(id)!;
    const part = change(n);
    if (!part) continue;
    const props = { ...n.props, ...part };
    changes.set(id, n.kind === "text" ? { props, ...textSize(props, n.width, n.height) } : { props });
  }
  return changes;
}

export const setProps = (ed: Editor, label: string, change: (n: DesignNode) => Partial<Props> | null, icon?: string) =>
  ed.update(propsChanges(ed, change), label, icon);

export function toggleVisible(ed: Editor, ids = ed.topSelected()) {
  const show = ids.some((id) => !ed.node(id)!.props.visible);
  ed.update(propsChanges(ed, () => ({ visible: show }), ids), show ? "Show" : "Hide", show ? "visible" : "hidden");
}

export function toggleLocked(ed: Editor, ids = ed.topSelected()) {
  const lock = ids.some((id) => !ed.node(id)!.props.locked);
  ed.update(propsChanges(ed, () => ({ locked: lock }), ids), lock ? "Lock" : "Unlock", lock ? "lock" : "unlock");
  if (lock) ed.select(ed.selected().filter((id) => !ids.includes(id)));
}

// Adds copies on top. Page-level frames go to the right of all others, everything else lands in place.
export async function duplicate(ed: Editor) {
  const ids = ed.topSelected();
  if (ids.length === 0) return;
  const nodes = serialize(ed, ids);
  const allFrames = ids.every((id) => ed.node(id)!.parentId === null && ed.node(id)!.kind === "frame");
  const right = union(ed.children(null).map(ed.worldBounds))?.right ?? 0;
  const left = ed.selectionBounds()!.left;
  const offset = allFrames ? { x: right + 100 - left, y: 0 } : { x: 0, y: 0 };
  const parent = ed.node(ids[0])!.parentId;
  const sameParent = ids.every((id) => ed.node(id)!.parentId === parent);
  await pasteNodes(ed, nodes, sameParent ? parent : null, offset, `Duplicate ${layers(ids.length)}`);
}

export const copyText = (ed: Editor) => toClipboardText(serialize(ed, ed.topSelected()));

// Pastes copied layers into the selected frame, else where their originals are when that place still exists.
export async function paste(ed: Editor, text: string): Promise<boolean> {
  const nodes = fromClipboardText(text);
  if (!nodes) return false;
  const sel = ed.topSelected();
  const frame = sel.length === 1 && ed.node(sel[0])!.kind === "frame" && !nodes.some((n) => n.ref === String(sel[0])) ? sel[0] : null;
  const original = ed.node(Number(nodes.find((n) => n.parent_ref === undefined)?.ref))?.parentId ?? null;
  await pasteNodes(ed, nodes, frame ?? original, { x: 0, y: 0 }, `Paste ${layers(nodes.filter((n) => n.parent_ref === undefined).length)}`);
  return true;
}

async function pasteNodes(ed: Editor, nodes: ReturnType<typeof serialize>, parent: number | null, offset: Point, label: string) {
  const placed = placeCopies(ed, nodes, parent, offset);
  await ed.run(async () => {
    const ids = await ed.add(placed, label);
    ed.select(ids.filter((_, i) => placed[i].parent_ref === undefined));
  });
}

// Wraps the selected layers in a new frame or group around them, in their common parent, keeping their order.
// `rename` gives the wrapped layers new names (variants), recorded with the wrap.
export async function wrapSelection(ed: Editor, kind: "frame" | "group", extra: Partial<Props> = {}, wrapLabel?: string,
  rename?: (n: DesignNode) => string) {
  const ids = ed.topSelected().slice().sort((a, b) => ed.node(a)!.z - ed.node(b)!.z);
  if (ids.length === 0) return;
  const parent = ed.node(ids[0])!.parentId;
  if (!ids.every((id) => ed.node(id)!.parentId === parent)) return ed.setError("Pick layers inside the same frame or group.");
  const b = ed.selectionBounds()!;
  const box = boxAt({ origin: { x: b.left, y: b.top }, angle: 0 }, ed.world(parent), b.right - b.left, b.bottom - b.top);
  const z = Math.max(...ids.map((id) => ed.node(id)!.z));
  const props = { ...(kind === "frame" ? { ...defaultProps("frame"), fills: [] } : defaultProps("group")), ...extra };
  const label = wrapLabel ?? (kind === "frame" ? "Frame" : "Group");
  const name = `${label} ${ed.live.value.filter((n) => n.kind === kind && !!n.props.main === !!extra.main && !!n.props.variantSet === !!extra.variantSet).length + 1}`;
  await ed.run(async () => {
    const [wrapper] = await ed.add([{ kind, name, parent_id: parent, ...box, z, props }], "", false);
    const old = new Map(ids.map((id) => {
      const n = ed.node(id)!;
      return [id, { x: n.x, y: n.y, rotation: n.rotation, parentId: n.parentId, z: n.z, ...(rename ? { name: n.name } : {}) } as Change];
    }));
    const wrapperWorld = { origin: { x: b.left, y: b.top }, angle: 0 };
    const changes = new Map(ids.map((id, i) => {
      const n = ed.node(id)!;
      return [id, { ...boxAt(ed.world(id), wrapperWorld, n.width, n.height), parentId: wrapper, z: i + 1, ...(rename ? { name: rename(n) } : {}) } as Change];
    }));
    await updateNodes(ed.api, changes);
    ed.select([wrapper]);
    ed.history.push({
      label: `${label} ${layers(ids.length)}`, icon: extra.main || extra.variantSet ? "design-component" : `design-${kind}`,
      undo: async () => { await updateNodes(ed.api, old); await removeNodes(ed.api, [wrapper]); },
      redo: async () => { await restoreNodes(ed.api, [wrapper]); await updateNodes(ed.api, changes); },
    });
  });
}

export const frameSelection = (ed: Editor) => wrapSelection(ed, "frame");
export const groupSelection = (ed: Editor) => wrapSelection(ed, "group");

// Takes the layers out of the selected groups, where the groups were, and removes the groups.
export async function ungroup(ed: Editor) {
  const groups = ed.topSelected().filter((id) => ed.node(id)!.kind === "group");
  if (groups.length === 0) return;
  const changes = new Map<number, Change>();
  const freed: number[] = [];
  for (const g of groups) {
    const group = ed.node(g)!;
    const siblings = ed.children(group.parentId);
    const above = siblings[siblings.indexOf(g) + 1];
    const top = above !== undefined ? ed.node(above)!.z : group.z + 1;
    const kids = ed.children(g);
    const target = ed.world(group.parentId);
    kids.forEach((id, i) => {
      const n = ed.node(id)!;
      changes.set(id, { ...boxAt(ed.world(id), target, n.width, n.height), parentId: group.parentId, z: group.z + ((top - group.z) * (i + 1)) / (kids.length + 1) });
      freed.push(id);
    });
  }
  const old = new Map([...changes.keys()].map((id) => {
    const n = ed.node(id)!;
    return [id, { x: n.x, y: n.y, rotation: n.rotation, parentId: n.parentId, z: n.z } as Change];
  }));
  await ed.run(async () => {
    await updateNodes(ed.api, changes);
    await removeNodes(ed.api, groups);
    ed.select(freed);
    ed.history.push({
      label: `Ungroup ${layers(groups.length)}`, icon: "design-ungroup",
      undo: async () => { await restoreNodes(ed.api, groups); await updateNodes(ed.api, old); },
      redo: async () => { await updateNodes(ed.api, changes); await removeNodes(ed.api, groups); },
    });
  });
}

// Finishes typing in a text layer: saves the text and its size; empty text deletes the layer.
export function finishText(ed: Editor, id: number, text: string, isNew: boolean) {
  const n = ed.node(id);
  if (!n) return;
  const note = isNoteText(n, ed.children(n.parentId).map((c) => ed.node(c)!), ed.node(n.parentId) ?? undefined);
  if (text.trim() === "" && !note) {
    if (isNew) void ed.run(() => removeNodes(ed.api, [id]));
    else ed.remove([id]);
    return;
  }
  const props = { ...n.props, text };
  const change: Change = { props, ...textSize(props, n.width, n.height) };
  if (!isNew) {
    if (text !== n.props.text) ed.update(new Map([[id, change]]), "Edit text", "design-text");
    return;
  }
  void ed.run(() => ed.save(new Map([[id, change]])));
  ed.history.push({ label: "Add text", icon: "add", undo: () => removeNodes(ed.api, [id]), redo: () => restoreNodes(ed.api, [id]) });
}

// A selected frame becomes a main component; other layers are framed into a new one.
export async function createComponent(ed: Editor) {
  const ids = ed.topSelected();
  if (ids.length === 0) return;
  if (ids.some((id) => ed.instanceOf(id) !== null)) return ed.setError("Detach the instance first: an instance can't be a main component.");
  const n = ed.node(ids[0])!;
  if (ids.length === 1 && n.kind === "frame") {
    if (!n.props.main) setProps(ed, "Create component", () => ({ main: true }), "design-component");
    return;
  }
  await wrapSelection(ed, "frame", { main: true }, "Component");
}

// A new instance of a main component (a set's first variant), next to it or centered at `at`.
export async function createInstance(ed: Editor, mainId: number, at?: Point) {
  const asked = ed.node(mainId);
  if (asked?.props.variantSet) mainId = ed.children(mainId).find((id) => ed.node(id)!.props.main) ?? mainId;
  const main = ed.node(mainId);
  if (!main?.props.main) return;
  // A variant's instance goes next to its set, never inside it.
  const set = ed.node(main.parentId)?.props.variantSet ? ed.node(main.parentId)! : null;
  const beside = set ?? main;
  const parent = at ? ed.frameAt(at) : beside.parentId;
  if (parent !== null && [mainId, set?.id].some((m) => m !== undefined && (parent === m || ed.ancestors(parent).includes(m))))
    return ed.setError("An instance can't go inside its own main component.");
  const box = at
    ? boxAt({ origin: { x: at.x - main.width / 2, y: at.y - main.height / 2 }, angle: 0 }, ed.world(parent), main.width, main.height)
    : { x: beside.x + beside.width + 40, y: beside.y, width: main.width, height: main.height, rotation: beside.rotation };
  await ed.run(async () => {
    const ids = await ed.add([{ kind: "frame", name: main.name, parent_id: parent, ...box, props: copyProps(main.props, null, mainId) }],
      `Add instance of ${main.name}`);
    ed.syncSoon(true);
    ed.select(ids);
  });
}

// The instances stop following their main and keep how they look.
export function detachInstances(ed: Editor, ids = ed.topSelected().filter((id) => ed.node(id)?.props.instanceOf !== null)) {
  const changes = propsChanges(ed, () => ({ instanceOf: null, master: null, overrides: [] }), ids.flatMap(ed.instanceLayers));
  if (changes.size) ed.update(changes, `Detach ${ids.length === 1 ? "instance" : `${ids.length} instances`}`, "design-detach");
}

// Takes back what was changed on instances (or on single layers in them), so they look like their main again.
export function resetOverrides(ed: Editor, ids = ed.topSelected()) {
  const layersOf = (id: number) => (ed.node(id)?.props.instanceOf !== null ? ed.instanceLayers(id) : [id]);
  const changes = propsChanges(ed, (n) => (n.props.overrides.length ? { overrides: [] } : null), ids.flatMap(layersOf));
  if (changes.size) ed.update(changes, "Reset overrides", "undo");
}

// Overrides stay on layers whose name path the other component has too.
export function swapComponent(ed: Editor, id: number, mainId: number) {
  const main = ed.node(mainId);
  if (!main?.props.main || ed.node(id)?.props.instanceOf === mainId) return;
  if (id === mainId || ed.ancestors(id).includes(mainId)) return ed.setError("An instance can't go inside its own main component.");
  ed.update(new Map([[id, { props: { ...ed.node(id)!.props, instanceOf: mainId } }]]), `Swap to ${main.name}`, "design-instance");
}

// The mains of the variant set a main is in, else just that main.
export function variantsOf(ed: Editor, mainId: number): number[] {
  const set = ed.node(ed.node(mainId)?.parentId);
  return set?.props.variantSet ? ed.children(set.id).filter((id) => ed.node(id)!.props.main) : [mainId];
}

// Selected mains become variants of one component, in a new set around them.
export async function combineAsVariants(ed: Editor) {
  const ids = ed.topSelected();
  if (ids.length < 2 || !ids.every((id) => ed.node(id)!.props.main)) return ed.setError("Pick two or more main components.");
  await wrapSelection(ed, "frame", { variantSet: true, clip: false }, "Variants",
    (n) => (Object.keys(variantValues(n.name)).length ? n.name : `Property 1=${n.name}`));
}

// Another variant below the others, a copy of `mainId` with its first value made new; the set grows to fit.
export async function addVariant(ed: Editor, mainId: number) {
  const main = ed.node(mainId);
  const set = ed.node(main?.parentId);
  if (!main || !set?.props.variantSet) return;
  const siblings = ed.children(set.id);
  const names = new Set(siblings.map((id) => ed.node(id)!.name));
  const values = variantValues(main.name);
  const key = Object.keys(values)[0] ?? "Property 1";
  const base = values[key] ?? main.name;
  let n = 2;
  while (names.has(variantName({ ...values, [key]: `${base} ${n}` }))) n++;
  const name = variantName({ ...values, [key]: `${base} ${n}` });
  const bottom = Math.max(...siblings.map((id) => ed.node(id)!.y + ed.node(id)!.height));
  const nodes = serialize(ed, [mainId]);
  nodes[0].name = name;
  const placed = placeCopies(ed, nodes, set.id, { x: 0, y: bottom + 20 - main.y });
  const old = { height: set.height };
  const grown = { height: Math.max(set.height, bottom + 20 + main.height + 20) };
  await ed.run(async () => {
    const ids = await ed.add(placed, "", false);
    await updateNodes(ed.api, new Map([[set.id, grown]]));
    ed.select([ids[0]]);
    ed.history.push({
      label: "Add variant", icon: "design-component",
      undo: async () => { await removeNodes(ed.api, ids); await updateNodes(ed.api, new Map([[set.id, old]])); },
      redo: async () => { await restoreNodes(ed.api, ids); await updateNodes(ed.api, new Map([[set.id, grown]])); },
    });
  });
}

// Sets one variant property of an instance: it swaps to the variant with that value.
export function setVariant(ed: Editor, instanceId: number, key: string, value: string) {
  const main = ed.node(ed.node(instanceId)?.props.instanceOf);
  if (!main) return;
  const target = pickVariant(variantsOf(ed, main.id).map((id) => ({ id, name: ed.node(id)!.name })), main.name, key, value);
  if (target !== null) swapComponent(ed, instanceId, target);
}

// Renames a variant by one property.
export function renameVariant(ed: Editor, mainId: number, key: string, value: string) {
  const main = ed.node(mainId);
  if (!main || !value.trim()) return;
  const name = variantName({ ...variantValues(main.name), [key]: value.trim() });
  if (name !== main.name) ed.update(new Map([[mainId, { name }]]), "Rename variant");
}
