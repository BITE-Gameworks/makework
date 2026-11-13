import { rotatePoint, turnedBounds, type Point } from "../canvas/geometry";
import { fitText, wrapText } from "../canvas/text";
import { markerSvg } from "./ends";
import { markLabel, rowText, structureLayout, structureOf } from "./rows";
import { isStructured, portPoint, type DiagramRow, type DiagramEdge, type DiagramPage, type DiagramShape, type Port } from "./model";

const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
}[c]!));
const n = (value: number) => String(Math.round(value * 100) / 100);

export function shapePrimitives(shape: DiagramShape): string {
  const { w, h } = shape;
  switch (shape.kind) {
    case "ellipse": return `<ellipse cx="${n(w / 2)}" cy="${n(h / 2)}" rx="${n(w / 2)}" ry="${n(h / 2)}"/>`;
    case "diamond": return `<path d="M ${n(w / 2)} 0 L ${n(w)} ${n(h / 2)} L ${n(w / 2)} ${n(h)} L 0 ${n(h / 2)} Z"/>`;
    case "parallelogram": return `<path d="M ${n(w * 0.2)} 0 H ${n(w)} L ${n(w * 0.8)} ${n(h)} H 0 Z"/>`;
    case "cylinder": return `<path d="M 0 ${n(h * 0.12)} C 0 ${n(-h * 0.04)} ${n(w)} ${n(-h * 0.04)} ${n(w)} ${n(h * 0.12)} V ${n(h * 0.88)} C ${n(w)} ${n(h * 1.04)} 0 ${n(h * 1.04)} 0 ${n(h * 0.88)} Z M 0 ${n(h * 0.12)} C 0 ${n(h * 0.28)} ${n(w)} ${n(h * 0.28)} ${n(w)} ${n(h * 0.12)}"/>`;
    case "document": return `<path d="M 0 0 H ${n(w)} V ${n(h * 0.82)} Q ${n(w * 0.75)} ${n(h * 0.92)} ${n(w * 0.5)} ${n(h * 0.82)} T 0 ${n(h * 0.82)} Z"/>`;
    case "actor": return `<circle cx="${n(w / 2)}" cy="${n(h * 0.17)}" r="${n(Math.min(w, h) * 0.12)}"/><path d="M ${n(w / 2)} ${n(h * 0.3)} V ${n(h * 0.68)} M ${n(w * 0.2)} ${n(h * 0.45)} H ${n(w * 0.8)} M ${n(w / 2)} ${n(h * 0.68)} L ${n(w * 0.25)} ${n(h)} M ${n(w / 2)} ${n(h * 0.68)} L ${n(w * 0.75)} ${n(h)}"/>`;
    case "cloud": return `<path d="M ${n(w * 0.22)} ${n(h * 0.78)} C ${n(w * -0.02)} ${n(h * 0.78)} ${n(w * -0.03)} ${n(h * 0.48)} ${n(w * 0.18)} ${n(h * 0.42)} C ${n(w * 0.19)} ${n(h * 0.15)} ${n(w * 0.48)} ${n(h * 0.06)} ${n(w * 0.62)} ${n(h * 0.28)} C ${n(w * 0.86)} ${n(h * 0.16)} ${n(w * 1.04)} ${n(h * 0.42)} ${n(w * 0.9)} ${n(h * 0.59)} C ${n(w * 1.05)} ${n(h * 0.86)} ${n(w * 0.74)} ${n(h * 0.94)} ${n(w * 0.59)} ${n(h * 0.8)} C ${n(w * 0.48)} ${n(h * 1.02)} ${n(w * 0.25)} ${n(h * 0.99)} ${n(w * 0.22)} ${n(h * 0.78)} Z"/>`;
    case "note": return `<path d="M 0 0 H ${n(w * 0.76)} L ${n(w)} ${n(h * 0.24)} V ${n(h)} H 0 Z M ${n(w * 0.76)} 0 V ${n(h * 0.24)} H ${n(w)}"/>`;
    case "rounded": return `<rect x="0" y="0" width="${n(w)}" height="${n(h)}" rx="${n(Math.min(12, h / 4))}"/>`;
    case "container": case "swimlane": return `<rect x="0" y="0" width="${n(w)}" height="${n(h)}"/>${shape.kind === "swimlane" ? `<path d="M 0 28 H ${n(w)}"/>` : ""}`;
    default: return `<rect x="0" y="0" width="${n(w)}" height="${n(h)}"/>`;
  }
}

