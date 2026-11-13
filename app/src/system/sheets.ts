import type { MockPlugin } from "./backend";
import type { JsonRow } from "./data";
import { InvalidRequest } from "./errors";

const maxBatch = 500;
const maxCoordinate = 1_000_000;
const editableSheet = ["name", "z", "rows", "cols", "mode", "calendar", "locked", "frozen_rows", "frozen_cols", "col_widths", "row_heights"] as const;

interface CellChange {
  row: number;
  col: number;
  value?: string | null;
  style?: string | null;
}

export const sheets: MockPlugin = {
  manifest: {
    name: "sheets",
    version: "0.1.0",
    description: "Spreadsheets with formulas, formatting, validation rules and calendar mode.",
    tables: [
      {
        name: "sheets_sheets", parent: null,
        columns: {
          channel_id: "bigint", name: "text", color: "text", z: "decimal", rows: "int", cols: "int", mode: "text", calendar: "text",
          locked: "bool", frozen_rows: "int", frozen_cols: "int", col_widths: "text", row_heights: "text",
        },
      },
      {
        name: "sheets_cells", parent: "sheets_sheets",
        columns: { sheet_id: "bigint", row: "int", col: "int", value: "text", style: "text", author_id: "bigint", updated_at: "timestamp" },
      },
      {
        name: "sheets_rules", parent: "sheets_sheets",
        columns: { sheet_id: "bigint", range: "text", kind: "text", config: "text" },
      },
    ],
  },

  register({ data, onApi, onApiRead }) {
    const sheet = (id: unknown): JsonRow => {
      const [row] = data.select("sheets_sheets", { id: Number(id) });
      if (!row) throw new InvalidRequest(`Unknown sheet ${id}`);
      return row;
    };
    const cells = (id: unknown) => data.select("sheets_cells", { sheet_id: Number(id) });
    const number = (value: unknown, what: string, min = 0, max = maxCoordinate): number => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < min || n > max) throw new InvalidRequest(`${what} must be an integer from ${min} to ${max}.`);
      return n;
    };
    const json = (value: unknown, what: string, objectOnly = true): string => {
      let parsed: unknown;
      try { parsed = JSON.parse(String(value)); }
      catch { throw new InvalidRequest(`${what} must be valid JSON.`); }
      if (objectOnly && (!parsed || typeof parsed !== "object" || Array.isArray(parsed)))
        throw new InvalidRequest(`${what} must be a JSON object.`);
      return JSON.stringify(parsed);
    };
    const style = (value: unknown) => {
      const parsed = JSON.parse(json(value, "style")) as Record<string, unknown>;
      const allowed = new Set(["bold", "italic", "underline", "strike", "color", "background", "align", "verticalAlign", "format", "currency"]);
      const unknown = Object.keys(parsed).find((key) => !allowed.has(key));
      if (unknown) throw new InvalidRequest(`Unknown cell style '${unknown}'.`);
      for (const key of ["bold", "italic", "underline", "strike"])
        if (parsed[key] !== undefined && typeof parsed[key] !== "boolean") throw new InvalidRequest(`${key} must be a boolean.`);
      for (const key of ["color", "background"])
        if (parsed[key] !== undefined && parsed[key] !== "" && !/^#[0-9a-f]{6}$/i.test(String(parsed[key])))
          throw new InvalidRequest(`${key} must be a hex color.`);
      if (parsed.align !== undefined && !["left", "center", "right"].includes(String(parsed.align)))
        throw new InvalidRequest("align must be left, center or right.");
      if (parsed.verticalAlign !== undefined && !["top", "middle", "bottom"].includes(String(parsed.verticalAlign)))
        throw new InvalidRequest("verticalAlign must be top, middle or bottom.");
      if (parsed.format !== undefined && !["number", "percent", "currency", "date"].includes(String(parsed.format)))
        throw new InvalidRequest("format must be number, percent, currency or date.");
      if (parsed.currency !== undefined) {
        if (typeof parsed.currency !== "string" || !/^[A-Z]{3}$/.test(parsed.currency))
          throw new InvalidRequest("currency must be a three-letter ISO currency code.");
        if (typeof Intl.supportedValuesOf === "function" && !Intl.supportedValuesOf("currency").includes(parsed.currency))
          throw new InvalidRequest(`'${parsed.currency}' is not a supported currency code.`);
      }
      return JSON.stringify(parsed);
    };
    const rangeBounds = (value: unknown) => {
      const range = String(value).toUpperCase().replaceAll("$", "");
      const match = /^([A-Z]{1,3})([1-9]\d*)(?::([A-Z]{1,3})([1-9]\d*))?$/.exec(range);
      if (!match) throw new InvalidRequest("range must look like A1 or A1:C20.");
      const col = (label: string) => [...label].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0) - 1;
      return {
        value: range,
        top: Math.min(Number(match[2]) - 1, Number(match[4] ?? match[2]) - 1),
        bottom: Math.max(Number(match[2]) - 1, Number(match[4] ?? match[2]) - 1),
        left: Math.min(col(match[1]), col(match[3] ?? match[1])),
        right: Math.max(col(match[1]), col(match[3] ?? match[1])),
      };
    };
    const inRange = (row: number, col: number, range: ReturnType<typeof rangeBounds>) =>
      row >= range.top && row <= range.bottom && col >= range.left && col <= range.right;
    const ruleConfig = (kind: string, value: unknown) => {
      const parsed = JSON.parse(json(value, "config")) as Record<string, unknown>;
      if (kind === "dropdown" && (!Array.isArray(parsed.options) || parsed.options.length === 0))
        throw new InvalidRequest("A dropdown needs at least one option.");
      if (kind === "number") {
        for (const key of ["min", "max"])
          if (parsed[key] !== undefined && !Number.isFinite(Number(parsed[key]))) throw new InvalidRequest(`${key} must be a number.`);
        if (parsed.min !== undefined && parsed.max !== undefined && Number(parsed.min) > Number(parsed.max))
          throw new InvalidRequest("The minimum can't exceed the maximum.");
      }
      if (kind === "conditional") {
        if (typeof parsed.condition !== "string" || !/^(>=|<=|<>|=|>|<)\s*[-+]?\d+(?:\.\d+)?$/.test(parsed.condition))
          throw new InvalidRequest("A conditional rule needs a comparison such as >=10.");
        if (parsed.style !== undefined) parsed.style = JSON.parse(style(JSON.stringify(parsed.style)));
      }
      return JSON.stringify(parsed);
    };
    const calendarConfig = (value: unknown) => {
      const parsed = JSON.parse(json(value, "calendar")) as Record<string, unknown>;
      if (parsed.firstWeekday !== undefined && (!Number.isInteger(parsed.firstWeekday) || Number(parsed.firstWeekday) < 0 || Number(parsed.firstWeekday) > 6))
        throw new InvalidRequest("firstWeekday must be an integer from 0 to 6.");
      if (parsed.itemsPerDay !== undefined && (!Number.isInteger(parsed.itemsPerDay) || Number(parsed.itemsPerDay) < 1 || Number(parsed.itemsPerDay) > 20))
        throw new InvalidRequest("itemsPerDay must be an integer from 1 to 20.");
      if (parsed.month !== undefined && (typeof parsed.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(parsed.month)))
        throw new InvalidRequest("month must use YYYY-MM format.");
      if (parsed.cellStyle !== undefined) parsed.cellStyle = JSON.parse(style(JSON.stringify(parsed.cellStyle)));
      return JSON.stringify(parsed);
    };
    const name = (value: unknown) => {
      const result = String(value ?? "").trim();
      if (!result || result.length > 100) throw new InvalidRequest("Sheet names are 1 to 100 characters.");
      return result;
    };
    const checkAddress = (row: number, col: number, target: JsonRow) => {
      if (target.mode === "calendar" && col === 0) return;
      if ((target.rows != null && row >= Number(target.rows)) || (target.cols != null && col >= Number(target.cols)))
        throw new InvalidRequest("That cell is outside this sheet's size limits.");
    };
    const cellChanges = (value: unknown): CellChange[] => {
      let changes: unknown;
      try { changes = JSON.parse(String(value)); }
      catch { throw new InvalidRequest("'cells' must be a JSON list."); }
      if (!Array.isArray(changes) || changes.length > maxBatch)
        throw new InvalidRequest(`'cells' must be a list of at most ${maxBatch} cells.`);
      return changes as CellChange[];
    };
    const updateCells = (sheetId: number, delta: number, start: number, count: number, axis: "row" | "col", deleting: boolean) => {
      const extent = axis === "row" ? "rows" : "cols";
      const match = (cell: JsonRow) => Number(cell[axis]) >= start && (!deleting || Number(cell[axis]) < start + count);
      const before = cells(sheetId);
      if (deleting) for (const cell of before.filter(match)) data.delete("sheets_cells", { id: cell.id });
      const moving = before.filter((cell) => deleting ? Number(cell[axis]) >= start + count : Number(cell[axis]) >= start)
        .sort((a, b) => deleting ? Number(a[axis]) - Number(b[axis]) : Number(b[axis]) - Number(a[axis]));
      for (const cell of moving) {
        const to = Number(cell[axis]) + delta;
        data.update("sheets_cells", { [axis]: to }, { id: cell.id });
      }
      const current = sheet(sheetId);
      const dimensionKey = axis === "row" ? "row_heights" : "col_widths";
      const dimensions = JSON.parse(String(current[dimensionKey] ?? "{}")) as Record<string, number>;
      const shifted: Record<string, number> = {};
      for (const [indexText, value] of Object.entries(dimensions)) {
        const index = Number(indexText);
        if (deleting && index >= start && index < start + count) continue;
        const next = deleting ? index >= start + count ? index - count : index : index >= start ? index + count : index;
        shifted[String(next)] = value;
      }
      const settings: Record<string, unknown> = {};
      if (Object.keys(dimensions).length > 0) settings[dimensionKey] = JSON.stringify(shifted);
      if (current[extent] != null) settings[extent] = Math.max(1, Number(current[extent]) + delta);
      if (Object.keys(settings).length > 0) data.update("sheets_sheets", settings, { id: sheetId });
    };
    const shiftReferences = (formula: string, formulaSheet: number, targetSheet: number, sheetNames: Map<string, number>,
      axis: "row" | "col", at: number, count: number, deleting: boolean) => {
      if (!formula.startsWith("=")) return formula;
      const columnIndex = (label: string) => [...label].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0) - 1;
      const ref = (columnAbs: string, column: string, rowAbs: string, row: string) => {
        const original = Number(axis === "row" ? row : columnIndex(column)) - (axis === "row" ? 1 : 0);
        if (deleting && original >= at && original < at + count) return "#REF!";
        const next = deleting && original >= at + count ? original - count : !deleting && original >= at ? original + count : original;
        if (axis === "row") return `${columnAbs}${column}${rowAbs}${next + 1}`;
        let n = next + 1;
        let label = "";
        while (n > 0) { label = String.fromCodePoint(65 + (n - 1) % 26) + label; n = Math.floor((n - 1) / 26); }
        return `${columnAbs}${label}${rowAbs}${row}`;
      };
      const rangeRef = (first: RegExpExecArray, second: RegExpExecArray) => {
        const start = Number(axis === "row" ? first[4] : columnIndex(first[2]));
        const end = Number(axis === "row" ? second[4] : columnIndex(second[2]));
        const low = Math.min(start, end);
        const high = Math.max(start, end);
        let nextLow = low;
        let nextHigh = high;
        if (deleting) {
          const startAt = at + (axis === "row" ? 1 : 0);
          if (high < startAt) { /* unchanged */ }
          else if (low >= startAt + count) { nextLow -= count; nextHigh -= count; }
          else if (low >= startAt && high < startAt + count) return "#REF!";
          else {
            if (low >= startAt) nextLow = startAt;
            if (high >= startAt + count) nextHigh = high - count;
            else nextHigh = startAt - 1;
            if (nextHigh < nextLow) return "#REF!";
          }
        } else if (low >= at + (axis === "row" ? 1 : 0)) {
          nextLow += count;
          nextHigh += count;
        } else if (high >= at + (axis === "row" ? 1 : 0)) {
          nextHigh += count;
        }
        const firstNext = start <= end ? nextLow : nextHigh;
        const secondNext = start <= end ? nextHigh : nextLow;
        const make = (match: RegExpExecArray, value: number) => axis === "row"
          ? `${match[1]}${match[2]}${match[3]}${value}`
          : `${match[1]}${columnName(value)}${match[3]}${match[4]}`;
        const columnName = (col: number) => {
          let n = col + 1;
          let label = "";
          while (n > 0) { label = String.fromCodePoint(65 + (n - 1) % 26) + label; n = Math.floor((n - 1) / 26); }
          return label;
        };
        return `${make(first, firstNext)}:${make(second, secondNext)}`;
      };
      const adjustedReference = (match: RegExpExecArray, applies: boolean) =>
        applies ? ref(match[1], match[2].toUpperCase(), match[3], match[4]) : match[0];
      let output = "";
      for (let i = 0; i < formula.length;) {
        if (formula[i] === '"') {
          const start = i++;
          while (i < formula.length) {
            if (formula[i++] === '"' && formula[i] !== '"') break;
            if (formula[i - 1] === '"' && formula[i] === '"') i++;
          }
          output += formula.slice(start, i);
          continue;
        }
        if (formula[i] === "'") {
          const start = i++;
          let name = "";
          while (i < formula.length) {
            if (formula[i] !== "'") { name += formula[i++]; continue; }
            i++;
            if (formula[i] === "'") { name += "'"; i++; continue; }
            break;
          }
          const quoted = formula.slice(start, i);
          output += quoted;
          if (formula[i] === "!") {
            output += formula[i++];
            const match = /^(\$?)([A-Z]{1,3})(\$?)([1-9]\d*)/i.exec(formula.slice(i));
            if (match) {
              const applies = sheetNames.get(name.toLowerCase()) === targetSheet;
              const tail = /^:(\$?)([A-Z]{1,3})(\$?)([1-9]\d*)/i.exec(formula.slice(i + match[0].length));
              if (applies && tail) output += rangeRef(match, tail);
              else output += adjustedReference(match, applies);
              i += match[0].length + (applies && tail ? tail[0].length : 0);
            }
          }
          continue;
        }
        const named = /^([A-Za-z_][A-Za-z0-9_.]*)!/.exec(formula.slice(i));
        if (named) {
          output += named[0];
          i += named[0].length;
          const match = /^(\$?)([A-Z]{1,3})(\$?)([1-9]\d*)/i.exec(formula.slice(i));
          if (match) {
            const applies = sheetNames.get(named[1].toLowerCase()) === targetSheet;
            const tail = /^:(\$?)([A-Z]{1,3})(\$?)([1-9]\d*)/i.exec(formula.slice(i + match[0].length));
            if (applies && tail) output += rangeRef(match, tail);
            else output += adjustedReference(match, applies);
            i += match[0].length + (applies && tail ? tail[0].length : 0);
          }
          continue;
        }
        const match = /^(\$?)([A-Z]{1,3})(\$?)([1-9]\d*)/i.exec(formula.slice(i));
        const previous = formula[i - 1] ?? "";
        if (match && !/[A-Za-z0-9_.]/.test(previous)) {
          const applies = formulaSheet === targetSheet;
          const tail = /^:(\$?)([A-Z]{1,3})(\$?)([1-9]\d*)/i.exec(formula.slice(i + match[0].length));
          if (applies && tail) output += rangeRef(match, tail);
          else output += adjustedReference(match, applies);
          i += match[0].length + (applies && tail ? tail[0].length : 0);
          continue;
        }
        output += formula[i++];
      }
      return output;
    };
    const shiftSheetFormulas = (sheetId: number, axis: "row" | "col", at: number, count: number, deleting: boolean) => {
      const sheetRows = data.select("sheets_sheets");
      const sheetNames = new Map(sheetRows.map((row) => [String(row.name).toLowerCase(), Number(row.id)]));
      const sheetIds = sheetRows.map((row) => Number(row.id));
      for (const id of sheetIds) {
        const formulas = data.select("sheets_cells", { sheet_id: id }).filter((cell) => String(cell.value ?? "").startsWith("="));
        for (const cell of formulas) {
          if (id === sheetId && deleting && Number(cell[axis]) >= at && Number(cell[axis]) < at + count) continue;
          const value = shiftReferences(String(cell.value), id, sheetId, sheetNames, axis, at, count, deleting);
          if (value !== cell.value) data.update("sheets_cells", { value }, { id: cell.id });
        }
      }
    };

    onApi("list-sheets", "Lists a channel's sheets in tab order: { rows }.",
      [{ name: "channel_id", type: "bigint", description: "The sheets channel." }],
      (r) => ({ rows: data.select("sheets_sheets", { channel_id: Number(r.args.channel_id) }).sort((a, b) => Number(a.z) - Number(b.z) || a.id - b.id) }));
    onApi("list-cells", "Lists non-empty cells for one sheet: { rows }.",
      [{ name: "sheet_id", type: "bigint", description: "The sheet." }],
      (r) => ({ rows: cells(r.args.sheet_id) }));
    onApi("list-rules", "Lists data validation and conditional formatting rules: { rows }.",
      [{ name: "sheet_id", type: "bigint", description: "The sheet." }],
      (r) => ({ rows: data.select("sheets_rules", { sheet_id: Number(r.args.sheet_id) }) }));

    onApi("add-sheet", "Adds a sheet at the end of the tabs: { id }.",
      [
        { name: "channel_id", type: "bigint", description: "The sheets channel." },
        { name: "name", type: "text", description: "The tab name." },
      ],
      (r) => {
        const channelId = Number(r.args.channel_id);
        const siblings = data.select("sheets_sheets", { channel_id: channelId });
        if (siblings.some((s) => s.name === name(r.args.name))) throw new InvalidRequest("A sheet with that name already exists.");
        return { id: data.insert("sheets_sheets", {
          channel_id: channelId, name: name(r.args.name), z: Math.max(0, ...siblings.map((s) => Number(s.z))) + 1,
          color: "", rows: 1000, cols: 26, mode: "grid", calendar: JSON.stringify({ itemsPerDay: 4 }), locked: false, frozen_rows: 0, frozen_cols: 0, col_widths: "{}", row_heights: "{}",
        }) };
      });
    onApi("set-sheet", "Changes sheet settings: { name?, color?, rows?, cols?, mode?, calendar?, locked?, frozen_rows?, frozen_cols?, col_widths?, row_heights? }.",
      [
        { name: "sheet_id", type: "bigint", description: "The sheet." },
        ...editableSheet.filter((key) => key !== "z").map((key) => ({
          name: key,
          type: key === "locked" ? "bool" as const : key === "rows" || key === "cols" || key.startsWith("frozen_") ? "int" as const : "text" as const,
          required: false, description: `The new ${key}.`,
        })),
        { name: "color", type: "text", required: false, description: "The tab color." },
        { name: "unlimited_rows", type: "bool", required: false, description: "Remove the row limit." },
        { name: "unlimited_cols", type: "bool", required: false, description: "Remove the column limit." },
      ],
      (r) => {
        const row = sheet(r.args.sheet_id);
        const values: Record<string, unknown> = {};
        const calendarMoves: { cell: JsonRow; row: number }[] = [];
        if (r.args.name != null) values.name = name(r.args.name);
        if (r.args.color != null) {
          const color = String(r.args.color);
          if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw new InvalidRequest("Sheet color must be a hex color or empty.");
          values.color = color.toLowerCase();
        }
        if (r.args.unlimited_rows === true) values.rows = null;
        else if (r.args.rows != null) values.rows = number(r.args.rows, "rows", 1);
        if (r.args.unlimited_cols === true) values.cols = null;
        else if (r.args.cols != null) values.cols = number(r.args.cols, "cols", 1);
        if (r.args.mode != null) {
          if (!["grid", "calendar"].includes(String(r.args.mode))) throw new InvalidRequest("mode is 'grid' or 'calendar'.");
          values.mode = r.args.mode;
        }
        if (r.args.locked != null) {
          if (typeof r.args.locked !== "boolean") throw new InvalidRequest("locked must be a boolean.");
          values.locked = r.args.locked;
        }
        if (r.args.calendar != null) {
          const nextCalendar = calendarConfig(r.args.calendar);
          const previousCalendar = JSON.parse(String(row.calendar ?? "{}")) as Record<string, unknown>;
          const previousItems = Number(previousCalendar.itemsPerDay ?? 4);
          const nextItems = Number(JSON.parse(nextCalendar).itemsPerDay ?? 4);
          if (row.mode === "calendar" && previousItems !== nextItems) {
            const calendarCells = cells(row.id).filter((cell) => Number(cell.col) === 0);
            const mapped = calendarCells.map((cell) => ({
              cell,
              day: Math.floor(Number(cell.row) / previousItems),
              slot: Number(cell.row) % previousItems,
            }));
            if (mapped.some(({ cell, slot }) => slot >= nextItems
              && (String(cell.value ?? "") !== "" || String(cell.style ?? "{}") !== "{}")))
              throw new InvalidRequest("Clear or move items from the extra daily slots before reducing cells per day.");
            for (const { cell, day, slot } of mapped) {
              const nextRow = day * nextItems + slot;
              if (nextRow > maxCoordinate) throw new InvalidRequest("That calendar setting would exceed the cell coordinate limit.");
              if (nextRow !== Number(cell.row)) calendarMoves.push({ cell, row: nextRow });
            }
          }
          values.calendar = nextCalendar;
        }
        for (const key of ["frozen_rows", "frozen_cols"] as const)
          if (r.args[key] != null) values[key] = number(r.args[key], key, 0, 100_000);
        for (const [key, min, max] of [["col_widths", 48, 600], ["row_heights", 20, 200]] as const) {
          if (r.args[key] == null) continue;
          const dimensions = JSON.parse(json(r.args[key], key)) as Record<string, unknown>;
          for (const [index, dimension] of Object.entries(dimensions)) {
            if (!/^(0|[1-9]\d*)$/.test(index) || Number(index) > maxCoordinate)
              throw new InvalidRequest(`${key} keys must be nonnegative row or column indexes.`);
            if (!Number.isFinite(Number(dimension)) || Number(dimension) < min || Number(dimension) > max)
              throw new InvalidRequest(`${key} values must be between ${min} and ${max}.`);
          }
          values[key] = JSON.stringify(dimensions);
        }
        if (values.name !== undefined && data.select("sheets_sheets", { channel_id: row.channel_id }).some((s) => s.id !== row.id && s.name === values.name))
          throw new InvalidRequest("A sheet with that name already exists.");
        const rows = values.rows ?? row.rows;
        const cols = values.cols ?? row.cols;
        const nextMode = values.mode ?? row.mode;
        if (values.rows !== undefined && nextMode !== "calendar" && rows != null
          && cells(row.id).some((c) => Number(c.row) >= Number(rows)))
          throw new InvalidRequest("The row limit can't exclude existing cells.");
        if (values.cols !== undefined && cols != null && cells(row.id).some((c) => Number(c.col) >= Number(cols)))
          throw new InvalidRequest("The column limit can't exclude existing cells.");
        for (const move of calendarMoves) data.update("sheets_cells", { row: move.row }, { id: move.cell.id });
        return { updated: Object.keys(values).length ? data.update("sheets_sheets", values, { id: row.id }) : 0 };
      });
    onApi("rename-sheet", "Renames a sheet.",
      [{ name: "sheet_id", type: "bigint", description: "The sheet." }, { name: "name", type: "text", description: "The tab name." }],
      (r) => {
        const row = sheet(r.args.sheet_id);
        const newName = name(r.args.name);
        if (data.select("sheets_sheets", { channel_id: row.channel_id }).some((s) => s.id !== row.id && s.name === newName))
          throw new InvalidRequest("A sheet with that name already exists.");
        return { updated: data.update("sheets_sheets", { name: newName }, { id: row.id }) };
      });
    onApi("move-sheet", "Moves a sheet to tab position z.",
      [{ name: "sheet_id", type: "bigint", description: "The sheet." }, { name: "z", type: "decimal", description: "The tab position." }],
      (r) => ({ updated: data.update("sheets_sheets", { z: r.args.z }, { id: sheet(r.args.sheet_id).id }) }));
    onApi("delete-sheet", "Deletes a sheet and its cells and rules. A channel must keep at least one sheet.",
      [{ name: "sheet_id", type: "bigint", description: "The sheet." }],
      (r) => {
        const row = sheet(r.args.sheet_id);
        if (data.select("sheets_sheets", { channel_id: row.channel_id }).length < 2)
          throw new InvalidRequest("A sheets channel must keep at least one sheet.");
        data.delete("sheets_cells", { sheet_id: row.id });
        data.delete("sheets_rules", { sheet_id: row.id });
        return { deleted: data.delete("sheets_sheets", { id: row.id }) };
      });

    onApi("set-cells", `Sets up to ${maxBatch} cells in one batch. Each cell is { row, col, value?, style? }; null clears a field.`,
      [
        { name: "sheet_id", type: "bigint", description: "The sheet." },
        { name: "cells", type: "text", description: "JSON list of cell changes." },
      ],
      (r) => {
        const target = sheet(r.args.sheet_id);
        const changes = cellChanges(r.args.cells);
        const seen = new Set<string>();
        let updated = 0;
        for (const change of changes) {
          const row = number(change.row, "row");
          const col = number(change.col, "col");
          checkAddress(row, col, target);
          const [existing] = data.select("sheets_cells", { sheet_id: target.id, row, col });
          const nextValue = change.value === undefined ? existing?.value : change.value;
          if (nextValue != null && nextValue !== "") {
            for (const rule of data.select("sheets_rules", { sheet_id: target.id })) {
              if (!inRange(row, col, rangeBounds(rule.range))) continue;
              const config = JSON.parse(String(rule.config)) as Record<string, unknown>;
              if (rule.kind === "dropdown" && !((config.options as unknown[]) ?? []).some((option) =>
                String(typeof option === "object" && option !== null && "value" in option ? (option as { value: unknown }).value : option) === String(nextValue)))
                throw new InvalidRequest(`Choose one of the dropdown options for cell ${row + 1}, ${col + 1}.`);
              if (rule.kind === "number") {
                const value = Number(nextValue);
                if (!Number.isFinite(value) || (config.min !== undefined && value < Number(config.min)) || (config.max !== undefined && value > Number(config.max)))
                  throw new InvalidRequest(`That value is outside the number rule for cell ${row + 1}, ${col + 1}.`);
              }
              if (rule.kind === "date" && (Number.isNaN(Date.parse(String(nextValue))) || !/^\d{4}-\d{2}-\d{2}$/.test(String(nextValue))))
                throw new InvalidRequest(`That is not a date for cell ${row + 1}, ${col + 1}.`);
              if (rule.kind === "checkbox" && !["true", "false", "1", "0"].includes(String(nextValue).toLowerCase()))
                throw new InvalidRequest(`That is not a checkbox value for cell ${row + 1}, ${col + 1}.`);
            }
          }
          const address = `${row}:${col}`;
          if (seen.has(address)) throw new InvalidRequest("A batch can't change the same cell twice.");
          seen.add(address);
          if (change.value === undefined && change.style === undefined) continue;
          const values: Record<string, unknown> = { updated_at: new Date().toISOString() };
          if (change.value !== undefined) values.value = change.value;
          if (change.style !== undefined) values.style = change.style === null ? null : style(change.style);
          const nextStyle = change.style === undefined ? existing?.style : change.style;
          if ((nextValue == null || nextValue === "") && nextStyle == null) {
            if (existing) updated += data.delete("sheets_cells", { id: existing.id });
          } else if (existing) updated += data.update("sheets_cells", values, { id: existing.id });
          else {
            data.insert("sheets_cells", { sheet_id: target.id, row, col, value: nextValue, style: nextStyle, author_id: r.userId, updated_at: values.updated_at });
            updated++;
          }
        }
        return { updated };
      });

    for (const axis of ["row", "col"] as const) {
      const extent = axis === "row" ? "rows" : "cols";
      for (const operation of ["insert", "delete"] as const) {
        const parameters = [
          { name: "sheet_id", type: "bigint" as const, description: "The sheet." },
          { name: "at", type: "int" as const, description: `The ${axis} index.` },
          ...(operation === "delete" ? [{ name: "count", type: "int" as const, description: "How many to delete." }] : []),
        ];
        onApi(`${operation}-${axis}s`, `${operation === "insert" ? "Inserts" : "Deletes"} ${axis}s and shifts cell addresses.`,
          parameters,
          (r) => {
            const target = sheet(r.args.sheet_id);
            const at = number(r.args.at, "at");
            const count = operation === "delete" ? number(r.args.count, "count", 1, maxCoordinate) : 1;
            const current = target[extent] == null ? null : Number(target[extent]);
            if (current !== null && (operation === "insert" ? at > current : at >= current || at + count > current))
              throw new InvalidRequest(`That ${axis} is outside the sheet's size limit.`);
            if (operation === "insert" && current !== null && current >= maxCoordinate) throw new InvalidRequest(`The ${extent} limit is ${maxCoordinate}.`);
            if (operation === "insert" && cells(target.id).some((cell) => Number(cell[axis]) >= maxCoordinate))
              throw new InvalidRequest(`Inserting there would exceed the ${axis} coordinate limit.`);
            shiftSheetFormulas(target.id, axis, at, count, operation === "delete");
            updateCells(target.id, operation === "insert" ? count : -count, at, count, axis, operation === "delete");
            return { updated: 1 };
          });
      }
    }

    onApi("set-rule", "Adds or changes a validation or conditional formatting rule for a range.",
      [
        { name: "sheet_id", type: "bigint", description: "The sheet." },
        { name: "range", type: "text", description: "A range such as A1:C20." },
        { name: "kind", type: "text", description: "dropdown, number, date, checkbox or conditional." },
        { name: "config", type: "text", description: "JSON rule configuration." },
        { name: "rule_id", type: "bigint", required: false, description: "The existing rule to update." },
      ],
      (r) => {
        const target = sheet(r.args.sheet_id);
        const range = rangeBounds(r.args.range);
        const kind = String(r.args.kind);
        if (!["dropdown", "number", "date", "checkbox", "conditional"].includes(kind)) throw new InvalidRequest("Unknown rule kind.");
        const config = ruleConfig(kind, r.args.config);
        checkAddress(range.bottom, range.right, target);
        if (r.args.rule_id != null) {
          const [existing] = data.select("sheets_rules", { id: Number(r.args.rule_id), sheet_id: target.id });
          if (!existing) throw new InvalidRequest(`Unknown rule ${r.args.rule_id}`);
          data.update("sheets_rules", { range: range.value, kind, config }, { id: existing.id });
          return { id: existing.id };
        }
        const [existing] = data.select("sheets_rules", { sheet_id: target.id, range: range.value });
        if (existing) {
          data.update("sheets_rules", { kind, config }, { id: existing.id });
          return { id: existing.id };
        }
        return { id: data.insert("sheets_rules", { sheet_id: target.id, range: range.value, kind, config }) };
      });
    onApi("delete-rule", "Deletes a validation or conditional formatting rule.",
      [{ name: "rule_id", type: "bigint", description: "The rule." }],
      (r) => ({ deleted: data.delete("sheets_rules", { id: r.args.rule_id as number }) }));
    onApiRead((r) => data.select(r.table, r.where));
  },
};
