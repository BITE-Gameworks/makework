import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";
import type { DiagramStyle, EdgeKind, ShapeKind } from "./model";

export interface ImportedShape {
  ref: string;
  kind: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  text: string;
  style: DiagramStyle;
}

// An end without a shape (exports only) has a point instead.
export interface ImportedEdge {
  from: string;
  to: string;
  fromPoint?: { x: number; y: number };
  toPoint?: { x: number; y: number };
  kind: EdgeKind;
  startArrow: string;
  endArrow: string;
  label: string;
  startLabel?: string;
  endLabel?: string;
  style: { stroke: string; strokeWidth: number; dash: boolean };
}

// Our heads (ends.ts) as draw.io names them: a shape and whether it is filled.
const drawioHeads: [string, string, boolean][] = [
  ["arrow", "classic", true], ["open", "open", false], ["triangle", "block", false], ["diamond", "diamondThin", false],
  ["diamond-filled", "diamondThin", true], ["circle", "oval", false], ["dot", "oval", true],
  ["er-one", "ERone", false], ["er-mandatory-one", "ERmandOne", false], ["er-many", "ERmany", false],
  ["er-one-many", "ERoneToMany", false], ["er-zero-one", "ERzeroToOne", false], ["er-zero-many", "ERzeroToMany", false],
];

function drawioHead(name: string): { arrow: string; fill: boolean } {
  const [, arrow, fill] = drawioHeads.find(([ours]) => ours === name) ?? (name ? drawioHeads[0] : ["", "none", false]);
  return { arrow, fill };
}

// draw.io's head (its default end is a filled classic arrow) as ours; one we don't draw becomes an arrow, or a filled
// or hollow shape of the nearest kind.
function headFromDrawio(arrow: string | undefined, fill: string | undefined, fallback: string): string {
  if (arrow === undefined) return fallback;
  if (arrow === "none" || arrow === "") return "";
  const filled = fill !== "0";
  const er = drawioHeads.find(([, theirs]) => theirs === arrow && theirs.startsWith("ER"));
  if (er) return er[0];
  const exact = drawioHeads.find(([, theirs, full]) => theirs === arrow && full === filled);
  if (exact) return exact[0];
  if (/diamond/i.test(arrow)) return filled ? "diamond-filled" : "diamond";
  if (/oval|circle/i.test(arrow)) return filled ? "dot" : "circle";
  if (/block|classic/i.test(arrow)) return filled ? "arrow" : "triangle";
  if (/open/i.test(arrow)) return "open";
  return "arrow";
}

