import { describe, expect, it } from "vitest";
import { connectorIcon, headIcon, headOf, heads, markerSvg, presetOf, presets } from "../../../../src/plugins/builtin/diagram/ends";

// A connector's ends: UML heads, ER cardinalities and plain arrows, each drawn from one definition in the view and
// in exports, and the presets that set both ends at once.
describe("connector ends", () => {
  it("has a marker for every head, and none for no head", () => {
    for (const head of heads) {
      const svg = markerSvg("m", head.name, "#123456", "#ffffff", 1.5);
      expect(svg).toContain('<marker id="m"');
      expect(svg).toContain("#123456");
    }
    expect(markerSvg("m", "", "#123456", "#ffffff", 1.5)).toBe("");
  });

  it("fills a hollow head with the background, so the line doesn't show through", () => {
    expect(markerSvg("m", "triangle", "#123456", "#fafafa", 1.5)).toContain('fill="#fafafa"');
    expect(markerSvg("m", "arrow", "#123456", "#fafafa", 1.5)).not.toContain("#fafafa");
  });

  it("draws a head it doesn't know (from a newer app) as an arrow", () => {
    expect(headOf("something-new")?.name).toBe("arrow");
    expect(headOf("")).toBeNull();
    expect(headOf("er-zero-many")?.name).toBe("er-zero-many");
  });

  it("grows a head with the line, less than the line", () => {
    const size = (width: number) => Number(/markerWidth="([\d.]+)"/.exec(markerSvg("m", "arrow", "#000000", "#ffffff", width))![1]);
    expect(size(4)).toBeGreaterThan(size(1.5));
    expect(size(4) / size(1.5)).toBeLessThan(4 / 1.5);
  });

  it("sets UML and ER notation with presets, and names the preset a connector's ends match", () => {
    const set = (id: string) => presets.find((preset) => preset.id === id)!;
    expect(set("generalization")).toMatchObject({ start: "", end: "triangle", dash: false });
    expect(set("realization")).toMatchObject({ start: "", end: "triangle", dash: true });
    expect(set("composition")).toMatchObject({ start: "diamond-filled", end: "" });
    expect(set("one-to-many")).toMatchObject({ start: "er-mandatory-one", end: "er-many" });
    expect(presetOf({ startArrow: "", endArrow: "triangle", style: { dash: true } })?.id).toBe("realization");
    expect(presetOf({ startArrow: "dot", endArrow: "er-many", style: { dash: false } })).toBeUndefined();
    for (const preset of presets) {
      for (const name of [preset.start, preset.end]) expect(name === "" || heads.some((head) => head.name === name)).toBe(true);
    }
  });

  // The library shows each kind with its own picture and a line on what it means.
  it("gives every kind a description and its own icon, dashed when the kind is", () => {
    const icons = new Set(presets.map((preset) => connectorIcon(preset.start, preset.end, preset.dash)));
    expect(icons.size).toBe(presets.length);
    for (const preset of presets) expect(preset.description.length).toBeGreaterThan(5);
    const dashed = decodeURIComponent(connectorIcon("", "triangle", true));
    expect(dashed).toContain("stroke-dasharray");
    expect(decodeURIComponent(connectorIcon("", "triangle", false))).not.toContain("stroke-dasharray");
    expect(headIcon("er-many")).toBe(connectorIcon("", "er-many", false));
  });
});
