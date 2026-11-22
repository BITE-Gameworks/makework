import { describe, expect, it } from "vitest";
import { edgeStep } from "../../src/ui/touchDrag";

describe("edgeStep", () => {
  it("doesn't scroll away from the edges", () => {
    expect(edgeStep(200, 0, 400)).toBe(0);
    expect(edgeStep(40, 0, 400)).toBe(0);
    expect(edgeStep(360, 0, 400)).toBe(0);
  });

  it("scrolls back near the start and on near the end", () => {
    expect(edgeStep(20, 0, 400)).toBeLessThan(0);
    expect(edgeStep(380, 0, 400)).toBeGreaterThan(0);
  });

  it("goes faster closer to the edge, up to a cap", () => {
    expect(Math.abs(edgeStep(10, 0, 400))).toBeGreaterThan(Math.abs(edgeStep(30, 0, 400)));
    expect(edgeStep(0, 0, 400)).toBe(-14);
    expect(edgeStep(-50, 0, 400)).toBe(-14);
    expect(edgeStep(400, 0, 400)).toBe(14);
  });

  it("keeps the two bands apart in a small scroller", () => {
    expect(edgeStep(30, 0, 60)).toBe(0);
    expect(edgeStep(5, 0, 60)).toBeLessThan(0);
    expect(edgeStep(5, 0, 0)).toBe(0);
  });
});
