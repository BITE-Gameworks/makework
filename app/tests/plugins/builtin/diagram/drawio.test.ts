import { describe, expect, it } from "vitest";
import { encodeDrawio, importDrawio } from "../../../../src/plugins/builtin/diagram/drawio";

describe("draw.io interchange", () => {
  it("round-trips compressed draw.io XML with attached connectors and text", () => {
    const source = {
      shapes: [{
        ref: "start", kind: "ellipse" as const, x: 12, y: 24, w: 120, h: 60, rotation: 0, text: "Start & finish",
        style: { fill: "#ffffff", stroke: "#222222", strokeWidth: 1.5, textColor: "#111111", fontSize: 14, align: "center" as const, dash: false },
      }, {
        ref: "decision", kind: "diamond" as const, x: 220, y: 30, w: 110, h: 80, rotation: 0, text: "Ready?",
        style: { fill: "#eeeeee", stroke: "#333333", strokeWidth: 2, textColor: "#111111", fontSize: 16, align: "center" as const, dash: true },
      }],
      edges: [{
        from: "start", to: "decision", kind: "orthogonal" as const, startArrow: "", endArrow: "arrow", label: "yes",
        style: { stroke: "#555555", strokeWidth: 1.5, dash: false },
      }],
    };
    const result = importDrawio(encodeDrawio(source.shapes, source.edges));
    expect(result.shapes.map(({ ref, kind, x, y, w, h, text }) => ({ ref, kind, x, y, w, h, text }))).toEqual([
      { ref: "start", kind: "ellipse", x: 12, y: 24, w: 120, h: 60, text: "Start & finish" },
      { ref: "decision", kind: "diamond", x: 220, y: 30, w: 110, h: 80, text: "Ready?" },
    ]);
    expect(result.edges).toEqual([expect.objectContaining({ from: "start", to: "decision", kind: "orthogonal", label: "yes" })]);
  });

  it("imports plain uncompressed mxGraph XML and skips dangling connectors", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="A" style="ellipse;fillColor=#ffffff;" vertex="1" parent="1"><mxGeometry x="1" y="2" width="30" height="20" as="geometry"/></mxCell><mxCell id="b" edge="1" source="a" target="missing" parent="1"/></root></mxGraphModel>`;
    expect(importDrawio(xml)).toMatchObject({ shapes: [{ ref: "a", kind: "ellipse", x: 1, y: 2 }], edges: [] });
  });

  // draw.io names heads by shape and fill (endArrow=block;endFill=0 is UML's hollow triangle), and keeps an end's
  // label as a child cell of the connector at x = -1 (its source) or 1 (its target).
  it("maps UML and ER heads and end labels both ways", () => {
    const style = { fill: "#ffffff", stroke: "#222222", strokeWidth: 1.5, textColor: "#111111", fontSize: 14, align: "center" as const, dash: false };
    const box = (ref: string, x: number) => ({ ref, kind: "rect" as const, x, y: 0, w: 100, h: 60, rotation: 0, text: ref, style });
    const pairs: [string, string][] = [
      ["", "arrow"], ["", "open"], ["", "triangle"], ["diamond", ""], ["diamond-filled", ""], ["circle", "dot"],
      ["er-one", "er-mandatory-one"], ["er-many", "er-one-many"], ["er-zero-one", "er-zero-many"],
    ];
    const edges = pairs.map(([startArrow, endArrow]) => ({
      from: "a", to: "b", kind: "straight" as const, startArrow, endArrow, label: "", startLabel: "1", endLabel: "0..*",
      style: { stroke: "#555555", strokeWidth: 1.5, dash: false },
    }));
    const result = importDrawio(encodeDrawio([box("a", 0), box("b", 300)], edges));
    expect(result.edges.map((edge) => [edge.startArrow, edge.endArrow])).toEqual(pairs);
    expect(result.edges.every((edge) => edge.startLabel === "1" && edge.endLabel === "0..*")).toBe(true);
    // The labels are the connector's, not shapes of their own.
    expect(result.shapes.map((shape) => shape.ref)).toEqual(["a", "b"]);
  });

  it("reads heads and end labels as draw.io writes them", () => {
    const xml = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>`
      + `<mxCell id="a" value="Order" vertex="1" parent="1"><mxGeometry x="0" y="0" width="100" height="60" as="geometry"/></mxCell>`
      + `<mxCell id="b" value="Line" vertex="1" parent="1"><mxGeometry x="300" y="0" width="100" height="60" as="geometry"/></mxCell>`
      + `<mxCell id="e" value="" style="edgeStyle=entityRelationEdgeStyle;startArrow=ERmandOne;endArrow=ERzeroToMany;startFill=0;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>`
      + `<mxCell id="e-s" value="1" style="edgeLabel;resizable=0;html=1;" vertex="1" connectable="0" parent="e"><mxGeometry x="-1" relative="1" as="geometry"/></mxCell>`
      + `<mxCell id="e-t" value="many" style="edgeLabel;resizable=0;html=1;" vertex="1" connectable="0" parent="e"><mxGeometry x="1" relative="1" as="geometry"/></mxCell>`
      + `<mxCell id="f" style="endArrow=block;endFill=0;dashed=1;" edge="1" parent="1" source="b" target="a"><mxGeometry relative="1" as="geometry"/></mxCell>`
      + `</root></mxGraphModel>`;
    const result = importDrawio(xml);
    expect(result.shapes).toHaveLength(2);
    expect(result.edges).toEqual([
      expect.objectContaining({ startArrow: "er-mandatory-one", endArrow: "er-zero-many", startLabel: "1", endLabel: "many" }),
      expect.objectContaining({ startArrow: "", endArrow: "triangle", style: expect.objectContaining({ dash: true }) }),
    ]);
  });
});
