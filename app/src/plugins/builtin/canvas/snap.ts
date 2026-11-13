import type { Rect } from "./geometry";

export interface Guide {
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
}

const xs = (r: Rect) => [r.left, (r.left + r.right) / 2, r.right];
const ys = (r: Rect) => [r.top, (r.top + r.bottom) / 2, r.bottom];

export function snapShift(values: number[], targets: number[], threshold: number): number {
  let best = 0;
  let bestDistance = threshold;
  for (const value of values)
    for (const target of targets) {
      const distance = Math.abs(target - value);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = target - value;
      }
    }
  return best;
}

export const snapTargets = (rects: Rect[]) => ({ x: rects.flatMap(xs), y: rects.flatMap(ys) });

export function guidesFor(box: Rect, targets: Rect[]): Guide[] {
  const guides: Guide[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
  for (const target of targets) {
    for (const x of xs(box))
      if (xs(target).some((value) => near(value, x)))
        guides.push({ axis: "x", at: x, from: Math.min(box.top, target.top), to: Math.max(box.bottom, target.bottom) });
    for (const y of ys(box))
      if (ys(target).some((value) => near(value, y)))
        guides.push({ axis: "y", at: y, from: Math.min(box.left, target.left), to: Math.max(box.right, target.right) });
  }
  return guides;
}
