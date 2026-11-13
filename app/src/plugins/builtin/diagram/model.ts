import type { ApiValue } from "../../../api/types";
import { decodeEmoji, encodeEmoji } from "../../../markdown/emoji";
import type { ExportSetting } from "../canvas/export";
import type { Point, Rect } from "../canvas/geometry";

export type ShapeKind =
  | "rect" | "rounded" | "ellipse" | "diamond" | "parallelogram" | "cylinder" | "document"
  | "actor" | "cloud" | "note" | "text" | "image" | "icon" | "container" | "swimlane"
  // Shapes and connectors kept together as one object (moved, selected and exported as one); drawn as nothing.
  | "group"
  // Structured shapes: a header and compartments of rows (rows.ts).
  | StructuredKind;
export const structuredKinds = [
  "uml-class", "uml-abstract", "uml-interface", "uml-enum", "uml-object", "uml-datatype", "db-table", "db-view", "db-junction",
] as const;
export type StructuredKind = typeof structuredKinds[number];
export const isStructured = (kind: ShapeKind): kind is StructuredKind => (structuredKinds as readonly string[]).includes(kind);
export type EdgeKind = "straight" | "orthogonal" | "curved";
export type Port = "n" | "e" | "s" | "w" | "c";

export interface DiagramPage {
  id: number;
  channelId: number;
  name: string;
  z: number;
  background: string;
  grid: boolean;
  exports: ExportSetting[];
}

export interface DiagramStyle {
  fill: string;
  stroke: string;
  strokeWidth: number;
  textColor: string;
  fontSize: number;
  align: "left" | "center" | "right";
  dash: boolean;
  icon?: string;
  svg?: string;
  tintIcons?: boolean;
}

export interface DiagramShape {
  id: number;
  pageId: number;
  parentId: number | null;
  kind: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  z: number;
  text: string;
  style: DiagramStyle;
  // Set on an object, it is offered as a live export (docs can embed it) and saved with these settings.
  exports: ExportSetting[];
}

// An end is on a shape (id and port) or free at a point (id null). `points` holds at most one bend: the waypoint
// of a straight or curved connector, or where the middle segment of an orthogonal one runs.
export interface DiagramEdge {
  id: number;
  pageId: number;
  // The group it is in.
  parentId: number | null;
  fromId: number | null;
  fromPort: Port;
  fromPoint: Point;
  toId: number | null;
  toPort: Port;
  toPoint: Point;
  points: Point[];
  kind: EdgeKind;
  // Heads by name (ends.ts).
  startArrow: string;
  endArrow: string;
  label: string;
  // Next to each end: a multiplicity ("1", "0..*") or a role.
  startLabel: string;
  endLabel: string;
  // An end on one row of a structured shape (null: on the whole shape).
  fromRow: number | null;
  toRow: number | null;
  style: { stroke: string; strokeWidth: number; dash: boolean };
}

// One line of a structured shape: an attribute, operation or literal of a class, a column of a table. Its fields are
// read from what was typed (rows.ts parseRow); `marks`: pk, fk, uq, nn, static, abstract.
export type RowSection = "attributes" | "operations" | "literals" | "columns";
export interface DiagramRow {
  id: number;
  shapeId: number;
  section: RowSection;
  z: number;
  name: string;
  type: string;
  params: string;
  value: string;
  visibility: "" | "+" | "-" | "#" | "~";
  marks: string[];
}

export type ShapeChange = Partial<Omit<DiagramShape, "id" | "pageId">>;
export type PageChange = Partial<Pick<DiagramPage, "name" | "background" | "grid" | "exports">>;

export const shapeName = (shape: DiagramShape) =>
  shape.text.split("\n")[0].trim() || (shape.kind === "group" ? "Group" : shapeKinds.find((item) => item.kind === shape.kind)?.label ?? "Shape");

export function parseExports(value: ApiValue): ExportSetting[] {
  try {
    const items: unknown = JSON.parse(String(value ?? "[]"));
    if (!Array.isArray(items)) return [];
    return items.filter((item): item is ExportSetting => !!item && typeof item === "object"
      && ["png", "jpg", "webp", "svg", "pdf"].includes(String(item.format)) && Number(item.scale) > 0)
      .map((item) => ({ scale: Number(item.scale), format: item.format, suffix: String(item.suffix ?? "") }));
  } catch {
    return [];
  }
}

