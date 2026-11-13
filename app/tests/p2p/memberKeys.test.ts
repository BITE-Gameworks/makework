import { describe, expect, it } from "vitest";
import { ApiClient } from "../../src/api/client";
import { createIdentity } from "../../src/core/identity";
import { MockTransport } from "../../src/mock/transport";
import { memoryCommits } from "../../src/p2p/commits";
import { Ledger, createLedgerBackend } from "../../src/p2p/ledger";
import { publicKeysOf, secretRecipients } from "../../src/p2p/memberKeys";
import { userNumberOf } from "../../src/p2p/log";
import { workspacePolicy } from "../../src/p2p/policy";
import { members } from "../../src/system/members";

async function signer() {
  const identity = await createIdentity(true);
  return { author: identity.id, key: { x: identity.publicKey.x!, y: identity.publicKey.y! }, privateKey: identity.privateKey, replica: crypto.randomUUID() };
}

describe("members' public keys", () => {
  it("are kept until a commit comes in", async () => {
    const owner = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(owner);
    const ledger = new Ledger(workspaceId, owner, workspacePolicy, memoryCommits());
    const backend = createLedgerBackend(ledger, []);
    backend.load(members);
    await ledger.load();
    await ledger.adopt(genesis);
    const api = new ApiClient(new MockTransport(backend));

    const first = publicKeysOf(ledger);
    expect(first.get(userNumberOf(owner.author))?.id).toBe(owner.author);
    expect(publicKeysOf(ledger)).toBe(first);

    await api.plugin("members").call("set-profile", { username: "a", display_name: "A", color: "" });
    await ledger.flush();
    const after = publicKeysOf(ledger);
    expect(after).not.toBe(first);
    expect(after.get(userNumberOf(owner.author))?.id).toBe(owner.author);
  });

  it("come from a profile when the commits are gone, and only a member's own key is taken", async () => {
    const self = await signer();
    const quiet = await signer();
    const { recipients, unknown } = secretRecipients({
      commitCount: 0, owner: null, log: () => [],
      select: (_plugin: string, table: string) => (table === "members_profiles"
        ? [{ user_id: userNumberOf(quiet.author), key_x: quiet.key.x, key_y: quiet.key.y }, { user_id: 5, key_x: quiet.key.x, key_y: quiet.key.y }] : []),
    } as unknown as Parameters<typeof secretRecipients>[0], { id: self.author, publicKey: self.key });
    expect(recipients.get(userNumberOf(quiet.author))?.id).toBe(quiet.author);
    expect(unknown).toEqual([5]);
  });
});

describe("secretRecipients", () => {
  const self = { id: "self", publicKey: { x: "x", y: "y" } };
  const ledger = (tables: Record<string, Record<string, unknown>[]>, owner: number | null = null) => ({
    commitCount: 0, owner, log: () => [],
    select: (_plugin: string, table: string) => tables[table] ?? [],
  }) as unknown as Parameters<typeof secretRecipients>[0];

  it("keeps going without members it has no key for, and skips bots and the banned", () => {
    const { recipients, unknown } = secretRecipients(ledger({
      members_profiles: [{ user_id: 1 }, { user_id: 2, bot: true }, { user_id: 3 }],
      roles_bans: [{ user_id: 3 }],
      nodes_nodes: [{ user_id: 4, status: "authorized" }, { user_id: 5, status: "pending" }],
    }, 6), self);
    expect([...recipients.keys()]).toEqual([]);
    expect(unknown.sort()).toEqual([1, 4, 6]);
  });
});
