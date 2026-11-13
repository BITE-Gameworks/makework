import { describe, expect, it } from "vitest";
import { createIdentity } from "../../src/core/identity";
import { readWorkspaceArchive, type WorkspaceArchive } from "../../src/core/workspaceSnapshots";
import { Ledger, type Signer } from "../../src/p2p/ledger";
import { signCommit, type Commit } from "../../src/p2p/log";

async function history() {
  const identity = await createIdentity(false);
  const signer: Signer = {
    author: identity.id, key: { x: identity.publicKey.x!, y: identity.publicKey.y! },
    privateKey: identity.privateKey, replica: "archive-test",
  };
  const { workspaceId, genesis } = await Ledger.createGenesis(signer);
  const cutoff = await signCommit({
    server: workspaceId, author: signer.author, key: signer.key, replica: signer.replica, seq: 1, clock: 1,
    time: Date.now(), action: "test.change", ops: [],
  }, signer.privateKey);
  return { signer, workspaceId, commits: [genesis, cutoff], cutoff };
}

function archiveBlob(workspaceId: string, cutoffHash: string, commits: Commit[]): Blob {
  const value: WorkspaceArchive = { version: 1, workspaceId, cutoffHash, commits };
  return new Blob([JSON.stringify(value)]);
}

describe("workspace history archives", () => {
  it("validates the signed, ordered history and exact snapshot cutoff", async () => {
    const { workspaceId, commits, cutoff } = await history();

    await expect(readWorkspaceArchive(archiveBlob(workspaceId, cutoff.hash, commits), workspaceId, cutoff.hash, 2))
      .resolves.toEqual(commits);
  });

  it("rejects a mismatched cutoff, duplicate, out-of-order, or unrelated workspace history", async () => {
    const { workspaceId, commits, cutoff } = await history();
    const valid = archiveBlob(workspaceId, cutoff.hash, commits);

    await expect(readWorkspaceArchive(valid, workspaceId, cutoff.hash, 3)).rejects.toThrow(/doesn't match/);
    await expect(readWorkspaceArchive(valid, "another-workspace", cutoff.hash, 2)).rejects.toThrow(/doesn't match/);
    await expect(readWorkspaceArchive(archiveBlob(workspaceId, cutoff.hash, [...commits, commits[1]]), workspaceId, cutoff.hash, 2))
      .rejects.toThrow(/doesn't match|invalid or unrelated/);
    await expect(readWorkspaceArchive(archiveBlob(workspaceId, cutoff.hash, [commits[1], commits[0]]), workspaceId, cutoff.hash, 2))
      .rejects.toThrow(/invalid or unrelated/);
  });
});
