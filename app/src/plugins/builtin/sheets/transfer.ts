import * as XLSX from "@e965/xlsx";
import type { WorkbookSheet } from "./data";

export interface ImportedSheet {
  name: string;
  rows: number;
  cols: number;
  cells: { row: number; col: number; value: string }[];
}

const maxImportBytes = 25 * 1024 * 1024;
const maxImportCells = 50_000;
const maxImportRows = 100_000;
const maxImportCols = 1_000;

export function importWorkbook(bytes: Uint8Array, fileName: string, existingNames: string[]): ImportedSheet[] {
  if (bytes.byteLength > maxImportBytes) throw new Error("Import files must be 25 MB or smaller.");
  const book = XLSX.read(bytes, { type: "array", cellDates: true });
  if (!book.SheetNames.length) throw new Error("The selected file contains no worksheets.");
  const names = new Set(existingNames.map((name) => name.toLocaleLowerCase()));
  let totalCells = 0;
  return book.SheetNames.map((sourceName) => {
    const worksheet = book.Sheets[sourceName];
    const ref = worksheet["!ref"];
    const range = ref ? XLSX.utils.decode_range(ref) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
    const rows = range.e.r + 1;
    const cols = range.e.c + 1;
    const area = rows * cols;
    if (rows > maxImportRows || cols > maxImportCols || area > maxImportCells)
      throw new Error(`Worksheet "${sourceName}" exceeds the import limit of ${maxImportCells.toLocaleString()} cells.`);
    totalCells += area;
    if (totalCells > maxImportCells)
      throw new Error(`The workbook exceeds the import limit of ${maxImportCells.toLocaleString()} cells.`);
    const name = uniqueSheetName(sourceName || fileName.replace(/\.[^.]+$/, ""), names);
    const cells: ImportedSheet["cells"] = [];
    for (let row = range.s.r; row <= range.e.r; row++) {
      for (let col = range.s.c; col <= range.e.c; col++) {
        const cell = worksheet[XLSX.utils.encode_cell({ r: row, c: col })];
        if (cell?.v === undefined || cell.v === null) continue;
        const value = typeof cell.f === "string"
          ? `=${cell.f}`
          : cell.v instanceof Date
            ? cell.v.toISOString().slice(0, 10)
            : String(cell.v);
        if (value !== "") cells.push({ row, col, value });
      }
    }
    return { name, rows, cols, cells };
  });
}

export type SheetFileFormat = "xlsx" | "xls" | "ods" | "csv";

export function exportWorkbook(sheets: WorkbookSheet[], format: SheetFileFormat, currentId: number): Blob {
  const selected = sheets.find((sheet) => sheet.id === currentId) ?? sheets[0];
  if (!selected) throw new Error("There is no sheet to export.");
  const exported = format === "csv" ? [selected] : sheets;
  const book = XLSX.utils.book_new();
  for (const sheet of exported) {
    const cellRows = sheet.cells.reduce((max, cell) => Math.max(max, cell.row + 1), 1);
    const cellCols = sheet.cells.reduce((max, cell) => Math.max(max, cell.col + 1), 1);
    const rows: (string | null)[][] = Array.from({ length: cellRows }, () => new Array<string | null>(cellCols).fill(null));
    for (const cell of sheet.cells) rows[cell.row][cell.col] = cell.value;
    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    for (const cell of sheet.cells) {
      if (!cell.value.startsWith("=")) continue;
      const address = XLSX.utils.encode_cell({ r: cell.row, c: cell.col });
      worksheet[address] = { t: "n", f: cell.value.slice(1) };
    }
    XLSX.utils.book_append_sheet(book, worksheet, sheet.name.slice(0, 31) || "Sheet");
  }
  if (format === "csv")
    return new Blob([XLSX.utils.sheet_to_csv(book.Sheets[book.SheetNames[0]])], { type: "text/csv;charset=utf-8" });
  const data = XLSX.write(book, { bookType: format, type: "array" });
  return new Blob([data], { type: mimeType(format) });
}

export function safeWorkbookName(name: string): string {
  return name.trim().replace(/[/\\:*?"<>|]/g, "_") || "Workbook";
}

function uniqueSheetName(source: string, names: Set<string>): string {
  const base = source.replace(/[\\/*?:[\]]/g, " ").trim().slice(0, 31) || "Sheet";
  let name = base;
  let suffix = 2;
  while (names.has(name.toLocaleLowerCase())) {
    const ending = ` (${suffix++})`;
    name = `${base.slice(0, 31 - ending.length)}${ending}`;
  }
  names.add(name.toLocaleLowerCase());
  return name;
}

function mimeType(format: Exclude<SheetFileFormat, "csv">): string {
  return format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    : format === "xls" ? "application/vnd.ms-excel"
      : "application/vnd.oasis.opendocument.spreadsheet";
}
