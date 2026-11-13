// Shared list-order rules: a saved order first, items it does not know after it, and moves that never copy a
// list that did not change.
import { describe, expect, it } from "vitest";
import { orderedBy, reorderIds } from "../../src/core/order";

const byId = (item: { id: number }) => item.id;
const items = [{ id: 1 }, { id: 2 }, { id: 3 }];

describe("orderedBy", () => {
  it("shows the saved order first, then items it does not know, in their current order", () => {
    expect(orderedBy(items, [3, 1], byId).map(byId)).toEqual([3, 1, 2]);
    expect(orderedBy(items, [9, 3], byId).map(byId)).toEqual([3, 1, 2]);
  });

  it("falls back to the current order when none is stored", () => {
    expect(orderedBy(items, undefined, byId)).toBe(items);
    expect(orderedBy(items, [], byId)).toBe(items);
  });

  it("does not repeat an id or copy a list that is already in that order", () => {
    expect(orderedBy(items, [3, 3, 1], byId).map(byId)).toEqual([3, 1, 2]);
    expect(orderedBy(items, [1, 2, 3], byId)).toBe(items);
  });
});

describe("reorderIds", () => {
  it("moves an id before another, to the end with null, and never touches a no-op move", () => {
    expect(reorderIds([1, 2, 3], 3, 1)).toEqual([3, 1, 2]);
    expect(reorderIds([1, 2, 3], 1, null)).toEqual([2, 3, 1]);
    expect(reorderIds([1, 2, 3], 2, null)).toEqual([1, 3, 2]);
    expect(reorderIds([1, 2, 3], 1, 1)).toEqual([1, 2, 3]);
    expect(reorderIds([1, 2, 3], 2, 3)).toEqual([1, 2, 3]);
    expect(reorderIds([1, 2, 3], 7, 1)).toEqual([1, 2, 3]);
  });

  it("returns the same array for a no-op move", () => {
    const ids = [1, 2, 3];
    expect(reorderIds(ids, 3, null)).toBe(ids);
  });

  it("works with workspace ids", () => {
    expect(reorderIds(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });
});
