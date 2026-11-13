// Node groups: with more than `groupSize` nodes, a member connects to one group of nodes instead of all of them
// (sync.ts). Groups are neighbours by longitude (nodes without a place by user id), so the group nearest a member is
// near it; a member without a place takes a group by a hash of its id. Nodes reach each other in their own room and
// pass members' messages between groups (mesh.ts, two hops). Everyone works out the same groups from the node rows.
import { rank } from "./placement";

export const groupSize = 3;

export type GroupNode = { user: number; lat: number | null; lon: number | null };

// The groups, each a list of node user ids. One group (all nodes) up to `groupSize` nodes.
export function nodeGroups(nodes: GroupNode[]): number[][] {
  if (nodes.length <= groupSize) return [nodes.map((n) => n.user).sort((a, b) => a - b)];
  const sorted = [...nodes].sort((a, b) => (a.lon ?? 1e9) - (b.lon ?? 1e9) || a.user - b.user);
  const count = Math.ceil(nodes.length / groupSize);
  const groups: number[][] = Array.from({ length: count }, () => []);
  sorted.forEach((node, i) => groups[Math.floor((i * count) / sorted.length)].push(node.user));
  return groups;
}

export function groupOfNode(groups: number[][], user: number): number {
  return groups.findIndex((group) => group.includes(user));
}

// Great-circle distance in km.
function distance(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 12_742 * Math.asin(Math.sqrt(h));
}

// The groups for a member, best first: by the nearest node of each group to `place`, else by a hash of `key`.
export function memberGroups(groups: number[][], nodes: GroupNode[], place: { lat: number; lon: number } | null, key: string): number[] {
  const indexes = groups.map((_, i) => i);
  const byUser = new Map(nodes.map((n) => [n.user, n]));
  const nearest = (group: number[]) => {
    let best = Infinity;
    for (const user of group) {
      const node = byUser.get(user);
      if (place && node && node.lat !== null && node.lon !== null) best = Math.min(best, distance(place, { lat: node.lat, lon: node.lon }));
    }
    return best;
  };
  const hashed = rank(key, indexes);
  if (!place) return hashed;
  const scores = new Map(indexes.map((i) => [i, nearest(groups[i])]));
  return [...hashed].sort((a, b) => scores.get(a)! - scores.get(b)!);
}
