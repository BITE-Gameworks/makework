import { describe, expect, it } from "vitest";
import { commitStoreFor, indexedCommits } from "../../src/p2p/commits";
import type { Commit } from "../../src/p2p/log";
import type { StoredCheckpoint } from "../../src/p2p/ledger";

// The desktop bridge's storage calls, with servers "inFolder" kept in a folder.
function bridge() {
  const lines = new Map<string, Commit[]>();
  const checkpoints = new Map<string, StoredCheckpoint>();
  return {
    lines,
    checkpoints,
    location: async (id: string) => (id === "inFolder" ? "/home/me/Studio" : null),
    loadCommits: async (id: string) => [...(lines.get(id) ?? [])],
    addCommits: async (id: string, commits: Commit[]) => void lines.set(id, [...(lines.get(id) ?? []), ...commits]),
    compactCommits: async (id: string, hashes: string[]) => {
      const removed = new Set(hashes);
      lines.set(id, (lines.get(id) ?? []).filter((commit) => !removed.has(commit.hash)));
    },
    loadCheckpoint: async (id: string) => checkpoints.get(id) ?? null,
    saveCheckpoint: async (id: string, checkpoint: StoredCheckpoint) => void checkpoints.set(id, checkpoint),
    deleteCheckpoint: async (id: string) => void checkpoints.delete(id),
  };
}

describe("where a server's commits are kept", () => {
  it("uses the server's folder when it has one", async () => {
    const storage = bridge();
    const store = await commitStoreFor("inFolder", storage);
    const commit = { hash: "h1" } as Commit;
    await store.add("inFolder", [commit]);
    expect(storage.lines.get("inFolder")).toEqual([commit]);
    expect(await store.load("inFolder")).toEqual([commit]);
  });

  it("loads a folder's commits in log order, whatever order its files gave", async () => {
    const storage = bridge();
    const store = await commitStoreFor("inFolder", storage);
    const at = (clock: number, hash: string) => ({ clock, author: "a", replica: "r", seq: clock, hash }) as Commit;
    storage.lines.set("inFolder", [at(3, "chat"), at(1, "files"), at(2, "chat")]);
    expect((await store.load("inFolder")).map((c) => c.clock)).toEqual([1, 2, 3]);
  });

  it("uses IndexedDB for servers in the app's storage, and in the browser", async () => {
    expect(await commitStoreFor("inApp", bridge())).toBe(indexedCommits);
    expect(await commitStoreFor("inApp", undefined)).toBe(indexedCommits);
  });

  it("loads, saves and clears a folder checkpoint alongside its commits", async () => {
    const storage = bridge();
    const store = await commitStoreFor("inFolder", storage);
    const checkpoint: StoredCheckpoint = {
      version: 1, index: 256, hash: "anchor", genesisHash: "genesis", tables: [], rejected: [],
    };
    await store.saveCheckpoint!("inFolder", checkpoint);
    expect(await store.loadCheckpoint!("inFolder")).toEqual(checkpoint);
    await store.deleteCheckpoint!("inFolder");
    expect(await store.loadCheckpoint!("inFolder")).toBeNull();
  });
});