const escapeXml = (value: string) => value.replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
}[c]!));
const decodeXml = (value: string) => value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
  if (entity.startsWith("#")) {
    const code = entity[1].toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  }
  return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()] ?? match;
});
const attrs = (text: string) => Object.fromEntries([...text.matchAll(/(?<![\w:-])([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], decodeXml(m[2])]));
const escapeXmlAttribute = (value: string) => escapeXml(value);
const escapeBase64 = (bytes: Uint8Array) => {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(raw);
};

export function encodeDrawio(shapes: ImportedShape[], edges: ImportedEdge[], pageName = "Page 1"): string {
  const cells = shapes.map((shape, index) => {
    const id = escapeXmlAttribute(shape.ref || String(index + 2));
    const fill = shape.style.fill.startsWith("#") ? shape.style.fill : "#ffffff";
    const stroke = shape.style.stroke.startsWith("#") ? shape.style.stroke : "#333333";
    // A structured shape goes out as its header box for now (its rows: step B, as draw.io's stacked child cells).
    const styleKind: Partial<Record<ShapeKind, string>> = {
      rect: "rectangle", rounded: "rounded=1", ellipse: "ellipse", diamond: "rhombus", parallelogram: "parallelogram",
      cylinder: "cylinder", document: "shape=document", actor: "shape=umlActor", cloud: "cloud", note: "shape=note",
      text: "text", image: "image", icon: "image", container: "swimlane", swimlane: "swimlane", group: "group",
    };
    const style = `shape=${styleKind[shape.kind] ?? "swimlane"};fillColor=${fill};strokeColor=${stroke};fontColor=${shape.style.textColor.startsWith("#") ? shape.style.textColor : "#222222"};fontSize=${shape.style.fontSize};align=${shape.style.align};${shape.style.dash ? "dashed=1;" : ""}rotation=${shape.rotation};`;
    return `<mxCell id="${id}" value="${escapeXmlAttribute(shape.text)}" style="${escapeXmlAttribute(style)}" vertex="1" parent="1"><mxGeometry x="${shape.x}" y="${shape.y}" width="${shape.w}" height="${shape.h}" as="geometry"/></mxCell>`;
  }).join("");
  const edgeCells = edges.map((edge, index) => {
    const from = escapeXmlAttribute(edge.from);
    const to = escapeXmlAttribute(edge.to);
    const id = `edge${index + 1}`;
    const start = drawioHead(edge.startArrow);
    const end = drawioHead(edge.endArrow);
    const style = `edgeStyle=${edge.kind === "orthogonal" ? "orthogonalEdgeStyle" : "none"};strokeColor=${edge.style.stroke.startsWith("#") ? edge.style.stroke : "#555555"};strokeWidth=${edge.style.strokeWidth};dashed=${edge.style.dash ? 1 : 0};startArrow=${start.arrow};startFill=${start.fill ? 1 : 0};endArrow=${end.arrow};endFill=${end.fill ? 1 : 0};`;
    const ends = `${edge.fromPoint ? "" : ` source="${from}"`}${edge.toPoint ? "" : ` target="${to}"`}`;
    const points = `${edge.fromPoint ? `<mxPoint x="${edge.fromPoint.x}" y="${edge.fromPoint.y}" as="sourcePoint"/>` : ""}${edge.toPoint ? `<mxPoint x="${edge.toPoint.x}" y="${edge.toPoint.y}" as="targetPoint"/>` : ""}`;
    // An end's label is a child cell of the connector, at its source (x = -1) or target (x = 1).
    const endLabel = (text: string | undefined, side: "s" | "t") => text
      ? `<mxCell id="${id}-${side}" value="${escapeXmlAttribute(text)}" style="edgeLabel;resizable=0;html=1;align=${side === "s" ? "left" : "right"};verticalAlign=bottom;" vertex="1" connectable="0" parent="${id}"><mxGeometry x="${side === "s" ? -1 : 1}" relative="1" as="geometry"><mxPoint as="offset"/></mxGeometry></mxCell>`
      : "";
    return `<mxCell id="${id}" value="${escapeXmlAttribute(edge.label)}" style="${escapeXmlAttribute(style)}" edge="1"${ends} parent="1"><mxGeometry relative="1" as="geometry">${points}</mxGeometry></mxCell>`
      + endLabel(edge.startLabel, "s") + endLabel(edge.endLabel, "t");
  }).join("");
  const model = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}${edgeCells}</root></mxGraphModel>`;
  const packed = escapeBase64(deflateSync(strToU8(encodeURIComponent(model))));
  return `<mxfile host="app.diagrams.net" version="24.7.17"><diagram name="${escapeXmlAttribute(pageName)}" id="makework">${packed}</diagram></mxfile>`;
}

function decodeCompressed(text: string): string | null {
  const compact = text.trim().replace(/\s/g, "");
  try {
    const bytes = Uint8Array.from(atob(compact), (char) => char.charCodeAt(0));
    const inflated = strFromU8(inflateSync(bytes));
    try {
      return decodeURIComponent(inflated);
    } catch {
      return inflated;
    }
  } catch {
    return null;
  }
}

function modelXml(input: string): string {
  const raw = input.trim().replace(/^\uFEFF/, "").replace(/^<\?xml\b[^?]*\?>\s*/i, "");
  if (raw.startsWith("<mxGraphModel")) return raw;
  if (!raw.startsWith("<mxfile")) {
    const unpacked = decodeCompressed(raw);
    if (unpacked) return modelXml(unpacked);
    throw new Error("This is not a supported .drawio document.");
  }
  const diagram = /<diagram\b[^>]*>([\s\S]*?)<\/diagram>/i.exec(raw)?.[1]?.trim();
  if (!diagram) throw new Error("The .drawio file has no diagram page.");
  if (diagram.startsWith("<mxGraphModel")) return diagram;
  const unpacked = decodeCompressed(diagram);
  if (unpacked?.includes("<mxGraphModel")) return modelXml(unpacked);
  try {
    const decoded = decodeURIComponent(atob(diagram));
    if (decoded.includes("<mxGraphModel")) return modelXml(decoded);
  } catch {
    // Report the useful invalid-format error below.
  }
  throw new Error("The .drawio page uses an unsupported encoding.");
}

function styleValues(style: string): Record<string, string> {
  return Object.fromEntries(style.split(";").filter(Boolean).map((entry) => {
    const index = entry.indexOf("=");
    return index < 0 ? [entry, "1"] : [entry.slice(0, index), entry.slice(index + 1)];
  }));
}

function kindOf(style: Record<string, string>): ShapeKind {
  const kind = `${style.shape ?? ""} ${Object.keys(style).join(" ")}`.toLowerCase();
  if (kind.includes("ellipse")) return "ellipse";
  if (kind.includes("rhombus") || kind.includes("diamond")) return "diamond";
  if (kind.includes("parallelogram")) return "parallelogram";
  if (kind.includes("cylinder")) return "cylinder";
  if (kind.includes("document")) return "document";
  if (kind.includes("actor") || kind.includes("umlactor")) return "actor";
  if (kind.includes("cloud")) return "cloud";
  if (kind.includes("note")) return "note";
  if (kind.includes("swimlane")) return "swimlane";
  if (kind.includes("text")) return "text";
  if (kind.includes("image")) return "icon";
  if (kind.includes("rounded")) return "rounded";
  return "rect";
}

const finite = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function importDrawio(input: string): { shapes: ImportedShape[]; edges: ImportedEdge[] } {
  const xml = modelXml(input);
  const shapes: ImportedShape[] = [];
  const edges: ImportedEdge[] = [];
  const cells = new Map<string, ImportedShape>();
  const all = [...xml.matchAll(/<mxCell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mxCell>)/gi)].map((match) => ({ cell: attrs(match[1]), body: match[2] ?? "" }));
  // Labels at a connector's ends are cells inside it: the label nearest each end, kept by connector id.
  const edgeIds = new Set(all.filter(({ cell }) => cell.edge).map(({ cell }) => cell.id));
  const endLabels = new Map<string, { start?: string; end?: string; middle?: string }>();
  for (const { cell, body } of all) {
    if (!cell.vertex || !cell.parent || !edgeIds.has(cell.parent)) continue;
    const at = finite(attrs(/<mxGeometry\b([^>]*?)(?:\/>|>)/i.exec(body)?.[1] ?? "").x, 0);
    const labels = endLabels.get(cell.parent) ?? {};
    labels[at <= -0.5 ? "start" : at >= 0.5 ? "end" : "middle"] = cell.value ?? "";
    endLabels.set(cell.parent, labels);
  }
  for (const { cell, body } of all) {
    if (cell.id === "0" || cell.id === "1" || (!cell.vertex && !cell.edge)) continue;
    if (cell.parent && edgeIds.has(cell.parent)) continue;
    const style = styleValues(cell.style ?? "");
    if (cell.edge) {
      if (!cell.source || !cell.target) continue;
      const labels = endLabels.get(cell.id) ?? {};
      edges.push({
        from: cell.source, to: cell.target, kind: style.edgeStyle?.toLowerCase().includes("orthogonal") ? "orthogonal" : "straight",
        startArrow: headFromDrawio(style.startArrow, style.startFill, ""),
        endArrow: headFromDrawio(style.endArrow, style.endFill, "arrow"), label: cell.value || labels.middle || "",
        startLabel: labels.start ?? "", endLabel: labels.end ?? "",
        style: {
          stroke: /^#[0-9a-f]{6}$/i.test(style.strokeColor ?? "") ? style.strokeColor : "var(--mw-text-muted)",
          strokeWidth: Math.max(0.5, finite(style.strokeWidth, 1.5)), dash: style.dashed === "1",
        },
      });
      continue;
    }
    const geometryText = /<mxGeometry\b([^>]*?)(?:\/>|>)/i.exec(body)?.[1] ?? "";
    const geometry = attrs(geometryText);
    const kind = kindOf(style);
    const textStyleColor = style.fontColor && /^#[0-9a-f]{6}$/i.test(style.fontColor) ? style.fontColor : "var(--mw-text)";
    const shape: ImportedShape = {
      ref: cell.id, kind, x: finite(geometry.x, 0), y: finite(geometry.y, 0),
      w: Math.max(1, finite(geometry.width, 120)), h: Math.max(1, finite(geometry.height, 64)),
      rotation: finite(style.rotation, 0), text: cell.value ?? "",
      style: {
        fill: style.fillColor && /^#[0-9a-f]{6}$/i.test(style.fillColor) ? style.fillColor : "var(--mw-light)",
        stroke: style.strokeColor && /^#[0-9a-f]{6}$/i.test(style.strokeColor) ? style.strokeColor : "var(--mw-text)",
        strokeWidth: Math.max(0, finite(style.strokeWidth, 1.5)), textColor: textStyleColor,
        fontSize: Math.max(6, Math.min(96, finite(style.fontSize, 14))),
        align: style.align === "left" || style.align === "right" ? style.align : "center", dash: style.dashed === "1",
      },
    };
    shapes.push(shape);
    cells.set(shape.ref, shape);
  }
  return {
    shapes,
    edges: edges.filter((edge) => cells.has(edge.from) && cells.has(edge.to)),
  };
}