// The shapes the library offers, each with a line on what it is for.
export const shapeKinds: { kind: ShapeKind; label: string; icon: string; description: string }[] = [
  { kind: "rect", label: "Rectangle", icon: "diagram-rect", description: "A step, a component or a thing" },
  { kind: "rounded", label: "Rounded rectangle", icon: "diagram-rounded", description: "A step, or a softer box for a group" },
  { kind: "ellipse", label: "Ellipse", icon: "diagram-ellipse", description: "A start or end, a state or an event" },
  { kind: "diamond", label: "Decision", icon: "diagram-diamond", description: "A yes/no branch in a flow" },
  { kind: "parallelogram", label: "Parallelogram", icon: "diagram-parallelogram", description: "Input or output: data going in or out" },
  { kind: "cylinder", label: "Database", icon: "diagram-cylinder", description: "Stored data: a database or a store" },
  { kind: "document", label: "Document", icon: "diagram-document", description: "A document, a file or a report" },
  { kind: "actor", label: "Actor", icon: "diagram-actor", description: "A user or another system from outside" },
  { kind: "cloud", label: "Cloud", icon: "diagram-cloud", description: "The internet, or a cloud service" },
  { kind: "note", label: "Note", icon: "diagram-note", description: "A comment on the diagram" },
  { kind: "text", label: "Text", icon: "design-text", description: "Free text without a box" },
  { kind: "icon", label: "Icon", icon: "icons", description: "Find an icon: services, devices, logos" },
  { kind: "container", label: "Container", icon: "diagram-container", description: "A box around shapes: a system or a boundary" },
  { kind: "swimlane", label: "Swimlane", icon: "diagram-swimlane", description: "A lane for each actor or system in a process" },
];

export const defaultStyle = (kind: ShapeKind): DiagramStyle => ({
  fill: kind === "text" || kind === "actor" ? "transparent" : kind === "icon" ? "var(--mw-text)" : "var(--mw-light)",
  stroke: "var(--mw-text)",
  strokeWidth: 1.5,
  textColor: "var(--mw-text)",
  fontSize: 14,
  align: "center",
  dash: false,
});

function color(value: unknown, fallback: string): string {
  const text = String(value ?? "");
  return /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(text) || /^var\(--mw-[a-z-]+\)$/.test(text) ? text : fallback;
}

function parseStyle(kind: ShapeKind, value: ApiValue): DiagramStyle {
  const fallback = defaultStyle(kind);
  try {
    const raw = JSON.parse(String(value ?? "{}")) as Partial<DiagramStyle>;
    const fontSize = Number(raw.fontSize);
    const strokeWidth = Number(raw.strokeWidth);
    return {
      fill: color(raw.fill, fallback.fill), stroke: color(raw.stroke, fallback.stroke),
      textColor: color(raw.textColor, fallback.textColor),
      strokeWidth: Number.isFinite(strokeWidth) ? Math.max(0, Math.min(32, strokeWidth)) : fallback.strokeWidth,
      fontSize: Number.isFinite(fontSize) ? Math.max(6, Math.min(96, fontSize)) : fallback.fontSize,
      align: raw.align === "left" || raw.align === "right" ? raw.align : "center",
      dash: raw.dash === true,
      ...(typeof raw.icon === "string" ? { icon: raw.icon } : {}),
      ...(typeof raw.svg === "string" ? { svg: raw.svg } : {}),
      ...(raw.tintIcons === true ? { tintIcons: true } : {}),
    };
  } catch {
    return fallback;
  }
}

