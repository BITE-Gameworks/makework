// A connector's ends: what is drawn where it meets a shape. Plain arrows, the UML heads (generalization's hollow
// triangle, aggregation's and composition's diamonds) and the ER cardinalities (crow's feet), each defined once as
// data and drawn from it in the view, in exports and as its icon. Stored by name in `start_arrow` / `end_arrow`.
// Presets set both ends (and the dash) for the usual UML and ER connectors.

// A head is drawn along the line, its tip at the right (x = width, y = height / 2), where the line ends; at the start
// the marker turns around (orient auto-start-reverse). Parts: filled in the line's color, hollow (outlined, filled
// with the background so the line doesn't show through), or line (strokes only).
interface Part {
  d: string;
  paint: "fill" | "hollow" | "line";
}

export interface Head {
  name: string;
  label: string;
  width: number;
  height: number;
  parts: Part[];
}

const circle = (cx: number, cy: number, r: number) => `M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;

export const heads: Head[] = [
  { name: "arrow", label: "Arrow", width: 10, height: 8, parts: [{ d: "M 0 0 L 10 4 L 0 8 Z", paint: "fill" }] },
  { name: "open", label: "Open arrow", width: 10, height: 8, parts: [{ d: "M 0 0 L 10 4 L 0 8", paint: "line" }] },
  { name: "triangle", label: "Hollow triangle", width: 12, height: 10, parts: [{ d: "M 0.5 0.5 L 11.5 5 L 0.5 9.5 Z", paint: "hollow" }] },
  { name: "diamond", label: "Hollow diamond", width: 16, height: 8, parts: [{ d: "M 0.5 4 L 8 0.5 L 15.5 4 L 8 7.5 Z", paint: "hollow" }] },
  { name: "diamond-filled", label: "Filled diamond", width: 16, height: 8, parts: [{ d: "M 0 4 L 8 0 L 16 4 L 8 8 Z", paint: "fill" }] },
  { name: "circle", label: "Circle", width: 8, height: 8, parts: [{ d: circle(4, 4, 3.5), paint: "hollow" }] },
  { name: "dot", label: "Dot", width: 8, height: 8, parts: [{ d: circle(4, 4, 4), paint: "fill" }] },
  { name: "er-one", label: "One", width: 12, height: 12, parts: [{ d: "M 6 0 L 6 12", paint: "line" }] },
  { name: "er-mandatory-one", label: "Exactly one", width: 12, height: 12, parts: [{ d: "M 4 0 L 4 12 M 8 0 L 8 12", paint: "line" }] },
  { name: "er-many", label: "Many", width: 12, height: 12, parts: [{ d: "M 0 6 L 12 0 M 0 6 L 12 12", paint: "line" }] },
  { name: "er-one-many", label: "One or many", width: 16, height: 12, parts: [{ d: "M 2 0 L 2 12 M 4 6 L 16 0 M 4 6 L 16 12", paint: "line" }] },
  { name: "er-zero-one", label: "Zero or one", width: 18, height: 12, parts: [
    { d: "M 13 0 L 13 12", paint: "line" }, { d: circle(4.5, 6, 3.5), paint: "hollow" },
  ] },
  { name: "er-zero-many", label: "Zero or many", width: 20, height: 12, parts: [
    { d: "M 8 6 L 20 0 M 8 6 L 20 12", paint: "line" }, { d: circle(4.5, 6, 3.5), paint: "hollow" },
  ] },
];

const byName = new Map(heads.map((head) => [head.name, head]));

// No head for "", the head by its name, and an arrow for a name this app doesn't know (written by a newer one).
export function headOf(name: string): Head | null {
  if (!name) return null;
  return byName.get(name) ?? byName.get("arrow")!;
}

// How much bigger than its own units a head is drawn: it grows with the line, but more slowly, so a thick line
// doesn't end in a huge head.
export const headScale = (strokeWidth: number) => Math.max(1.2, Math.sqrt(Math.max(0.5, strokeWidth)) * 1.25);

// What a part of a head is painted with.
export function partPaint(part: Part, color: string, background: string, strokeWidth: number) {
  const width = strokeWidth / headScale(strokeWidth);
  if (part.paint === "fill") return { fill: color, stroke: "none", strokeWidth: 0 };
  if (part.paint === "hollow") return { fill: background, stroke: color, strokeWidth: width };
  return { fill: "none", stroke: color, strokeWidth: width };
}

// The marker's size and anchor, in the line's coordinates.
export function markerFrame(head: Head, strokeWidth: number) {
  const scale = headScale(strokeWidth);
  return {
    width: head.width * scale, height: head.height * scale, refX: head.width, refY: head.height / 2,
    viewBox: `0 0 ${head.width} ${head.height}`,
  };
}

const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
const n = (value: number) => Number(value.toFixed(2));

// A head as an SVG <marker> for exports ("" for no head). The view draws the same frame and parts as elements.
export function markerSvg(id: string, name: string, color: string, background: string, strokeWidth: number): string {
  const head = headOf(name);
  if (!head) return "";
  const frame = markerFrame(head, strokeWidth);
  const parts = head.parts.map((part) => {
    const paint = partPaint(part, color, background, strokeWidth);
    return `<path d="${part.d}" fill="${esc(paint.fill)}" stroke="${esc(paint.stroke)}" stroke-width="${n(paint.strokeWidth)}" stroke-linejoin="round"/>`;
  }).join("");
  return `<marker id="${esc(id)}" markerUnits="userSpaceOnUse" markerWidth="${n(frame.width)}" markerHeight="${n(frame.height)}" refX="${frame.refX}" refY="${frame.refY}" viewBox="${frame.viewBox}" orient="auto-start-reverse" overflow="visible">${parts}</marker>`;
}

// A connector as an icon (a data URL `Icon` takes as its name): a short line with its start head (turned around) and
// its end head, dashed when it is. Icons are drawn as a mask in the text color, so a hollow part can't be filled with
// the background: it cuts the line out instead.
export function connectorIcon(start: string, end: string, dash: boolean): string {
  const ends = [{ head: headOf(start), tip: 2, turned: true }, { head: headOf(end), tip: 22, turned: false }];
  // Two heads share the icon's width.
  const room = ends.every((item) => item.head) ? 9 : 14;
  const placed = ends.flatMap(({ head, tip, turned }) => {
    if (!head) return [];
    const scale = Math.min(room / head.width, 12 / head.height);
    const x = turned ? tip + head.width * scale : tip - head.width * scale;
    return [{ head, at: `translate(${n(x)} ${n(12 - (head.height * scale) / 2)}) scale(${n(turned ? -scale : scale)} ${n(scale)})` }];
  });
  const drawn = placed.map(({ head, at }) => `<g transform="${at}">${head.parts.map((part) => part.paint === "fill"
    ? `<path d="${part.d}" fill="black"/>`
    : `<path d="${part.d}" fill="none" stroke="black" stroke-width="1.6" vector-effect="non-scaling-stroke"/>`).join("")}</g>`).join("");
  const hollow = placed.map(({ head, at }) =>
    `<g transform="${at}">${head.parts.filter((part) => part.paint === "hollow").map((part) => `<path d="${part.d}" fill="black"/>`).join("")}</g>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><mask id="m"><rect width="24" height="24" fill="white"/>${hollow}</mask>`
    + `<path d="M 2 12 L 22 12" stroke="black" stroke-width="1.8"${dash ? ' stroke-dasharray="3 2"' : ""} mask="url(#m)"/>${drawn}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// A head alone, as the end pickers show it: a line ending in it.
