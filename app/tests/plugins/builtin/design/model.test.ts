import { describe, expect, it } from "vitest";
import { between, boxAt, compose, effect, localTransform, apply, svgGradient } from "../../../../src/plugins/builtin/design/model";
import { effectFilter } from "../../../../src/plugins/builtin/design/render";

const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

describe("design geometry", () => {
  it("keeps a layer's place on the page when it moves to another parent", () => {
    const parent = localTransform({ x: 100, y: 50, width: 400, height: 300, rotation: 30 });
    const child = { x: 20, y: 40, width: 80, height: 60, rotation: 15 };
    const world = compose(parent, localTransform(child));
    const onPage = boxAt(world, { origin: { x: 0, y: 0 }, angle: 0 }, child.width, child.height);
    near(onPage.rotation, 45);
    const back = boxAt(compose({ origin: { x: 0, y: 0 }, angle: 0 }, localTransform(onPage)), parent, child.width, child.height);
    near(back.x, child.x);
    near(back.y, child.y);
    near(back.rotation, child.rotation);
  });

  it("turns layers around their centers", () => {
    const t = localTransform({ x: 0, y: 0, width: 100, height: 20, rotation: 90 });
    const c = apply(t, { x: 50, y: 10 });
    near(c.x, 50);
    near(c.y, 10);
  });

  it("puts z values between neighbours", () => {
    expect(between(undefined, undefined)).toBe(1);
    expect(between(3, undefined)).toBe(4);
    expect(between(undefined, 3)).toBe(2);
    expect(between(1, 2)).toBe(1.5);
  });
});

describe("design markup from synced values", () => {
  const breakout = '"/><image href="x" onerror="run()"/><stop stop-color="';

  it("keeps a gradient stop's color inside its attribute", () => {
    const markup = svgGradient({ kind: "linear", angle: 0, stops: [{ color: breakout, opacity: 1, position: 0 }] }, "g", 10, 10);
    expect(markup).not.toContain("<image");
    expect(markup).toContain('stop-color="&#34;/&#62;');
  });

  it("keeps normal colors as they are", () => {
    const markup = svgGradient({ kind: "linear", angle: 0, stops: [{ color: "#ff0000", opacity: 1, position: 0 }] }, "g", 10, 10);
    expect(markup).toContain('stop-color="#ff0000"');
  });

  it("keeps a shadow's color inside its attribute", () => {
    for (const kind of ["drop-shadow", "inner-shadow"] as const) {
      const markup = effectFilter([{ ...effect(kind), color: breakout }], (c) => c.color, "f");
      expect(markup).not.toContain("<image");
    }
  });
});
