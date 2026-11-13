// Agent skills of sheets channels.
import { decodeEmoji, encodeEmoji } from "../../../markdown/emoji";
import { claimOrBusy } from "../../../agents/locks";
import { clip, findChannel, rowsOfChannels } from "../../../agents/skillKit";
import type { AgentIndexer, AgentSkill, BotContext } from "../../types";

const lower = (value: unknown) => String(value ?? "").trim().toLowerCase();
// ---- sheets
const colName = (col: number): string => (col >= 26 ? colName(Math.floor(col / 26) - 1) : "") + String.fromCodePoint(65 + (col % 26));

function parseCell(cell: string): { row: number; col: number } {
  const match = /^([A-Za-z]{1,2})(\d{1,5})$/.exec(cell.trim());
  if (!match) throw new Error(`'${cell}' is not a cell like B3.`);
  const col = [...match[1].toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return { row: Number(match[2]) - 1, col };
}

async function sheetOf(context: BotContext, channelId: number, name: string): Promise<{ id: number; name: string } | null> {
  const sheets = (await context.read("sheets", "sheets_sheets", { channel_id: channelId })).sort((a, b) => Number(a.z) - Number(b.z));
  const row = (name.trim() && sheets.find((s) => lower(s.name) === lower(name))) || sheets[0];
  return row ? { id: Number(row.id), name: String(row.name) } : null;
}

export const sheetsSkills: AgentSkill[] = [{
  name: "sheets_read",
  description: "Reads the filled cells of a sheet (name may be empty for the first sheet) as A1=value lines.",
  args: { channel: "string", sheet: "string" },
  permissions: ["read:sheets"], channelType: "sheets",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "sheets");
    const sheet = await sheetOf(context, channel.id, String(args.sheet));
    if (!sheet) return "The channel has no sheets.";
    const cells = (await context.read("sheets", "sheets_cells", { sheet_id: sheet.id })).filter((c) => c.value != null && c.value !== "")
      .sort((a, b) => Number(a.row) - Number(b.row) || Number(a.col) - Number(b.col));
    return cells.length ? `${sheet.name}:\n${clip(cells.slice(0, 200).map((c) => `${colName(Number(c.col))}${Number(c.row) + 1}=${decodeEmoji(String(c.value))}`).join("\n"))}` : `${sheet.name} is empty.`;
  },
}, {
  name: "sheets_write_table",
  description: String.raw`Writes a block of cells in one step, starting at a cell (like A1). rows has one line per row and cells separated by | (a pipe), for example "Item | Cost\nHosting | 20\nTotal | =SUM(B2:B2)". Values starting with = are formulas. Use it instead of many sheets_set calls.`,
  args: { channel: "string", sheet: "string", start: "string", rows: "string" },
  permissions: ["read:sheets", "write:sheets"], channelType: "sheets",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "sheets");
    const sheets = context.write("sheets");
    const sheet = await sheetOf(context, channel.id, String(args.sheet)) ?? { id: (await sheets.call<{ id: number }>("add-sheet", { channel_id: channel.id, name: "Sheet1" })).id, name: "Sheet1" };
    const origin = parseCell(String(args.start || "A1"));
    const cells: { row: number; col: number; value: string }[] = [];
    String(args.rows).split("\n").forEach((line, r) => line.split("|").forEach((value, c) => {
      const text = value.trim();
      if (text !== "") cells.push({ row: origin.row + r, col: origin.col + c, value: encodeEmoji(text) });
    }));
    if (!cells.length) throw new Error("There is nothing to write.");
    if (cells.length > 400) throw new Error("Write at most 400 cells at a time.");
    claimOrBusy(context, channel.id, `sheet:${sheet.id}`, `The sheet '${sheet.name}'`);
    await sheets.call("set-cells", { sheet_id: sheet.id, cells: JSON.stringify(cells) });
    return `Wrote ${cells.length} cells starting at ${String(args.start || "A1").toUpperCase()} on ${sheet.name}.`;
  },
}, {
  name: "sheets_set",
  description: "Sets one cell of a sheet to a value or a formula starting with = (sheet may be empty for the first sheet).",
  args: { channel: "string", sheet: "string", cell: "string", value: "string" },
  permissions: ["read:sheets", "write:sheets"], channelType: "sheets",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "sheets");
    const sheets = context.write("sheets");
    const sheet = await sheetOf(context, channel.id, String(args.sheet)) ?? { id: (await sheets.call<{ id: number }>("add-sheet", { channel_id: channel.id, name: "Sheet1" })).id, name: "Sheet1" };
    const { row, col } = parseCell(String(args.cell));
    claimOrBusy(context, channel.id, `cell:${sheet.id}:${row}:${col}`, `Cell ${String(args.cell).toUpperCase()}`);
    await sheets.call("set-cells", { sheet_id: sheet.id, cells: JSON.stringify([{ row, col, value: encodeEmoji(String(args.value)) }]) });
    return `Set ${String(args.cell).toUpperCase()} on ${sheet.name} to ${args.value}.`;
  },
}];


const maxSheetText = 5000;

export const sheetsIndex: AgentIndexer = {
  permissions: ["read:sheets"], noun: "sheets",
  async items(context, channels) {
    const sheets = await rowsOfChannels(context, "sheets", "sheets_sheets", channels);
    const values = new Map<number, string[]>();
    for (const cell of await context.read("sheets", "sheets_cells")) {
      if (!cell.value) continue;
      values.set(Number(cell.sheet_id), [...(values.get(Number(cell.sheet_id)) ?? []), decodeEmoji(String(cell.value))]);
    }
    return sheets.map((r) => ({ channelId: Number(r.channel_id), id: Number(r.id), label: String(r.name), text: (values.get(Number(r.id)) ?? []).join(" ").slice(0, maxSheetText) }));
  },
};
