import { afterEach, describe, expect, it } from "vitest";
import { ApiClient } from "../../src/api/client";
import { createIdentity, exportPkcs8, importAgreementKey } from "../../src/core/identity";
import { MockTransport } from "../../src/mock/transport";
import { ChatKeyring, KeyedTransport } from "../../src/p2p/chatKeyring";
import { memoryCommits } from "../../src/p2p/commits";
import { Ledger, createLedgerBackend } from "../../src/p2p/ledger";
import { workspacePolicy } from "../../src/p2p/policy";
import { channels } from "../../src/system/channels";
import { chat } from "../../src/system/chat";
import { members } from "../../src/system/members";
import { roles } from "../../src/system/roles";

const rings: ChatKeyring[] = [];
afterEach(() => rings.splice(0).forEach((r) => r.stop()));

async function person() {
  const identity = await createIdentity(true);
  const key = { x: identity.publicKey.x!, y: identity.publicKey.y! };
  return {
    signer: { author: identity.id, key, privateKey: identity.privateKey, replica: crypto.randomUUID() },
    account: { id: identity.id, publicKey: key },
    agreement: await importAgreementKey(await exportPkcs8(identity.privateKey)),
  };
}

async function member(workspaceId: string, who: Awaited<ReturnType<typeof person>>) {
  const ledger = new Ledger(workspaceId, who.signer, workspacePolicy, memoryCommits());
  const keyring = new ChatKeyring(ledger, who.account, who.agreement);
  rings.push(keyring);
  const backend = createLedgerBackend(ledger, [], { chat: keyring });
  for (const plugin of [channels, members, roles, chat]) backend.load(plugin);
  await ledger.load();
  const api = new ApiClient(new KeyedTransport(new MockTransport(backend), keyring));
  keyring.start(api.plugin("chat"), () => backend.emit({ plugin: "chat", table: "chat_keys", change: "update", ids: [] }));
  return { ledger, backend, api, keyring };
}

type Member = Awaited<ReturnType<typeof member>>;
async function sync(...all: Member[]) {
  for (const from of all) await from.ledger.flush();
  for (const from of all) for (const to of all) if (from !== to) await to.ledger.receive(from.ledger.missing(to.ledger.vector()));
}

describe("encrypted chat between two members", () => {
  it("seals in the ledger, and the other member reads it once the key is given", async () => {
    const ownerPerson = await person();
    const { workspaceId, genesis } = await Ledger.createGenesis(ownerPerson.signer);
    const a = await member(workspaceId, ownerPerson);
    await a.ledger.adopt(genesis);
    const b = await member(workspaceId, await person());
    await a.api.plugin("members").call("set-profile", { username: "a", display_name: "A", color: "" });
    await sync(a, b);
    await b.api.plugin("members").call("set-profile", { username: "b", display_name: "B", color: "" });
    const category = await a.api.plugin("channels").insert("channels_categories", { name: "general", position: 0 });
    const { id: channel } = await a.api.plugin("channels").call<{ id: number }>("add-channel", { category_id: category, name: "talk", type: "chat" });
    await sync(a, b);

    const { id } = await a.api.plugin("chat").call<{ id: number }>("post-message", { channel_id: channel, body: "meet at noon" });
    const stored = a.ledger.select("chat", "chat_messages", { id })[0];
    expect(String(stored.body)).toMatch(/^mwe1\.1\./);
    expect(a.ledger.select("chat", "chat_key_grants", {}).map((g) => Number(g.user_id)).sort()).toEqual([a.ledger.me, b.ledger.me].sort());

    await sync(a, b);
    await b.keyring.ensure(channel);
    const { rows } = await b.api.plugin("chat").call<{ rows: { body: string }[] }>("list-messages", { channel_id: channel });
    expect(rows.map((r) => r.body)).toEqual(["meet at noon"]);

    await b.api.plugin("chat").call("post-message", { channel_id: channel, body: "ok" });
    await sync(a, b);
    const seen = await a.api.plugin("chat").call<{ rows: { body: string }[] }>("list-messages", { channel_id: channel });
    expect(seen.rows.map((r) => r.body)).toEqual(["meet at noon", "ok"]);
    expect(a.ledger.select("chat", "chat_keys", {})).toHaveLength(1);

    // B is kicked: A's next message needs a key B never gets.
    await a.api.plugin("members").call("kick", { user_id: b.ledger.me });
    await a.api.plugin("chat").call("post-message", { channel_id: channel, body: "after" });
    const keys = a.ledger.select("chat", "chat_keys", {});
    expect(keys.map((k) => Number(k.epoch))).toEqual([1, 2]);
    expect(a.ledger.select("chat", "chat_key_grants", { epoch: 2 }).map((g) => Number(g.user_id))).toEqual([a.ledger.me]);
  });
});
