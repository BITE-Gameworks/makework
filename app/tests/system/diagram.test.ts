import { describe, expect, it } from "vitest";
import { ApiClient, ApiRequestError } from "../../src/api/client";
import { MockTransport } from "../../src/mock/transport";
import { MockBackend } from "../../src/system/backend";
import { diagram } from "../../src/system/diagram";

function api() {
  const backend = new MockBackend();
  backend.load(diagram);
  return new ApiClient(new MockTransport(backend)).plugin("diagram");
}

describe("diagram data", () => {
  it("creates pages, containers and shapes, and validates parent containment", async () => {
    const client = api();
    const { id: pageId } = await client.call<{ id: number }>("add-page", { channel_id: 2, name: "Flow" });
    const { ids } = await client.call<{ ids: number[] }>("add-shapes", {
      page_id: pageId,
      shapes: JSON.stringify([
        { ref: "group", kind: "container", x: 0, y: 0, w: 300, h: 180 },
        { parent_ref: "group", kind: "diamond", x: 20, y: 20, w: 100, h: 80, text: "Decision" },
      ]),
    });
    const { rows } = await client.call<{ rows: { id: number; parent_id: number | null; text: string }[] }>("list-shapes", { page_id: pageId });
    expect(rows.map((shape) => [shape.id, shape.parent_id, shape.text])).toEqual([
      [ids[0], null, ""], [ids[1], ids[0], "Decision"],
    ]);
    await expect(client.call("add-shapes", {
      page_id: pageId,
      shapes: JSON.stringify([{ parent_id: ids[1], kind: "rect", x: 0, y: 0, w: 10, h: 10 }]),
    })).rejects.toBeInstanceOf(ApiRequestError);
    await expect(client.call("update-shapes", { changes: JSON.stringify([{ id: ids[0], parent_id: ids[0] }]) }))
      .rejects.toThrow(/inside itself/);
    await expect(client.call("update-shapes", { changes: JSON.stringify([{ id: ids[1], w: 0 }]) }))
      .rejects.toThrow(/width and height must be positive/);
  });

  it("keeps connectors attached to shapes and hides/restores them", async () => {
    const client = api();
    const { id: pageId } = await client.call<{ id: number }>("add-page", { channel_id: 2, name: "Flow" });
    const { ids: shapes } = await client.call<{ ids: number[] }>("add-shapes", {
      page_id: pageId, shapes: JSON.stringify([
        { kind: "rect", x: 0, y: 0, w: 100, h: 50 },
        { kind: "ellipse", x: 240, y: 0, w: 100, h: 50 },
      ]),
    });
    const { ids: edges } = await client.call<{ ids: number[] }>("add-edges", {
      page_id: pageId,
      edges: JSON.stringify([{ from_id: shapes[0], from_port: "e", to_id: shapes[1], to_port: "w", kind: "orthogonal", points: "[]" }]),
    });
    await client.call("update-shapes", { changes: JSON.stringify([{ id: shapes[0], x: 20 }]) });
    await client.call("update-edges", { changes: JSON.stringify([{
      id: edges[0], to_id: shapes[0], to_port: "n", style: JSON.stringify({ stroke: "#123456", strokeWidth: 3, dash: true }),
    }]) });
    const { rows } = await client.call<{ rows: { from_id: number; to_id: number; to_port: string; kind: string; style: string }[] }>("list-edges", { page_id: pageId });
    expect(rows).toEqual([expect.objectContaining({
      from_id: shapes[0], to_id: shapes[0], to_port: "n", kind: "orthogonal",
      style: JSON.stringify({ stroke: "#123456", strokeWidth: 3, dash: true }),
    })]);
    await client.call("remove-edges", { ids: JSON.stringify(edges) });
    expect((await client.call<{ rows: unknown[] }>("list-edges", { page_id: pageId })).rows).toEqual([]);
    await client.call("restore-edges", { ids: JSON.stringify(edges) });
    expect((await client.call<{ rows: unknown[] }>("list-edges", { page_id: pageId })).rows).toHaveLength(1);
  });

  // A multiplicity or role at each end; written only when set, so connectors without one stay readable by older apps
  // (they refuse a column they don't know).
  it("keeps a label at each end of a connector, and writes none when there is none", async () => {
    const client = api();
    const { id: pageId } = await client.call<{ id: number }>("add-page", { channel_id: 2, name: "Model" });
    const { ids: shapes } = await client.call<{ ids: number[] }>("add-shapes", {
      page_id: pageId, shapes: JSON.stringify([{ kind: "rect", x: 0, y: 0, w: 100, h: 50 }, { kind: "rect", x: 240, y: 0, w: 100, h: 50 }]),
    });
    const ends = { from_id: shapes[0], from_port: "e", to_id: shapes[1], to_port: "w", kind: "straight", points: "[]" };
    const { ids } = await client.call<{ ids: number[] }>("add-edges", {
      page_id: pageId, edges: JSON.stringify([
        { ...ends, start_arrow: "er-mandatory-one", end_arrow: "er-many", start_label: "1", end_label: "0..*" },
        { ...ends, start_label: "", end_label: "" },
      ]),
    });
    const list = async () => (await client.call<{ rows: Record<string, unknown>[] }>("list-edges", { page_id: pageId })).rows;
    const [labelled, plain] = await list();
    expect(labelled).toMatchObject({ start_arrow: "er-mandatory-one", end_arrow: "er-many", start_label: "1", end_label: "0..*" });
    expect(plain.start_label ?? null).toBeNull();
    expect(plain.end_label ?? null).toBeNull();
    await client.call("update-edges", { changes: JSON.stringify([{ id: ids[0], end_label: "many" }, { id: ids[1], label: "uses" }]) });
    const [changed, other] = await list();
    expect(changed.end_label).toBe("many");
    expect(other.start_label ?? null).toBeNull();
  });

  // A class's attributes and operations, a table's columns: rows of their own, that a connector can end on.
  it("keeps the rows of a structured shape, and connectors on a row", async () => {
    const client = api();
    const { id: pageId } = await client.call<{ id: number }>("add-page", { channel_id: 2, name: "Schema" });
    const { ids: [users, orders, box] } = await client.call<{ ids: number[] }>("add-shapes", {
      page_id: pageId, shapes: JSON.stringify([
        { kind: "db-table", x: 0, y: 0, w: 200, h: 80, text: "users" },
        { kind: "db-table", x: 400, y: 0, w: 200, h: 80, text: "orders" },
        { kind: "rect", x: 0, y: 300, w: 100, h: 50 },
      ]),
    });
    const { ids: [id, userId] } = await client.call<{ ids: number[] }>("add-rows", { rows: JSON.stringify([
      { shape_id: users, section: "columns", z: 1, name: "id", type: "int", marks: "pk" },
      { shape_id: orders, section: "columns", z: 1, name: "user_id", type: "int", marks: "fk" },
    ]) });
    await expect(client.call("add-rows", { rows: JSON.stringify([{ shape_id: box, section: "columns", name: "x" }]) }))
      .rejects.toBeInstanceOf(ApiRequestError);
    const ends = { kind: "orthogonal", points: "[]", end_arrow: "er-many", start_arrow: "er-mandatory-one" };
    const { ids: [onRows] } = await client.call<{ ids: number[] }>("add-edges", { page_id: pageId, edges: JSON.stringify([
      { ...ends, from_id: users, from_port: "e", from_row: id, to_id: orders, to_port: "w", to_row: userId },
      { ...ends, from_id: users, from_port: "e", to_id: orders, to_port: "w" },
    ]) });
    // A row of another shape is no end of this one.
    await expect(client.call("add-edges", { page_id: pageId, edges: JSON.stringify([
      { ...ends, from_id: users, from_port: "e", from_row: userId, to_id: orders, to_port: "w" },
    ]) })).rejects.toBeInstanceOf(ApiRequestError);
    const edges = (await client.call<{ rows: Record<string, unknown>[] }>("list-edges", { page_id: pageId })).rows;
    expect(edges[0]).toMatchObject({ id: onRows, from_row: id, to_row: userId });
    expect(edges[1].from_row ?? null).toBeNull();

    const listRows = async () => (await client.call<{ rows: Record<string, unknown>[] }>("list-rows", { page_id: pageId })).rows;
    expect((await listRows()).map((row) => row.name)).toEqual(["id", "user_id"]);
    await client.call("update-rows", { changes: JSON.stringify([{ id: userId, name: "buyer_id", marks: "fk,nn" }]) });
    expect((await listRows())[1]).toMatchObject({ name: "buyer_id", marks: "fk,nn", shape_id: orders });
    await client.call("remove-rows", { ids: JSON.stringify([userId]) });
    expect((await listRows()).map((row) => row.name)).toEqual(["id"]);
    await client.call("restore-rows", { ids: JSON.stringify([userId]) });
    expect(await listRows()).toHaveLength(2);
  });

  it("keeps connector ends free at a point and attaches or frees them later", async () => {
    const client = api();
    const { id: pageId } = await client.call<{ id: number }>("add-page", { channel_id: 2, name: "Flow" });
    const { ids: shapes } = await client.call<{ ids: number[] }>("add-shapes", {
      page_id: pageId, shapes: JSON.stringify([{ kind: "rect", x: 0, y: 0, w: 100, h: 50 }]),
    });
    const { ids: [edgeId] } = await client.call<{ ids: number[] }>("add-edges", {
      page_id: pageId, edges: JSON.stringify([{ from_id: null, from_port: "c", from_x: 10, from_y: 20, to_id: null, to_port: "c", to_x: 90, to_y: 40, kind: "straight" }]),
    });
    await client.call("update-edges", { changes: JSON.stringify([{ id: edgeId, to_id: shapes[0], to_port: "n" }]) });
    let [row] = (await client.call<{ rows: Record<string, unknown>[] }>("list-edges", { page_id: pageId })).rows;
    expect(row).toMatchObject({ from_id: null, from_x: 10, from_y: 20, to_id: shapes[0], to_port: "n", to_x: null });
    await client.call("update-edges", { changes: JSON.stringify([{ id: edgeId, to_id: null, to_port: "c", to_x: 5, to_y: 6 }]) });
    [row] = (await client.call<{ rows: Record<string, unknown>[] }>("list-edges", { page_id: pageId })).rows;
    expect(row).toMatchObject({ to_id: null, to_x: 5, to_y: 6 });
    await expect(client.call("add-edges", {
      page_id: pageId, edges: JSON.stringify([{ from_id: null, from_port: "c", to_id: shapes[0], to_port: "w" }]),
    })).rejects.toThrow(/finite x and y/);
  });

  it("groups shapes and connectors and keeps export settings on objects and pages", async () => {
    const client = api();
    const { id: pageId } = await client.call<{ id: number }>("add-page", { channel_id: 2, name: "Flow" });
    const { ids: [groupId, rectId] } = await client.call<{ ids: number[] }>("add-shapes", {
      page_id: pageId, shapes: JSON.stringify([
        { ref: "g", kind: "group", x: 0, y: 0, w: 100, h: 50, exports: JSON.stringify([{ scale: 2, format: "png", suffix: "" }]) },
        { parent_ref: "g", kind: "rect", x: 0, y: 0, w: 100, h: 50 },
      ]),
    });
    const { ids: [edgeId] } = await client.call<{ ids: number[] }>("add-edges", {
      page_id: pageId, edges: JSON.stringify([{ parent_id: groupId, from_id: rectId, from_port: "e", to_id: null, to_port: "c", to_x: 200, to_y: 25 }]),
    });
    const shapes = (await client.call<{ rows: Record<string, unknown>[] }>("list-shapes", { page_id: pageId })).rows;
    expect(shapes.find((row) => row.id === rectId)).toMatchObject({ parent_id: groupId });
    expect(JSON.parse(String(shapes.find((row) => row.id === groupId)!.exports))).toEqual([{ scale: 2, format: "png", suffix: "" }]);
    expect((await client.call<{ rows: Record<string, unknown>[] }>("list-edges", { page_id: pageId })).rows[0]).toMatchObject({ parent_id: groupId });
    await expect(client.call("update-edges", { changes: JSON.stringify([{ id: edgeId, parent_id: rectId }]) })).rejects.toThrow(/group/);
    await expect(client.call("update-shapes", { changes: JSON.stringify([{ id: groupId, exports: JSON.stringify([{ scale: 1, format: "gif", suffix: "" }]) }]) }))
      .rejects.toThrow(/format/);
    await client.call("update-page", { id: pageId, changes: JSON.stringify({ exports: JSON.stringify([{ scale: 1, format: "svg", suffix: "" }]) }) });
    const [pageRow] = (await client.call<{ rows: Record<string, unknown>[] }>("list-pages", { channel_id: 2 })).rows.filter((row) => row.id === pageId);
    expect(JSON.parse(String(pageRow.exports))).toEqual([{ scale: 1, format: "svg", suffix: "" }]);
  });

  it("rejects invalid backgrounds, edge ports, and malformed style objects", async () => {
    const client = api();
    const { id: pageId } = await client.call<{ id: number }>("add-page", { channel_id: 2, name: "Flow" });
    const { ids } = await client.call<{ ids: number[] }>("add-shapes", {
      page_id: pageId, shapes: JSON.stringify([{ kind: "rect", x: 0, y: 0, w: 100, h: 50 }, { kind: "rect", x: 200, y: 0, w: 100, h: 50 }]),
    });
    await expect(client.call("update-page", { id: pageId, changes: JSON.stringify({ background: "blue" }) }))
      .rejects.toThrow(/background/);
    await expect(client.call("add-edges", {
      page_id: pageId, edges: JSON.stringify([{ from_id: ids[0], from_port: "north", to_id: ids[1], to_port: "w" }]),
    })).rejects.toThrow(/port/);
    await expect(client.call("add-shapes", {
      page_id: pageId, shapes: JSON.stringify([{ kind: "rect", x: 0, y: 0, w: 10, h: 10, style: "[]" }]),
    })).rejects.toThrow(/style/);
    await expect(client.call("add-shapes", {
      page_id: pageId, shapes: JSON.stringify([{ kind: "rect", x: 0, y: 0, w: -1, h: 10 }]),
    })).rejects.toThrow(/width and height must be positive/);
  });
});
