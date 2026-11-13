import { describe, expect, it } from "vitest";
import { ApiClient } from "../../src/api/client";
import { MockTransport } from "../../src/mock/transport";
import { MockBackend } from "../../src/system/backend";
import { sheets } from "../../src/system/sheets";

function setup() {
  const backend = new MockBackend();
  backend.load(sheets);
  return new ApiClient(new MockTransport(backend));
}

describe("sheets data", () => {
  it("batches cell edits and shifts cells when rows or columns are inserted and deleted", async () => {
    const api = setup().plugin("sheets");
    const { id } = await api.call<{ id: number }>("add-sheet", { channel_id: 1, name: "Sheet 1" });
    await api.call("set-cells", {
      sheet_id: id,
      cells: JSON.stringify([
        { row: 0, col: 0, value: "top" },
        { row: 1, col: 1, value: "middle" },
        { row: 3, col: 2, value: "bottom" },
      ]),
    });
    await api.call("insert-rows", { sheet_id: id, at: 1 });
    await api.call("insert-cols", { sheet_id: id, at: 1 });
    expect((await api.read("sheets_cells")).map((c) => [c.row, c.col, c.value])).toEqual([
      [0, 0, "top"], [2, 2, "middle"], [4, 3, "bottom"],
    ]);

    await api.call("delete-rows", { sheet_id: id, at: 1, count: 2 });
    await api.call("delete-cols", { sheet_id: id, at: 1, count: 1 });
    expect((await api.read("sheets_cells")).map((c) => [c.row, c.col, c.value])).toEqual([
      [0, 0, "top"], [2, 2, "bottom"],
    ]);
  });

  it("validates ranges, limits, and batch addresses", async () => {
    const api = setup().plugin("sheets");
    const { id } = await api.call<{ id: number }>("add-sheet", { channel_id: 1, name: "Sheet 1" });
    await api.call("set-sheet", { sheet_id: id, rows: 2, cols: 3 });
    await expect(api.call("set-cells", { sheet_id: id, cells: JSON.stringify([{ row: 2, col: 0, value: "outside" }]) }))
      .rejects.toThrow(/outside this sheet/);
    await expect(api.call("set-cells", {
      sheet_id: id,
      cells: JSON.stringify([{ row: 0, col: 0, value: "a" }, { row: 0, col: 0, value: "b" }]),
    }))    .rejects.toThrow(/same cell twice/);
  });

  it("accepts a style object in conditional formatting rules", async () => {
    const api = setup().plugin("sheets");
    const { id } = await api.call<{ id: number }>("add-sheet", { channel_id: 1, name: "Conditional" });
    await api.call("set-rule", {
    sheet_id: id,
    range: "A1:B2",
    kind: "conditional",
    config: JSON.stringify({ condition: ">=10", style: { background: "#336699", color: "#ffffff" } }),
    });
    const [rule] = await api.read("sheets_rules", { sheet_id: id });
    expect(JSON.parse(String(rule.config))).toEqual({
    condition: ">=10",
    style: { background: "#336699", color: "#ffffff" },
    });
    await expect(api.call("set-rule", { sheet_id: id, range: "A0:B2", kind: "dropdown", config: "{}" }))
      .rejects.toThrow(/range must look like/);
  });

  it("refuses an insert that would shift cells past the coordinate limit", async () => {
    const api = setup().plugin("sheets");
    const { id } = await api.call<{ id: number }>("add-sheet", { channel_id: 1, name: "Sheet 1" });
    await api.call("set-sheet", { sheet_id: id, unlimited_rows: true });
    await api.call("set-cells", { sheet_id: id, cells: JSON.stringify([{ row: 1_000_000, col: 0, value: "edge" }]) });
    await expect(api.call("insert-rows", { sheet_id: id, at: 0 })).rejects.toThrow(/coordinate limit/);
  });

  it("validates calendar settings", async () => {
    const api = setup().plugin("sheets");
    const { id } = await api.call<{ id: number }>("add-sheet", { channel_id: 1, name: "Calendar" });
    const [created] = await api.read("sheets_sheets", { id });
    expect([created.rows, created.cols, created.calendar]).toEqual([1000, 26, JSON.stringify({ itemsPerDay: 4 })]);
    await api.call("set-sheet", { sheet_id: id, calendar: JSON.stringify({ month: "2024-02", firstWeekday: 1, itemsPerDay: 4 }) });
    await expect(api.call("set-sheet", { sheet_id: id, calendar: JSON.stringify({ firstWeekday: 7 }) }))
      .rejects.toThrow(/firstWeekday/);
  });

  it("stores sheet locks and validates currency styles", async () => {
    const api = setup().plugin("sheets");
    const { id } = await api.call<{ id: number }>("add-sheet", { channel_id: 1, name: "Locked" });
    await api.call("set-sheet", { sheet_id: id, locked: true });
    expect((await api.read("sheets_sheets", { id }))[0].locked).toBe(true);
    await api.call("set-cells", {
      sheet_id: id,
      cells: JSON.stringify([{ row: 0, col: 0, value: "1234.5", style: JSON.stringify({
        format: "currency", currency: "EUR", align: "center", verticalAlign: "bottom", strike: true,
      }) }]),
    });
    expect(JSON.parse(String((await api.read("sheets_cells", { sheet_id: id }))[0].style))).toMatchObject({
      currency: "EUR", align: "center", verticalAlign: "bottom", strike: true,
    });
    await expect(api.call("set-cells", {
      sheet_id: id,
      cells: JSON.stringify([{ row: 0, col: 0, style: JSON.stringify({ format: "currency", currency: "ZZZ" }) }]),
    })).rejects.toThrow(/supported currency code/);
  });

  it("persists and validates row heights and column widths", async () => {
    const api = setup().plugin("sheets");
    const { id } = await api.call<{ id: number }>("add-sheet", { channel_id: 1, name: "Resizable" });
    await api.call("set-sheet", {
      sheet_id: id, col_widths: JSON.stringify({ 0: 240, 3: 96 }), row_heights: JSON.stringify({ 1: 48 }),
    });
    await api.call("insert-rows", { sheet_id: id, at: 1 });
    await api.call("insert-cols", { sheet_id: id, at: 1 });
    const [sheet] = await api.read("sheets_sheets", { id });
    expect(JSON.parse(String(sheet.col_widths))).toEqual({ 0: 240, 4: 96 });
    expect(JSON.parse(String(sheet.row_heights))).toEqual({ 2: 48 });
    await expect(api.call("set-sheet", { sheet_id: id, col_widths: JSON.stringify({ 0: 40 }) }))
      .rejects.toThrow(/between 48 and 600/);
    await expect(api.call("set-sheet", { sheet_id: id, row_heights: JSON.stringify({ 0: 201 }) }))
      .rejects.toThrow(/between 20 and 200/);
    await expect(api.call("set-cells", {
      sheet_id: id, cells: JSON.stringify([{ row: 0, col: 0, style: JSON.stringify({ verticalAlign: "baseline" }) }]),
    })).rejects.toThrow(/verticalAlign/);
  });

  it("appends rows and columns at the configured table bounds", async () => {
    const api = setup().plugin("sheets");
    const { id } = await api.call<{ id: number }>("add-sheet", { channel_id: 1, name: "Table" });
    await api.call("insert-rows", { sheet_id: id, at: 1000 });
    await api.call("insert-cols", { sheet_id: id, at: 26 });
    const [sheet] = await api.read("sheets_sheets", { id });
    expect([sheet.rows, sheet.cols]).toEqual([1001, 27]);
  });

  it("remaps calendar item rows by date when cells per day changes and protects occupied slots", async () => {
    const api = setup().plugin("sheets");
    const { id } = await api.call<{ id: number }>("add-sheet", { channel_id: 1, name: "Calendar" });
    await api.call("set-sheet", { sheet_id: id, mode: "calendar", calendar: JSON.stringify({ itemsPerDay: 4 }) });
    await api.call("set-cells", {
      sheet_id: id,
      cells: JSON.stringify([{ row: 20_000 * 4, col: 0, value: "first" }, { row: 20_000 * 4 + 2, col: 0, value: "third" }]),
    });
    await expect(api.call("set-sheet", { sheet_id: id, calendar: JSON.stringify({ itemsPerDay: 2 }) }))
      .rejects.toThrow(/extra daily slots/);
    await api.call("set-cells", { sheet_id: id, cells: JSON.stringify([{ row: 20_000 * 4 + 2, col: 0, value: null }]) });
    await api.call("set-sheet", { sheet_id: id, calendar: JSON.stringify({ itemsPerDay: 2 }) });
    expect((await api.read("sheets_cells", { sheet_id: id })).map((cell) => [cell.row, cell.value]))
      .toEqual([[20_000 * 2, "first"]]);
    await api.call("set-sheet", { sheet_id: id, mode: "grid" });
    await api.call("set-sheet", { sheet_id: id, mode: "calendar" });
  });

  it("keeps one sheet and removes its rows when deleting another", async () => {
    const api = setup().plugin("sheets");
    const first = await api.call<{ id: number }>("add-sheet", { channel_id: 1, name: "First" });
    await expect(api.call("delete-sheet", { sheet_id: first.id })).rejects.toThrow(/keep at least one sheet/);
    const second = await api.call<{ id: number }>("add-sheet", { channel_id: 1, name: "Second" });
    await api.call("set-cells", { sheet_id: second.id, cells: JSON.stringify([{ row: 0, col: 0, value: "x" }]) });
    await api.call("set-rule", { sheet_id: second.id, range: "A1:B2", kind: "dropdown", config: JSON.stringify({ options: ["x"] }) });
    await api.call("delete-sheet", { sheet_id: second.id });
    expect(await api.read("sheets_sheets")).toHaveLength(1);
    expect(await api.read("sheets_cells")).toEqual([]);
    expect(await api.read("sheets_rules")).toEqual([]);
  });

  it("enforces dropdown, number, and checkbox rules when cells change", async () => {
    const api = setup().plugin("sheets");
    const { id } = await api.call<{ id: number }>("add-sheet", { channel_id: 1, name: "Sheet 1" });
    await api.call("set-rule", { sheet_id: id, range: "A1", kind: "dropdown", config: JSON.stringify({ options: ["red", "blue"] }) });
    await expect(api.call("set-cells", { sheet_id: id, cells: JSON.stringify([{ row: 0, col: 0, value: "green" }]) }))
      .rejects.toThrow(/dropdown options/);
    await api.call("set-cells", { sheet_id: id, cells: JSON.stringify([{ row: 0, col: 0, value: "blue" }]) });

    await api.call("set-rule", { sheet_id: id, range: "B1", kind: "number", config: JSON.stringify({ min: 0, max: 10 }) });
    await expect(api.call("set-cells", { sheet_id: id, cells: JSON.stringify([{ row: 0, col: 1, value: "11" }]) }))
      .rejects.toThrow(/number rule/);
    await api.call("set-rule", { sheet_id: id, range: "C1", kind: "checkbox", config: "{}" });
    await expect(api.call("set-cells", { sheet_id: id, cells: JSON.stringify([{ row: 0, col: 2, value: "perhaps" }]) }))
      .rejects.toThrow(/checkbox value/);
    await expect(api.call("set-cells", { sheet_id: id, cells: JSON.stringify([{ row: 0, col: 0, style: "{bad}" }]) }))
      .rejects.toThrow(/style must be valid JSON/);
  });

  it("shifts formulas and turns deleted references into #REF!", async () => {
    const api = setup().plugin("sheets");
    const { id } = await api.call<{ id: number }>("add-sheet", { channel_id: 1, name: "Sheet 1" });
    await api.call("set-cells", {
      sheet_id: id,
      cells: JSON.stringify([
        { row: 0, col: 0, value: "10" },
        { row: 1, col: 0, value: "20" },
        { row: 0, col: 1, value: "=SUM(A2:A3)+$A$2" },
      ]),
    });
    await api.call("insert-rows", { sheet_id: id, at: 1 });
    let [formula] = await api.read("sheets_cells", { row: 0, col: 1 });
    expect(formula.value).toBe("=SUM(A3:A4)+$A$3");
    await api.call("delete-rows", { sheet_id: id, at: 2, count: 1 });
    [formula] = await api.read("sheets_cells", { row: 0, col: 1 });
    expect(formula.value).toBe("=SUM(A3:A3)+#REF!");
  });
});
