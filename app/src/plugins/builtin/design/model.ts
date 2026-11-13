import type { ApiValue } from "../../../api/types";
import { decodeEmoji, encodeEmoji } from "../../../markdown/emoji";
import type { Vector } from "./vector";

export type NodeKind = "frame" | "group" | "rect" | "ellipse" | "line" | "text" | "image" | "svg" | "path";

export interface Paint {
  color: string;      // #rrggbb; for linked paints the value when they were linked, used if the color is gone
  opacity: number;    // 0..1
  visible: boolean;
  ref?: number | null;   // a document color (design_colors), whose value comes from the active palette
  // Fills only: drawn as this gradient. `color` is then its first stop, for whatever shows a paint as one color.
  gradient?: Gradient | null;
}

export type GradientKind = "linear" | "radial";

export interface GradientStop {
  color: string;      // #rrggbb
  opacity: number;    // 0..1, times the paint's opacity
  position: number;   // 0..1 along the gradient
}

export interface Gradient {
  kind: GradientKind;
  angle: number;      // linear: degrees like CSS, 0 toward the top, 90 toward the right
  stops: GradientStop[];
}

// Turns a color, linked or not, into the #rrggbb to show.
export type Resolve = (c: { color: string; ref?: number | null }) => string;
export const unlinked: Resolve = (c) => c.color;

export type StrokeAlign = "inside" | "center" | "outside";

export interface Stroke extends Paint {
  width: number;
  align: StrokeAlign;   // where the stroke sits on the edge; lines always center
}

export type EffectKind = "drop-shadow" | "inner-shadow" | "layer-blur" | "background-blur";

export interface Effect {
  kind: EffectKind;
  visible: boolean;
  color: string;
  ref?: number | null;
  opacity: number;
  x: number;
  y: number;
  blur: number;
  spread: number;
}

export type CornerStyle = "round" | "cut";

import type { ExportSetting } from "../canvas/export";
export type { ExportFormat, ExportSetting } from "../canvas/export";

export interface TextStyle {
  family: string;
  size: number;
  weight: number;
  italic: boolean;
  align: "left" | "center" | "right";
  lineHeight: number;      // multiple of the size, 0 for the font's own
  letterSpacing: number;   // px
  verticalAlign: "top" | "middle" | "bottom";   // where text sits in a fixed size box
  underline: boolean;
  strike: boolean;
}

// Auto width grows sideways, auto height wraps at the width and grows down, fixed keeps the box.
export type TextSizing = "width" | "height" | "fixed";

// Prototype: what a layer does in play mode.
export type Trigger = "click" | "enter" | "hover" | "delay";
export type Action = "navigate" | "back" | "overlay" | "close" | "change-to";
export type OverlayPlace = "center" | "top" | "bottom";
export type Scroll = "none" | "vertical" | "horizontal" | "both";
export type Transition = "instant" | "dissolve" | "move-in" | "move-out" | "push" | "slide-in" | "smart";
export type Direction = "left" | "right" | "up" | "down";
export type Easing = "ease-out" | "ease-in" | "ease-in-out" | "linear" | "bouncy";

export interface Interaction {
  trigger: Trigger;
  delay: number;            // ms, for "delay"
  action: Action;
  target: number | null;    // the page-level frame to go to or open, or the variant to change to
  overlay: OverlayPlace;    // where an overlay opens
  backdrop: boolean;        // an overlay darkens the frame behind it
  closeOutside: boolean;    // a click outside the overlay closes it
  transition: Transition;
  direction: Direction;     // where moving transitions go
  duration: number;         // ms
  easing: Easing;
}

export const interaction = (target: number | null): Interaction => ({
  trigger: "click", delay: 1000, action: "navigate", target, overlay: "center", backdrop: true, closeOutside: true,
  transition: "instant", direction: "left", duration: 300, easing: "ease-out",
});

// Where a layer goes when its frame is resized: kept to one side, both sides (stretching), centered, or scaled.
export type HConstraint = "left" | "right" | "both" | "center" | "scale";
export type VConstraint = "top" | "bottom" | "both" | "center" | "scale";
export interface Constraints {
  h: HConstraint;
  v: VConstraint;
}

