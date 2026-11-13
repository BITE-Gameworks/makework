import type { JSX } from "solid-js";
import { pathData, scaledPaths } from "./vector";
import { attributeText, cornerSizes, cssColor, cssGradient, type DesignNode, type Effect, type Props, type Resolve, type Stroke, type TextStyle } from "./model";

const fallbackFonts = "sans-serif";

export function fontStyle(t: TextStyle): JSX.CSSProperties {
  return {
    "font-family": `"${t.family.replaceAll('"', "")}", ${fallbackFonts}`,
    "font-size": `${t.size}px`,
    "font-weight": t.weight,
    "font-style": t.italic ? "italic" : "normal",
    "text-align": t.align,
    "line-height": t.lineHeight > 0 ? String(t.lineHeight) : "normal",
    "letter-spacing": `${t.letterSpacing}px`,
    "text-decoration-line": [t.underline && "underline", t.strike && "line-through"].filter(Boolean).join(" ") || undefined,
  };
}

const visibleEffects = (p: Props, ...kinds: Effect["kind"][]) => p.effects.filter((e) => e.visible && kinds.includes(e.kind));
const shadowColor = (e: Effect, resolve: Resolve) => cssColor({ color: e.color, ref: e.ref, opacity: e.opacity, visible: true }, resolve);
const isCut = (n: DesignNode) => n.props.corners === "cut" && cornerSizes(n).some((c) => c > 0);
// Box shadows follow rounded corners but are hidden by clip-path, so cut corners and text shadow with a filter.
const shadowsAsFilter = (n: DesignNode) => n.kind === "text" || n.kind === "line" || n.kind === "svg" || n.kind === "path" || isCut(n);

const num = (v: number) => String(Math.round(v * 1000) / 1000);

// Shadows and blurs as one SVG filter: drop shadows behind, the layer, inner shadows on it, then layer blur.
export function effectFilter(effects: Effect[], resolve: Resolve, id: string): string | null {
  const shown = effects.filter((e) => e.visible && e.kind !== "background-blur");
  if (shown.length === 0) return null;
  const parts: string[] = [];
  const merge: string[] = [];
  shown.filter((e) => e.kind === "drop-shadow").forEach((e, i) => {
    const color = resolve({ color: e.color, ref: e.ref });
    parts.push(
      `<feMorphology in="SourceAlpha" operator="${e.spread < 0 ? "erode" : "dilate"}" radius="${num(Math.abs(e.spread))}" result="ds${i}a"/>`,
      `<feOffset in="ds${i}a" dx="${num(e.x)}" dy="${num(e.y)}" result="ds${i}b"/>`,
      `<feGaussianBlur in="ds${i}b" stdDeviation="${num(e.blur / 2)}" result="ds${i}c"/>`,
      `<feFlood flood-color="${attributeText(color)}" flood-opacity="${num(e.opacity)}"/>`,
      `<feComposite in2="ds${i}c" operator="in" result="ds${i}"/>`,
    );
    merge.push(`ds${i}`);
  });
  merge.push("SourceGraphic");
  shown.filter((e) => e.kind === "inner-shadow").forEach((e, i) => {
    const color = resolve({ color: e.color, ref: e.ref });
    parts.push(
      `<feFlood flood-color="${attributeText(color)}" flood-opacity="${num(e.opacity)}"/>`,
      `<feComposite in2="SourceAlpha" operator="out" result="is${i}a"/>`,
      `<feOffset in="is${i}a" dx="${num(e.x)}" dy="${num(e.y)}" result="is${i}b"/>`,
      `<feGaussianBlur in="is${i}b" stdDeviation="${num(e.blur / 2)}" result="is${i}c"/>`,
      `<feComposite in="is${i}c" in2="SourceAlpha" operator="in" result="is${i}"/>`,
    );
    merge.push(`is${i}`);
  });
  parts.push(`<feMerge result="all">${merge.map((m) => `<feMergeNode in="${m}"/>`).join("")}</feMerge>`);
  const blur = shown.find((e) => e.kind === "layer-blur");
  if (blur) parts.push(`<feGaussianBlur in="all" stdDeviation="${num(blur.blur / 2)}"/>`);
  return `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">${parts.join("")}</filter>`;
}

