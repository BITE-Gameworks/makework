import { describe, expect, it } from "vitest";
import { edgeGeometry, edgePoints, recolorIconSvg, renderDiagramSvg, shapeSvgMarkup } from "../../../../src/plugins/builtin/diagram/render";
import { wrapText } from "../../../../src/plugins/builtin/canvas/text";
import type { DiagramEdge, DiagramPage, DiagramRow, DiagramShape } from "../../../../src/plugins/builtin/diagram/model";

const page: DiagramPage = { id: 1, channelId: 1, name: "Flow", z: 0, background: "", grid: true, exports: [] };
const style = { fill: "#ffffff", stroke: "#222222", strokeWidth: 1.5, textColor: "#111111", fontSize: 14, align: "center" as const, dash: false };
const shape = (id: number, x: number, text = ""): DiagramShape => ({
  id, pageId: 1, parentId: null, kind: "rect", x, y: 10, w: 100, h: 50, rotation: 0, z: id, text, style, exports: [],
});
const edge: DiagramEdge = {
  id: 1, pageId: 1, parentId: null, fromId: 1, fromPort: "e", fromPoint: { x: 0, y: 0 }, toId: 2, toPort: "w", toPoint: { x: 0, y: 0 }, points: [], kind: "straight",
  startArrow: "", endArrow: "arrow", label: "", startLabel: "", endLabel: "", fromRow: null, toRow: null,
  style: { stroke: "#222222", strokeWidth: 1.5, dash: false },
};

