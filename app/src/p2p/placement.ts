// Which nodes keep which file (RAID 1 style: every file on `copies` nodes). Rendezvous hashing: each node gets a score
// per file from the file's hash and the node's user id; a file's holders are the `copies` highest-scoring nodes that
// aren't gone. Everyone computes the same answer from the workspace's node rows alone, with no list to keep in sync, and
// when a node is gone only its files move (to the next node in their ranking); when it comes back they move back.
// Nodes and members use it (node/host.ts keeps its files, p2p/nodes.ts asks holders first).

export type PlacedNode = { user: number; gone: boolean };

// A fast 53-bit hash (cyrb53): the same on every device, no WebCrypto (async) needed for thousands of files.
function score(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// Every node ranked for this file, best first (ties by user id, so the order is total).
export function rank(hash: string, users: number[]): number[] {
  return users
    .map((user) => ({ user, s: score(`${hash}:${user}`) }))
    .sort((a, b) => b.s - a.s || a.user - b.user)
    .map((x) => x.user);
}

// The nodes that keep this file: the first `copies` in its ranking that aren't gone. With fewer nodes left than
// `copies`, all of them.
export function holders(hash: string, nodes: PlacedNode[], copies: number): number[] {
  const gone = new Set(nodes.filter((n) => n.gone).map((n) => n.user));
  return rank(hash, nodes.map((n) => n.user)).filter((user) => !gone.has(user)).slice(0, Math.max(1, copies));
}

// Copies of each file a workspace asks for when it hasn't set any.
export const defaultCopies = 1;