// Corners as CSS: rounded corners as border-radius, cut corners as a clip-path polygon.
export function cornerStyle(n: DesignNode): JSX.CSSProperties {
  if (n.kind === "ellipse") return { "border-radius": "50%" };
  const [a, b, c, d] = cornerSizes(n);
  if (a + b + c + d === 0) return {};
  if (n.props.corners === "round") return { "border-radius": `${a}px ${b}px ${c}px ${d}px` };
  const w = n.width;
  const h = n.height;
  const points = [[a, 0], [w - b, 0], [w, b], [w, h - c], [w - c, h], [d, h], [0, h - d], [0, a]];
  return { "clip-path": `polygon(${points.map(([x, y]) => `${x}px ${y}px`).join(", ")})` };
}

// The layer's box: place, size, opacity, layer blur, and shadows that have to be filters. A group has no shape of
// its own, so its effects are the SVG filter `filterId` (from `effectFilter`), drawn around its children.
export function boxStyle(n: DesignNode, resolve: Resolve, filterId?: string): JSX.CSSProperties {
  const p = n.props;
  const filters = n.kind === "group" ? (filterId ? [`url(#${filterId})`] : []) : [
    ...(shadowsAsFilter(n) ? visibleEffects(p, "drop-shadow").map((e) => `drop-shadow(${e.x}px ${e.y}px ${e.blur / 2}px ${shadowColor(e, resolve)})`) : []),
    ...visibleEffects(p, "layer-blur").map((e) => `blur(${e.blur / 2}px)`),
  ];
  return {
    width: `${n.width}px`,
    height: `${n.height}px`,
    transform: `translate(${n.x}px, ${n.y}px) rotate(${n.rotation}deg)`,
    opacity: p.opacity < 1 ? p.opacity : undefined,
    display: p.visible ? undefined : "none",
    filter: filters.length ? filters.join(" ") : undefined,
  };
}

// Fills listed top first become CSS backgrounds, which also stack top first.
function backgrounds(props: Props, resolve: Resolve): string | undefined {
  const fills = props.fills.filter((f) => f.visible);
  if (fills.length === 0) return undefined;
  return fills.map((f) => (f.gradient ? cssGradient(f.gradient, f.opacity) : `linear-gradient(${cssColor(f, resolve)}, ${cssColor(f, resolve)})`)).join(", ");
}

// A group's background blur, which its shapes take on (`fillStyle`'s `backdrop`).
export const backgroundBlurs = (n: DesignNode) => visibleEffects(n.props, "background-blur").map((e) => `blur(${e.blur / 2}px)`);

// The shape's fill, with shadows that can be box shadows and background blur, plus `backdrop` from its groups.
export function fillStyle(n: DesignNode, resolve: Resolve, backdrop: string[] = []): JSX.CSSProperties {
  const p = n.props;
  const shadows = [
    ...(shadowsAsFilter(n) ? [] : visibleEffects(p, "drop-shadow")
      .map((e) => `${e.x}px ${e.y}px ${e.blur}px ${e.spread}px ${shadowColor(e, resolve)}`)),
    ...visibleEffects(p, "inner-shadow").map((e) => `inset ${e.x}px ${e.y}px ${e.blur}px ${e.spread}px ${shadowColor(e, resolve)}`),
  ];
  const blurs = [...backdrop, ...backgroundBlurs(n)];
  return {
    ...cornerStyle(n),
    "background-image": backgrounds(p, resolve),
    "box-shadow": shadows.length ? shadows.join(", ") : undefined,
    "backdrop-filter": blurs.length ? blurs.join(" ") : undefined,
  };
}

// The box text sits in: wrapping, and where it sits vertically when the box is taller.
export function textBoxStyle(n: DesignNode): JSX.CSSProperties {
  const align = { top: "flex-start", middle: "center", bottom: "flex-end" }[n.props.textStyle.verticalAlign];
  return { "justify-content": n.props.sizing === "fixed" ? align : "flex-start" };
}

