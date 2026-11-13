// Exporting layers as files. Every format starts from an SVG written from the layer data (not the screen), so
// exports look the same at any zoom; PNG, JPG and WEBP draw that SVG onto a canvas, PDF holds a JPG of it.
import { contentBlob, isLocal } from "../../../core/content";
import { saveExports, svgFile } from "../canvas/export";
import type { Editor } from "./editor";
import { boundsOf, cornersOf, svgGradient, type DesignNode, type Effect, type ExportSetting, type Paint, type Resolve } from "./model";
import { effectFilter, fontStyle, outlinePath, tintedSvg } from "./render";

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const num = (v: number) => String(Math.round(v * 1000) / 1000);
// Text as base64 of its UTF-8 bytes (btoa alone takes Latin-1 only).
const utf8Base64 = (text: string) => {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCodePoint(byte);
  return btoa(binary);
};

export interface SvgSource {
  node(id: number): DesignNode | undefined;
  world(id: number): { origin: { x: number; y: number }; angle: number };
  children(parent: number | null): number[];
  resolve: Resolve;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("The file couldn't be read."));
    reader.readAsDataURL(blob);
  });
}

// One layer and everything in it as SVG, in the page's coordinates.
class SvgWriter {
  private readonly defs: string[] = [];
  private next = 0;

  constructor(private readonly ed: SvgSource, private readonly resolve: Resolve) {}

  private id(prefix: string) {
    return `${prefix}${++this.next}`;
  }

  private paint(color: string, ref: number | null | undefined, opacity: number, kind: "fill" | "stroke") {
    const value = this.resolve({ color, ref });
    return `${kind}="${value}"${opacity < 1 ? ` ${kind}-opacity="${num(opacity)}"` : ""}`;
  }

  // A fill in the layer's own w x h box: its color, or its gradient added to the defs.
  private fill(f: Paint, n: DesignNode) {
    if (!f.gradient) return this.paint(f.color, f.ref, f.opacity, "fill");
    const id = this.id("grad");
    this.defs.push(svgGradient(f.gradient, id, n.width, n.height, f.opacity));
    return `fill="url(#${id})"`;
  }

  private filter(effects: Effect[]): string {
    const id = this.id("fx");
    const filter = effectFilter(effects, this.resolve, id);
    if (!filter) return "";
    this.defs.push(filter);
    return ` filter="url(#${id})"`;
  }

