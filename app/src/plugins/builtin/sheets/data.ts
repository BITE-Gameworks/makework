import type { ApiValue } from "../../../api/types";
import { decodeEmoji, encodeEmoji } from "../../../markdown/emoji";
import { createLive } from "../../live";
import type { PluginClient } from "../../../api/client";

// Sizes of rows and columns nobody resized, in px.
export const rowHeight = 28;
export const colWidth = 128;

export interface Sheet {
  id: number;
  channel_id: number;
  name: string;
  color: string;
  locked: boolean;
  z: number;
  rows: number | null;
  cols: number | null;
  mode: "grid" | "calendar";
  calendar: Record<string, unknown>;
  frozen_rows: number;
  frozen_cols: number;
  col_widths: Record<number, number>;
  row_heights: Record<number, number>;
}

export interface SheetCell {
  id: number;
  sheet_id: number;
  row: number;
  col: number;
  value: string;
  style: CellStyle;
  author_id: number;
  updated_at: string;
}

export interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  background?: string;
  align?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle" | "bottom";
  format?: "number" | "percent" | "currency" | "date";
  currency?: string;
}

export interface SheetRule {
  id: number;
  sheet_id: number;
  range: string;
  kind: "dropdown" | "number" | "date" | "checkbox" | "conditional";
  config: Record<string, unknown>;
}

export interface WorkbookSheet extends Sheet {
  cells: SheetCell[];
  rules: SheetRule[];
}

const obj = (value: unknown): Record<string, unknown> => {
  try {
    const result = JSON.parse(String(value ?? "{}"));
    return result && typeof result === "object" && !Array.isArray(result) ? result : {};
  } catch {
    return {};
  }
};

const number = (value: ApiValue | undefined) => value == null ? null : Number(value);

function toSheet(row: Record<string, ApiValue>): Sheet {
  return {
    id: Number(row.id), channel_id: Number(row.channel_id), name: decodeEmoji(String(row.name ?? "")), color: String(row.color ?? ""), z: Number(row.z),
    locked: row.locked === true, rows: number(row.rows), cols: number(row.cols), mode: row.mode === "calendar" ? "calendar" : "grid",
    calendar: obj(row.calendar), frozen_rows: Number(row.frozen_rows ?? 0), frozen_cols: Number(row.frozen_cols ?? 0),
    col_widths: obj(row.col_widths) as Record<number, number>, row_heights: obj(row.row_heights) as Record<number, number>,
  };
}

function toCell(row: Record<string, ApiValue>): SheetCell {
  return {
    id: Number(row.id), sheet_id: Number(row.sheet_id), row: Number(row.row), col: Number(row.col),
    value: decodeEmoji(String(row.value ?? "")), style: obj(row.style) as CellStyle,
    author_id: Number(row.author_id), updated_at: String(row.updated_at ?? ""),
  };
}

function toRule(row: Record<string, ApiValue>): SheetRule {
  return {
    id: Number(row.id), sheet_id: Number(row.sheet_id), range: String(row.range ?? ""),
    kind: String(row.kind ?? "dropdown") as SheetRule["kind"], config: obj(row.config),
  };
}

export async function loadWorkbook(api: PluginClient, channelId: number): Promise<WorkbookSheet[]> {
  const { rows } = await api.call<{ rows: Record<string, ApiValue>[] }>("list-sheets", { channel_id: channelId });
  return Promise.all(rows.map(async (row) => {
    const sheet = toSheet(row);
    const [cells, rules] = await Promise.all([
      api.call<{ rows: Record<string, ApiValue>[] }>("list-cells", { sheet_id: sheet.id }),
      api.call<{ rows: Record<string, ApiValue>[] }>("list-rules", { sheet_id: sheet.id }),
    ]);
    return { ...sheet, cells: cells.rows.map(toCell), rules: rules.rows.map(toRule) };
  }));
}

export const createWorkbook = (api: PluginClient, channelId: number) =>
  createLive<WorkbookSheet[]>(api, [], () => channelId, () => loadWorkbook(api, channelId));

export const renameSheet = (api: PluginClient, sheetId: number, name: string) =>
  api.call("rename-sheet", { sheet_id: sheetId, name: encodeEmoji(name) });

export const moveSheet = (api: PluginClient, sheetId: number, z: number) =>
  api.call("move-sheet", { sheet_id: sheetId, z });

export const deleteSheet = (api: PluginClient, sheetId: number) =>
  api.call("delete-sheet", { sheet_id: sheetId });

export const setSheet = (api: PluginClient, sheetId: number, settings: Record<string, unknown>) =>
  api.call("set-sheet", {
    sheet_id: sheetId,
    ...settings,
    ...(["calendar", "col_widths", "row_heights"] as const).reduce((out, key) => {
      if (settings[key] !== undefined) out[key] = JSON.stringify(settings[key]);
      return out;
    }, {} as Record<string, unknown>),
  });

export interface CellChange {
  row: number;
  col: number;
  value?: string | null;
  style?: CellStyle | null;
}

export const setCells = (api: PluginClient, sheetId: number, changes: CellChange[]) =>
  api.call("set-cells", {
    sheet_id: sheetId,
    cells: JSON.stringify(changes.map((change) => ({
      ...change,
      ...(typeof change.value === "string" && { value: encodeEmoji(change.value) }),
      ...(change.style && { style: JSON.stringify(change.style) }),
    }))),
  });

export const insertRows = (api: PluginClient, sheetId: number, at: number) =>
  api.call("insert-rows", { sheet_id: sheetId, at });

export const deleteRows = (api: PluginClient, sheetId: number, at: number, count = 1) =>
  api.call("delete-rows", { sheet_id: sheetId, at, count });

export const insertCols = (api: PluginClient, sheetId: number, at: number) =>
  api.call("insert-cols", { sheet_id: sheetId, at });

export const deleteCols = (api: PluginClient, sheetId: number, at: number, count = 1) =>
  api.call("delete-cols", { sheet_id: sheetId, at, count });

export const setRule = (api: PluginClient, sheetId: number, range: string, kind: SheetRule["kind"], config: Record<string, unknown>, ruleId?: number) =>
  api.call("set-rule", { sheet_id: sheetId, range, kind, config: JSON.stringify(config), ...(ruleId !== undefined && { rule_id: ruleId }) });

export const deleteRule = (api: PluginClient, ruleId: number) =>
  api.call("delete-rule", { rule_id: ruleId });
