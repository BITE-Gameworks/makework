import { contentRef, deleteContent, retainContent, setSynced, storedBlob } from "./content";
import { storeFile } from "./stream";
import { Ledger, newRowId, type SnapshotLoader, type StoredCheckpoint } from "../p2p/ledger";
import { compareCommits, verifyCommit, workspaceIdOf, type Commit, type SnapshotRef } from "../p2p/log";
import { declaredManifestsFromSnapshot } from "../system/declared";

export interface WorkspaceArchive {
  version: 1;
  workspaceId: string;
  cutoffHash: string;
  commits: Commit[];
}

export async function createWorkspaceSnapshot(ledger: Ledger): Promise<Commit> {
  const state = await ledger.snapshotState();
  const log = ledger.log().map(({ commit }) => commit);
  const anchor = log.at(-1);
  if (!anchor || anchor.hash !== state.hash) throw new Error("The snapshot cutoff is no longer the latest signed commit.");
  const previous = ledger.snapshotForBootstrap();
  let previousCommits: Commit[] = [];
  if (previous) {
    if (!previous.ref.archiveContent) throw new Error("The previous snapshot has no history archive to preserve.");
    const previousArchive = await exportWorkspaceArchive(previous.ref.archiveContent);
    previousCommits = await readWorkspaceArchive(previousArchive, ledger.workspaceId, previous.ref.hash, previous.ref.index);
  }
  const commitsByHash = new Map([...previousCommits, ...log].map((commit) => [commit.hash, commit]));
  const commits = [...commitsByHash.values()].sort(compareCommits);
  if (commits.length !== state.index || commits.at(-1)?.hash !== anchor.hash)
    throw new Error("The complete history archive doesn't match the snapshot cutoff.");
  const archive: WorkspaceArchive = { version: 1, workspaceId: ledger.workspaceId, cutoffHash: anchor.hash, commits };
  const archived = await storeFile(new Blob([JSON.stringify(archive)]), { workspaceId: ledger.workspaceId });
  const stored = await storeFile(new Blob([JSON.stringify(state)]), { workspaceId: ledger.workspaceId });
  const releaseArchive = retainContent(ledger.workspaceId, [archived.hash]);
  const ref: SnapshotRef = {
    version: 1, index: state.index, hash: state.hash, genesisHash: state.genesisHash,
    order: { clock: anchor.clock, author: anchor.author, replica: anchor.replica, seq: anchor.seq },
    vector: ledger.vector(), content: contentRef(stored.hash), archiveContent: contentRef(archived.hash),
  };
  const snapshotRowId = newRowId();
  const row = {
    cutoff_index: ref.index, cutoff_hash: ref.hash, genesis_hash: ref.genesisHash, vector: JSON.stringify(ref.vector),
    content: ref.content, archive_content: ref.archiveContent ?? null, created_by: ledger.me, created_at: new Date().toISOString(),
  };
  let committed = false;
  try {
    ledger.transact("workspace.snapshot", () => {
      ledger.write({ ext: "members", table: "members_snapshots", kind: "insert", id: snapshotRowId, values: row });
    }, { ref, state });
    await ledger.flush();
    const active = ledger.snapshotForBootstrap();
    if (!active || active.ref.content !== ref.content) throw new Error("The signed workspace snapshot wasn't saved.");
    committed = true;
    setSynced(ledger.workspaceId, { kind: "archive", id: snapshotRowId }, true);
    await ledger.compactSnapshot();
    return active.commit;
  } catch (error) {
    if (!committed) {
      if (!stored.existed) await deleteContent(stored.hash);
      if (!archived.existed) await deleteContent(archived.hash);
    }
    throw error;
  } finally {
    releaseArchive();
  }
}

export function isSnapshotState(value: unknown): value is StoredCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<StoredCheckpoint>;
  return state.version === 1 && Number.isSafeInteger(state.index) && typeof state.hash === "string"
    && typeof state.genesisHash === "string" && Array.isArray(state.tables) && Array.isArray(state.rejected);
}

// The ledger's reader of snapshot states. `text` gives a content's text from this device's store (the app's, or a
// node's own: nodes have no IndexedDB), null when it isn't here. The declared plugins' tables in the state are
// registered first, so their rows decode.
export function snapshotLoader(ledger: () => Ledger, text: (hash: string) => Promise<string | null>): SnapshotLoader {
  return async (ref) => {
    const hash = ref.content.startsWith("mwc:") ? ref.content.slice(4) : "";
    const stored = /^[0-9a-f]{64}$/.test(hash) ? await text(hash) : null;
    if (stored === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(stored);
    } catch (error) {
      console.warn("Workspace snapshot content isn't valid JSON:", error);
      return null;
    }
    if (!isSnapshotState(value)) return null;
    for (const manifest of declaredManifestsFromSnapshot(value))
      if (!ledger().manifest(manifest.name)) ledger().register(manifest);
    return value;
  };
}

export async function readWorkspaceArchive(blob: Blob, workspaceId: string, cutoffHash: string, cutoffIndex: number): Promise<Commit[]> {
  const value: unknown = JSON.parse(await blob.text());
  if (!isWorkspaceArchive(value) || value.workspaceId !== workspaceId || value.cutoffHash !== cutoffHash
    || value.commits.length !== cutoffIndex)
    throw new Error("This archive doesn't match the workspace snapshot.");
  const verified = await Promise.all(value.commits.map(verifyCommit));
  const commits: Commit[] = [];
  const hashes = new Set<string>();
  for (let i = 0; i < verified.length; i++) {
    const commit = verified[i];
    if (!commit || commit.hash !== value.commits[i].hash
      || hashes.has(commit.hash) || (i > 0 && compareCommits(commits[i - 1], commit) >= 0)
      || (commit.server !== workspaceId && (commit.server !== "" || await workspaceIdOf(commit) !== workspaceId)))
      throw new Error("The archive contains an invalid or unrelated signed change.");
    hashes.add(commit.hash);
    commits.push(commit);
  }
  const genesis = commits.filter((commit) => commit.server === "");
  if (genesis.length !== 1 || await workspaceIdOf(genesis[0]) !== workspaceId
    || commits.at(-1)?.hash !== cutoffHash)
    throw new Error("The archive doesn't contain the signed snapshot cutoff.");
  return commits;
}

function isWorkspaceArchive(value: unknown): value is WorkspaceArchive {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const archive = value as Partial<WorkspaceArchive>;
  return archive.version === 1 && typeof archive.workspaceId === "string" && typeof archive.cutoffHash === "string"
    && Array.isArray(archive.commits) && archive.commits.every((commit) =>
      !!commit && typeof commit === "object" && typeof commit.hash === "string");
}

export async function exportWorkspaceArchive(content: string): Promise<Blob> {
  const hash = content.startsWith("mwc:") ? content.slice(4) : "";
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("The history archive reference is invalid.");
  const blob = await storedBlob(hash);
  if (!blob) throw new Error("This history archive isn't on this device.");
  return blob;
}
