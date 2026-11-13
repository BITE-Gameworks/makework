export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type Align = "left" | "h-center" | "right" | "top" | "v-center" | "bottom";

export function alignShift(box: Rect, target: Rect, how: Align): Point {
  const x = how === "left" ? target.left - box.left
    : how === "right" ? target.right - box.right
      : how === "h-center" ? (target.left + target.right - box.left - box.right) / 2 : 0;
  const y = how === "top" ? target.top - box.top
    : how === "bottom" ? target.bottom - box.bottom
      : how === "v-center" ? (target.top + target.bottom - box.top - box.bottom) / 2 : 0;
  return { x, y };
}

export function distributeShifts(items: { id: number; rect: Rect }[], axis: "x" | "y"): Map<number, number> {
  if (items.length < 3) return new Map();
  const start = (r: Rect) => axis === "x" ? r.left : r.top;
  const size = (r: Rect) => axis === "x" ? r.right - r.left : r.bottom - r.top;
  const sorted = [...items].sort((a, b) => start(a.rect) - start(b.rect));
  const first = sorted[0].rect;
  const last = sorted.at(-1)!.rect;
  const span = start(last) + size(last) - start(first);
  const gap = (span - sorted.reduce((sum, item) => sum + size(item.rect), 0)) / (sorted.length - 1);
  const shifts = new Map<number, number>();
  let at = start(first);
  for (const { id, rect } of sorted) {
    const shift = at - start(rect);
    if (Math.abs(shift) > 1e-6) shifts.set(id, shift);
    at += size(rect) + gap;
  }
  return shifts;
}

export function rotatePoint(p: Point, degrees: number): Point {
  const a = degrees * Math.PI / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos };
}

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const handleDir = (h: Handle): Point => ({ x: h.includes("w") ? -1 : h.includes("e") ? 1 : 0, y: h.includes("n") ? -1 : h.includes("s") ? 1 : 0 });

// One box resized by a handle, in the box's own coordinates (top left at 0, 0): the dragged sides follow `at`,
// `keepRatio` keeps the shape and `fromCenter` grows both sides. Dragging past the fixed side flips the box.
export function resizeLocal(handle: Handle, at: Point, width: number, height: number, keepRatio: boolean, fromCenter: boolean): Rect {
  const dir = handleDir(handle);
  // Each dragged side: its new length from the fixed side (or the center), negative when dragged past it.
  const span = (d: number, q: number, length: number) =>
    d === 0 ? null : (q - (fromCenter ? length / 2 : d > 0 ? 0 : length)) * d * (fromCenter ? 2 : 1);
  let sw = span(dir.x, at.x, width);
  let sh = span(dir.y, at.y, height);
  if (keepRatio && width > 0 && height > 0) {
    const f = Math.max(sw === null ? 0 : Math.abs(sw) / width, sh === null ? 0 : Math.abs(sh) / height);
    sw = (sw === null ? 1 : Math.sign(sw) || 1) * width * f;
    sh = (sh === null ? 1 : Math.sign(sh) || 1) * height * f;
  }
  const place = (d: number, size: number | null, length: number): [number, number] => {
    if (size === null) return [0, length];
    if (fromCenter || d === 0) return [length / 2 - size / 2, length / 2 + size / 2];
    return d > 0 ? [0, size] : [length - size, length];
  };
  const [x1, x2] = place(dir.x, sw, width);
  const [y1, y2] = place(dir.y, sh, height);
  return { left: Math.min(x1, x2), top: Math.min(y1, y2), right: Math.max(x1, x2), bottom: Math.max(y1, y2) };
}

// Which sides a resize turned inside out: the dragged side went past the fixed side (or the center).
export function resizeFlips(handle: Handle, at: Point, width: number, height: number, fromCenter: boolean): { x: boolean; y: boolean } {
  const dir = handleDir(handle);
  const past = (d: number, q: number, length: number) => d !== 0 && (q - (fromCenter ? length / 2 : d > 0 ? 0 : length)) * d < 0;
  return { x: past(dir.x, at.x, width), y: past(dir.y, at.y, height) };
}

// The page-aligned box around a box of this size turned by `degrees` about its center.
export function turnedBounds(x: number, y: number, width: number, height: number, degrees: number): Rect {
  const half = [rotatePoint({ x: width / 2, y: height / 2 }, degrees), rotatePoint({ x: width / 2, y: -height / 2 }, degrees)];
  const dx = Math.max(...half.map((p) => Math.abs(p.x)));
  const dy = Math.max(...half.map((p) => Math.abs(p.y)));
  const cx = x + width / 2;
  const cy = y + height / 2;
  return { left: cx - dx, top: cy - dy, right: cx + dx, bottom: cy + dy };
}
