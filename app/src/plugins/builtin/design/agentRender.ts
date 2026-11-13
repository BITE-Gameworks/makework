// A quick picture of a whole design channel for agents to look at: layers drawn in order as plain SVG (paths, rectangles,
// ellipses, text, nested groups and frames; no effects or rotation), then turned into a PNG data URL.
import type { DesignNode } from "./model";
import { pathData, scaledPaths } from "./vector";

const firstPaint = (list: { color: string; visible?: boolean }[] | undefined) => (list ?? []).find((p) => p.visible !== false)?.color;
const escapeHtml =(text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]!);

export function designSvg(nodes: DesignNode[], maxSide = 640): { svg: string; width: number; height: number } {
  const children = new Map<number | null, DesignNode[]>();
  for (const n of nodes) (children.get(n.parentId) ?? children.set(n.parentId, []).get(n.parentId)!).push(n);
  const draw = (parent: number | null, ox: number, oy: number): string => (children.get(parent) ?? []).slice().sort((a, b) => a.z - b.z).map((n) => {
    const x = ox + n.x, y = oy + n.y;
    const fill = firstPaint(n.props.fills) ?? "none";
    const stroke = firstPaint(n.props.strokes);
    const look = `fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${n.props.strokes[0]?.width ?? 1}"` : ""}`;
    if (n.kind === "path" && n.props.vector) return `<path transform="translate(${x} ${y})" d="${pathData(scaledPaths(n.props.vector, n.width, n.height))}" ${look}/>`;
    if (n.kind === "rect") return `<rect x="${x}" y="${y}" width="${n.width}" height="${n.height}" rx="${n.props.radius || 0}" ${look}/>`;
    if (n.kind === "frame") return `<rect x="${x}" y="${y}" width="${n.width}" height="${n.height}" ${look}/>${draw(n.id, x, y)}`;
    if (n.kind === "ellipse") return `<ellipse cx="${x + n.width / 2}" cy="${y + n.height / 2}" rx="${n.width / 2}" ry="${n.height / 2}" ${look}/>`;
    if (n.kind === "text") return `<text x="${x}" y="${y + n.props.textStyle.size}" font-size="${n.props.textStyle.size}" fill="${fill === "none" ? "#ffffff" : fill}">${escapeHtml(n.props.text || n.name)}</text>`;
    if (n.kind === "group") return draw(n.id, x, y);
    return "";
  }).join("");
  const body = draw(null, 0, 0);
  const boxes = nodes.filter((n) => n.parentId === null);
  const left = Math.min(0, ...boxes.map((n) => n.x)) - 10, top = Math.min(0, ...boxes.map((n) => n.y)) - 10;
  const right = Math.max(100, ...boxes.map((n) => n.x + n.width)) + 10, bottom = Math.max(100, ...boxes.map((n) => n.y + n.height)) + 10;
  const k = maxSide / Math.max(right - left, bottom - top);
  const width = Math.round((right - left) * k), height = Math.round((bottom - top) * k);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${left} ${top} ${right - left} ${bottom - top}">`
    + `<rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" fill="#c8d0e0"/>${body}</svg>`;
  return { svg, width, height };
}

export async function designPng(nodes: DesignNode[]): Promise<string> {
  const { svg, width, height } = designSvg(nodes);
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/png");
}
