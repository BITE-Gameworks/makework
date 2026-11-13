import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Room } from "trystero";
import { ApiClient } from "../../src/api/client";
import { createIdentity, exportPkcs8, importAgreementKey } from "../../src/core/identity";
import { MockTransport } from "../../src/mock/transport";
import { HostedServer } from "../../src/node/host";
import { fileContent } from "../../src/node/storage";
import { memoryCommits } from "../../src/p2p/commits";
import { inviteCode, newInviteToken } from "../../src/p2p/invite";
import { Ledger, createLedgerBackend } from "../../src/p2p/ledger";
import { userNumberOf } from "../../src/p2p/log";
import { localPlugins, plugins } from "../../src/p2p/plugins";
import { workspacePolicy } from "../../src/p2p/policy";
import { WorkspaceSync } from "../../src/p2p/sync";
import { Network } from "../p2p/fakeNetwork";

// A node a member added (p2p/pair.ts): part of the workspace through its row, with no invite, in a workspace that
// has invites (which refused the old node's profile).

const closers: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (check()) return true;
    await wait(100);
  }
  return check();
}

describe("a node added by a member", () => {
  it("gets in without an invite, takes its name, and shows the newest public invite on its page", async () => {
    const network = new Network();
    const owner = await createIdentity(false);
    const signer = { author: owner.id, key: { x: owner.publicKey.x!, y: owner.publicKey.y! }, privateKey: owner.privateKey, replica: crypto.randomUUID() };
    const { workspaceId, genesis } = await Ledger.createGenesis(signer);
    const ledger = new Ledger(workspaceId, signer, workspacePolicy, memoryCommits());
    const backend = createLedgerBackend(ledger, localPlugins);
    for (const plugin of plugins) backend.load(plugin);
    await ledger.load();
    await ledger.adopt(genesis);
    const api = new ApiClient(new MockTransport(backend));
    const sealed = () => JSON.stringify({ v: 1, id: crypto.randomUUID(), from: owner.id, to: owner.id, at: Date.now(), iv: "iv", data: "data" });
    await api.plugin("members").call("create-invite", { token: newInviteToken(), sealed_token: sealed(), label: "Private" });

    const node = await createIdentity(true);
    const key = { x: node.publicKey.x!, y: node.publicKey.y! };
    await api.plugin("nodes").call("add", { user_id: userNumberOf(node.id), key_x: key.x, key_y: key.y, page: "join" });
    await ledger.flush();

    const sync = new WorkspaceSync(ledger, workspaceId, "workspace-room-secret", {
      self: "a", tabs: false, peerAuth: { localAccess: "member" },
      joinRoom: (roomId, passive) => network.join("a", roomId, passive) as unknown as Room,
    });
    sync.setNodes({ known: () => true, isNode: (p) => p.startsWith("n") });
    closers.push(() => sync.close());
    const dir = await mkdtemp(join(tmpdir(), "mw-paired-"));
    dirs.push(dir);
    const server = await HostedServer.open({ id: workspaceId, secret: "workspace-room-secret", v: 3, replica: crypto.randomUUID() }, {
      identity: { id: node.id, key, privateKey: node.privateKey, agreementKey: await importAgreementKey(await exportPkcs8(node.privateKey)) },
      commits: memoryCommits(), content: fileContent(dir), senders: 8, healAfterMs: 60_000, self: "n1",
      joinRoom: (roomId, passive) => network.join("n1", roomId, passive) as unknown as Room,
    }, () => ({ address: "", url: "", place: null }));
    closers.push(() => server.close().catch(() => {}));

    expect(await until(() => server.status() === "authorized")).toBe(true);
    expect(server.page()).toBe("join");
    // Its profile, without an invite, reaches the owner.
    expect(await until(() => ledger.select("members", "members_profiles", { user_id: userNumberOf(node.id) }).length === 1)).toBe(true);
    expect(server.pageInvite()).toBeNull();

    const token = newInviteToken();
    const { id } = await api.plugin("members").call<{ id: number }>("create-invite", { token, sealed_token: sealed(), label: "Page", public: true });
    expect(await until(() => server.pageInvite() === inviteCode(workspaceId, token))).toBe(true);
    await api.plugin("members").call("revoke-invite", { id });
    expect(await until(() => server.pageInvite() === null)).toBe(true);
  }, 60_000);
});
