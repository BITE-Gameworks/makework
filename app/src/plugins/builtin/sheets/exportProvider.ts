import type { ExportProvider, LinkContext } from "../../types";
import { wrapText } from "../canvas/text";
import { colWidth, loadWorkbook, rowHeight, type WorkbookSheet } from "./data";
import { FormulaBook, type CellValue } from "./formula";
import { assertMaterializable, matrixBounds } from "./matrix";

const idOf = (id: number | string) => /^table:\d+$/.test(String(id)) ? Number(String(id).slice(6)) : null;
const escapeHtml = (value: string) => value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const escapeXml = (value: string) => escapeHtml(value).replaceAll("'", "&apos;");
const display = (value: CellValue) => value instanceof Date ? value.toISOString().slice(0, 10) : value instanceof Error ? value.message : value == null ? "" : String(value);
async function tableValues(context: LinkContext, sheetId: number) {
  const workbook = await loadWorkbook(context.api, context.channel.id);
  const sheet = workbook.find((item) => item.id === sheetId);
  if (!sheet) return null;
  const size = matrixBounds(sheet.cells);
  assertMaterializable(size.rows, size.cols);
  const formula = new FormulaBook(workbook.map(({ id, name }) => ({ id, name })), workbook.flatMap((item) =>
    item.cells.map((cell) => ({ sheetId: item.id, row: cell.row, col: cell.col, value: cell.value }))));
  const values = Array.from({ length: size.rows }, (_, row) =>
    Array.from({ length: size.cols }, (_, col) => display(formula.get(sheetId, row, col))));
  return { sheet, values };
}

function markup(values: string[][]) {
  return `<table>${values.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</table>`;
}

const fontSize = 14;
const lineHeight = 18;
const padding = 6;

