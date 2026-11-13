// The account's private category order (core/categoryOrder.ts): personal, never synced.
import { describe, expect, it, vi } from "vitest";
import type { Category } from "../../src/core/workspaces";

vi.mock("../../src/core/account", () => ({ account: () => ({ id: "acct" }) }));

import { categoryOrder, orderedCategories, reorderCategories, setCategoryOrder } from "../../src/core/categoryOrder";

const categories: Category[] = [
  { id: 1, name: "a", position: 0 },
  { id: 2, name: "b", position: 1 },
  { id: 3, name: "c", position: 2 },
];

describe("categoryOrder", () => {
  it("keeps the stored order per server and per account", () => {
    setCategoryOrder("svr", [3, 1, 2]);
    expect(categoryOrder("svr")).toEqual([3, 1, 2]);
    expect(categoryOrder("other")).toBeUndefined();
    setCategoryOrder("other", [1, 3]);
    expect(categoryOrder("svr")).toEqual([3, 1, 2]);
    expect(categoryOrder("other")).toEqual([1, 3]);
  });
});

describe("orderedCategories", () => {
  it("shows the stored order first, new categories after in the server's order", () => {
    expect(orderedCategories(categories, [3, 1]).map((c) => c.id)).toEqual([3, 1, 2]);
    expect(orderedCategories(categories, [9, 3]).map((c) => c.id)).toEqual([3, 1, 2]);
  });

  it("falls back to the server's order when none is stored", () => {
    expect(orderedCategories(categories, undefined).map((c) => c.id)).toEqual([1, 2, 3]);
    expect(orderedCategories(categories, []).map((c) => c.id)).toEqual([1, 2, 3]);
  });
});

describe("reorderCategories", () => {
  it("moves a category before another, to the end with null, and never touches a no-op drop", () => {
    expect(reorderCategories([1, 2, 3], 3, 1)).toEqual([3, 1, 2]);
    expect(reorderCategories([1, 2, 3], 1, null)).toEqual([2, 3, 1]);
    expect(reorderCategories([1, 2, 3], 2, null)).toEqual([1, 3, 2]);
    expect(reorderCategories([1, 2, 3], 1, 1)).toEqual([1, 2, 3]);
    expect(reorderCategories([1, 2, 3], 2, 3)).toEqual([1, 2, 3]);
    expect(reorderCategories([1, 2, 3], 7, 1)).toEqual([1, 2, 3]);
  });

  it("returns the same array for a no-op move", () => {
    const ids = [1, 2, 3];
    expect(reorderCategories(ids, 3, null)).toBe(ids);
  });
});