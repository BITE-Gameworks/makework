import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  bitsFromBase64, bitsToBase64, dataHolders, defaultStorage, digestBytes, duties, groupIndexes, hasBit, keyOfSlot, matchesList, minStripeMb,
  parityHolder, parityKey, pieceCount, pieceKey, pieceLength, pieceSize, setBit, setMinStripeBytes, slotCount, slotOf, striped, stripeLimit,
  xorPieces, type Storage,
} from "../../src/p2p/pieces";

const hash = "ab".repeat(32);
const nodes = (users: number[], gone: number[] = []) => users.map((user) => ({ user, gone: gone.includes(user) }));
const copies: Storage = { copies: 2, stripeBytes: 16 * 1024 * 1024, parity: 0 };
const parity: Storage = { copies: 2, stripeBytes: 16 * 1024 * 1024, parity: 3 };

describe("pieces", () => {
  afterEach(() => setMinStripeBytes(null));

  it("splits nothing under 20 GB: the default, and stored thresholds below it count as it", () => {
    const gb = 1024 ** 3;
    expect(defaultStorage.stripeBytes).toBe(20 * gb);
    expect(minStripeMb()).toBe(20 * 1024);
    expect(stripeLimit(null)).toBe(20 * gb);
    expect(stripeLimit(0)).toBe(0);
    expect(stripeLimit(16)).toBe(20 * gb);
    expect(stripeLimit(100 * 1024)).toBe(100 * gb);
    expect(striped(19 * gb, { ...copies, stripeBytes: stripeLimit(16) })).toBe(false);
    expect(striped(300 * gb, { ...copies, stripeBytes: stripeLimit(16) })).toBe(true);
    // Tests lower it.
    setMinStripeBytes(1024 * 1024);
    expect(stripeLimit(1)).toBe(1024 * 1024);
    expect(defaultStorage.stripeBytes).toBe(1024 * 1024);
  });

  it("splits only files over the threshold, in 4 MiB pieces with a shorter last one", () => {
    expect(striped(16 * 1024 * 1024, copies)).toBe(false);
    expect(striped(16 * 1024 * 1024 + 1, copies)).toBe(true);
    expect(striped(1e12, { ...copies, stripeBytes: 0 })).toBe(false);
    expect(striped(null, copies)).toBe(false);
    const size = 9 * 1024 * 1024 + 5;
    expect(pieceCount(size)).toBe(3);
    expect([0, 1, 2].map((i) => pieceLength(i, size))).toEqual([pieceSize, pieceSize, 1024 * 1024 + 5]);
  });

  it("gives every piece `copies` nodes, spread over all of them", () => {
    const all = nodes([1, 2, 3, 4]);
    const size = 40 * pieceSize;
    const per = new Map<number, number>();
    for (let i = 0; i < pieceCount(size); i++) {
      const kept = dataHolders(hash, i, all, copies);
      expect(new Set(kept).size).toBe(2);
      for (const user of kept) per.set(user, (per.get(user) ?? 0) + 1);
    }
    expect([...per.keys()].sort()).toEqual([1, 2, 3, 4]);
    // Each node's own list says the same.
    const fromDuties = [1, 2, 3, 4].reduce((n, me) => n + duties(hash, size, me, all, copies).length, 0);
    expect(fromDuties).toBe(pieceCount(size) * 2);
  });

  it("with parity: one node per piece, and each group's parity on a node keeping none of its pieces", () => {
    const all = nodes([1, 2, 3, 4, 5]);
    const size = 10 * pieceSize;
    for (let g = 0; g * parity.parity < pieceCount(size); g++) {
      const group = groupIndexes(g, size, parity);
      const keepers = group.flatMap((i) => dataHolders(hash, i, all, parity));
      expect(keepers).toHaveLength(group.length);
      const p = parityHolder(hash, g, size, all, parity);
      if (new Set(keepers).size < 5) expect(keepers).not.toContain(p);
    }
    expect(groupIndexes(3, size, parity)).toEqual([9]);
  });

  it("with parity, puts the pieces of a group on different nodes, so one node lost costs a group one piece", () => {
    const size = 30 * pieceSize;
    for (const seed of ["ab", "cd", "ef", "01", "23"]) {
      const h = seed.repeat(32);
      const three = nodes([1, 2, 3]);
      for (let g = 0; g * parity.parity < pieceCount(size); g++) {
        const keepers = groupIndexes(g, size, parity).flatMap((i) => dataHolders(h, i, three, parity));
        expect(new Set(keepers).size).toBe(keepers.length);
      }
      // A node gone: still apart among the others.
      const left = nodes([1, 2, 3, 4], [2]);
      for (let g = 0; g * parity.parity < pieceCount(size); g++) {
        const keepers = groupIndexes(g, size, parity).flatMap((i) => dataHolders(h, i, left, parity));
        expect(new Set(keepers).size).toBe(keepers.length);
        expect(keepers).not.toContain(2);
      }
    }
    // Fewer nodes than a group's pieces: they share, every piece still has a node.
    expect(groupIndexes(0, size, parity).map((i) => dataHolders(hash, i, nodes([1, 2]), parity).length)).toEqual([1, 1, 1]);
  });

  it("rebuilds a lost piece from the rest of its group and the parity", () => {
    const piece = (seed: number, length = pieceSize) => {
      const bytes = new Uint8Array(length);
      for (let j = 0; j < length; j++) bytes[j] = (j * seed + 7) % 256;
      return bytes;
    };
    const same = (x: Uint8Array, y: Uint8Array) => Buffer.from(x).equals(Buffer.from(y));
    const group = [piece(3), piece(5), piece(11, 1000)];
    const p = xorPieces(group);
    expect(same(xorPieces([group[0], group[2], p]).slice(0, pieceSize), group[1])).toBe(true);
    expect(same(xorPieces([group[0], group[1], p]).slice(0, 1000), group[2])).toBe(true);
    expect(same(xorPieces([group[0], group[1], p]).slice(0, 1000), group[0].slice(0, 1000))).toBe(false);
  });

  it("says which pieces a node has as one bit per slot", () => {
    const size = 10 * pieceSize + 1; // 11 pieces; with parity per 3, 4 parity pieces
    expect(slotCount(size, parity)).toBe(15);
    expect(slotOf(pieceKey(hash, 10), hash, size)).toBe(10);
    expect(slotOf(parityKey(hash, 2), hash, size)).toBe(13);
    expect(keyOfSlot(hash, 13, size)).toBe(parityKey(hash, 2));
    expect(slotOf(`${"cd".repeat(32)}:1`, hash, size)).toBeNull();
    let bits: Uint8Array = new Uint8Array(0);
    for (const slot of [0, 7, 8, 13]) bits = setBit(bits, slot, true);
    bits = setBit(bits, 7, false);
    const back = bitsFromBase64(bitsToBase64(bits))!;
    expect([0, 7, 8, 13, 14, 200].map((slot) => hasBit(back, slot))).toEqual([true, false, true, true, false, false]);
    expect(bitsFromBase64("not base64!")).toBeNull();
  });

  it("checks a piece against the file's piece list", async () => {
    const pieces = [new Uint8Array(1000).fill(1), new Uint8Array(500).fill(2)] as Uint8Array<ArrayBuffer>[];
    const list = new Uint8Array(pieces.length * digestBytes);
    pieces.forEach((piece, i) => list.set(createHash("sha256").update(piece).digest(), i * digestBytes));
    expect(await matchesList(list, 0, pieces[0])).toBe(true);
    expect(await matchesList(list, 1, pieces[1])).toBe(true);
    expect(await matchesList(list, 1, pieces[0])).toBe(false);
    expect(await matchesList(list, 2, pieces[0])).toBe(false);
  });
});