export interface Props {
  fills: Paint[];
  strokes: Stroke[];
  radius: number;
  radii: [number, number, number, number] | null;   // top left, top right, bottom right, bottom left; null uses radius
  corners: CornerStyle;    // rounded, or cut straight at 45 degrees
  effects: Effect[];
  exports: ExportSetting[];
  opacity: number;
  visible: boolean;
  locked: boolean;
  clip: boolean;           // frames hide what sticks out
  text: string;
  textStyle: TextStyle;
  sizing: TextSizing;
  svg: string;             // markup of svg layers
  // The color of svg layers drawn in currentColor (icons): set on the svg, so it can follow a palette color.
  tint: Paint | null;
  vector: Vector | null;   // path layers' anchors
  // Components (components.ts): a main component is a frame to reuse, an instance a frame copying one (`instanceOf`).
  // The layers inside an instance follow the main's layer they copy (`master`) except for their `overrides`.
  main: boolean;
  instanceOf: number | null;
  master: number | null;
  overrides: string[];     // field and props names changed on this copy
  variantSet: boolean;     // a frame holding mains that are variants of one component ("State=Hover, Size=Large")
  interactions: Interaction[];
  scroll: Scroll;          // frames scroll their content in play mode
  constraints: Constraints;
}

// The unrotated box: top left in the parent's coordinates, turned around its center.
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;   // degrees, clockwise
}

export interface Fields extends Box {
  parentId: number | null;
  name: string;
  z: number;
  props: Props;
}

export interface DesignNode extends Fields {
  id: number;
  kind: NodeKind;
  url: string | null;
  thumb: string | null;
}

export type Change = Partial<Fields>;

export const defaultTextStyle: TextStyle = {
  family: "Inter", size: 16, weight: 400, italic: false, align: "left", lineHeight: 0, letterSpacing: 0, verticalAlign: "top", underline: false, strike: false,
};

export const solid = (color: string, opacity = 1): Paint => ({ color, opacity, visible: true });
// From a color to the same color faded out.
export const gradientOf = (kind: GradientKind, color: string): Gradient => ({
  kind, angle: 90, stops: [{ color, opacity: 1, position: 0 }, { color, opacity: 0, position: 1 }],
});
export const stroke = (color: string, align: StrokeAlign = "inside", width = 1): Stroke => ({ ...solid(color), width, align });

export function effect(kind: EffectKind): Effect {
  const blur = kind === "layer-blur" || kind === "background-blur";
  return { kind, visible: true, color: "#000000", opacity: 0.25, x: 0, y: blur ? 0 : 4, blur: blur ? 8 : 4, spread: 0 };
}

export const effectLabels: Record<EffectKind, string> = {
  "drop-shadow": "Drop shadow", "inner-shadow": "Inner shadow", "layer-blur": "Layer blur", "background-blur": "Background blur",
};

// The four corner sizes, top left first, never more than half the shorter side.
export function cornerSizes(n: { width: number; height: number; props: Props }): [number, number, number, number] {
  const max = Math.max(0, Math.min(n.width, n.height) / 2);
  const r = n.props.radii ?? [n.props.radius, n.props.radius, n.props.radius, n.props.radius];
  return r.map((v) => Math.min(max, Math.max(0, v || 0))) as [number, number, number, number];
}

// Black or white, whichever reads better on a color.
export function inkFor(background: string): string {
  const hex = toHex(background);
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.18 ? "#000000" : "#ffffff";
}


export function defaultProps(kind: NodeKind): Props {
  const base: Props = {
    fills: [], strokes: [], radius: 0, radii: null, corners: "round", effects: [], exports: [], opacity: 1, visible: true, locked: false, clip: false,
    text: "", textStyle: { ...defaultTextStyle }, sizing: "width", svg: "", tint: null, vector: null,
    main: false, instanceOf: null, master: null, overrides: [], variantSet: false, interactions: [], scroll: "none",
    constraints: { h: "left", v: "top" },
  };
  switch (kind) {
    case "frame": return { ...base, fills: [solid("#ffffff")], clip: true };
    case "rect": case "ellipse": return { ...base, fills: [solid("#d9d9d9")] };
    case "line": return { ...base, strokes: [stroke("#000000", "center")] };
    case "path": return { ...base, strokes: [stroke("#000000", "center")] };
    case "text": return { ...base, fills: [solid("#000000")] };
    default: return base;
  }
}