// A structured shape (a class, a table) in its own coordinates: outline, header (stereotype and name), a line under
// the header and between compartments, its rows (a table's keys in a column of their own). The canvas and exports
// draw the same; `colors` are what the export can write (the canvas passes theme variables).
export function structuredMarkup(shape: DiagramShape, rows: readonly DiagramRow[], colors: { fill: string; stroke: string; text: string }): string {
  const structure = structureOf(shape.kind) ?? { sections: [] };
  const layout = structureLayout(shape, rows);
  const { w } = shape;
  const h = layout.height;
  const font = shape.style.fontSize;
  const rowFont = Math.min(font, 13);
  const table = shape.kind.startsWith("db-");
  const keysWidth = table ? 30 : 0;
  const line = (y: number) => `<path d="M 0 ${n(y)} H ${n(w)}"/>`;
  const outline = `<g fill="${esc(colors.fill)}" stroke="${esc(colors.stroke)}" stroke-width="${n(shape.style.strokeWidth)}" stroke-dasharray="${shape.style.dash ? "6 4" : "none"}"><rect x="0" y="0" width="${n(w)}" height="${n(h)}"/></g>`;
  const separators = `<g fill="none" stroke="${esc(colors.stroke)}" stroke-width="${n(shape.style.strokeWidth)}">${line(layout.header.h)}${layout.compartments.slice(1).map((c) => line(c.y)).join("")}</g>`;
  const nameY = structure.stereotype ? layout.header.h - 15 : layout.header.h / 2;
  const nameStyle = structure.nameStyle === "italic" ? ' font-style="italic"' : structure.nameStyle === "underline" ? ' text-decoration="underline"' : "";
  const header = (structure.stereotype ? `<text x="${n(w / 2)}" y="13" font-size="${n(rowFont * 0.85)}" text-anchor="middle" dominant-baseline="central">«${esc(structure.stereotype)}»</text>` : "")
    + `<text x="${n(w / 2)}" y="${n(nameY)}" font-size="${n(font)}" font-weight="600" text-anchor="middle" dominant-baseline="central"><tspan${nameStyle}>${esc(fitText(shape.text.split("\n")[0], font, w - 8))}</tspan></text>`;
  const rowMarkup = layout.compartments.flatMap((c) => c.rows).map(({ row, y, h: rowH }) => {
    const mid = y + rowH / 2;
    const text = fitText(rowText(row, shape.kind, { marks: false }), rowFont, w - keysWidth - 12);
    const decoration = row.marks.includes("static") ? ' text-decoration="underline"' : row.marks.includes("abstract") ? ' font-style="italic"' : "";
    const keys = table && row.marks.some((mark) => mark === "pk" || mark === "fk")
      ? `<text x="6" y="${n(mid)}" font-size="${n(rowFont * 0.8)}" font-weight="700" dominant-baseline="central">${row.marks.filter((mark) => mark === "pk" || mark === "fk").map(markLabel).join(",")}</text>` : "";
    return `${keys}<text x="${n(keysWidth + 6)}" y="${n(mid)}" font-size="${n(rowFont)}" dominant-baseline="central"${decoration}>${esc(text)}</text>`;
  }).join("");
  return `${outline}${separators}<g fill="${esc(colors.text)}" font-family="sans-serif">${header}${rowMarkup}</g>`;
}

