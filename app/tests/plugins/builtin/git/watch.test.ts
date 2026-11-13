import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compareHeads, describeChanges, repeat } from "../../../../src/plugins/builtin/git/watch";

describe("watching the remote", () => {
  it("finds the branches that moved or appeared", () => {
    const known = [{ name: "main", head: "a1" }, { name: "dev", head: "b1" }];
    expect(compareHeads(known, [{ name: "main", head: "a2" }, { name: "dev", head: "b1" }, { name: "new", head: "c1" }]))
      .toEqual([{ branch: "main", count: null, isNew: false }, { branch: "new", count: null, isNew: true }]);
    expect(compareHeads(known, known)).toEqual([]);
  });

  it("says what changed in a line", () => {
    expect(describeChanges([{ branch: "main", count: 3, isNew: false }])).toBe("3 new commits on main");
    expect(describeChanges([{ branch: "main", count: 1, isNew: false }, { branch: "dev", count: null, isNew: true }]))
      .toBe("1 new commit on main, new branch dev");
    expect(describeChanges([{ branch: "main", count: null, isNew: false }])).toBe("new commits on main");
  });

  describe("repeating a check", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("runs one check at a time, on time and when the window comes back", async () => {
      let running = 0;
      let most = 0;
      let calls = 0;
      const check = vi.fn(async () => {
        calls++;
        most = Math.max(most, ++running);
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        running--;
      });
      const target = new EventTarget();
      const stop = repeat(check, 60_000, { focus: target, minGapMs: 10_000 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toBe(1);
      // While a check runs, another isn't started; focus right after one is too soon.
      target.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(20_000);
      target.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(2);
      expect(most).toBe(1);
      stop();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(calls).toBe(2);
    });
  });
});
