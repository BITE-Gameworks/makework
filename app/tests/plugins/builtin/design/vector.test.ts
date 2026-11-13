import { describe, expect, it } from "vitest";
import { fitPaths, mirrorVector, pathData, scaledPaths, simplify, smoothThrough } from "../../../../src/plugins/builtin/design/vector";

describe("design paths", () => {
  it("fits paths into a box starting at 0, 0", () => {
    const fit = fitPaths([{ closed: true, points: [{ x: 10, y: 20 }, { x: 50, y: 20 }, { x: 30, y: 60 }] }])!;
    expect(fit.box).toEqual({ left: 10, top: 20, right: 50, bottom: 60 });
    expect(fit.vector.w).toBe(40);
    expect(fit.vector.paths[0].points[0]).toMatchObject({ x: 0, y: 0 });
    expect(pathData(fit.vector.paths)).toBe("M 0 0 L 40 0 L 20 40 Z");
  });

  it("counts curves in the box, not their handles", () => {
    const fit = fitPaths([{ closed: false, points: [{ x: 0, y: 0, out: { x: 0, y: -40 } }, { x: 100, y: 0, in: { x: 100, y: -40 } }] }])!;
    expect(fit.box.top).toBeCloseTo(-30, 0);
    expect(fit.box.bottom).toBe(0);
  });

  it("stretches points with the layer's box", () => {
    const vector = { w: 10, h: 0, paths: [{ closed: false, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }] };
    expect(scaledPaths(vector, 30, 5)[0].points[1]).toMatchObject({ x: 30, y: 0 });
  });

  it("keeps the corners of a freehand line", () => {
    const line = [...Array(11).keys()].map((i) => ({ x: i, y: 0 })).concat([...Array(10).keys()].map((i) => ({ x: 10, y: i + 1 })));
    expect(simplify(line, 0.5)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
    const smooth = smoothThrough(simplify(line, 0.5), false);
    expect(smooth[0].in).toBeNull();
    expect(smooth[2].out).toBeNull();
  });

  it("mirrors a drawing inside its box", () => {
    const v = { w: 40, h: 20, paths: [{ closed: false, points: [{ x: 0, y: 0, out: { x: 10, y: 5 } }, { x: 40, y: 20 }] }] };
    const sideways = mirrorVector(v, "x").paths[0].points;
    expect(sideways[0]).toMatchObject({ x: 40, y: 0, out: { x: 30, y: 5 } });
    expect(mirrorVector(v, "y").paths[0].points[1]).toMatchObject({ x: 40, y: 0 });
  });
});