export const kindLabels: Record<NodeKind, string> = {
  frame: "Frame", group: "Group", rect: "Rectangle", ellipse: "Ellipse", line: "Line", text: "Text", image: "Image", svg: "Vector", path: "Path",
};

export const kindIcons: Record<NodeKind, string> = {
  frame: "design-frame", group: "design-group", rect: "design-rect", ellipse: "design-ellipse", line: "design-line", text: "design-text",
  image: "image", svg: "design-vector", path: "design-pen",
};

export const nodeIcon = (n: DesignNode) =>
  n.props.main || n.props.variantSet ? "design-component" : n.props.instanceOf !== null ? "design-instance" : kindIcons[n.kind];

const kinds = Object.keys(kindLabels) as NodeKind[];

function parseProps(kind: NodeKind, text: ApiValue): Props {
  const props = defaultProps(kind);
  try {
    const stored = JSON.parse(String(text ?? "{}")) as Partial<Props> & { autoWidth?: boolean };
    if (!stored.sizing && stored.autoWidth === false) stored.sizing = "height";
    delete stored.autoWidth;
    Object.assign(props, stored, { textStyle: { ...props.textStyle, ...stored.textStyle } });
    props.strokes = props.strokes.map((s: Partial<Stroke>) => ({ ...stroke("#000000", kind === "line" || kind === "path" ? "center" : "inside"), ...s }));
    props.effects = (props.effects ?? []).map((e) => ({ ...effect(e.kind), ...e }));
    props.interactions = (props.interactions ?? []).map((i) => ({ ...interaction(null), ...i }));
  } catch {
    // Unreadable props keep the defaults.
  }
  props.text = decodeEmoji(props.text);
  return props;
}

export function toNode(row: Record<string, ApiValue>): DesignNode {
  const kind = kinds.includes(row.kind as NodeKind) ? row.kind as NodeKind : "rect";
  return {
    id: Number(row.id),
    parentId: row.parent_id === null || row.parent_id === undefined ? null : Number(row.parent_id),
    kind,
    name: decodeEmoji(String(row.name ?? "")),
    z: Number(row.z) || 0,
    x: Number(row.x) || 0,
    y: Number(row.y) || 0,
    width: Number(row.width) || 0,
    height: Number(row.height) || 0,
    rotation: Number(row.rotation) || 0,
    props: parseProps(kind, row.props),
    url: row.url ? String(row.url) : null,
    thumb: row.thumb ? String(row.thumb) : null,
  };
}

export const propsText = (props: Props) => JSON.stringify({ ...props, text: encodeEmoji(props.text) });

