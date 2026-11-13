import { describe, expect, it } from "vitest";
import { capacity, groupPlaces, layout, slot, type SpreadPoint } from "../../src/shell/globeSpread";

const member = (key: string, lon = 2.33, lat = 48.87, self = false): SpreadPoint => ({ key, lon, lat, kind: "member", self });
const node = (key: string, lon = 2.33, lat = 48.87): SpreadPoint => ({ key, lon, lat, kind: "node" });

describe("groupPlaces", () => {
  it("puts points on the same spot into one place and others apart", () => {
    const places = groupPlaces([member("a"), member("b", 2.4, 48.9), member("c", 13.37, 52.5)]);
    expect(places.map((p) => p.items.map((i) => i.key).sort())).toEqual([["a", "b"], ["c"]]);
  });

  it("puts the signed-in member first, then nodes, whatever the order given", () => {
    const points = [member("x"), node("n"), member("y"), member("me", undefined, undefined, true)];
    const [place] = groupPlaces(points);
    expect(place.items.slice(0, 2).map((i) => i.key)).toEqual(["me", "n"]);
    const [again] = groupPlaces([...points].reverse());
    expect(again.items.map((i) => i.key)).toEqual(place.items.map((i) => i.key));
  });
});

describe("slot", () => {
  const nearest = (count: number, seed: number) => {
    const spots = Array.from({ length: count }, (_, i) => slot(i, 9, seed));
    let least = Infinity;
    for (let i = 0; i < count; i++)
      for (let j = i + 1; j < count; j++) least = Math.min(least, Math.hypot(spots[i][0] - spots[j][0], spots[i][1] - spots[j][1]));
    return least;
  };

  it("keeps every slot at least about a step from the others", () => {
    for (const count of [2, 3, 7, 40, 500]) for (const seed of [0, 1234567, 4000000000]) expect(nearest(count, seed)).toBeGreaterThanOrEqual(9 * 0.9);
  });

  it("gives the same slot for the same inputs and another scatter for another place", () => {
    expect(slot(5, 9, 42)).toEqual(slot(5, 9, 42));
    expect(slot(5, 9, 42)).not.toEqual(slot(5, 9, 43));
  });
});

describe("capacity", () => {
  it("fits more slots in a bigger disk, and always one", () => {
    expect(capacity(0, 9)).toBe(1);
    expect(capacity(20, 9)).toBeGreaterThan(capacity(10, 9));
    expect(capacity(60, 9)).toBeGreaterThan(capacity(20, 9));
  });
});