export function shapeSvgMarkup(shape: DiagramShape, rows: readonly DiagramRow[] = []): string {
  if (isStructured(shape.kind)) return structuredMarkup(shape, rows, { fill: shape.style.fill, stroke: shape.style.stroke, text: shape.style.textColor });
  const fill = ["actor", "text", "icon"].includes(shape.kind) ? "none" : shape.style.fill;
  const stroke = ["text", "icon"].includes(shape.kind) ? "none" : shape.style.stroke;
  return `<g fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="${n(shape.style.strokeWidth)}" stroke-dasharray="${shape.style.dash ? "6 4" : "none"}">${shapePrimitives(shape)}</g>`;
}

const portDirs: Record<Port, Point | null> = { n: { x: 0, y: -1 }, e: { x: 1, y: 0 }, s: { x: 0, y: 1 }, w: { x: -1, y: 0 }, c: null };
// How far a connector leaves a shape straight before it turns.
const lead = 24;

const axisDir = (v: Point): Point =>
  Math.abs(v.x) >= Math.abs(v.y) ? { x: Math.sign(v.x) || 1, y: 0 } : { x: 0, y: Math.sign(v.y) || 1 };
const along = (p: Point, d: Point, k: number): Point => ({ x: p.x + d.x * k, y: p.y + d.y * k });

export interface EdgeEnd {
  at: Point;
  // The way the line leaves (outward from the shape's side, turned with it); null for free ends and centers.
  dir: Point | null;
  attached: boolean;
}

export function shapeEnd(shape: DiagramShape, port: Port): EdgeEnd {
  const base = portDirs[port];
  return { at: portPoint(shape, port), dir: base ? axisDir(rotatePoint(base, shape.rotation)) : null, attached: true };
}

export const freeEnd = (at: Point): EdgeEnd => ({ at, dir: null, attached: false });

// The rows of a page by their shape.
export type RowsByShape = Map<number, readonly DiagramRow[]>;
export function rowsByShape(rows: readonly DiagramRow[]): RowsByShape {
  const out = new Map<number, DiagramRow[]>();
  for (const row of rows) out.set(row.shapeId, [...(out.get(row.shapeId) ?? []), row]);
  return out;
}

const centerOf = (shape: DiagramShape): Point => ({ x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 });

// A point in a shape's own coordinates, on the page (turned with the shape).
function onPage(shape: DiagramShape, x: number, y: number): Point {
  const angle = shape.rotation * Math.PI / 180;
  const dx = x - shape.w / 2;
  const dy = y - shape.h / 2;
  return { x: shape.x + shape.w / 2 + dx * Math.cos(angle) - dy * Math.sin(angle), y: shape.y + shape.h / 2 + dx * Math.sin(angle) + dy * Math.cos(angle) };
}

// An end on a row: the row's middle on the shape's left or right side, whichever faces `toward` (the other end).
export function rowEnd(shape: DiagramShape, rows: readonly DiagramRow[], rowId: number, toward: Point): EdgeEnd | null {
  const placed = structureLayout(shape, rows).compartments.flatMap((c) => c.rows).find((item) => item.row.id === rowId);
  if (!placed) return null;
  const east = toward.x >= shape.x + shape.w / 2;
  const at = onPage(shape, east ? shape.w : 0, placed.y + placed.h / 2);
  return { at, dir: axisDir(rotatePoint({ x: east ? 1 : -1, y: 0 }, shape.rotation)), attached: true };
}

export function edgeEnd(edge: DiagramEdge, side: "from" | "to", byId: Map<number, DiagramShape>, rows?: RowsByShape): EdgeEnd | null {
  const id = side === "from" ? edge.fromId : edge.toId;
  if (id === null) return freeEnd(side === "from" ? edge.fromPoint : edge.toPoint);
  const shape = byId.get(id);
  if (!shape) return null;
  // On a row while it is there; a removed row's connector ends on the whole shape.
  const rowId = side === "from" ? edge.fromRow : edge.toRow;
  if (rowId !== null && rows) {
    const otherId = side === "from" ? edge.toId : edge.fromId;
    const otherShape = otherId === null ? undefined : byId.get(otherId);
    const toward = otherShape ? centerOf(otherShape) : otherId === null ? (side === "from" ? edge.toPoint : edge.fromPoint) : centerOf(shape);
    const onRow = rowEnd(shape, rows.get(shape.id) ?? [], rowId, toward);
    if (onRow) return onRow;
  }
  return shapeEnd(shape, side === "from" ? edge.fromPort : edge.toPort);
}