const number = (value: ApiValue, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function toPage(row: Record<string, ApiValue>): DiagramPage {
  return {
    id: number(row.id), channelId: number(row.channel_id), name: decodeEmoji(String(row.name ?? "")),
    z: number(row.z), background: String(row.background ?? ""), grid: row.grid !== false, exports: parseExports(row.exports),
  };
}

export function toShape(row: Record<string, ApiValue>): DiagramShape {
  const kind = row.kind === "group" || shapeKinds.some((item) => item.kind === row.kind) || isStructured(row.kind as ShapeKind)
    ? row.kind as ShapeKind : "rect";
  return {
    id: number(row.id), pageId: number(row.page_id), parentId: row.parent_id == null ? null : number(row.parent_id),
    kind, x: number(row.x), y: number(row.y), w: number(row.w, 120), h: number(row.h, 64),
    rotation: number(row.rotation), z: number(row.z), text: decodeEmoji(String(row.text ?? "")), style: parseStyle(kind, row.style),
    exports: parseExports(row.exports),
  };
}

const ports: ReadonlySet<Port> = new Set(["n", "e", "s", "w", "c"]);
const edgeKinds: ReadonlySet<EdgeKind> = new Set(["straight", "orthogonal", "curved"]);

export function toEdge(row: Record<string, ApiValue>): DiagramEdge {
  const parsePoints = (): Point[] => {
    try {
      const values: unknown = JSON.parse(String(row.points ?? "[]"));
      if (!Array.isArray(values)) return [];
      return values.filter((point): point is Point => !!point && typeof point === "object"
        && Number.isFinite(Number((point as Point).x)) && Number.isFinite(Number((point as Point).y)))
        .map((point) => ({ x: Number(point.x), y: Number(point.y) }));
    } catch {
      return [];
    }
  };
  let style = { stroke: "var(--mw-text-muted)", strokeWidth: 1.5, dash: false };
  try {
    const raw = JSON.parse(String(row.style ?? "{}")) as Partial<typeof style>;
    style = {
      stroke: color(raw.stroke, style.stroke),
      strokeWidth: Number.isFinite(Number(raw.strokeWidth)) ? Math.max(0, Math.min(32, Number(raw.strokeWidth))) : style.strokeWidth,
      dash: raw.dash === true,
    };
  } catch {
    // Keep the safe defaults for malformed synced style data.
  }
  return {
    id: number(row.id), pageId: number(row.page_id), parentId: row.parent_id == null ? null : number(row.parent_id), fromId: row.from_id == null ? null : number(row.from_id),
    fromPort: ports.has(row.from_port as Port) ? row.from_port as Port : "e",
    fromPoint: { x: number(row.from_x), y: number(row.from_y) },
    toId: row.to_id == null ? null : number(row.to_id), toPort: ports.has(row.to_port as Port) ? row.to_port as Port : "w",
    toPoint: { x: number(row.to_x), y: number(row.to_y) },
    points: parsePoints(), kind: edgeKinds.has(row.kind as EdgeKind) ? row.kind as EdgeKind : "orthogonal",
    startArrow: String(row.start_arrow ?? ""), endArrow: String(row.end_arrow ?? "arrow"),
    label: decodeEmoji(String(row.label ?? "")), startLabel: decodeEmoji(String(row.start_label ?? "")),
    endLabel: decodeEmoji(String(row.end_label ?? "")), style,
    fromRow: row.from_row == null ? null : number(row.from_row), toRow: row.to_row == null ? null : number(row.to_row),
  };
}

export const shapeStyleText = (style: DiagramStyle) => JSON.stringify(style);

const rowSections: ReadonlySet<RowSection> = new Set(["attributes", "operations", "literals", "columns"]);
const visibilities = ["", "+", "-", "#", "~"] as const;

export function toRow(row: Record<string, ApiValue>): DiagramRow {
  const visibility = String(row.visibility ?? "");
  return {
    id: number(row.id), shapeId: number(row.shape_id),
    section: rowSections.has(row.section as RowSection) ? row.section as RowSection : "attributes",
    z: number(row.z), name: decodeEmoji(String(row.name ?? "")), type: decodeEmoji(String(row.type ?? "")),
    params: decodeEmoji(String(row.params ?? "")), value: decodeEmoji(String(row.value ?? "")),
    visibility: (visibilities as readonly string[]).includes(visibility) ? visibility as DiagramRow["visibility"] : "",
    marks: String(row.marks ?? "").split(",").map((mark) => mark.trim()).filter(Boolean),
  };
}
export const encodeText = (value: string) => encodeEmoji(value);

export function bounds(shape: DiagramShape): Rect {
  return { left: shape.x, top: shape.y, right: shape.x + shape.w, bottom: shape.y + shape.h };
}

export function portPoint(shape: DiagramShape, port: Port): Point {
  const local = {
    n: { x: shape.w / 2, y: 0 }, e: { x: shape.w, y: shape.h / 2 },
    s: { x: shape.w / 2, y: shape.h }, w: { x: 0, y: shape.h / 2 }, c: { x: shape.w / 2, y: shape.h / 2 },
  }[port];
  const angle = shape.rotation * Math.PI / 180;
  const x = local.x - shape.w / 2;
  const y = local.y - shape.h / 2;
  return {
    x: shape.x + shape.w / 2 + x * Math.cos(angle) - y * Math.sin(angle),
    y: shape.y + shape.h / 2 + x * Math.sin(angle) + y * Math.cos(angle),
  };
}