  private text(n: DesignNode): string {
    const t = n.props.textStyle;
    const style = fontStyle(t);
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = `${t.italic ? "italic " : ""}${t.weight} ${t.size}px ${style["font-family"]}`;
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${t.letterSpacing}px`;
    const m = ctx.measureText("Hg");
    const ascent = m.fontBoundingBoxAscent;
    const natural = ascent + m.fontBoundingBoxDescent;
    const lineHeight = t.lineHeight > 0 ? t.lineHeight * t.size : natural;
    // Wrapped the way the box wraps it: by words at the width, unless it grows sideways.
    const lines: string[] = [];
    for (const paragraph of n.props.text.split("\n")) {
      if (n.props.sizing === "width") {
        lines.push(paragraph);
        continue;
      }
      let line = "";
      for (const word of paragraph.split(/(?<=\s)/)) {
        if (line && ctx.measureText(line + word).width > n.width + 0.5) {
          lines.push(line.trimEnd());
          line = word;
        } else line += word;
      }
      lines.push(line);
    }
    const total = lines.length * lineHeight;
    const free = n.props.sizing === "fixed" ? n.height - total : 0;
    const top = { top: 0, middle: free / 2, bottom: free }[t.verticalAlign];
    const x = { left: 0, center: n.width / 2, right: n.width }[t.align];
    const anchor = { left: "start", center: "middle", right: "end" }[t.align];
    const fill = n.props.fills.find((f) => f.visible);
    const stroke = n.props.strokes.find((s) => s.visible && s.width > 0);
    const attrs = [
      `font-family="${esc(`${t.family}, sans-serif`)}"`, `font-size="${num(t.size)}"`, `font-weight="${t.weight}"`,
      t.italic ? `font-style="italic"` : "",
      t.underline || t.strike ? `text-decoration="${[t.underline && "underline", t.strike && "line-through"].filter(Boolean).join(" ")}"` : "", t.letterSpacing ? `letter-spacing="${num(t.letterSpacing)}"` : "",
      `text-anchor="${anchor}"`, `xml:space="preserve"`,
      fill ? this.fill(fill, n) : `fill="none"`,
      stroke ? `${this.paint(stroke.color, stroke.ref, stroke.opacity, "stroke")} stroke-width="${num(stroke.width)}" paint-order="stroke"` : "",
    ].filter(Boolean).join(" ");
    const spans = lines.map((line, i) =>
      `<tspan x="${num(x)}" y="${num(top + i * lineHeight + (lineHeight - natural) / 2 + ascent)}">${esc(line)}</tspan>`);
    return `<text ${attrs}>${spans.join("")}</text>`;
  }

  async node(id: number, transform: string): Promise<string> {
    const n = this.ed.node(id);
    if (!n?.props.visible) return "";
    const p = n.props;
    const out: string[] = [];
    const outline = outlinePath(n, 0);
    // Fills listed top first are drawn bottom first.
    if (n.kind !== "text" && n.kind !== "line" && n.kind !== "group")
      for (const f of [...p.fills].reverse().filter((f) => f.visible))
        out.push(`<path d="${outline}" ${this.fill(f, n)}/>`);
    let clip = "";
    if (n.kind === "image" || n.kind === "svg" || (n.kind === "frame" && p.clip)) {
      const cid = this.id("clip");
      this.defs.push(`<clipPath id="${cid}"><path d="${outline}"/></clipPath>`);
      clip = ` clip-path="url(#${cid})"`;
    }
    if (n.kind === "image" && n.url) {
      const href = isLocal(n.url) ? await blobToDataUrl(await contentBlob(n.url, "image/*")) : n.thumb;
      if (href) out.push(`<image href="${href}" width="${num(n.width)}" height="${num(n.height)}" preserveAspectRatio="xMidYMid slice"${clip}/>`);
    }
    if (n.kind === "svg" && p.svg)
      out.push(`<image href="data:image/svg+xml;base64,${utf8Base64(tintedSvg(n, this.ed.resolve))}" width="${num(n.width)}" height="${num(n.height)}"${clip}/>`);
    if (n.kind === "text") out.push(this.text(n));
    if (n.kind === "frame" || n.kind === "group") {
      const kids: string[] = [];
      for (const c of this.ed.children(id)) {
        const k = this.ed.node(c)!;
        kids.push(await this.node(c, `translate(${num(k.x + k.width / 2)} ${num(k.y + k.height / 2)}) rotate(${num(k.rotation)}) translate(${num(-k.width / 2)} ${num(-k.height / 2)})`));
      }
      out.push(`<g${clip}>${kids.join("")}</g>`);
    }
    if (n.kind !== "text" && n.kind !== "group")
      for (const s of [...p.strokes].reverse().filter((s) => s.visible && s.width > 0)) {
        const offset = n.kind === "line" || s.align === "center" ? 0 : s.align === "inside" ? -s.width / 2 : s.width / 2;
        out.push(`<path d="${outlinePath(n, offset)}" fill="none" ${this.paint(s.color, s.ref, s.opacity, "stroke")} stroke-width="${num(s.width)}"/>`);
      }
    const opacity = p.opacity < 1 ? ` opacity="${num(p.opacity)}"` : "";
    return `<g transform="${transform}"${opacity}${this.filter(p.effects)}>${out.join("")}</g>`;
  }

  // The layer alone, on a canvas the size of its box on the page plus room for strokes and shadows.
  async document(id: number): Promise<{ svg: string; width: number; height: number }> {
    const n = this.ed.node(id)!;
    const t = this.ed.world(id);
    const box = boundsOf(cornersOf(t, n.width, n.height));
    const reach = Math.max(0,
      ...n.props.strokes.filter((s) => s.visible).map((s) => (n.kind === "line" || s.align === "center" ? s.width / 2 : s.align === "outside" ? s.width : 0)),
      ...n.props.effects.filter((e) => e.visible && e.kind === "drop-shadow").map((e) => Math.max(Math.abs(e.x), Math.abs(e.y)) + e.blur + Math.max(0, e.spread)),
      ...n.props.effects.filter((e) => e.visible && e.kind === "layer-blur").map((e) => e.blur));
    const left = box.left - reach;
    const top = box.top - reach;
    const width = Math.max(1, box.right - box.left + reach * 2);
    const height = Math.max(1, box.bottom - box.top + reach * 2);
    const body = await this.node(id, `translate(${num(t.origin.x)} ${num(t.origin.y)}) rotate(${num(t.angle)})`);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}" viewBox="${num(left)} ${num(top)} ${num(width)} ${num(height)}">` +
      `<defs>${this.defs.join("")}</defs>${body}</svg>`;
    return { svg, width, height };
  }
}

export async function exportFile(ed: SvgSource, id: number, setting: ExportSetting): Promise<{ name: string; blob: Blob }> {
  const n = ed.node(id);
  if (!n) throw new Error(`Layer ${id} no longer exists.`);
  const { svg, width, height } = await new SvgWriter(ed, ed.resolve).document(id);
  return svgFile(svg, width, height, n.name || "Layer", setting);
}

// Exports each layer with each of its settings: one file is saved as it is, several go into one .zip.
export async function exportLayers(ed: Editor, ids: number[]): Promise<void> {
  const files: { name: string; blob: Blob }[] = [];
  for (const id of ids)
    for (const setting of ed.node(id)?.props.exports ?? []) files.push(await exportFile(ed, id, setting));
  await saveExports(files, ids.length === 1 ? ed.node(ids[0])?.name || "Export" : "Export");
}
