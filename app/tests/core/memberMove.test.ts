import { describe, expect, it } from "vitest";
import { ApiClient } from "../../src/api/client";
import { moveMemberIn } from "../../src/core/memberMove";
import { createIdentity } from "../../src/core/identity";
import { MockTransport } from "../../src/mock/transport";
import { memoryCommits } from "../../src/p2p/commits";
import { Ledger, createLedgerBackend, type Signer } from "../../src/p2p/ledger";
import { workspacePolicy } from "../../src/p2p/policy";
import { channels } from "../../src/system/channels";
import { chat } from "../../src/system/chat";
import { members } from "../../src/system/members";
import { roles } from "../../src/system/roles";

async function signer(): Promise<Signer> {
  const identity = await createIdentity(false);
  return { author: identity.id, key: { x: identity.publicKey.x!, y: identity.publicKey.y! }, privateKey: identity.privateKey, replica: crypto.randomUUID() };
}

async function member(workspaceId: string, who: Signer) {
  const ledger = new Ledger(workspaceId, who, workspacePolicy, memoryCommits());
  const backend = createLedgerBackend(ledger);
  for (const plugin of [channels, members, roles, chat]) backend.load(plugin);
  await ledger.load();
  return { ledger, api: new ApiClient(new MockTransport(backend)), id: ledger.me };
}

type Member = Awaited<ReturnType<typeof member>>;

async function sync(...all: Member[]) {
  for (const from of all) await from.ledger.flush();
  for (const from of all) for (const to of all) if (from !== to) await to.ledger.receive(from.ledger.missing(to.ledger.vector()));
}


describe("moving a member to another account", () => {
  it("hands everything of the old account to the new one and bans the old one", async () => {
    const owner = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(owner);
    const a = await member(workspaceId, owner);
    await a.ledger.adopt(genesis);
    const old = await member(workspaceId, await signer());
    const fresh = await member(workspaceId, await signer());
    const r = a.api.plugin("roles");
    await r.call("ensure-everyone");
    const categoryId = await a.api.plugin("channels").insert("channels_categories", { name: "general", position: 0 });
    const { id: general } = await a.api.plugin("channels").call<{ id: number }>("add-channel", { category_id: categoryId, name: "general", type: "chat" });
    await a.api.plugin("channels").insert("channels_workspace", { name: "S", short: "", color: "", icon: "", welcome_channel_id: general });
    const { id: mods } = await r.call<{ id: number }>("create-role", { name: "mods", permissions: "manage_messages" });
    await sync(a, old, fresh);
    await old.api.plugin("members").call("set-profile", { username: "ada", display_name: "Ada", color: "" });
    await old.api.plugin("members").call("set-workspace-profile", { nickname: "Captain", bio: "Hi" });
    const { id: message } = await old.api.plugin("chat").call<{ id: number }>("post-message", { channel_id: general, body: "mine" });
    await old.api.plugin("chat").call("react", { message_id: message, code: "smile" });
    await fresh.api.plugin("members").call("set-profile", { username: "ada2", display_name: "Ada", color: "" });
    await sync(a, old, fresh);
    await fresh.api.plugin("chat").call("react", { message_id: message, code: "smile" });
    await sync(a, old, fresh);
    await r.call("assign-role", { user_id: old.id, role_id: mods });
    await r.call("mute", { user_id: old.id, kind: "chat" });
    await sync(a, old, fresh);

    // Only the owner may move people.
    await expect(moveMemberIn(fresh.ledger, old.id, fresh.id, "Ada")).rejects.toThrow(/owner/);
    await moveMemberIn(a.ledger, old.id, fresh.id, "Ada");
    await sync(a, old, fresh);

    for (const m of [a, fresh]) {
      const read = (ext: string, table: string) => m.api.plugin(ext).read(table);
      expect((await read("chat", "chat_messages")).find((x) => x.id === message)?.author_id).toBe(fresh.id);
      // Both had the same reaction: one is left, the new account's.
      expect((await read("chat", "chat_reactions")).map((x) => x.user_id)).toEqual([fresh.id]);
      expect((await read("roles", "roles_members")).map((x) => x.user_id)).toEqual([fresh.id]);
      expect((await read("roles", "roles_mutes")).map((x) => x.user_id)).toEqual([fresh.id]);
      expect((await read("roles", "roles_bans")).map((x) => x.user_id)).toEqual([old.id]);
      const profiles = await read("members", "members_profiles");
      expect(profiles.map((p) => p.user_id)).toEqual([fresh.id]);
      expect(profiles[0]).toMatchObject({ nickname: "Captain", bio: "Hi" });
      expect(await read("members", "members_moves")).toMatchObject([{ from_id: old.id, to_id: fresh.id, name: "Ada" }]);
      const note = (await read("chat", "chat_messages")).find((x) => x.kind === "move");
      expect(note).toMatchObject({ channel_id: general, author_id: a.id });
      expect(JSON.parse(String(note!.body))).toEqual({ from_id: old.id, to_id: fresh.id, name: "Ada" });
    }
    // The old account's changes are refused from now on.
    await expect(old.api.plugin("chat").call("post-message", { channel_id: general, body: "still me" })).rejects.toThrow(/banned/);
  });
});
