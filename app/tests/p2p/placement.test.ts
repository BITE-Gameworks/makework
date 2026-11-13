import { describe, expect, it } from "vitest";
import { holders, rank } from "../../src/p2p/placement";

const hashes = Array.from({ length: 1000 }, (_, i) => i.toString(16).padStart(64, "0"));
const nodes = (users: number[], gone: number[] = []) => users.map((user) => ({ user, gone: gone.includes(user) }));

describe("placement", () => {
  it("gives every file the same holders on every device, `copies` of them", () => {
    const all = nodes([11, 22, 33, 44]);
    for (const hash of hashes.slice(0, 50)) {
      const kept = holders(hash, all, 2);
      expect(kept).toHaveLength(2);
      expect(holders(hash, [...all].reverse(), 2)).toEqual(kept);
      expect(new Set(kept).size).toBe(2);
    }
  });

  it("spreads files evenly over the nodes", () => {
    const all = nodes([11, 22, 33, 44]);
    const count = new Map<number, number>();
    for (const hash of hashes) for (const user of holders(hash, all, 2)) count.set(user, (count.get(user) ?? 0) + 1);
    // 1,000 files x 2 copies over 4 nodes: about 500 each.
    for (const n of count.values()) expect(Math.abs(n - 500)).toBeLessThan(75);
  });

  it("moves only a gone node's files, each to the next node in its ranking, and back when it returns", () => {
    const before = new Map(hashes.map((h) => [h, holders(h, nodes([11, 22, 33, 44]), 2)]));
    const during = new Map(hashes.map((h) => [h, holders(h, nodes([11, 22, 33, 44], [33]), 2)]));
    for (const hash of hashes) {
      const was = before.get(hash)!;
      const now = during.get(hash)!;
      expect(now).not.toContain(33);
      expect(now).toHaveLength(2);
      if (!was.includes(33)) expect(now).toEqual(was);
      else expect(now).toEqual(rank(hash, [11, 22, 33, 44]).filter((u) => u !== 33).slice(0, 2));
    }
    const after = hashes.map((h) => holders(h, nodes([11, 22, 33, 44]), 2));
    expect(after).toEqual([...before.values()]);
  });

  it("keeps a file on every node left when there are fewer than `copies`", () => {
    expect(holders(hashes[0], nodes([11, 22, 33], [22]), 3).sort()).toEqual([11, 33]);
    expect(holders(hashes[0], nodes([11]), 2)).toEqual([11]);
  });
});
