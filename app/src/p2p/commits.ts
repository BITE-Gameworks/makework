// Where a device keeps the signed commits of its serverless workspaces: IndexedDB (`commits`, keyed
// "<server>:<hash>"), the workspace's own folder on desktop (`.makework/commits/<plugin>.jsonl` through the desktop
// app), or memory in tests.
import { dbDelete, dbDeleteMany, dbDeleteRange, dbGet, dbGetRange, dbPut, dbPutMany, prefixRange } from "../core/db";
import { desktop, type DesktopBridge } from "../core/desktop";
import { compareCommits, type Commit } from "./log";
import type { CommitStore, StoredCheckpoint } from "./ledger";

export const indexedCommits: CommitStore = {
  load: (workspaceId) => dbGetRange<Commit>("commits", prefixRange(workspaceId)),
  add: (workspaceId, commits) => dbPutMany("commits", commits.map((c) => [`${workspaceId}:${c.hash}`, c] as const)),
  compact: (workspaceId, hashes) => dbDeleteMany("commits", hashes.map((hash) => `${workspaceId}:${hash}`)),
  loadCheckpoint: async (workspaceId) => (await dbGet<StoredCheckpoint>("checkpoints", workspaceId)) ?? null,
  saveCheckpoint: (workspaceId, checkpoint) => dbPut("checkpoints", checkpoint, workspaceId),
  deleteCheckpoint: (workspaceId) => dbDelete("checkpoints", workspaceId),
};

type Storage = Pick<NonNullable<DesktopBridge["storage"]>,
  "location" | "loadCommits" | "addCommits" | "compactCommits" | "loadCheckpoint" | "saveCheckpoint" | "deleteCheckpoint">;

const folderCommits = (storage: Storage): CommitStore => ({
  // The folder's files come one plugin after another; sorted, the ledger adds them without moving any.
  load: async (workspaceId) => (await storage.loadCommits(workspaceId)).sort(compareCommits),
  add: (workspaceId, commits) => storage.addCommits(workspaceId, commits),
  compact: (workspaceId, hashes) => storage.compactCommits(workspaceId, hashes),
  loadCheckpoint: (workspaceId) => storage.loadCheckpoint(workspaceId),
  saveCheckpoint: (workspaceId, checkpoint) => storage.saveCheckpoint(workspaceId, checkpoint),
  deleteCheckpoint: (workspaceId) => storage.deleteCheckpoint(workspaceId),
});

// The workspace's folder when it has one, else IndexedDB.
export async function commitStoreFor(workspaceId: string, storage: Storage | undefined = desktop?.storage): Promise<CommitStore> {
  return storage && (await storage.location(workspaceId)) ? folderCommits(storage) : indexedCommits;
}

export function clearCommits(workspaceId: string): Promise<void> {
  return dbDeleteRange("commits", prefixRange(workspaceId));
}

export function memoryCommits(): CommitStore & { all: Map<string, Commit[]> } {
  const all = new Map<string, Commit[]>();
  return {
    all,
    load: async (workspaceId) => [...(all.get(workspaceId) ?? [])],
    add: async (workspaceId, commits) => void all.set(workspaceId, [...(all.get(workspaceId) ?? []), ...commits]),
    compact: async (workspaceId, hashes) => {
      const removed = new Set(hashes);
      all.set(workspaceId, (all.get(workspaceId) ?? []).filter((commit) => !removed.has(commit.hash)));
    },
  };
}
