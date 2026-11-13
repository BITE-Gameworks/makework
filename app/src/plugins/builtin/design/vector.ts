// Path layers drawn with the pen and pencil: anchors with optional curve handles, in the layer's coordinates.
import type { Point, Rect } from "./model";

export interface Anchor {
  x: number;
  y: number;
  in?: Point | null;    // handle of the curve arriving here
  out?: Point | null;   // handle of the curve leaving
}

export interface SubPath {
  points: Anchor[];
  closed: boolean;
}

// Points are kept at the size they were drawn (w x h) and stretched to the layer's box when it is resized.
export interface Vector {
  w: number;
  h: number;
  paths: SubPath[];
}

const num = (v: number) => String(Math.round(v * 1000) / 1000);

const scaleOf = (v: Vector, width: number, height: number) => ({
  x: v.w > 1e-6 ? width / v.w : 1,
  y: v.h > 1e-6 ? height / v.h : 1,
});

const mapAnchor = (a: Anchor, f: (p: Point) => Point): Anchor =>
  ({ ...f(a), in: a.in ? f(a.in) : null, out: a.out ? f(a.out) : null });

export const mapPaths = (paths: SubPath[], f: (p: Point) => Point): SubPath[] =>
  paths.map((s) => ({ closed: s.closed, points: s.points.map((a) => mapAnchor(a, f)) }));

// The same drawing mirrored inside its box, sideways ("x") or upside down ("y").
export function mirrorVector(v: Vector, axis: "x" | "y"): Vector {
  return { ...v, paths: mapPaths(v.paths, (p) => (axis === "x" ? { x: v.w - p.x, y: p.y } : { x: p.x, y: v.h - p.y })) };
}

// The paths at a box size.
export function scaledPaths(v: Vector, width: number, height: number): SubPath[] {
  const s = scaleOf(v, width, height);
  return mapPaths(v.paths, (p) => ({ x: p.x * s.x, y: p.y * s.y }));
}

// Each segment of a subpath as a cubic: start, two controls, end.
function segments(s: SubPath): [Point, Point, Point, Point][] {
  const out: [Point, Point, Point, Point][] = [];
  const n = s.points.length;
  for (let i = 0; i < (s.closed ? n : n - 1); i++) {
    const a = s.points[i];
    const b = s.points[(i + 1) % n];
    out.push([a, a.out ?? a, b.in ?? b, b]);
  }
  return out;
}

export function pathData(paths: SubPath[]): string {
  return paths.filter((s) => s.points.length > 0).map((s) => {
    const parts = [`M ${num(s.points[0].x)} ${num(s.points[0].y)}`];
    const list = segments(s);
    for (const [i, [a, c1, c2, b]] of list.entries()) {
      const straight = c1 === a && c2 === b;
      // Z draws a straight closing segment.
      if (straight && s.closed && i === list.length - 1) break;
      parts.push(straight ? `L ${num(b.x)} ${num(b.y)}` : `C ${num(c1.x)} ${num(c1.y)} ${num(c2.x)} ${num(c2.y)} ${num(b.x)} ${num(b.y)}`);
    }
    if (s.closed) parts.push("Z");
    return parts.join(" ");
  }).join(" ");
}

const cubicAt = (a: Point, c1: Point, c2: Point, b: Point, t: number): Point => {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
  };
};

// The box the drawn path covers (curves sampled, handles left out).
export function pathBounds(paths: SubPath[]): Rect | null {
  const pts: Point[] = [];
  for (const s of paths) {
    pts.push(...s.points);
    for (const [a, c1, c2, b] of segments(s))
      if (c1 !== a || c2 !== b) for (let i = 1; i < 24; i++) pts.push(cubicAt(a, c1, c2, b, i / 24));
  }
  if (pts.length === 0) return null;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

// Paths moved so their box starts at 0, 0, with that box (in the paths' coordinates).
export function fitPaths(paths: SubPath[]): { vector: Vector; box: Rect } | null {
  const box = pathBounds(paths);
  if (!box) return null;
  const moved = mapPaths(paths, (p) => ({ x: p.x - box.left, y: p.y - box.top }));
  return { vector: { w: box.right - box.left, h: box.bottom - box.top, paths: moved }, box };
}

// Fewer points along a freehand line, none further than `tolerance` from it (Ramer-Douglas-Peucker).
export function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length < 3) return points;
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    const a = points[first];
    const b = points[last];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let far = -1;
    let farDist = tolerance;
    for (let i = first + 1; i < last; i++) {
      const p = points[i];
      const d = len < 1e-9 ? Math.hypot(p.x - a.x, p.y - a.y) : Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len;
      if (d > farDist) {
        far = i;
        farDist = d;
      }
    }
    if (far >= 0) {
      keep[far] = true;
      stack.push([first, far], [far, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// A smooth curve through the points (Catmull-Rom turned into cubic handles).
export function smoothThrough(points: Point[], closed: boolean): Anchor[] {
  const n = points.length;
  if (n < 3) return points.map((p) => ({ x: p.x, y: p.y }));
  const at = (i: number) => (closed ? points[(i + n) % n] : points[Math.max(0, Math.min(n - 1, i))]);
  return points.map((p, i) => {
    const prev = at(i - 1);
    const next = at(i + 1);
    const t = { x: (next.x - prev.x) / 6, y: (next.y - prev.y) / 6 };
    const ends = !closed && (i === 0 || i === n - 1);
    return {
      x: p.x, y: p.y,
      in: ends && i === 0 ? null : { x: p.x - t.x, y: p.y - t.y },
      out: ends && i === n - 1 ? null : { x: p.x + t.x, y: p.y + t.y },
    };
  });
}
