import { describe, expect, it } from "vitest";
import { arrange, normalize, type ArrangeBox } from "../../../../src/plugins/builtin/canvas/arrange";

const box = (id: number, left: number, top: number, width: number, height: number): ArrangeBox => ({ id, left, top, width, height });

const boxes = [box(1, 450, 275, 100, 50), box(2, -100, -50, 200, 100), box(3, 200, -110, 100, 300)];
const placed = (result: ReturnType<typeof arrange>) =>
  boxes.map((b) => ({ ...b, ...result.get(b.id)! })).map((b) => ({ left: b.left, top: b.top, right: b.left + b.width, bottom: b.top + b.height }));
const overlap = (a: ReturnType<typeof placed>[number], b: ReturnType<typeof placed>[number]) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

describe("canvas arrange", () => {
  it("never overlaps and starts at the selection's top left", () => {
    for (const how of ["optimal", "horizontal", "vertical", "grid"] as const) {
      const out = placed(arrange(boxes, how));
      for (let i = 0; i < out.length; i++)
        for (let j = i + 1; j < out.length; j++) expect(overlap(out[i], out[j]), how).toBe(false);
      // Grid cells start there; each box is centered in its cell.
      const start = how === "grid" ? "toBeGreaterThanOrEqual" : "toBeCloseTo";
      expect(Math.min(...out.map((b) => b.left)), how)[start](-100);
      expect(Math.min(...out.map((b) => b.top)), how)[start](-110);
    }
  });

  it("lines up rows and columns", () => {
    expect(new Set(placed(arrange(boxes, "horizontal")).map((b) => b.top)).size).toBe(1);
    expect(new Set(placed(arrange(boxes, "vertical")).map((b) => b.left)).size).toBe(1);
  });

  it("normalizes to a shared height", () => {
    const scales = normalize(boxes, "height");
    const heights = boxes.map((b) => b.height * scales.get(b.id)!);
    for (const h of heights) expect(h).toBeCloseTo(heights[0]);
  });
});