export interface EdgeGeometry {
  points: Point[];
  d: string;
  // The bend handle: where it is and which way dragging it moves the bend ("x": the line's vertical middle part).
  handle: { at: Point; axis: "x" | "y" | "xy" };
}

function tidy(route: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of route) {
    const last = out.at(-1);
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    const before = out.at(-2);
    if (before && last && ((before.x === last.x && last.x === p.x) || (before.y === last.y && last.y === p.y))) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

function orthogonal(from: EdgeEnd, to: EdgeEnd, bend: Point | null): Omit<EdgeGeometry, "d"> {
  const s = from.at;
  const e = to.at;
  const sd = from.dir ?? axisDir({ x: e.x - s.x, y: e.y - s.y });
  const ed = to.dir ?? axisDir({ x: s.x - e.x, y: s.y - e.y });
  const a = along(s, sd, from.attached ? lead : 0);
  const b = along(e, ed, to.attached ? lead : 0);
  const sideways = sd.x !== 0;
  const arrivesSideways = ed.x !== 0;
  const channelX = (mx: number) => ({
    route: [s, a, { x: mx, y: a.y }, { x: mx, y: b.y }, b, e], handle: { at: { x: mx, y: (a.y + b.y) / 2 }, axis: "x" as const },
  });
  const channelY = (my: number) => ({
    route: [s, a, { x: a.x, y: my }, { x: b.x, y: my }, b, e], handle: { at: { x: (a.x + b.x) / 2, y: my }, axis: "y" as const },
  });
  let result;
  if (sideways && arrivesSideways) result = channelX(bend?.x ?? (a.x + b.x) / 2);
  else if (!sideways && !arrivesSideways) result = channelY(bend?.y ?? (a.y + b.y) / 2);
  else if (sideways) {
    // One turn when the corner lies ahead of both ends, else a middle part that can be dragged.
    result = !bend && (b.x - a.x) * sd.x >= 0 && (a.y - b.y) * ed.y >= 0
      ? { route: [s, a, { x: b.x, y: a.y }, b, e], handle: { at: { x: b.x, y: (a.y + b.y) / 2 }, axis: "x" as const } }
      : channelX(bend?.x ?? (a.x + b.x) / 2);
  } else {
    result = !bend && (b.y - a.y) * sd.y >= 0 && (a.x - b.x) * ed.x >= 0
      ? { route: [s, a, { x: a.x, y: b.y }, b, e], handle: { at: { x: (a.x + b.x) / 2, y: b.y }, axis: "y" as const } }
      : channelY(bend?.y ?? (a.y + b.y) / 2);
  }
  return { points: tidy(result.route), handle: result.handle };
}

export function edgeGeometryOf(edge: Pick<DiagramEdge, "kind" | "points">, from: EdgeEnd, to: EdgeEnd): EdgeGeometry {
  const bend = edge.points.length === 1 ? edge.points[0] : null;
  const s = from.at;
  const e = to.at;
  const line = (points: Point[]) => points.map((p, i) => `${i ? "L" : "M"} ${n(p.x)} ${n(p.y)}`).join(" ");
  if (edge.kind === "orthogonal") {
    const route = orthogonal(from, to, bend);
    return { ...route, d: line(route.points) };
  }
  if (edge.kind === "straight") {
    const points = bend ? [s, bend, e] : [s, e];
    return { points, d: line(points), handle: { at: bend ?? { x: (s.x + e.x) / 2, y: (s.y + e.y) / 2 }, axis: "xy" } };
  }
  if (bend) {
    // A curve through the bend: the control point that puts the curve's middle there.
    const c = { x: 2 * bend.x - (s.x + e.x) / 2, y: 2 * bend.y - (s.y + e.y) / 2 };
    const at = (t: number) => ({
      x: (1 - t) ** 2 * s.x + 2 * (1 - t) * t * c.x + t ** 2 * e.x, y: (1 - t) ** 2 * s.y + 2 * (1 - t) * t * c.y + t ** 2 * e.y,
    });
    return {
      points: Array.from({ length: 17 }, (_, i) => at(i / 16)),
      d: `M ${n(s.x)} ${n(s.y)} Q ${n(c.x)} ${n(c.y)} ${n(e.x)} ${n(e.y)}`, handle: { at: bend, axis: "xy" },
    };
  }
  const k = Math.max(30, Math.hypot(e.x - s.x, e.y - s.y) / 3);
  const c1 = along(s, from.dir ?? axisDir({ x: e.x - s.x, y: e.y - s.y }), k);
  const c2 = along(e, to.dir ?? axisDir({ x: s.x - e.x, y: s.y - e.y }), k);
  const at = (t: number) => {
    const u = 1 - t;
    return {
      x: u ** 3 * s.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * e.x,
      y: u ** 3 * s.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * e.y,
    };
  };
  return {
    points: Array.from({ length: 17 }, (_, i) => at(i / 16)),
    d: `M ${n(s.x)} ${n(s.y)} C ${n(c1.x)} ${n(c1.y)} ${n(c2.x)} ${n(c2.y)} ${n(e.x)} ${n(e.y)}`, handle: { at: at(0.5), axis: "xy" },
  };
}

export function edgeGeometry(edge: DiagramEdge, byId: Map<number, DiagramShape>, rows?: RowsByShape): EdgeGeometry | null {
  const from = edgeEnd(edge, "from", byId, rows);
  const to = edgeEnd(edge, "to", byId, rows);
  return from && to ? edgeGeometryOf(edge, from, to) : null;
}

export function edgePoints(edge: DiagramEdge, byId: Map<number, DiagramShape>, rows?: RowsByShape): Point[] {
  return edgeGeometry(edge, byId, rows)?.points ?? [];
}

// Where a connector's label goes: the middle of the line.
export function edgeLabelPoint(geometry: EdgeGeometry): Point {
  return geometry.handle.at;
}

// Where an end's label goes (a multiplicity or a role): a little along the line from that end, past its head, and
// off the line to one side (above, or left of a vertical line), so it reads clear of the line and the shape.
export function endLabelPoint(geometry: EdgeGeometry, end: "start" | "end"): Point {
  const points = end === "start" ? geometry.points : [...geometry.points].reverse();
  const at = points[0];
  const next = points.find((point) => point.x !== at.x || point.y !== at.y) ?? { x: at.x + 1, y: at.y };
  const length = Math.hypot(next.x - at.x, next.y - at.y);
  const along = { x: (next.x - at.x) / length, y: (next.y - at.y) / length };
  let side = { x: -along.y, y: along.x };
  if (side.y > 0 || (side.y === 0 && side.x > 0)) side = { x: -side.x, y: -side.y };
  return { x: at.x + along.x * endLabelAlong + side.x * endLabelOff, y: at.y + along.y * endLabelAlong + side.y * endLabelOff };
}
const endLabelAlong = 18;
const endLabelOff = 10;

export function recolorIconSvg(svg: string, style: DiagramShape["style"], force = false): string {
  const colorAttribute = (attribute: "fill" | "stroke") => new RegExp(String.raw`(\b${attribute}\s*=\s*)(["'])(.*?)\2`, "gi");
  const result = svg
    .replace(colorAttribute("fill"), (match, prefix: string, quote: string, value: string) =>
      value.toLowerCase() === "currentcolor" || (force && value.toLowerCase() !== "none" && !value.startsWith("url("))
        ? `${prefix}${quote}${style.fill}${quote}` : match)
    .replace(colorAttribute("stroke"), (match, prefix: string, quote: string, value: string) =>
      value.toLowerCase() === "currentcolor" || (force && value.toLowerCase() !== "none" && !value.startsWith("url("))
        ? `${prefix}${quote}${style.stroke}${quote}` : match);
  return result.replace(/currentColor/gi, style.fill);
}

// Room left and right of shape text, as in the view (.diagram-shape-text padding).
const textInset = 4;
function shapeMarkup(shape: DiagramShape, rows: RowsByShape): string {
  const { style } = shape;
  const transform = `translate(${n(shape.x + shape.w / 2)} ${n(shape.y + shape.h / 2)}) rotate(${n(shape.rotation)}) translate(${n(-shape.w / 2)} ${n(-shape.h / 2)})`;
  if (isStructured(shape.kind)) return `<g transform="${transform}">${structuredMarkup(shape, rows.get(shape.id) ?? [], {
    fill: svgColor(style.fill, "#ffffff"), stroke: svgColor(style.stroke, "#333333"), text: svgColor(style.textColor, "#222222"),
  })}</g>`;
  const fill = shape.kind === "actor" || shape.kind === "text" || shape.kind === "icon" ? "none" : svgColor(style.fill, "#ffffff");
  const stroke = shape.kind === "text" || shape.kind === "icon" ? "none" : svgColor(style.stroke, "#333333");
  const icon = shape.kind === "icon" && style.svg
    ? `<image href="data:image/svg+xml,${encodeURIComponent(style.svg.replaceAll("currentColor",svgColor(style.textColor, "#222222")))}" width="${n(shape.w)}" height="${n(shape.h)}" preserveAspectRatio="xMidYMid meet"/>`
    : "";
  const primitives = shape.kind === "icon" ? "" : shapePrimitives(shape);
  const lineHeight = style.fontSize * 1.25;
  const lines = shape.text ? wrapText(shape.text, style.fontSize, Math.max(1, shape.w - textInset * 2)) : [];
  const x = style.align === "left" ? textInset : style.align === "right" ? shape.w - textInset : shape.w / 2;
  const content = lines.length ? `<text fill="${esc(svgColor(style.textColor, "#222222"))}" font-family="sans-serif" font-size="${n(style.fontSize)}" text-anchor="${style.align === "left" ? "start" : style.align === "right" ? "end" : "middle"}" dominant-baseline="central">${lines.map((line, i) =>
    `<tspan x="${n(x)}" y="${n(shape.h / 2 + (i - (lines.length - 1) / 2) * lineHeight)}" xml:space="preserve">${esc(line)}</tspan>`).join("")}</text>` : "";
  return `<g transform="${transform}"><g fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="${n(style.strokeWidth)}" stroke-dasharray="${style.dash ? "6 4" : "none"}">${primitives}</g>${icon}${content}</g>`;
}

const svgColor = (value: string, fallback: string) => value.startsWith("#") ? value : fallback;

// The page as a standalone SVG, cropped to what is on it. `only`: just these objects (and what is inside them), the
// connectors in them or between their shapes, without the page background.
export function renderDiagramSvg(page: DiagramPage, allShapes: DiagramShape[], allEdges: DiagramEdge[], only?: number[], rows: readonly DiagramRow[] = []): string {
  return renderDiagram(page, allShapes, allEdges, only, rows).svg;
}

export function renderDiagram(page: DiagramPage, allShapes: DiagramShape[], allEdges: DiagramEdge[], only?: number[], allRows: readonly DiagramRow[] = []): { svg: string; width: number; height: number } {
  const rows = rowsByShape(allRows);
  const byId = new Map(allShapes.map((shape) => [shape.id, shape]));
  let shapes = allShapes;
  let edges = allEdges;
  if (only) {
    const picked = new Set(only);
    const inPicked = (shape: DiagramShape): boolean =>
      picked.has(shape.id) || (shape.parentId !== null && !!byId.get(shape.parentId) && inPicked(byId.get(shape.parentId)!));
    shapes = allShapes.filter(inPicked);
    const kept = new Set(shapes.map((shape) => shape.id));
    edges = allEdges.filter((edge) => (edge.parentId !== null && kept.has(edge.parentId)) || ((edge.fromId !== null || edge.toId !== null)
      && (edge.fromId === null || kept.has(edge.fromId)) && (edge.toId === null || kept.has(edge.toId))));
  }
  const visible = shapes.filter((shape) => shape.kind !== "group" && (shape.kind !== "container" || shape.style.fill !== "transparent"));
  const markers: string[] = [];
  const paper = svgColor(page.background, "#ffffff");
  const edgeMarkup = edges.map((edge, index) => {
    const geometry = edgeGeometry(edge, byId, rows);
    if (!geometry) return "";
    const color = svgColor(edge.style.stroke, "#666666");
    // Each end its own head (ends.ts); hollow ones filled with the page so the line doesn't show through.
    const start = markerSvg(`start${index}`, edge.startArrow, color, paper, edge.style.strokeWidth);
    const end = markerSvg(`end${index}`, edge.endArrow, color, paper, edge.style.strokeWidth);
    markers.push(start, end);
    const mid = edgeLabelPoint(geometry);
    const label = (text: string, at: Point, dy = 0) =>
      text ? `<text x="${n(at.x)}" y="${n(at.y + dy)}" text-anchor="middle" dominant-baseline="central" fill="#222222">${esc(text)}</text>` : "";
    return `<path d="${geometry.d}" fill="none" stroke="${esc(color)}" stroke-width="${n(edge.style.strokeWidth)}" ${edge.style.dash ? 'stroke-dasharray="6 4"' : ""} ${start ? `marker-start="url(#start${index})"` : ""} ${end ? `marker-end="url(#end${index})"` : ""}/>`
      + label(edge.label, mid, -6) + label(edge.startLabel, endLabelPoint(geometry, "start")) + label(edge.endLabel, endLabelPoint(geometry, "end"));
  }).join("");
  const shapeMarkupText = visible.slice().sort((a, b) => a.z - b.z || a.id - b.id).map((shape) => shapeMarkup(shape, rows)).join("");
  const allBounds = [
    ...visible.map((shape) => turnedBounds(shape.x, shape.y, shape.w, shape.h, shape.rotation)),
    ...edges.flatMap((edge) => edgePoints(edge, byId, rows).map((point) => ({ left: point.x, top: point.y, right: point.x, bottom: point.y }))),
  ];
  const margin = only ? 8 : 24;
  const left = (allBounds.length ? Math.min(...allBounds.map((r) => r.left)) : 0) - margin;
  const top = (allBounds.length ? Math.min(...allBounds.map((r) => r.top)) : 0) - margin;
  const right = (allBounds.length ? Math.max(...allBounds.map((r) => r.right)) : 1) + margin;
  const bottom = (allBounds.length ? Math.max(...allBounds.map((r) => r.bottom)) : 1) + margin;
  const background = only ? "" : `<rect x="${n(left)}" y="${n(top)}" width="${n(right - left)}" height="${n(bottom - top)}" fill="${esc(paper)}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${n(right - left)}" height="${n(bottom - top)}" viewBox="${n(left)} ${n(top)} ${n(right - left)} ${n(bottom - top)}"><defs>${markers.join("")}</defs>${background}${edgeMarkup}${shapeMarkupText}</svg>`;
  return { svg, width: right - left, height: bottom - top };
}

export function nearestPort(shape: DiagramShape, point: { x: number; y: number }): Port {
  const choices: Port[] = ["n", "e", "s", "w"];
  return choices.reduce((best, port) => {
    const current = portPoint(shape, port);
    const selected = portPoint(shape, best);
    return Math.hypot(point.x - current.x, point.y - current.y) < Math.hypot(point.x - selected.x, point.y - selected.y) ? port : best;
  }, choices[0]);
}
