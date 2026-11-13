// Joining a workspace with an invite when the app closes before the join is in (a big workspace takes a while to
// arrive): the next start goes on with the same invite. Before 2026-10-16 the token wasn't kept, so the next start
// had no invite to show, the profile was refused, and pasting the code again said "already in that workspace".
// IndexedDB, the account's keys and the commit store are faked (no DOM in node); the workspace's data is already on
// the device, as if it arrived before the app closed.
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: new Map<string, unknown>(),
  keys: { signing: null as CryptoKey | null, agreement: null as CryptoKey | null },
  store: null as unknown,
  notify: vi.fn(),
}));
vi.mock("../../src/core/db", () => ({
  dbGet: async (store: string, key: string) => mocks.db.get(`${store}:${key}`),
  dbPut: async (store: string, value: unknown, key: string) => void mocks.db.set(`${store}:${key}`, structuredClone(value)),
}));
vi.mock("../../src/core/account", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/account")>()),
  accountKey: () => mocks.keys.signing,
  accountAgreementKey: () => mocks.keys.agreement,
}));
vi.mock("../../src/p2p/commits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/p2p/commits")>()),
  commitStoreFor: async () => mocks.store,
}));
vi.mock("../../src/core/notifier", () => ({ notify: mocks.notify }));

import { ApiClient } from "../../src/api/client";
import type { Account } from "../../src/core/account";
import { createIdentity, exportPkcs8, importAgreementKey } from "../../src/core/identity";
import { MockTransport } from "../../src/mock/transport";
import { memoryCommits } from "../../src/p2p/commits";
import { inviteCode, newInviteToken } from "../../src/p2p/invite";
import { Ledger, createLedgerBackend } from "../../src/p2p/ledger";
import { localPlugins, plugins } from "../../src/p2p/plugins";
import { workspacePolicy } from "../../src/p2p/policy";
import { joinWorkspace, joinedWorkspaces, openWorkspace, type OpenWorkspace } from "../../src/p2p/workspaces";

const opened: OpenWorkspace[] = [];
afterEach(async () => {
  for (const server of opened.splice(0)) await server.close().catch(() => {});
  mocks.db.clear();
});

async function until(check: () => boolean, ms = 15_000) {
  for (const end = Date.now() + ms; !check() && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 100));
  return check();
}

describe("joining with an invite", () => {
  it("goes on with the same invite after the app closed before the join was in", async () => {
    const owner = await createIdentity(false);
    const signer = { author: owner.id, key: { x: owner.publicKey.x!, y: owner.publicKey.y! }, privateKey: owner.privateKey, replica: crypto.randomUUID() };
    const { workspaceId, genesis } = await Ledger.createGenesis(signer);
    const store = memoryCommits();
    const host = new Ledger(workspaceId, signer, workspacePolicy, store);
    const backend = createLedgerBackend(host, localPlugins);
    for (const plugin of plugins) backend.load(plugin);
    await host.load();
    await host.adopt(genesis);
    const token = newInviteToken();
    const sealed = JSON.stringify({ v: 1, id: crypto.randomUUID(), from: owner.id, to: owner.id, at: Date.now(), iv: "iv", data: "data" });
    await new ApiClient(new MockTransport(backend)).plugin("members").call("create-invite", { token, sealed_token: sealed, label: "Invite" });
    await host.flush();
    // The joiner's device already has the history (it arrived before the app closed).
    mocks.store = { load: async () => [...(store.all.get(workspaceId) ?? [])], add: async () => {} };

    const joiner = await createIdentity(true);
    mocks.keys.signing = joiner.privateKey;
    mocks.keys.agreement = await importAgreementKey(await exportPkcs8(joiner.privateKey));
    const account = {
      id: joiner.id, username: "joiner", displayName: "Joiner", color: "", avatar: "", publicKey: { x: joiner.publicKey.x!, y: joiner.publicKey.y! },
      offline: true,
    } as unknown as Account;

    const first = await joinWorkspace(account, inviteCode(workspaceId, token));
    // Closed at once: no profile was sent.
    await first.close();
    const [saved] = await joinedWorkspaces(account);
    expect(saved).toMatchObject({ id: workspaceId, inviteToken: token });

    const again = await openWorkspace(saved, account);
    opened.push(again);
    expect(await until(() => again.ledger.select("members", "members_profiles", { user_id: again.ledger.me }).length === 1)).toBe(true);
    // In: the invite isn't kept any longer.
    expect(await until(() => mocks.db.size > 0 && !("inviteToken" in ((mocks.db.get(`servers:${joiner.id}`) as object[])[0] ?? {})))).toBe(true);
    expect(mocks.notify).not.toHaveBeenCalled();
  }, 30_000);

  // The profile went after 3 s without new commits. A catch-up pausing longer than that before the invite (made just
  // before, so near the end of the history) arrived had the joiner's own app refuse the profile ("That invite has
  // expired…"), tell it it couldn't join, and never try again (mesh-test node test, 2026-10-17).
  it("waits for its invite before sending the profile, when the history arrives with a pause", async () => {
    mocks.notify.mockClear();
    const owner = await createIdentity(false);
    const signer = { author: owner.id, key: { x: owner.publicKey.x!, y: owner.publicKey.y! }, privateKey: owner.privateKey, replica: crypto.randomUUID() };
    const { workspaceId, genesis } = await Ledger.createGenesis(signer);
    const store = memoryCommits();
    const host = new Ledger(workspaceId, signer, workspacePolicy, store);
    const backend = createLedgerBackend(host, localPlugins);
    for (const plugin of plugins) backend.load(plugin);
    await host.load();
    await host.adopt(genesis);
    const token = newInviteToken();
    const sealed = JSON.stringify({ v: 1, id: crypto.randomUUID(), from: owner.id, to: owner.id, at: Date.now(), iv: "iv", data: "data" });
    await new ApiClient(new MockTransport(backend)).plugin("members").call("create-invite", { token, sealed_token: sealed, label: "Invite" });
    await host.flush();
    // The first part of the history is here, the invite isn't yet.
    const all = [...(store.all.get(workspaceId) ?? [])];
    const withInvite = (c: { ops?: { table: string }[] }) => (c.ops ?? []).some((op) => op.table === "members_invites");
    mocks.store = { load: async () => all.filter((c) => !withInvite(c)), add: async () => {} };

    const joiner = await createIdentity(true);
    mocks.keys.signing = joiner.privateKey;
    mocks.keys.agreement = await importAgreementKey(await exportPkcs8(joiner.privateKey));
    const account = {
      id: joiner.id, username: "joiner", displayName: "Joiner", color: "", avatar: "", publicKey: { x: joiner.publicKey.x!, y: joiner.publicKey.y! },
      offline: true,
    } as unknown as Account;
    const joined = await joinWorkspace(account, inviteCode(workspaceId, token));
    opened.push(joined);
    const mine = () => joined.ledger.select("members", "members_profiles", { user_id: joined.ledger.me }).length;
    await new Promise((resolve) => setTimeout(resolve, 4_500));
    expect(mine()).toBe(0);
    expect(mocks.notify).not.toHaveBeenCalled();
    // The rest of the history comes.
    await joined.ledger.receive(host.missing(joined.ledger.vector()));
    expect(await until(() => mine() === 1)).toBe(true);
    expect(mocks.notify).not.toHaveBeenCalled();
  }, 30_000);
});