// A change as the plugin's columns.
export function toRow(change: Change): Record<string, ApiValue> {
  const row: Record<string, ApiValue> = {};
  for (const [key, value] of Object.entries(change)) {
    if (key === "parentId") row.parent_id = value as number | null;
    else if (key === "props") row.props = propsText(value as Props);
    else if (key === "name") row.name = encodeEmoji(value as string);
    else row[key] = value as ApiValue;
  }
  return row;
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-6;
  if (typeof a === "object" && a !== null) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

// Geometry. Layers only move and turn (no scale), so a layer's place in the world is a rigid transform:
// world = rotate(angle) * local + origin, where local is relative to the layer's top left.
export type Point = { x: number; y: number };
export interface Rigid {
  origin: Point;
  angle: number;   // degrees
}

export const identity: Rigid = { origin: { x: 0, y: 0 }, angle: 0 };

export function rotate(p: Point, degrees: number): Point {
  if (!degrees) return p;
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

export const apply = (t: Rigid, p: Point): Point => {
  const r = rotate(p, t.angle);
  return { x: r.x + t.origin.x, y: r.y + t.origin.y };
};

export const invert = (t: Rigid, p: Point): Point => rotate({ x: p.x - t.origin.x, y: p.y - t.origin.y }, -t.angle);

// The layer's own transform inside its parent.
export function localTransform(b: Box): Rigid {
  const half = rotate({ x: b.width / 2, y: b.height / 2 }, b.rotation);
  return { origin: { x: b.x + b.width / 2 - half.x, y: b.y + b.height / 2 - half.y }, angle: b.rotation };
}

export const compose = (parent: Rigid, child: Rigid): Rigid =>
  ({ origin: apply(parent, child.origin), angle: parent.angle + child.angle });

// The box that puts a layer of this size at a world transform, inside a parent at `parent`.
export function boxAt(world: Rigid, parent: Rigid, width: number, height: number): Box {
  const origin = invert(parent, world.origin);
  const rotation = normalizeAngle(world.angle - parent.angle);
  const half = rotate({ x: width / 2, y: height / 2 }, rotation);
  return { x: origin.x + half.x - width / 2, y: origin.y + half.y - height / 2, width, height, rotation };
}

export const normalizeAngle = (deg: number) => {
  const d = ((deg % 360) + 360) % 360;
  return d > 180 ? d - 360 : d;
};

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function cornersOf(t: Rigid, width: number, height: number): Point[] {
  return [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }].map((p) => apply(t, p));
}

export function boundsOf(points: Point[]): Rect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

export function union(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  return {
    left: Math.min(...rects.map((r) => r.left)), top: Math.min(...rects.map((r) => r.top)),
    right: Math.max(...rects.map((r) => r.right)), bottom: Math.max(...rects.map((r) => r.bottom)),
  };
}

export const overlaps = (a: Rect, b: Rect) => a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
export const contains = (r: Rect, p: Point) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;

// A z between two neighbours, for placing a layer without renumbering the others.
export function between(below: number | undefined, above: number | undefined): number {
  if (below === undefined && above === undefined) return 1;
  if (below === undefined) return above! - 1;
  if (above === undefined) return below + 1;
  return (below + above) / 2;
}

// A synced value inside a double-quoted attribute of markup that goes into innerHTML.
export const attributeText = (value: string) =>
  String(value).replace(/[&<>"']/g, (c) => `&#${c.codePointAt(0)};`);

// #rrggbb plus opacity as a CSS color.
const sortedStops = (g: Gradient) => [...g.stops].sort((a, b) => a.position - b.position);
const withAlpha = (color: string, alpha: number) =>
  alpha >= 1 ? color : `color-mix(in srgb, ${color} ${Math.round(alpha * 1000) / 10}%, transparent)`;

// A gradient as a CSS image, its stops faded by the paint's opacity. Radial ones reach the box's sides, like SVG's.
export function cssGradient(g: Gradient, opacity = 1): string {
  const stops = sortedStops(g).map((s) => `${withAlpha(s.color, s.opacity * opacity)} ${Math.round(s.position * 1000) / 10}%`).join(", ");
  return g.kind === "radial" ? `radial-gradient(closest-side, ${stops})` : `linear-gradient(${g.angle}deg, ${stops})`;
}

// The same gradient as an SVG element for a w x h box, so the line runs as CSS draws it.
export function svgGradient(g: Gradient, id: string, w: number, h: number, opacity = 1): string {
  const n = (v: number) => String(Math.round(v * 1000) / 1000);
  const stops = sortedStops(g).map((s) =>
    `<stop offset="${n(s.position)}" stop-color="${attributeText(s.color)}"${s.opacity * opacity < 1 ? ` stop-opacity="${n(s.opacity * opacity)}"` : ""}/>`).join("");
  if (g.kind === "radial")
    return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${n(w / 2)}" cy="${n(h / 2)}" r="${n(w / 2)}" gradientTransform="translate(${n(w / 2)} ${n(h / 2)}) scale(1 ${n(w ? h / w : 1)}) translate(${n(-w / 2)} ${n(-h / 2)})">${stops}</radialGradient>`;
  const a = (g.angle * Math.PI) / 180;
  const [dx, dy] = [Math.sin(a), -Math.cos(a)];
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n(w / 2 - dx * half)}" y1="${n(h / 2 - dy * half)}" x2="${n(w / 2 + dx * half)}" y2="${n(h / 2 + dy * half)}">${stops}</linearGradient>`;
}

export function cssColor(p: Paint, resolve: Resolve = unlinked): string {
  const color = resolve(p);
  if (p.opacity >= 1) return color;
  return `color-mix(in srgb, ${color} ${Math.round(p.opacity * 1000) / 10}%, transparent)`;
}

export function toHex(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(color)) return `#${[...color.slice(1)].map((c) => c + c).join("")}`.toLowerCase();
  return "#000000";
}
