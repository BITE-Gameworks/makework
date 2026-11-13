import { describe, expect, it } from "vitest";
import { FormulaBook } from "../../../../src/plugins/builtin/sheets/formula";

const sheet = { id: 1, name: "Main" };
const cells = (values: [number, number, string][]) => values.map(([row, col, value]) => ({ sheetId: 1, row, col, value }));

describe("Sheets formulas", () => {
  it("evaluates arithmetic, operators, ranges, and common functions", () => {
    const book = new FormulaBook([sheet], cells([
      [0, 0, "2"], [1, 0, "3"], [2, 0, "=SUM(A1:A2)"],
      [0, 1, "=IF(A3=5,ROUND(2.345,2),0)"], [1, 1, "=A1&\" apples\""], [2, 1, "=50%+0.25"],
      [3, 0, "=IF(FALSE,A1,6)"],
    ]));
    expect(book.get(1, 2, 0)).toBe(5);
    expect(book.get(1, 0, 1)).toBe(2.35);
    expect(book.get(1, 1, 1)).toBe("2 apples");
    expect(book.get(1, 2, 1)).toBe(0.75);
    expect(book.get(1, 3, 0)).toBe(6);
  });

  it("resolves cross-sheet references and lookup functions", () => {
    const book = new FormulaBook(
      [{ id: 1, name: "Main" }, { id: 2, name: "Budget 2" }],
      [
        { sheetId: 1, row: 0, col: 0, value: "='Budget 2'!B1*2" },
        { sheetId: 1, row: 1, col: 0, value: "=VLOOKUP(\"pear\",'Budget 2'!A1:B2,2,FALSE)" },
        { sheetId: 1, row: 2, col: 0, value: "=INDEX('Budget 2'!A1:B2,2,2)" },
        { sheetId: 1, row: 3, col: 0, value: "=XLOOKUP(\"apple\",'Budget 2'!A1:A2,'Budget 2'!B1:B2)" },
        { sheetId: 2, row: 0, col: 0, value: "pear" },
        { sheetId: 2, row: 0, col: 1, value: "4" },
        { sheetId: 2, row: 1, col: 0, value: "apple" },
        { sheetId: 2, row: 1, col: 1, value: "8" },
      ],
    );
    expect(book.get(1, 0, 0)).toBe(8);
    expect(book.get(1, 1, 0)).toBe(4);
    expect(book.get(1, 2, 0)).toBe(8);
    expect(book.get(1, 3, 0)).toBe(8);
  });

  it("reports cycles, missing names and division by zero", () => {
    const book = new FormulaBook([sheet], cells([
      [0, 0, "=B1"], [0, 1, "=A1"], [0, 2, "=1/0"], [0, 3, "=UNKNOWN(1)"], [0, 4, "=IFERROR(C1,7)"],
    ]));
    expect(String(book.get(1, 0, 0))).toBe("#CYCLE!");
    expect(String(book.get(1, 0, 2))).toBe("#DIV/0!");
    expect(String(book.get(1, 0, 3))).toBe("#NAME?");
    expect(book.get(1, 0, 4)).toBe(7);
  });
});