describe("diagram rendering", () => {
  it("keeps straight connector endpoints attached as shapes move", () => {
    const first = shape(1, 0);
    const second = shape(2, 200);
    expect(edgePoints(edge, new Map([[1, first], [2, second]]))).toEqual([{ x: 100, y: 35 }, { x: 200, y: 35 }]);
    expect(edgePoints(edge, new Map([[1, shape(1, 40)], [2, second]]))).toEqual([{ x: 140, y: 35 }, { x: 200, y: 35 }]);
  });

  it("escapes diagram text in standalone SVG output", () => {
    const svg = renderDiagramSvg(page, [{ ...shape(1, 0, "<script>alert('&')</script>"), w: 400 }], []);
    expect(svg).toContain("&lt;script&gt;alert(&apos;&amp;&apos;)&lt;/script&gt;");
    expect(svg).not.toContain("<script>");
  });

  it("includes fill and line styling in the interactive shape markup", () => {
    expect(shapeSvgMarkup(shape(1, 0))).toContain('<g fill="#ffffff" stroke="#222222" stroke-width="1.5"');
    expect(shapeSvgMarkup({ ...shape(1, 0), style: { ...style, dash: true } })).toContain('stroke-dasharray="6 4"');
  });

  it("routes orthogonal connectors through their bend and keeps them square when shapes move", () => {
    const shapes = new Map([[1, shape(1, 0)], [2, { ...shape(2, 200), y: 110 }]]);
    const routed = { ...edge, kind: "orthogonal" as const };
    const auto = edgePoints(routed, shapes);
    expect(auto[0]).toEqual({ x: 100, y: 35 });
    expect(auto.at(-1)).toEqual({ x: 200, y: 135 });
    const square = (points: { x: number; y: number }[]) => points.every((p, i) => i === 0 || p.x === points[i - 1].x || p.y === points[i - 1].y);
    expect(square(auto)).toBe(true);
    const bent = edgePoints({ ...routed, points: [{ x: 170, y: 0 }] }, shapes);
    expect(bent.some((p) => p.x === 170)).toBe(true);
    const moved = edgePoints({ ...routed, points: [{ x: 170, y: 0 }] }, new Map([[1, shape(1, -50)], [2, { ...shape(2, 260), y: 300 }]]));
    expect(square(moved)).toBe(true);
    expect(edgeGeometry({ ...routed, points: [{ x: 170, y: 0 }] }, shapes)?.handle.axis).toBe("x");
  });

  it("draws connectors with free ends", () => {
    const free = { ...edge, fromId: null, toId: null, fromPoint: { x: 5, y: 5 }, toPoint: { x: 50, y: 20 } };
    expect(edgePoints(free, new Map())).toEqual([{ x: 5, y: 5 }, { x: 50, y: 20 }]);
    expect(edgePoints({ ...free, points: [{ x: 30, y: 60 }] }, new Map())).toEqual([{ x: 5, y: 5 }, { x: 30, y: 60 }, { x: 50, y: 20 }]);
    expect(renderDiagramSvg(page, [], [free])).toContain('marker-end="url(#end0)"');
  });

  // UML and ER notation: each end has its own head, and its multiplicity next to it.
  it("draws each end's own head and label", () => {
    const relationship = { ...edge, startArrow: "diamond-filled", endArrow: "er-many", startLabel: "1", endLabel: "0..*" };
    const svg = renderDiagramSvg(page, [shape(1, 0), shape(2, 300)], [relationship]);
    expect(svg).toContain('marker-start="url(#start0)"');
    expect(svg).toContain('marker-end="url(#end0)"');
    expect(svg.match(/<marker /g)).toHaveLength(2);
    expect(svg).toContain(">1</text>");
    expect(svg).toContain(">0..*</text>");
    // Near their own ends: the start's label left of the end's.
    const x = (text: string) => {
      const at = svg.indexOf(`>${text}</text>`);
      return Number(/<text x="([\d.-]+)"[^<]*$/.exec(svg.slice(0, at + 1))![1]);
    };
    expect(x("1")).toBeLessThan(150);
    expect(x("0..*")).toBeGreaterThan(250);
  });

  it("fills a hollow head with the page's background", () => {
    const svg = renderDiagramSvg({ ...page, background: "#fafafa" }, [shape(1, 0), shape(2, 300)], [{ ...edge, endArrow: "triangle" }]);
    expect(svg).toMatch(/<marker id="end0"[^]*fill="#fafafa"/);
  });

  // A table: its name in the header, a line under it, its columns with their keys.
  const column = (id: number, shapeId: number, z: number, name: string, type: string, marks: string[] = []): DiagramRow =>
    ({ id, shapeId, section: "columns", z, name, type, params: "", value: "", visibility: "", marks });
  const table = (id: number, x: number, text: string): DiagramShape => ({ ...shape(id, x, text), kind: "db-table", w: 200, h: 90 });

  it("draws a table's header, columns and keys", () => {
    const svg = renderDiagramSvg(page, [table(1, 0, "users")], [], undefined, [column(10, 1, 1, "id", "int", ["pk"]), column(11, 1, 2, "email", "text")]);
    expect(svg).toContain(">users</tspan>");
    expect(svg).toContain(">id int</text>");
    expect(svg).toContain(">PK</text>");
    expect(svg).toContain(">email text</text>");
    expect(svg).toMatch(/<path d="M 0 \d+ H 200"/);
  });

  it("ends a connector on a row at the side facing the other end, and on the shape once the row is gone", () => {
    const rows = [column(10, 1, 1, "id", "int", ["pk"]), column(11, 1, 2, "user_id", "int", ["fk"])];
    const byRow = new Map([[1, rows]]);
    const onRow = { ...edge, fromId: 1, fromRow: 11, toId: 2, kind: "straight" as const };
    const right = edgeGeometry(onRow, new Map([[1, table(1, 0, "orders")], [2, shape(2, 400)]]), byRow)!;
    const second = right.points[0];
    expect(second.x).toBe(200);
    const left = edgeGeometry(onRow, new Map([[1, table(1, 400, "orders")], [2, shape(2, 0)]]), byRow)!;
    expect(left.points[0].x).toBe(400);
    expect(left.points[0].y).toBe(second.y);
    // The second row is lower than the first.
    expect(second.y).toBeGreaterThan(edgeGeometry({ ...onRow, fromRow: 10 }, new Map([[1, table(1, 0, "orders")], [2, shape(2, 400)]]), byRow)!.points[0].y);
    const gone = edgeGeometry(onRow, new Map([[1, table(1, 0, "orders")], [2, shape(2, 400)]]), new Map([[1, rows.slice(0, 1)]]))!;
    expect(gone.points[0]).toEqual({ x: 200, y: 10 + 45 });
  });

  it("exports a group with its shapes and connectors only", () => {
    const group = { ...shape(3, 0), kind: "group" as const };
    const inside = { ...shape(1, 0, "In"), parentId: 3 };
    const outside = shape(2, 400, "Out");
    const arrow = { ...edge, id: 2, parentId: 3, fromId: null, toId: null, fromPoint: { x: 0, y: 100 }, toPoint: { x: 80, y: 100 } };
    const svg = renderDiagramSvg(page, [group, inside, outside], [arrow, { ...edge, toId: 2 }], [3]);
    expect(svg).toContain(">In<");
    expect(svg).not.toContain(">Out<");
    expect(svg.match(/marker-end=/g)).toHaveLength(1);
  });

  it("uses icon fill and stroke colors and can tint a multicolor icon on edit", () => {
    const icon = '<svg><path fill="currentColor" stroke="currentColor"/><path fill="#ff0000" stroke="none"/></svg>';
    expect(recolorIconSvg(icon, { ...style, fill: "#00aa00", stroke: "#0000ff" }))
      .toBe('<svg><path fill="#00aa00" stroke="#0000ff"/><path fill="#ff0000" stroke="none"/></svg>');
    expect(recolorIconSvg(icon, { ...style, fill: "#00aa00", stroke: "#0000ff" }, true))
      .toBe('<svg><path fill="#00aa00" stroke="#0000ff"/><path fill="#00aa00" stroke="none"/></svg>');
  });
});

describe("diagram text in exports", () => {
  it("wraps text to the shape's width and keeps its own line breaks", () => {
    expect(wrapText("Allowed by the workspace's rules?", 14, 150)).toEqual(["Allowed by the", "workspace's rules?"]);
    expect(wrapText("One\nTwo", 14, 150)).toEqual(["One", "Two"]);
    expect(wrapText("abcdefghij", 10, 20).every((line) => line.length * 5.5 <= 20)).toBe(true);
  });

  it("centers wrapped lines in the shape", () => {
    const svg = renderDiagramSvg(page, [{ ...shape(1, 0, "Allowed by the workspace's rules?"), w: 160, h: 120 }], []);
    expect(svg.match(/<tspan/g)).toHaveLength(2);
    expect(svg).toContain('y="51.25"');
    expect(svg).toContain('y="68.75"');
  });
});
