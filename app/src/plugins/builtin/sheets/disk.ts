import { decodeEmoji } from "../../../markdown/emoji";
import type { DiskContext, DiskEntry, DiskLayout } from "../../types";
import { FormulaBook, type CellValue } from "./formula";
import { matrixBounds, maxMaterializedCells } from "./matrix";

const csv = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
const show = (value: CellValue) => value instanceof Date ? value.toISOString().slice(0, 10) : value == null ? "" : String(value);
const safeName = (value: string) => value.replace(/[\\/:*?"<>|]/g, "-").trim() || "Sheet";
const object = (value: unknown): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
};

export const sheetsDisk: DiskLayout = {
  async entries(context: DiskContext): Promise<DiskEntry[]> {
    const workbook = context.rows("sheets", "sheets_sheets").filter((row) => Number(row.channel_id) === context.channel.id)
      .sort((a, b) => Number(a.z) - Number(b.z) || a.id - b.id).map((row) => {
        const cells = context.rows("sheets", "sheets_cells", { column: "sheet_id", ids: [row.id] });
        const rules = context.rows("sheets", "sheets_rules", { column: "sheet_id", ids: [row.id] });
        return {
          id: row.id, name: decodeEmoji(String(row.name ?? "")),
          cells: cells.map((cell) => ({
            row: Number(cell.row), col: Number(cell.col), value: decodeEmoji(String(cell.value ?? "")),
            style: object(cell.style),
          })),
          rules: rules.map((rule) => ({
            id: rule.id, range: String(rule.range ?? ""), kind: String(rule.kind ?? ""), config: object(rule.config),
          })),
          calendar: object(row.calendar),
        };
      });
    const formulas = new FormulaBook(workbook.map(({ id, name }) => ({ id, name })), workbook.flatMap((sheet) =>
      sheet.cells.map((cell) => ({ sheetId: sheet.id, row: cell.row, col: cell.col, value: cell.value }))));
    const files: DiskEntry[] = [];
    for (const sheet of workbook) {
      const { rows, cols } = matrixBounds(sheet.cells);
      // Too big for a file: left out of the readable folder, so one huge sheet doesn't stop the whole folder copy.
      if (rows * cols > maxMaterializedCells) continue;
      const matrix = Array.from({ length: rows }, (_, row) =>
        Array.from({ length: cols }, (_, col) => csv(show(formulas.get(sheet.id, row, col)))).join(","));
      files.push({ path: [`${context.name([], `sheet:${sheet.id}`, safeName(decodeEmoji(sheet.name)))}.csv`], text: matrix.join("\r\n") });
      files.push({
        path: [".sheets", `${context.name([".sheets"], `sheet:${sheet.id}`, safeName(decodeEmoji(sheet.name)))}.json`],
        text: JSON.stringify({
          id: sheet.id, name: decodeEmoji(sheet.name), formulas: sheet.cells.filter((cell) => cell.value.startsWith("="))
            .map(({ row, col, value }) => ({ row, col, value })),
          styles: sheet.cells.filter((cell) => Object.keys(cell.style).length)
            .map(({ row, col, style }) => ({ row, col, style })),
          rules: sheet.rules, calendar: sheet.calendar,
        }, null, 2),
      });
    }
    return files;
  },
};
