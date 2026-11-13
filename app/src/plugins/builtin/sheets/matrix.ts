export interface CellCoordinate {
  row: number;
  col: number;
}

export const maxMaterializedCells = 100_000;

export function matrixBounds(cells: Iterable<CellCoordinate>) {
  let rows = 1;
  let cols = 1;
  for (const cell of cells) {
    rows = Math.max(rows, cell.row + 1);
    cols = Math.max(cols, cell.col + 1);
  }
  return { rows, cols };
}

export function assertMaterializable(rows: number, cols: number) {
  if (rows * cols > maxMaterializedCells)
    throw new Error(`This sheet is too large to materialize as a file (${rows.toLocaleString()} × ${cols.toLocaleString()} cells; limit ${maxMaterializedCells.toLocaleString()}).`);
}