export function textStyle(n: DesignNode, resolve: Resolve): JSX.CSSProperties {
  const p = n.props;
  const fill = p.fills.find((f) => f.visible);
  const stroke = p.strokes.find((s) => s.visible && s.width > 0);
  // A gradient shows through the letters.
  const gradient = fill?.gradient ? { "background-image": cssGradient(fill.gradient, fill.opacity), "background-clip": "text", "-webkit-background-clip": "text" } : {};
  return {
    ...fontStyle(p.textStyle),
    ...gradient,
    color: fill && !fill.gradient ? cssColor(fill, resolve) : "transparent",
    "-webkit-text-stroke": stroke ? `${stroke.width}px ${cssColor(stroke, resolve)}` : undefined,
    "paint-order": stroke ? "stroke fill" : undefined,
  };
}

const offsetOf = (s: Stroke, kind: DesignNode["kind"]) =>
  kind === "line" || kind === "path" || s.align === "center" ? 0 : s.align === "inside" ? -s.width / 2 : s.width / 2;

// The outline of a layer grown by `d` (shrunk when negative), as an SVG path in the layer's coordinates.
export function outlinePath(n: DesignNode, d: number): string {
  const w = n.width;
  const h = n.height;
  if (n.kind === "line") return `M 0 0 H ${w}`;
  if (n.kind === "path") return vectorPath(n);
  if (n.kind === "ellipse") {
    const rx = Math.max(0, w / 2 + d);
    const ry = Math.max(0, h / 2 + d);
    return `M ${w / 2 - rx} ${h / 2} a ${rx} ${ry} 0 1 0 ${rx * 2} 0 a ${rx} ${ry} 0 1 0 ${-rx * 2} 0 Z`;
  }
  const [l, t, r, b] = [-d, -d, w + d, h + d];
  const cut = n.props.corners === "cut";
  // Offsetting a 45 degree cut by d moves where it meets the sides by d * (2 - sqrt 2).
  const size = (c: number) => (c <= 0 ? 0 : Math.max(0, cut ? c + d * (2 - Math.SQRT2) : c + d));
  const [a, bb, c, dd] = cornerSizes(n).map(size);
  const corner = (r0: number, x: number, y: number) => (cut ? `L ${x} ${y}` : `A ${r0} ${r0} 0 0 1 ${x} ${y}`);
  return [
    `M ${l + a} ${t}`, `H ${r - bb}`, corner(bb, r, t + bb),
    `V ${b - c}`, corner(c, r - c, b),
    `H ${l + dd}`, corner(dd, l, b - dd),
    `V ${t + a}`, corner(a, l + a, t), "Z",
  ].join(" ");
}

// A path layer's outline at its box size; path strokes always sit on the center.
export const vectorPath = (n: DesignNode) => (n.props.vector ? pathData(scaledPaths(n.props.vector, n.width, n.height)) : "");

// Strokes drawn top first: the first in the list ends up on top.
export function strokePaths(n: DesignNode, resolve: Resolve): { d: string; stroke: string; width: number }[] {
  if (n.kind === "text" || n.kind === "group") return [];
  return n.props.strokes.filter((s) => s.visible && s.width > 0).reverse()
    .map((s) => ({ d: outlinePath(n, offsetOf(s, n.kind)), stroke: cssColor(s, resolve), width: s.width }));
}

// The size text takes with these props: its natural width, or wrapped at `width`.
export function measureText(props: Props, width?: number): { width: number; height: number } {
  const el = document.createElement("div");
  Object.assign(el.style, {
    position: "fixed", left: "-10000px", top: "0", visibility: "hidden",
    whiteSpace: width === undefined ? "pre" : "pre-wrap", overflowWrap: "break-word",
    width: width === undefined ? "auto" : `${width}px`,
  });
  for (const [k, v] of Object.entries(fontStyle(props.textStyle))) el.style.setProperty(k, String(v));
  // A trailing newline adds a line only when something follows it.
  el.textContent = props.text.endsWith("\n") ? `${props.text} ` : props.text || " ";
  document.body.append(el);
  const rect = el.getBoundingClientRect();
  el.remove();
  return { width: width ?? Math.ceil(rect.width), height: Math.ceil(rect.height) };
}

// An svg layer's markup with its tint: the color (and opacity) set on the root element, where its currentColor
// comes from.
export function tintedSvg(n: DesignNode, resolve: Resolve): string {
  const { svg, tint } = n.props;
  if (!tint) return svg;
  const opacity = tint.visible ? tint.opacity : 0;
  return svg.replace(/<svg\b/, `<svg color="${resolve(tint)}"${opacity < 1 ? ` opacity="${opacity}"` : ""}`);
}
