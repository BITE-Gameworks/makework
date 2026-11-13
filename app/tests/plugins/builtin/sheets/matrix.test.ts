import { describe, expect, it } from "vitest";
import { assertMaterializable, matrixBounds } from "../../../../src/plugins/builtin/sheets/matrix";

describe("sheet matrix output", () => {
  it("finds bounds without spreading or filling sparse cells", () => {
    expect(matrixBounds([{ row: 1, col: 2 }, { row: 9, col: 0 }])).toEqual({ rows: 10, cols: 3 });
    expect(matrixBounds([])).toEqual({ rows: 1, cols: 1 });
  });

  it("refuses to materialize oversized sparse ranges", () => {
    expect(() => assertMaterializable(100_000, 100_000)).toThrow(/too large to materialize/);
    expect(() => assertMaterializable(100, 1_000)).not.toThrow();
  });
});
