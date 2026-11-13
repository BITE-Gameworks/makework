import { describe, expect, it } from "vitest";
import { treeStep, type TreeRow } from "../../src/ui/treeKeys";

// src            (open folder)
//   core         (closed folder)
//   index.ts
// README.md
// docs           (open folder, nothing inside shown)
const rows: TreeRow[] = [
  { level: 1, expanded: true },
  { level: 2, expanded: false },
  { level: 2 },
  { level: 1 },
  { level: 1, expanded: true },
];

describe("treeStep", () => {
  it("moves up and down, and stays at the ends", () => {
    expect(treeStep(rows, 1, "ArrowDown")).toEqual({ focus: 2 });
    expect(treeStep(rows, 1, "ArrowUp")).toEqual({ focus: 0 });
    expect(treeStep(rows, 0, "ArrowUp")).toEqual({ focus: 0 });
    expect(treeStep(rows, 4, "ArrowDown")).toEqual({ focus: 4 });
    expect(treeStep(rows, 2, "Home")).toEqual({ focus: 0 });
    expect(treeStep(rows, 2, "End")).toEqual({ focus: 4 });
  });

  it("opens a closed row with Right, then goes to its first child", () => {
    expect(treeStep(rows, 1, "ArrowRight")).toEqual({ toggle: true });
    expect(treeStep(rows, 0, "ArrowRight")).toEqual({ focus: 1 });
    // Open with nothing inside, and a row that can't open: stays.
    expect(treeStep(rows, 4, "ArrowRight")).toEqual({ focus: 4 });
    expect(treeStep(rows, 3, "ArrowRight")).toEqual({ focus: 3 });
  });

  it("closes an open row with Left, else goes to the parent", () => {
    expect(treeStep(rows, 0, "ArrowLeft")).toEqual({ toggle: true });
    expect(treeStep(rows, 2, "ArrowLeft")).toEqual({ focus: 0 });
    expect(treeStep(rows, 1, "ArrowLeft")).toEqual({ focus: 0 });
    // At the top with nothing to close: stays.
    expect(treeStep(rows, 3, "ArrowLeft")).toEqual({ focus: 3 });
  });

  it("activates with Enter or Space and renames with F2", () => {
    expect(treeStep(rows, 2, "Enter")).toEqual({ activate: true });
    expect(treeStep(rows, 2, " ")).toEqual({ activate: true });
    expect(treeStep(rows, 2, "F2")).toEqual({ rename: true });
  });

  it("leaves other keys and unknown rows alone", () => {
    expect(treeStep(rows, 2, "Delete")).toBeNull();
    expect(treeStep(rows, 2, "a")).toBeNull();
    expect(treeStep(rows, -1, "ArrowDown")).toBeNull();
    expect(treeStep([], 0, "ArrowDown")).toBeNull();
  });
});