// The cells as an SVG grid: columns as wide as in the sheet, text wrapped inside its cell and rows as tall as their
// longest text, so nothing is cut off.
export function svg(values: string[][], columnWidth: (col: number) => number, minRowHeight: (row: number) => number): string {
  const cols = Math.max(1, ...values.map((row) => row.length));
  const widths = Array.from({ length: cols }, (_, col) => columnWidth(col));
  const lefts = widths.map((_, col) => widths.slice(0, col).reduce((sum, w) => sum + w, 0));
  const laid = values.map((row) => row.map((value, col) => wrapText(value, fontSize, Math.max(1, widths[col] - padding * 2))));
  const heights = laid.map((row, y) => Math.max(minRowHeight(y), ...row.map((lines) => lines.length * lineHeight + padding * 2)));
  const width = widths.reduce((sum, w) => sum + w, 0);
  const height = heights.reduce((sum, h) => sum + h, 0);
  let top = 0;
  const cells = laid.flatMap((row, y) => {
    const rowTop = top;
    top += heights[y];
    return row.map((lines, x) => {
      const textTop = rowTop + (heights[y] - lines.length * lineHeight) / 2;
      const text = lines.every((line) => !line) ? "" : `<text font-family="sans-serif" font-size="${fontSize}" fill="currentColor">${lines.map((line, i) =>
        `<tspan x="${lefts[x] + padding}" y="${textTop + i * lineHeight + 13}" xml:space="preserve">${escapeXml(line)}</tspan>`).join("")}</text>`;
      return `<rect x="${lefts[x]}" y="${rowTop}" width="${widths[x]}" height="${heights[y]}" fill="none" stroke="currentColor"/>${text}`;
    });
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${cells}</svg>`;
}

// A sheet's grid at its own column widths and row heights; the calendar as seven equal days.
function sheetSvg(sheet: WorkbookSheet, values: string[][], calendar: boolean): string {
  if (calendar) return svg(values, () => 160, () => 32);
  return svg(values, (col) => Number(sheet.col_widths[col]) || colWidth, (row) => Number(sheet.row_heights[row]) || rowHeight);
}

export function calendarValues(sheet: WorkbookSheet, workbook: WorkbookSheet[]) {
  // The month it is now, like the calendar view opens on (browsing months is each reader's own, never saved).
  const now = new Date();
  const [year, month] = [now.getUTCFullYear(), now.getUTCMonth() + 1];
  const weekdayValue = Number(sheet.calendar.firstWeekday ?? 1);
  const firstWeekday = Number.isInteger(weekdayValue) && weekdayValue >= 0 && weekdayValue <= 6 ? weekdayValue : 1;
  const itemsValue = Number(sheet.calendar.itemsPerDay ?? 4);
  const itemsPerDay = Number.isInteger(itemsValue) && itemsValue >= 1 && itemsValue <= 20 ? itemsValue : 4;
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (first.getUTCDay() - firstWeekday + 7) % 7;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const weeks = Math.ceil((offset + daysInMonth) / 7);
  const formula = new FormulaBook(workbook.map(({ id, name }) => ({ id, name })), workbook.flatMap((item) =>
    item.cells.map((cell) => ({ sheetId: item.id, row: cell.row, col: cell.col, value: cell.value }))));
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const values = Array.from({ length: weeks }, (_, week) => Array.from({ length: 7 }, (_, weekday) => {
    const dayOffset = week * 7 + weekday - offset + 1;
    const date = new Date(Date.UTC(year, month - 1, dayOffset));
    const epochDay = Math.floor(date.getTime() / 86_400_000);
    const items = Array.from({ length: itemsPerDay }, (_, slot) => display(formula.get(sheet.id, epochDay * itemsPerDay + slot, 0)))
      .filter(Boolean).slice(0, 3);
    return `${date.getUTCDate()}${date.getUTCMonth() === month - 1 ? "" : "*"}${items.length ? ` · ${items.join(" · ")}` : ""}`;
  }));
  return [[...weekdays.slice(firstWeekday), ...weekdays.slice(0, firstWeekday)], ...values];
}

export const sheetsExports: ExportProvider = {
  async list(context) {
    const workbook = await loadWorkbook(context.api, context.channel.id);
    return workbook.map((sheet) => ({ id: `table:${sheet.id}`, name: sheet.name, kinds: ["table", "text", "image", "svg"] }));
  },

  async render(id, kind, context, element) {
    const sheetId = idOf(id);
    if (sheetId === null) {
      element.textContent = "Export unavailable";
      return;
    }
    let stopped = false;
    const draw = async () => {
      try {
        const result = await tableValues(context, sheetId);
        if (stopped) return;
        if (!result) { element.textContent = "Export unavailable"; return; }
        if (kind === "text") element.textContent = result.values.map((row) => row.join("\t")).join("\n");
        else if (kind === "table") element.innerHTML = markup(result.values);
        else {
          const calendar = kind === "image" && result.sheet.mode === "calendar";
          const values = calendar ? calendarValues(result.sheet, await loadWorkbook(context.api, context.channel.id)) : result.values;
          element.innerHTML = sheetSvg(result.sheet, values, calendar);
        }
      } catch (error) {
        if (!stopped) element.textContent = error instanceof Error ? error.message : "Export unavailable";
      }
    };
    const unsubscribe = context.api.onEvent(() => void draw());
    await draw();
    return () => { stopped = true; unsubscribe(); };
  },

  async file(id, format, context) {
    if (format.toLowerCase() !== "svg") throw new Error(`Sheets exports don't support ${format}.`);
    const sheetId = idOf(id);
    const result = sheetId === null ? null : await tableValues(context, sheetId);
    if (!result) throw new Error(`Unknown Sheets export ${id}.`);
    const safe = result.sheet.name.replace(/[\\/:*?"<>|]/g, "-") || "sheet";
    const calendar = result.sheet.mode === "calendar";
    const values = calendar ? calendarValues(result.sheet, await loadWorkbook(context.api, context.channel.id)) : result.values;
    return { name: `${safe}.svg`, blob: new Blob([sheetSvg(result.sheet, values, calendar)], { type: "image/svg+xml" }) };
  },
};