export const headIcon = (name: string) => connectorIcon("", name, false);

export interface Preset {
  id: string;
  label: string;
  // What it means, in the library under its name.
  description: string;
  // Its library section.
  group: "flow" | "uml" | "er";
  start: string;
  end: string;
  dash: boolean;
}

// The usual connectors of UML class diagrams, ER models and flowcharts. In UML the diamond is at the whole (the
// connector's start), the triangle at the general class (its end).
export const presets: Preset[] = [
  {
    id: "flow", label: "Flow", description: "Then: one step leads to the next",
    group: "flow", start: "", end: "arrow", dash: false,
  },
  {
    id: "association", label: "Association", description: "A and B know each other",
    group: "uml", start: "", end: "", dash: false,
  },
  {
    id: "directed-association", label: "Directed association", description: "A knows B (B doesn't know A)",
    group: "uml", start: "", end: "open", dash: false,
  },
  {
    id: "generalization", label: "Generalization", description: "A inherits from B (B is the general one)",
    group: "uml", start: "", end: "triangle", dash: false,
  },
  {
    id: "realization", label: "Realization", description: "A implements interface B",
    group: "uml", start: "", end: "triangle", dash: true,
  },
  {
    id: "dependency", label: "Dependency", description: "A uses B (changes to B may affect A)",
    group: "uml", start: "", end: "open", dash: true,
  },
  {
    id: "aggregation", label: "Aggregation", description: "A has B; B can live without A",
    group: "uml", start: "diamond", end: "", dash: false,
  },
  {
    id: "composition", label: "Composition", description: "A owns B; B goes when A goes",
    group: "uml", start: "diamond-filled", end: "", dash: false,
  },
  {
    id: "one-to-one", label: "One to one", description: "Each A has exactly one B, and back",
    group: "er", start: "er-mandatory-one", end: "er-mandatory-one", dash: false,
  },
  {
    id: "one-to-many", label: "One to many", description: "One A has many B; each B has one A",
    group: "er", start: "er-mandatory-one", end: "er-many", dash: false,
  },
  {
    id: "many-to-many", label: "Many to many", description: "Many A go with many B (a join table)",
    group: "er", start: "er-many", end: "er-many", dash: false,
  },
  {
    id: "zero-one-to-zero-many", label: "Zero or one to zero or many", description: "An A may have any number of B; a B at most one A",
    group: "er", start: "er-zero-one", end: "er-zero-many", dash: false,
  },
];

// The preset a connector's ends and dash match, if any.
export function presetOf(edge: { startArrow: string; endArrow: string; style: { dash: boolean } }): Preset | undefined {
  return presets.find((preset) => preset.start === edge.startArrow && preset.end === edge.endArrow && preset.dash === edge.style.dash);
}
