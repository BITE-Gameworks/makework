import { describe, expect, it } from "vitest";
import { groupOfNode, memberGroups, nodeGroups } from "../../src/p2p/nodeGroups";

const node = (user: number, lon: number | null = null, lat: number | null = null) => ({ user, lat, lon });

describe("node groups", () => {
  it("keeps up to 3 nodes in one group", () => {
    expect(nodeGroups([node(3), node(1), node(2)])).toEqual([[1, 2, 3]]);
  });

  it("groups more nodes by longitude, at most 3 each, sizes differing by one at most", () => {
    const nodes = [node(1, 100), node(2, -70), node(3, 10), node(4, 140), node(5, -80), node(6, 5), node(7, 120)];
    const groups = nodeGroups(nodes);
    expect(groups).toHaveLength(3);
    expect(groups.flat().sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const group of groups) expect(group.length).toBeLessThanOrEqual(3);
    // Neighbours by longitude, in runs: 3 / 2 / 2 from west to east.
    expect(groups.map((g) => [...g].sort((a, b) => a - b))).toEqual([[2, 5, 6], [1, 3], [4, 7]]);
    expect(groupOfNode(groups, 4)).toBe(groupOfNode(groups, 7));
  });

  it("puts a member first in the group nearest to it, else in one picked by its id", () => {
    const nodes = [node(1, -74, 40.7), node(2, -87, 41.8), node(3, 2.3, 48.9), node(4, 13.4, 52.5)];
    const groups = nodeGroups(nodes);
    expect(groups).toHaveLength(2);
    const paris = memberGroups(groups, nodes, { lat: 48.9, lon: 2.3 }, "m1");
    expect(groups[paris[0]]).toContain(3);
    const chicago = memberGroups(groups, nodes, { lat: 41.8, lon: -87.6 }, "m1");
    expect(groups[chicago[0]]).toContain(2);
    // Without a place: by id, the same answer every time, and different members spread over the groups.
    expect(memberGroups(groups, nodes, null, "m1")).toEqual(memberGroups(groups, nodes, null, "m1"));
    const firsts = new Set(Array.from({ length: 20 }, (_, i) => memberGroups(groups, nodes, null, `m${i}`)[0]));
    expect(firsts.size).toBe(2);
  });
});
