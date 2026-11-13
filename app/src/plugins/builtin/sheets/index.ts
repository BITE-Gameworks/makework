import { solidView } from "../../solid";
import type { ClientPlugin } from "../../types";
import { sheetsSkills, sheetsIndex } from "./agentSkills";
import SheetsView from "./SheetsView";
import { sheetsDisk } from "./disk";
import { sheetsExports } from "./exportProvider";
import { loadWorkbook } from "./data";
import { cellAddress, FormulaBook } from "./formula";

export const sheetsPlugin: ClientPlugin = {
  manifest: {
    id: "makework.sheets",
    icon: "channel-table",
    name: "Sheets",
    version: "0.1.0",
    description: "Spreadsheets with formulas, formatting, validation rules, dropdowns and calendar mode.",
    author: "MakeWork",
  },
  agentSkills: { sheets: [...sheetsSkills] },
  agentIndex: { sheets: sheetsIndex },
  channelViews: { sheets: solidView(SheetsView) },
  disk: { sheets: sheetsDisk },
  exports: { sheets: sheetsExports },
  links: {
    sheets: {
      async resolve(target, context) {
        if (target.kind !== "cell") return null;
        const workbook = await loadWorkbook(context.api, context.channel.id);
        const cell = workbook.flatMap((sheet) => sheet.cells).find((row) => row.id === Number(target.id));
        const sheet = workbook.find((row) => row.id === cell?.sheet_id);
        return cell && sheet
          ? { title: `${sheet.name}!${cellAddress(cell.row, cell.col)} ${cell.value}`, icon: "channel-table" }
          : null;
      },
      async search(query, context) {
        const workbook = await loadWorkbook(context.api, context.channel.id);
        const formula = new FormulaBook(workbook.map(({ id, name }) => ({ id, name })),
          workbook.flatMap((sheet) => sheet.cells.map((cell) => ({ sheetId: sheet.id, row: cell.row, col: cell.col, value: cell.value }))));
        return workbook.flatMap((sheet) => sheet.cells.filter((cell) => cell.value.toLowerCase().includes(query)).map((cell) => ({
          kind: "cell", id: cell.id, title: `${sheet.name}!${cellAddress(cell.row, cell.col)} ${cell.value}`,
          detail: String(formula.get(sheet.id, cell.row, cell.col)),
        }))).slice(0, 5);
      },
    },
  },
};
