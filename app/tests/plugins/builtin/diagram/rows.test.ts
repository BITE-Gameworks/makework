import { describe, expect, it } from "vitest";
import { parseRow, rowText, structureLayout, structureOf } from "../../../../src/plugins/builtin/diagram/rows";
import type { DiagramRow, DiagramShape } from "../../../../src/plugins/builtin/diagram/model";

// The rows of a structured shape (a class's attributes and operations, a table's columns) are typed the usual way and
// read into fields, then written back the same way.
const row = (fields: Partial<DiagramRow>): DiagramRow => ({
  id: 1, shapeId: 1, section: "attributes", z: 1, name: "", type: "", params: "", value: "", visibility: "", marks: [], ...fields,
});

describe("rows typed in UML", () => {
  it("reads an attribute with its visibility, type and default", () => {
    expect(parseRow("- count: int = 0", "uml-class")).toMatchObject({ section: "attributes", visibility: "-", name: "count", type: "int", value: "0" });
    expect(parseRow("name", "uml-class")).toMatchObject({ section: "attributes", visibility: "", name: "name", type: "" });
  });

  it("reads an operation by its parentheses, with parameters and a return type", () => {
    expect(parseRow("+ find(id: int, deep: bool): User", "uml-class"))
      .toMatchObject({ section: "operations", visibility: "+", name: "find", params: "id: int, deep: bool", type: "User" });
    expect(parseRow("#reset()", "uml-interface")).toMatchObject({ section: "operations", visibility: "#", name: "reset", params: "", type: "" });
  });

  it("reads {static} and {abstract} as marks", () => {
    expect(parseRow("+ {static} instance(): Store", "uml-class")).toMatchObject({ name: "instance", marks: ["static"] });
    expect(parseRow("+ draw() {abstract}", "uml-abstract")).toMatchObject({ name: "draw", marks: ["abstract"] });
  });

  it("reads enumeration literals and object slots", () => {
    expect(parseRow("RED", "uml-enum")).toMatchObject({ section: "literals", name: "RED" });
    expect(parseRow("total = 42", "uml-object")).toMatchObject({ section: "attributes", name: "total", value: "42" });
  });

  it("writes rows back the way they are typed", () => {
    for (const text of ["- count: int = 0", "+ find(id: int, deep: bool): User", "# reset()", "+ {static} instance(): Store"]) {
      expect(rowText(row(parseRow(text, "uml-class")), "uml-class")).toBe(text);
    }
    expect(rowText(row(parseRow("total = 42", "uml-object")), "uml-object")).toBe("total = 42");
  });
});

describe("rows typed as table columns", () => {
  it("reads a column's name, type and keys", () => {
    expect(parseRow("id int PK", "db-table")).toMatchObject({ section: "columns", name: "id", type: "int", marks: ["pk"] });
    expect(parseRow("user_id: bigint fk not null", "db-table")).toMatchObject({ name: "user_id", type: "bigint", marks: ["fk", "nn"] });
    expect(parseRow("email varchar(255) UNIQUE", "db-table")).toMatchObject({ name: "email", type: "varchar(255)", marks: ["uq"] });
  });

  it("writes a column back with its keys, or without them for showing", () => {
    const column = row(parseRow("user_id: bigint fk not null", "db-table"));
    expect(rowText(column, "db-table")).toBe("user_id bigint FK NN");
    expect(rowText(column, "db-table", { marks: false })).toBe("user_id bigint");
  });
});

describe("a structured shape's layout", () => {
  const shape = (kind: DiagramShape["kind"], h = 40): DiagramShape => ({
    id: 1, pageId: 1, parentId: null, kind, x: 0, y: 0, w: 200, h, rotation: 0, z: 1, text: "Order",
    style: { fill: "#fff", stroke: "#000", strokeWidth: 1, textColor: "#000", fontSize: 14, align: "center", dash: false }, exports: [],
  });

  it("has a header, then a compartment per section with its rows in order", () => {
    const rows = [row({ id: 2, section: "operations", z: 1, name: "total" }), row({ id: 3, z: 2, name: "b" }), row({ id: 4, z: 1, name: "a" })];
    const layout = structureLayout(shape("uml-class"), rows);
    expect(layout.compartments.map((c) => c.section)).toEqual(["attributes", "operations"]);
    expect(layout.compartments[0].rows.map((r) => r.row.name)).toEqual(["a", "b"]);
    expect(layout.compartments[1].y).toBeGreaterThanOrEqual(layout.compartments[0].y + layout.compartments[0].h);
    expect(layout.height).toBeGreaterThan(layout.header.h + 3 * 20);
  });

  it("names the kind above the name for interfaces, enumerations and views", () => {
    expect(structureOf("uml-interface")?.stereotype).toBe("interface");
    expect(structureOf("uml-enum")?.sections).toEqual(["literals"]);
    expect(structureOf("db-view")?.stereotype).toBe("view");
    expect(structureOf("rect")).toBeUndefined();
    expect(structureLayout(shape("uml-interface"), []).header.h).toBeGreaterThan(structureLayout(shape("uml-class"), []).header.h);
  });

  it("is never shorter than the shape was made", () => {
    expect(structureLayout(shape("db-table", 300), []).height).toBe(300);
  });
});
