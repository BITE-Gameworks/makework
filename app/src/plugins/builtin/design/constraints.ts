// Constraints: where layers go when the frame around them is resized (on the canvas, in the properties panel, and in
// instances sized differently from their main).
import type { Change, Constraints, DesignNode } from "./model";

export interface Size {
  width: number;
  height: number;
}
type Axis = "start" | "end" | "both" | "center" | "scale";

export const scaled: Constraints = { h: "scale", v: "scale" };
const axisOf = { left: "start", top: "start", right: "end", bottom: "end", both: "both", center: "center", scale: "scale" } as const;

function along(pos: number, size: number, how: Axis, from: number, to: number): [number, number] {
  switch (how) {
    case "end": return [pos + to - from, size];
    case "both": return [pos, Math.max(0, size + to - from)];
    case "center": return [pos + (to - from) / 2, size];
    case "scale": {
      const f = from > 0 ? to / from : 1;
      return [pos * f, size * f];
    }
    default: return [pos, size];
  }
}

// The layer's box in a parent that went from `from` to `to`.
export function constrain(n: { x: number; y: number; width: number; height: number }, c: Constraints, from: Size, to: Size) {
  const [x, width] = along(n.x, n.width, axisOf[c.h], from.width, to.width);
  const [y, height] = along(n.y, n.height, axisOf[c.v], from.height, to.height);
  return { x, y, width, height };
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

// The changes that keep what is inside a resized frame or group in place: frames by their layers' constraints, groups
// scale everything. Layers that are resized hold others pass it on. `get` gives a layer as it was before.
export function resizeInside(id: number, kind: DesignNode["kind"], from: Size, to: Size,
  children: (id: number) => number[], get: (id: number) => DesignNode | undefined): Map<number, Change> {
  const out = new Map<number, Change>();
  const visit = (parent: number, group: boolean, a: Size, b: Size) => {
    for (const c of children(parent)) {
      const n = get(c);
      if (!n) continue;
      const box = constrain(n, group ? scaled : n.props.constraints, a, b);
      if (near(box.x, n.x) && near(box.y, n.y) && near(box.width, n.width) && near(box.height, n.height)) continue;
      out.set(c, n.kind === "line" ? { ...box, height: n.height } : box);
      if (n.kind === "frame" || n.kind === "group") visit(c, n.kind === "group", n, box);
    }
  };
  if (!near(from.width, to.width) || !near(from.height, to.height)) visit(id, kind === "group", from, to);
  return out;
}
