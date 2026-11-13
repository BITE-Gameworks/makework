import { describe, expect, it } from "vitest";
import { overridesAfter, pickVariant, planSync, variantProperties } from "../../../../src/plugins/builtin/design/components";
import { constrain, resizeInside } from "../../../../src/plugins/builtin/design/constraints";
import { toNode, type DesignNode, type Props } from "../../../../src/plugins/builtin/design/model";

const layer = (id: number, kind: string, parent: number | null, props: Partial<Props> = {}, box = { x: 0, y: 0, width: 10, height: 10 }): DesignNode =>
  toNode({ id, kind, name: `L${id}`, parent_id: parent, z: id, ...box, props: JSON.stringify(props) });

describe("component instances", () => {
  const main = layer(1, "frame", null, { main: true }, { x: 0, y: 0, width: 100, height: 50 });
  const label = layer(2, "text", 1, { text: "Buy" });

  it("adds a copy of each main layer to a new instance", () => {
    const instance = layer(10, "frame", null, { instanceOf: 1 }, { x: 200, y: 0, width: 100, height: 50 });
    const plan = planSync([main, label, instance]);
    expect(plan.add).toHaveLength(1);
    expect(plan.add[0]).toMatchObject({ parent_id: 10, kind: "text", name: "L2" });
    expect(plan.add[0].props).toMatchObject({ master: 2, text: "Buy", main: false, instanceOf: null });
  });

  it("follows the main except where overridden, and keeps the instance's place", () => {
    const changed = { ...label, props: { ...label.props, text: "Sell", fills: [] } };
    const instance = layer(10, "frame", null, { instanceOf: 1 }, { x: 200, y: 0, width: 80, height: 50 });
    const copy = layer(11, "text", 10, { text: "Mine", master: 2, overrides: ["text"] });
    const plan = planSync([main, changed, instance, copy]);
    expect(plan.add).toEqual([]);
    expect(plan.update.get(10)).toMatchObject({ width: 100 });
    expect(plan.update.get(10)).not.toHaveProperty("x");
    expect(plan.update.get(11)!.props).toMatchObject({ text: "Mine", fills: [] });
  });

  it("removes copies whose main layer is gone, and doubles", () => {
    const instance = layer(10, "frame", null, { instanceOf: 1 });
    const stale = layer(11, "rect", 10, { master: 99 });
    const first = layer(12, "text", 10, { master: 2 });
    const twin = layer(13, "text", 10, { master: 2 });
    const plan = planSync([main, label, instance, stale, first, twin]);
    expect(plan.remove.sort()).toEqual([11, 13]);
    expect(plan.add).toEqual([]);
  });

  it("leaves instances alone when their main is gone or inside them", () => {
    const orphan = layer(10, "frame", null, { instanceOf: 42 });
    const inside = layer(11, "frame", 1, { instanceOf: 1 });
    expect(planSync([main, label, orphan, inside]).add).toEqual([]);
  });

  it("records what an edit changes on a copy", () => {
    const copy = layer(11, "text", 10, { text: "Buy", master: 2 });
    expect(overridesAfter(copy, { props: { ...copy.props, text: "Sell" }, x: 5 }, false)?.sort()).toEqual(["text", "x"]);
    expect(overridesAfter(copy, { props: { ...copy.props, overrides: [] } }, false)).toBeNull();
  });
});

describe("variants", () => {
  it("keeps a copy and its overrides when the instance swaps to a variant with the same layer name", () => {
    const set = layer(1, "frame", null, { variantSet: true });
    const a = toNode({ id: 2, kind: "frame", name: "State=Default", parent_id: 1, z: 1, width: 100, height: 40, props: JSON.stringify({ main: true }) });
    const aLabel = toNode({ id: 3, kind: "text", name: "Label", parent_id: 2, z: 1, width: 50, height: 20, props: JSON.stringify({ text: "Go" }) });
    const b = toNode({ id: 4, kind: "frame", name: "State=Hover", parent_id: 1, z: 2, width: 100, height: 40, props: JSON.stringify({ main: true }) });
    const bLabel = toNode({ id: 5, kind: "text", name: "Label", parent_id: 4, z: 1, width: 50, height: 20, props: JSON.stringify({ text: "Go", fills: [] }) });
    const instance = layer(10, "frame", null, { instanceOf: 4 }, { x: 0, y: 0, width: 100, height: 40 });
    const copy = toNode({ id: 11, kind: "text", name: "Label", parent_id: 10, z: 1, width: 50, height: 20,
      props: JSON.stringify({ text: "Buy now", master: 3, overrides: ["text"] }) });
    const plan = planSync([set, a, aLabel, b, bLabel, instance, copy]);
    expect(plan.add).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.update.get(11)!.props).toMatchObject({ master: 5, text: "Buy now", fills: [] });
  });

  it("picks the variant that changes one property and keeps the rest", () => {
    const variants = [
      { id: 1, name: "State=Default, Size=Small" }, { id: 2, name: "State=Hover, Size=Small" },
      { id: 3, name: "State=Default, Size=Large" }, { id: 4, name: "State=Hover, Size=Large" },
    ];
    expect(pickVariant(variants, "State=Default, Size=Large", "State", "Hover")).toBe(4);
    expect(variantProperties(variants.map((v) => v.name))).toEqual([["State", ["Default", "Hover"]], ["Size", ["Small", "Large"]]]);
  });
});

describe("constraints", () => {
  it("moves, stretches, centers and scales a layer with its frame", () => {
    const box = { x: 10, y: 10, width: 20, height: 20 };
    const from = { width: 100, height: 100 };
    const to = { width: 200, height: 50 };
    expect(constrain(box, { h: "right", v: "bottom" }, from, to)).toEqual({ x: 110, y: -40, width: 20, height: 20 });
    expect(constrain(box, { h: "both", v: "center" }, from, to)).toEqual({ x: 10, y: -15, width: 120, height: 20 });
    expect(constrain(box, { h: "scale", v: "top" }, from, to)).toEqual({ x: 20, y: 10, width: 40, height: 20 });
  });

  it("lays out a resized instance's copies by their main layers' constraints", () => {
    const main = layer(1, "frame", null, { main: true }, { x: 0, y: 0, width: 100, height: 50 });
    const pin = layer(2, "rect", 1, { constraints: { h: "right", v: "top" } }, { x: 80, y: 0, width: 20, height: 20 });
    const instance = layer(10, "frame", null, { instanceOf: 1, overrides: ["width"] }, { x: 0, y: 0, width: 300, height: 50 });
    const copy = layer(11, "rect", 10, { master: 2, constraints: { h: "right", v: "top" } }, { x: 80, y: 0, width: 20, height: 20 });
    expect(planSync([main, pin, instance, copy]).update.get(11)).toMatchObject({ x: 280 });
  });

  it("passes a resize on to frames inside", () => {
    const nodes = new Map([
      [2, layer(2, "frame", 1, { constraints: { h: "both", v: "top" } }, { x: 0, y: 0, width: 100, height: 20 })],
      [3, layer(3, "rect", 2, { constraints: { h: "right", v: "top" } }, { x: 90, y: 0, width: 10, height: 10 })],
    ]);
    const kids: Record<number, number[]> = { 1: [2], 2: [3] };
    const out = resizeInside(1, "frame", { width: 100, height: 100 }, { width: 150, height: 100 }, (id) => kids[id] ?? [], (id) => nodes.get(id));
    expect(out.get(2)).toMatchObject({ width: 150 });
    expect(out.get(3)).toMatchObject({ x: 140 });
  });
});