describe("layout", () => {
  const crowd = (count: number, lon: number, prefix: string) => Array.from({ length: count }, (_, i) => member(`${prefix}${i}`, lon, 48.87));
  const options = { step: 9, maxRadius: 30 };

  it("draws a lone point right on its place", () => {
    const [place] = groupPlaces([member("a")]);
    const { spots, badges } = layout([{ place, at: [100, 100] }], options);
    expect(spots.get("a")).toEqual([100, 100]);
    expect(badges).toEqual([]);
  });

  it("gives every point of a crowd that fits a spot, and no badge", () => {
    const [place] = groupPlaces(crowd(5, 2.33, "m"));
    const { spots, badges } = layout([{ place, at: [100, 100] }], options);
    expect(spots.size).toBe(5);
    expect(badges).toEqual([]);
  });

  it("counts the members who don't fit in a badge, never the signed-in member or nodes", () => {
    const points = [...crowd(80, 2.33, "m"), member("me", 2.33, 48.87, true), node("n")];
    const [place] = groupPlaces(points);
    const { spots, ends, badges } = layout([{ place, at: [100, 100] }], options);
    expect(badges).toHaveLength(1);
    const [badge] = badges;
    expect(spots.size + badge.keys.length).toBe(82);
    expect(spots.size).toBe(capacity(30, 9) - 1);
    expect(spots.has("me") && spots.has("n")).toBe(true);
    expect(badge.keys).not.toContain("me");
    // Lines of hidden members end at the badge.
    expect(ends.get(badge.keys[0])).toEqual(badge.at);
    expect(ends.size).toBe(82);
  });

  it("shows more of a crowd in a bigger disk (zoomed in)", () => {
    const [place] = groupPlaces(crowd(300, 2.33, "m"));
    const small = layout([{ place, at: [100, 100] }], options).badges[0].keys.length;
    const big = layout([{ place, at: [100, 100] }], { ...options, maxRadius: 60 }).badges[0].keys.length;
    expect(big).toBeLessThan(small);
  });

  it("keeps two nearby crowds' spots apart", () => {
    const places = groupPlaces([...crowd(40, 2.33, "p"), ...crowd(40, 4.33, "b")]);
    const { spots } = layout([{ place: places[0], at: [100, 100] }, { place: places[1], at: [140, 100] }], options);
    const left = [...spots].filter(([k]) => k.startsWith("p")).map(([, at]) => at);
    const right = [...spots].filter(([k]) => k.startsWith("b")).map(([, at]) => at);
    for (const a of left) for (const b of right) expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeGreaterThanOrEqual(9 * 0.9);
  });

  it("leaves a big crowd the room a small neighbour doesn't need", () => {
    const shown = (neighbours: number) => {
      const places = groupPlaces([...crowd(60, 2.33, "p"), ...crowd(neighbours, 4.33, "b")]);
      const { spots } = layout([{ place: places[0], at: [100, 100] }, { place: places[1], at: [160, 100] }], options);
      return { paris: [...spots.keys()].filter((k) => k.startsWith("p")).length, brussels: [...spots.keys()].filter((k) => k.startsWith("b")).length };
    };
    const beside = shown(3);
    expect(beside.brussels).toBe(3);
    expect(beside.paris).toBeGreaterThan(shown(60).paris);
  });

  it("joins two crowds too close to spread both into one, around their middle", () => {
    const places = groupPlaces([...crowd(20, 2.33, "p"), ...crowd(20, 4.33, "b")]);
    const { badges } = layout([{ place: places[0], at: [100, 100] }, { place: places[1], at: [130, 100] }], options);
    expect(badges).toHaveLength(1);
    expect(badges[0].keys.some((k) => k.startsWith("p")) && badges[0].keys.some((k) => k.startsWith("b"))).toBe(true);
  });

  it("never leaves two crowds on top of each other, whatever order their places come in", () => {
    const places = groupPlaces([...crowd(5, 2.33, "a"), ...crowd(5, 4.33, "b"), ...crowd(5, 6.33, "c")]);
    for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [2, 1, 0]]) {
      const ats: [number, number][] = [[100, 100], [115, 100], [130, 100]];
      const { spots, badges } = layout(order.map((i) => ({ place: places[i], at: ats[i] })), options);
      const all = [...spots.values(), ...badges.map((b) => b.at)];
      for (let i = 0; i < all.length; i++)
        for (let j = i + 1; j < all.length; j++) expect(Math.hypot(all[i][0] - all[j][0], all[i][1] - all[j][1])).toBeGreaterThanOrEqual(9 * 0.9);
    }
  });

  it("joins a crowd whose middle moved close to another after a join", () => {
    const places = groupPlaces([...crowd(5, 2.33, "a"), ...crowd(5, 6.33, "c"), ...crowd(50, 4.33, "b")]);
    const ats: [number, number][] = [[100, 100], [137, 100], [118, 100]];
    const { badges } = layout(places.map((place, i) => ({ place, at: ats[i] })), options);
    expect(badges).toHaveLength(1);
  });

  it("keeps a lone node on its own place beside a crowd", () => {
    const places = groupPlaces([...crowd(20, 2.33, "p"), node("n", 4.33, 48.87)]);
    const { spots } = layout([{ place: places[0], at: [100, 100] }, { place: places[1], at: [125, 100] }], options);
    expect(spots.get("n")).toEqual([125, 100]);
  });

  it("joins places drawn on top of each other into one crowd", () => {
    const places = groupPlaces([...crowd(3, 2.33, "p"), ...crowd(3, 4.33, "b")]);
    const { spots } = layout([{ place: places[0], at: [100, 100] }, { place: places[1], at: [103, 100] }], options);
    expect(spots.size).toBe(6);
    const all = [...spots.values()];
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) expect(Math.hypot(all[i][0] - all[j][0], all[i][1] - all[j][1])).toBeGreaterThanOrEqual(9 * 0.9);
  });
});
