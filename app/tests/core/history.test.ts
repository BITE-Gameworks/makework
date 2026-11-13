import { describe, expect, it } from "vitest";
import { historyFor } from "../../src/core/history";

describe("undo history", () => {
  it("undoes, redoes, jumps and drops the redo tail on a new step", async () => {
    const h = historyFor("test:1");
    let value = 0;
    const set = (to: number) => () => Promise.resolve(void (value = to));
    for (const n of [1, 2, 3]) {
      value = n;
      h.push({ label: `set ${n}`, undo: set(n - 1), redo: set(n) });
    }
    await h.undo();
    expect([value, h.position()]).toEqual([2, 2]);
    await h.goTo(0);
    expect([value, h.canUndo(), h.canRedo()]).toEqual([0, false, true]);
    await h.redo();
    expect(value).toBe(1);
    value = 9;
    h.push({ label: "set 9", undo: set(1), redo: set(9) });
    expect([h.entries().length, h.canRedo()]).toEqual([2, false]);
  });

  it("keeps a failed step where it was", async () => {
    const h = historyFor("test:2");
    h.push({ label: "breaks", undo: () => Promise.reject(new Error("gone")), redo: () => Promise.resolve() });
    await expect(h.undo()).rejects.toThrow("gone");
    expect(h.position()).toBe(1);
  });
});
