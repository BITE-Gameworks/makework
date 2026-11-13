// A `workspace.snapshot` commit for tests: signed by `who`, cut at the ledger's latest commit, with made-up content refs
// (tests hand the state to the ledger through its snapshot loader).
import { newRowId, type Ledger, type Signer, type StoredCheckpoint } from "../../src/p2p/ledger";
import { signCommit, userNumberOf, type Commit, type SnapshotRef } from "../../src/p2p/log";

export async function signedSnapshot(ledger: Ledger, who: Signer, state: StoredCheckpoint): Promise<Commit> {
  const anchor = ledger.log().at(-1)!.commit;
  const ref: SnapshotRef = {
    version: 1, index: state.index, hash: state.hash, genesisHash: state.genesisHash,
    order: { clock: anchor.clock, author: anchor.author, replica: anchor.replica, seq: anchor.seq },
    vector: ledger.vector(), content: `mwc:${"a".repeat(64)}`, archiveContent: `mwc:${"b".repeat(64)}`,
  };
  return signCommit({
    server: ledger.workspaceId, author: who.author, key: who.key, replica: crypto.randomUUID(), seq: 0,
    clock: anchor.clock + 1, time: Date.now(), action: "workspace.snapshot",
    ops: [{
      ext: "members", table: "members_snapshots", kind: "insert", id: newRowId(),
      values: {
        cutoff_index: ref.index, cutoff_hash: ref.hash, genesis_hash: ref.genesisHash, vector: JSON.stringify(ref.vector),
        content: ref.content, archive_content: ref.archiveContent ?? null,
        created_by: userNumberOf(who.author), created_at: new Date().toISOString(),
      },
    }],
    snapshot: ref,
  }, who.privateKey);
}
