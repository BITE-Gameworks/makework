import { describe, expect, it } from "vitest";
import { ApiClient } from "../../src/api/client";
import { createIdentity } from "../../src/core/identity";
import { channels } from "../../src/system/channels";
import { bots } from "../../src/system/bots";
import { chat } from "../../src/system/chat";
import { diagram } from "../../src/system/diagram";
import { emoji } from "../../src/system/emoji";
import { files } from "../../src/system/files";
import { watch } from "../../src/system/watch";
import { git } from "../../src/system/git";
import { members } from "../../src/system/members";
import { nodes } from "../../src/system/nodes";
import { roles } from "../../src/system/roles";
import { sheets } from "../../src/system/sheets";
import { MockTransport } from "../../src/mock/transport";
import { memoryCommits } from "../../src/p2p/commits";
import { Ledger, createLedgerBackend, type Signer } from "../../src/p2p/ledger";
import { workspacePolicy } from "../../src/p2p/policy";
import { loadDeclared } from "../../src/system/declared";
import { inviteProof, inviteTokenKey, inviteUseText, newInviteToken } from "../../src/p2p/invite";

async function signer(): Promise<Signer> {
  const identity = await createIdentity(false);
  return { author: identity.id, key: { x: identity.publicKey.x!, y: identity.publicKey.y! }, privateKey: identity.privateKey, replica: crypto.randomUUID() };
}

async function member(workspaceId: string, who: Signer) {
  const ledger = new Ledger(workspaceId, who, workspacePolicy, memoryCommits());
  const backend = createLedgerBackend(ledger);
  for (const plugin of [channels, members, roles, chat, files, bots, git, nodes, sheets, diagram, emoji, watch]) backend.load(plugin);
  await ledger.load();
  const api = new ApiClient(new MockTransport(backend));
  return { ledger, backend, api, id: ledger.me };
}

type Member = Awaited<ReturnType<typeof member>>;

// Everyone gets everything everyone else has.
async function sync(...all: Member[]) {
  for (const from of all) await from.ledger.flush();
  for (const from of all) for (const to of all) if (from !== to) await to.ledger.receive(from.ledger.missing(to.ledger.vector()));
}

async function server() {
  const owner = await signer();
  const { workspaceId, genesis } = await Ledger.createGenesis(owner);
  const a = await member(workspaceId, owner);
  await a.ledger.adopt(genesis);
  const categoryId = await a.api.plugin("channels").insert("channels_categories", { name: "general", position: 0 });
  const b = await member(workspaceId, await signer());
  const c = await member(workspaceId, await signer());
  await sync(a, b, c);
  return { a, b, c, categoryId };
}

const addChannel = (m: Member, categoryId: number, name: string, type = "chat") =>
  m.api.plugin("channels").call<{ id: number }>("add-channel", { category_id: categoryId, name, type });
const channelNames = async (m: Member) => (await m.api.plugin("channels").read("channels_channels")).map((ch) => ch.name);

function inviteArgs(m: Member, values: { label?: string; max_uses?: number; expires_at?: string } = {}) {
  const token = newInviteToken();
  const author = m.ledger.author;
  return {
    token,
    args: {
      token,
      sealed_token: JSON.stringify({ v: 1, id: crypto.randomUUID(), from: author, to: author, at: Date.now(), iv: "iv", data: "data" }),
      ...values,
    },
  };
}

describe("server policy", () => {
  it("keeps the open rules until @everyone exists, and doesn't undo what was done before", async () => {
    const { a, b, categoryId } = await server();
    await addChannel(b, categoryId, "early");
    await sync(a, b);
    await a.api.plugin("roles").call("ensure-everyone");
    await sync(a, b);
    await expect(addChannel(b, categoryId, "late")).rejects.toThrow(/Manage channels/);
    expect(await channelNames(a)).toEqual(["early"]);
  });

  it("lets members post but only moderators delete other people's messages", async () => {
    const { a, b, c } = await server();
    await a.api.plugin("roles").call("ensure-everyone");
    await sync(a, b, c);
    const { id } = await b.api.plugin("chat").call<{ id: number }>("post-message", { channel_id: 1, body: "hi" });
    await sync(a, b, c);
    await expect(c.api.plugin("chat").call("delete-message", { message_id: id })).rejects.toThrow(/Manage messages/);

    const { id: mods } = await a.api.plugin("roles").call<{ id: number }>("create-role", { name: "mods", permissions: "manage_messages" });
    await a.api.plugin("roles").call("assign-role", { user_id: c.id, role_id: mods });
    await sync(a, b, c);
    await c.api.plugin("chat").call("delete-message", { message_id: id });
    await sync(a, b, c);
    expect((await b.api.plugin("chat").read("chat_messages"))[0].deleted).toBe(true);
  });

  // `purge` removes rows: nothing brings them back, and nodes and devices let the content go.
  it("lets members delete their own files for good, other people's only with Manage workspace", async () => {
    const { a, b, c } = await server();
    await a.api.plugin("roles").call("ensure-everyone");
    await sync(a, b, c);
    const add = (m: Member, name: string, parent: number | null = null) =>
      m.api.plugin("files").call<{ id: number }>("add-file", { channel_id: 1, parent_id: parent, name, mime: "text/plain", size: 1 });
    const { id: folder } = await b.api.plugin("files").call<{ id: number }>("add-folder", { channel_id: 1, name: "shared" });
    const { id: own } = await add(b, "own.txt");
    await sync(a, b, c);
    const { id: inFolder } = await add(c, "theirs.txt", folder);
    await sync(a, b, c);
    const names = async (m: Member) => (await m.api.plugin("files").read("files_entries")).map((e) => e.name);

    // Hiding someone else's file stays open to everyone with Edit content; removing it doesn't.
    await expect(c.api.plugin("files").call("purge", { entry_id: own })).rejects.toThrow(/Manage workspace/);
    // The folder is B's, a file in it is C's: all of it or nothing.
    await expect(b.api.plugin("files").call("purge", { entry_id: folder })).rejects.toThrow(/Manage workspace/);
    await sync(a, b, c);
    expect(await names(a)).toEqual(["shared", "own.txt", "theirs.txt"]);

    expect(await b.api.plugin("files").call("purge", { entry_id: own })).toEqual({ deleted: 1 });
    await sync(a, b, c);
    expect(await names(c)).toEqual(["shared", "theirs.txt"]);

    const { id: managers } = await a.api.plugin("roles").call<{ id: number }>("create-role", { name: "managers", permissions: "manage_workspace" });
    await a.api.plugin("roles").call("assign-role", { user_id: b.id, role_id: managers });
    await sync(a, b, c);
    expect(await b.api.plugin("files").call("purge", { entry_id: folder })).toEqual({ deleted: 2 });
    await sync(a, b, c);
    expect(await names(a)).toEqual([]);
    expect(await names(c)).toEqual([]);
    await expect(c.api.plugin("files").call("restore", { entry_id: inFolder })).rejects.toThrow("That file no longer exists.");
  });

  it("lets only moderators pin messages", async () => {
    const { a, b, c } = await server();
    await a.api.plugin("roles").call("ensure-everyone");
    const { id } = await b.api.plugin("chat").call<{ id: number }>("post-message", { channel_id: 1, body: "pin me" });
    await sync(a, b, c);
    await expect(c.api.plugin("chat").call("pin-message", { message_id: id })).rejects.toThrow(/Manage messages/);
    const { id: mods } = await a.api.plugin("roles").call<{ id: number }>("create-role", { name: "mods", permissions: "manage_messages" });
    await a.api.plugin("roles").call("assign-role", { user_id: c.id, role_id: mods });
    await sync(a, b, c);
    await c.api.plugin("chat").call("pin-message", { message_id: id });
    await sync(a, b, c);
    const { rows } = await b.api.plugin("chat").call<{ rows: { id: number; pinned_by: number }[] }>("list-pins", { channel_id: 1 });
    expect(rows.map((r) => [r.id, r.pinned_by])).toEqual([[id, c.id]]);
  });

  it("limits role managers to roles below their own and permissions they have", async () => {
    const { a, b } = await server();
    const rolesA = a.api.plugin("roles");
    await rolesA.call("ensure-everyone");
    const { id: admins } = await rolesA.call<{ id: number }>("create-role", { name: "admins", permissions: "manage_roles" });
    await rolesA.call("assign-role", { user_id: b.id, role_id: admins });
    await sync(a, b);
    const rolesB = b.api.plugin("roles");
    const { id: helpers } = await rolesB.call<{ id: number }>("create-role", { name: "helpers", permissions: "send_messages" });
    await expect(rolesB.call("edit-role", { id: admins, name: "mine", permissions: "manage_roles" })).rejects.toThrow(/below your highest/);
    await expect(rolesB.call("edit-role", { id: helpers, name: "helpers", permissions: "administrator" })).rejects.toThrow(/don't have it/);
    await rolesB.call("assign-role", { user_id: b.id, role_id: helpers });
    await sync(a, b);
    expect(await a.api.plugin("roles").read("roles_members")).toHaveLength(2);
  });

  it("lets members with edit content connect a repository", async () => {
    const { a, b } = await server();
    await a.api.plugin("roles").call("ensure-everyone");
    await sync(a, b);
    const setRepo = () => b.api.plugin("git").call("set-repo", { channel_id: 1, provider: "github", host: "github.com", path: "o/r" });
    await setRepo();
    const [role] = await a.api.plugin("roles").read("roles_roles");
    await a.api.plugin("roles").call("edit-role", { id: role.id, name: "everyone", permissions: "send_messages" });
    await sync(a, b);
    await expect(setRepo()).rejects.toThrow(/Edit content/);
  });

  it("lets members with edit content save a repository's submodules and import into them", async () => {
    const { a, b } = await server();
    await a.api.plugin("roles").call("ensure-everyone");
    await sync(a, b);
    const gitB = b.api.plugin("git");
    await gitB.call("set-repo", { channel_id: 1, provider: "github", host: "github.com", path: "o/r", subrepos: true });
    const setSubrepos = () => gitB.call("set-subrepos", {
      channel_id: 1, subrepos: JSON.stringify([{ sub_path: "lib", provider: "github", host: "github.com", path: "o/lib", pinned: "abcdef1" }]),
    });
    const importInto = (sha: string) => gitB.call("import-commits", {
      channel_id: 1, sub: "lib",
      commits: JSON.stringify([{ sha, parents: [], author_name: "Ann", author_email: "a@x", authored_at: "2026-01-01T00:00:00.000Z", message: "first" }]),
    });
    await setSubrepos();
    await importInto("aaaaaaa1");
    await sync(a, b);
    expect((await a.api.plugin("git").read("git_repos")).map((row) => row.sub_path).sort()).toEqual(["", "lib"]);
    expect(await a.api.plugin("git").read("git_commits")).toHaveLength(1);
    const [role] = await a.api.plugin("roles").read("roles_roles");
    await a.api.plugin("roles").call("edit-role", { id: role.id, name: "everyone", permissions: "send_messages" });
    await sync(a, b);
    await expect(gitB.call("set-subrepos", { channel_id: 1, subrepos: "[]" })).rejects.toThrow(/Edit content/);
    await expect(importInto("aaaaaaa2")).rejects.toThrow(/Edit content/);
  });

  it("lets members with edit content share build configurations, each change naming who made it", async () => {
    const { a, b, c } = await server();
    await a.api.plugin("roles").call("ensure-everyone");
    await sync(a, b, c);
    const fields = { name: "App", project: ".", output: "dist", system: "linux", steps: JSON.stringify(["make"]), collect: JSON.stringify({ kind: "binaries" }) };
    const { id } = await b.api.plugin("git").call<{ id: number }>("add-build", { channel_id: 1, ...fields });
    await sync(a, b, c);
    await c.api.plugin("git").call("update-build", { build_id: id, ...fields, steps: JSON.stringify(["make release"]) });
    await sync(a, b, c);
    const [row] = await a.api.plugin("git").read("git_builds");
    expect([row.author_id, row.updated_by, row.steps]).toEqual([b.id, c.id, JSON.stringify(["make release"])]);
    const [role] = await a.api.plugin("roles").read("roles_roles");
    await a.api.plugin("roles").call("edit-role", { id: role.id, name: "everyone", permissions: "send_messages" });
    await sync(a, b, c);
    await expect(c.api.plugin("git").call("update-build", { build_id: id, ...fields })).rejects.toThrow(/Edit content/);
    await expect(c.api.plugin("git").call("add-build", { channel_id: 1, ...fields })).rejects.toThrow(/Edit content/);
  });

  it("requires edit content for sheet changes and keeps cells attached to their sheet", async () => {
    const { a, b, categoryId } = await server();
    const channel = await addChannel(a, categoryId, "numbers", "sheets");
    const sheetApi = a.api.plugin("sheets");
    const { id: sheetId } = await sheetApi.call<{ id: number }>("add-sheet", { channel_id: channel.id, name: "Sheet 1" });
    await sheetApi.call("set-cells", { sheet_id: sheetId, cells: JSON.stringify([{ row: 0, col: 0, value: "one" }]) });
    await a.api.plugin("roles").call("ensure-everyone");
    const [everyone] = await a.api.plugin("roles").read("roles_roles", { everyone: true });
    await a.api.plugin("roles").call("edit-role", { id: everyone.id, name: "everyone", permissions: "" });
    await sync(a, b);

    const cells = b.api.plugin("sheets");
    await expect(cells.call("set-cells", { sheet_id: sheetId, cells: JSON.stringify([{ row: 0, col: 1, value: "two" }]) }))
      .rejects.toThrow(/Edit content/);

    await a.api.plugin("roles").call("edit-role", { id: everyone.id, name: "everyone", permissions: "send_messages,edit_content" });
    await sync(a, b);
    await cells.call("set-cells", { sheet_id: sheetId, cells: JSON.stringify([{ row: 0, col: 1, value: "two" }]) });
    await sync(a, b);
    expect((await a.api.plugin("sheets").read("sheets_cells")).map((row) => row.value)).toEqual(["one", "two"]);
  });

  it("requires edit content for diagram changes and keeps shapes attached to their page", async () => {
    const { a, b, categoryId } = await server();
    const channel = await addChannel(a, categoryId, "flow", "diagram");
    const { id: pageId } = await a.api.plugin("diagram").call<{ id: number }>("add-page", { channel_id: channel.id, name: "Flow" });
    await a.api.plugin("diagram").call("add-shapes", {
      page_id: pageId, shapes: JSON.stringify([{ kind: "rect", x: 0, y: 0, w: 100, h: 50 }]),
    });
    await a.api.plugin("roles").call("ensure-everyone");
    const rolesA = a.api.plugin("roles");
    const [everyone] = await rolesA.read("roles_roles", { everyone: true });
    await rolesA.call("edit-role", { id: everyone.id, name: "everyone", permissions: "" });
    await sync(a, b);
    const diagramB = b.api.plugin("diagram");
    await expect(diagramB.call("update-page", { id: pageId, changes: JSON.stringify({ name: "Denied" }) }))
      .rejects.toThrow(/Edit content/);

    await rolesA.call("edit-role", { id: everyone.id, name: "everyone", permissions: "edit_content" });
    await sync(a, b);
    await diagramB.call("update-page", { id: pageId, changes: JSON.stringify({ name: "Allowed" }) });
    await sync(a, b);
    expect((await a.api.plugin("diagram").call<{ rows: { name: string }[] }>("list-pages", { channel_id: channel.id })).rows[0].name)
      .toBe("Allowed");
  });

  // A table's columns and a class's members are rows of their own, under the same rule as the shape they are in.
  it("requires edit content for the rows of classes and tables", async () => {
    const { a, b, categoryId } = await server();
    const channel = await addChannel(a, categoryId, "schema", "diagram");
    const diagramA = a.api.plugin("diagram");
    const { id: pageId } = await diagramA.call<{ id: number }>("add-page", { channel_id: channel.id, name: "Schema" });
    const { ids: [table] } = await diagramA.call<{ ids: number[] }>("add-shapes", {
      page_id: pageId, shapes: JSON.stringify([{ kind: "db-table", x: 0, y: 0, w: 200, h: 80, text: "users" }]),
    });
    const { ids: [column] } = await diagramA.call<{ ids: number[] }>("add-rows", { rows: JSON.stringify([{ shape_id: table, section: "columns", name: "id" }]) });
    await a.api.plugin("roles").call("ensure-everyone");
    const rolesA = a.api.plugin("roles");
    const [everyone] = await rolesA.read("roles_roles", { everyone: true });
    await rolesA.call("edit-role", { id: everyone.id, name: "everyone", permissions: "" });
    await sync(a, b);
    const diagramB = b.api.plugin("diagram");
    await expect(diagramB.call("update-rows", { changes: JSON.stringify([{ id: column, name: "denied" }]) })).rejects.toThrow(/Edit content/);
    await rolesA.call("edit-role", { id: everyone.id, name: "everyone", permissions: "edit_content" });
    await sync(a, b);
    await diagramB.call("update-rows", { changes: JSON.stringify([{ id: column, name: "user_id" }]) });
    await sync(a, b);
    expect((await diagramA.call<{ rows: { name: string }[] }>("list-rows", { page_id: pageId })).rows.map((row) => row.name)).toEqual(["user_id"]);
  });

  it("blocks sheet edits while locked and lets workspace managers unlock", async () => {
    const { a, b, c, categoryId } = await server();
    const channel = await addChannel(a, categoryId, "numbers", "sheets");
    const sheetsA = a.api.plugin("sheets");
    const { id } = await sheetsA.call<{ id: number }>("add-sheet", { channel_id: channel.id, name: "Sheet 1" });
    await sheetsA.call("set-cells", { sheet_id: id, cells: JSON.stringify([{ row: 0, col: 0, value: "initial" }]) });
    await sheetsA.call("set-sheet", { sheet_id: id, locked: true });
    await a.api.plugin("roles").call("ensure-everyone");
    const everyone = a.api.plugin("roles");
    const [allMembers] = await everyone.read("roles_roles", { everyone: true });
    await everyone.call("edit-role", { id: allMembers.id, name: "everyone", permissions: "" });
    const { id: editorRole } = await everyone.call<{ id: number }>("create-role", {
      name: "editors", permissions: "edit_content",
    });
    const { id: managerRole } = await everyone.call<{ id: number }>("create-role", {
      name: "workspace managers", permissions: "manage_channels",
    });
    await everyone.call("assign-role", { user_id: b.id, role_id: managerRole });
    await everyone.call("assign-role", { user_id: c.id, role_id: editorRole });
    await sync(a, b, c);

    const sheetsB = b.api.plugin("sheets");
    await expect(sheetsB.call("set-cells", { sheet_id: id, cells: JSON.stringify([{ row: 0, col: 0, value: "blocked" }]) }))
      .rejects.toThrow(/sheet is locked/);
    const sheetsC = c.api.plugin("sheets");
    await expect(sheetsC.call("set-sheet", { sheet_id: id, locked: false })).rejects.toThrow(/workspace manager/);
    await expect(sheetsC.call("set-cells", { sheet_id: id, cells: JSON.stringify([{ row: 0, col: 0, value: "blocked" }]) }))
      .rejects.toThrow(/sheet is locked/);
    await sheetsB.call("set-sheet", { sheet_id: id, locked: false });
    await sync(a, b, c);
    await sheetsC.call("set-cells", { sheet_id: id, cells: JSON.stringify([{ row: 0, col: 0, value: "unlocked" }]) });
    await sync(a, b, c);
    expect((await sheetsA.read("sheets_cells", { sheet_id: id }))[0].value).toBe("unlocked");
  });

  it("lets the owner kick a member: profile and roles go, and members can't kick the owner", async () => {
    const { a, b } = await server();
    const rolesA = a.api.plugin("roles");
    await rolesA.call("ensure-everyone");
    const { id: helpers } = await rolesA.call<{ id: number }>("create-role", { name: "helpers", permissions: "send_messages" });
    await rolesA.call("assign-role", { user_id: b.id, role_id: helpers });
    await b.api.plugin("members").call("set-profile", { username: "b", display_name: "B", color: "" });
    await a.api.plugin("members").call("set-profile", { username: "a", display_name: "A", color: "" });
    await sync(a, b);
    await expect(b.api.plugin("members").call("kick", { user_id: a.id })).rejects.toThrow(/Kick members/);
    await rolesA.call("kick", { user_id: b.id });
    await a.api.plugin("members").call("kick", { user_id: b.id });
    await sync(a, b);
    for (const side of [a, b]) {
      expect((await side.api.plugin("members").read("members_profiles")).map((p) => p.user_id)).toEqual([a.id]);
      expect(await side.api.plugin("roles").read("roles_members")).toEqual([]);
    }
  });

  it("refuses a banned member's later changes", async () => {
    const { a, b } = await server();
    await a.api.plugin("roles").call("ensure-everyone");
    await b.api.plugin("chat").call("post-message", { channel_id: 1, body: "before" });
    await sync(a, b);
    await a.api.plugin("roles").call("ban", { user_id: b.id });
    await sync(a, b);
    await expect(b.api.plugin("chat").call("post-message", { channel_id: 1, body: "after" })).rejects.toThrow(/banned/);
    expect((await a.api.plugin("chat").read("chat_messages")).map((m) => m.body)).toEqual(["before"]);
  });

  it("refuses changes in a channel the member can't see", async () => {
    const { a, b, c, categoryId } = await server();
    const roles = a.api.plugin("roles");
    const { id: everyone } = await roles.call<{ id: number }>("ensure-everyone");
    const { id: staff } = await roles.call<{ id: number }>("create-role", { name: "staff" });
    await roles.call("assign-role", { user_id: c.id, role_id: staff });
    const { id: secret } = await addChannel(a, categoryId, "secret");
    const rule = { target: "channel", target_id: secret, subject: "role" };
    await a.api.plugin("channels").call("set-visibility", { ...rule, subject_id: everyone, visible: false });
    await a.api.plugin("channels").call("set-visibility", { ...rule, subject_id: staff, visible: true });
    await sync(a, b, c);
    await expect(b.api.plugin("chat").call("post-message", { channel_id: secret, body: "hi" })).rejects.toThrow(/can't see/);
    await c.api.plugin("chat").call("post-message", { channel_id: secret, body: "staff only" });
    await sync(a, b, c);
    expect((await b.api.plugin("chat").read("chat_messages")).map((m) => m.body)).toEqual(["staff only"]);
    await expect(b.api.plugin("channels").call("set-visibility", { ...rule, subject_id: everyone, visible: true })).rejects.toThrow(/Manage channels/);
  });

  it("makes a channel read-only by its edit rules, with exceptions per role", async () => {
    const { a, b, c, categoryId } = await server();
    const roles = a.api.plugin("roles");
    const { id: everyone } = await roles.call<{ id: number }>("ensure-everyone");
    const { id: staff } = await roles.call<{ id: number }>("create-role", { name: "staff" });
    await roles.call("assign-role", { user_id: c.id, role_id: staff });
    const { id: news } = await addChannel(a, categoryId, "news");
    const rule = { target: "channel", target_id: news, subject: "role" };
    await a.api.plugin("channels").call("set-edit", { ...rule, subject_id: everyone, edit: false });
    await a.api.plugin("channels").call("set-edit", { ...rule, subject_id: staff, edit: true });
    await sync(a, b, c);
    await expect(b.api.plugin("chat").call("post-message", { channel_id: news, body: "hi" })).rejects.toThrow(/Send messages/);
    const { id } = await c.api.plugin("chat").call<{ id: number }>("post-message", { channel_id: news, body: "announcement" });
    await sync(a, b, c);
    // Rows under a message belong to its channel too.
    await expect(b.api.plugin("chat").call("react", { message_id: id, code: "fire" })).rejects.toThrow(/Send messages/);
    // Clearing the edit setting leaves the visibility rule's row alone, and the server permissions decide again.
    await a.api.plugin("channels").call("set-visibility", { ...rule, subject_id: everyone, visible: true });
    await a.api.plugin("channels").call("set-edit", { ...rule, subject_id: everyone, edit: null });
    await sync(a, b, c);
    expect((await a.api.plugin("channels").read("channels_visibility")).filter((r) => r.subject_id === everyone))
      .toMatchObject([{ visible: true, edit: null }]);
    await b.api.plugin("chat").call("post-message", { channel_id: news, body: "now open" });
  });

  it("lets a bot's host post for it only where the bot's own roles allow", async () => {
    const { a, b, c, categoryId } = await server();
    const roles = a.api.plugin("roles");
    const { id: everyone } = await roles.call<{ id: number }>("ensure-everyone");
    const { id: staff } = await roles.call<{ id: number }>("create-role", { name: "staff" });
    await roles.call("assign-role", { user_id: c.id, role_id: staff });
    const { id: news } = await addChannel(a, categoryId, "news");
    const rule = { target: "channel", target_id: news, subject: "role" };
    await a.api.plugin("channels").call("set-edit", { ...rule, subject_id: everyone, edit: false });
    await a.api.plugin("channels").call("set-edit", { ...rule, subject_id: staff, edit: true });
    await a.api.plugin("bots").call("create", { user_id: 4242, type: "reply", nickname: "Grug", host: c.id });
    await sync(a, b, c);
    const post = (m: Member, channel: number) =>
      m.api.plugin("chat").call("post-bot-message", { channel_id: channel, bot_user_id: 4242, body: "beep", thread_id: null });
    await expect(post(c, news)).rejects.toThrow(/Send messages/);
    await expect(post(b, 1)).rejects.toThrow();
    await post(c, 1);
  });

  it("judges a commit made `as` a bot by the bot's roles, and only for its host", async () => {
    const { a, b, c, categoryId } = await server();
    const roles = a.api.plugin("roles");
    const { id: everyone } = await roles.call<{ id: number }>("ensure-everyone");
    const { id: staff } = await roles.call<{ id: number }>("create-role", { name: "staff" });
    await roles.call("assign-role", { user_id: c.id, role_id: staff });
    const { id: news } = await addChannel(a, categoryId, "news");
    const { id: open } = await addChannel(a, categoryId, "open");
    const rule = { target: "channel", target_id: news, subject: "role" };
    await a.api.plugin("channels").call("set-edit", { ...rule, subject_id: everyone, edit: false });
    await a.api.plugin("channels").call("set-edit", { ...rule, subject_id: staff, edit: true });
    await a.api.plugin("bots").call("create", { user_id: 4242, type: "agent", nickname: "Grug", host: c.id });
    await sync(a, b, c);
    const say = (m: Member, channel: number) =>
      m.api.forBot(4242).plugin("chat").call<{ id: number }>("post-message", { channel_id: channel, body: "beep" });
    await expect(say(c, news)).rejects.toThrow(/Send messages/);
    await expect(say(b, open)).rejects.toThrow(/hosts/);
    const { id } = await say(c, open);
    await sync(a, b, c);
    expect(await a.api.plugin("chat").read("chat_messages", { id })).toMatchObject([{ author_id: 4242 }]);
    expect(a.ledger.missing({}, true).some((commit) => commit.as === 4242)).toBe(true);
  });
});

describe("helper bots", () => {
  it("lets a leader pass a role it holds to its own helper, and nothing else", async () => {
    const { a, c } = await server();
    const roles = a.api.plugin("roles");
    const { id: builders } = await roles.call<{ id: number }>("create-role", { name: "Builders", permissions: "manage_channels" });
    const { id: other } = await roles.call<{ id: number }>("create-role", { name: "Other" });
    await roles.call("assign-role", { user_id: 4242, role_id: builders });
    await a.api.plugin("bots").call("create", { user_id: 4242, type: "leader", nickname: "Boss", host: c.id });
    await a.api.plugin("bots").call("create", { user_id: 4343, type: "agent", nickname: "Help", config: JSON.stringify({ _parent: 4242 }), host: c.id });
    await a.api.plugin("bots").call("create", { user_id: 4444, type: "agent", nickname: "Stranger", host: c.id });
    await sync(a, c);
    const asLeader = c.api.forBot(4242).plugin("roles");
    await asLeader.call("assign-role", { user_id: 4343, role_id: builders });
    await expect(asLeader.call("assign-role", { user_id: 4444, role_id: builders })).rejects.toThrow();
    await expect(asLeader.call("assign-role", { user_id: 4343, role_id: other })).rejects.toThrow();
  });
});

describe("bot credentials", () => {
  const envelope = (from: Member, to: Member) =>
    JSON.stringify({ v: 1, id: "x", from: from.ledger.author, to: to.ledger.author, at: 1, iv: "aa", data: "bb" });
  const shares = (...list: [number, string][]) => JSON.stringify(list.map(([user_id, sealed]) => ({ user_id, sealed })));

  it("lets only members with Store credentials save secrets, sealed to holders of that permission", async () => {
    const { a, b, c } = await server();
    const roles = a.api.plugin("roles");
    const { id: keeper } = await roles.call<{ id: number }>("create-role", { name: "keeper", permissions: "store_credentials" });
    await roles.call("assign-role", { user_id: c.id, role_id: keeper });
    await sync(a, b, c);
    const create = (m: Member, ...list: [number, string][]) => m.api.plugin("bots").call<{ id: number }>("credential-create", { name: "key", shares: shares(...list) });
    await expect(create(b, [b.id, envelope(b, b)])).rejects.toThrow(/Store credentials/);
    await expect(create(c, [b.id, envelope(c, b)])).rejects.toThrow(/Only members who store/);
    await expect(create(c, [c.id, envelope(b, c)])).rejects.toThrow(/sealed/);
    const { id } = await create(c, [c.id, envelope(c, c)], [a.id, envelope(c, a)]);
    await sync(a, b, c);
    expect(await a.api.plugin("bots").read("bots_credential_shares", { credential_id: id })).toHaveLength(2);
    await expect(b.api.plugin("bots").call("credential-remove", { id })).rejects.toThrow(/Store credentials/);
  });
});

describe("declared plugin data", () => {
  const packageRef = `mwc:${"0".repeat(64)}`;
  // The resolved declared manifest a workspace row keeps: a notes channel table, plus what a case needs.
  const notesManifest = (...tables: object[]) => JSON.stringify({
    name: "notes", version: "1.0.0", tables: [
      { name: "example_notes_view_notes", parent: null, columns: { note: "text", channel_id: "bigint", author_id: "bigint" }, channel: true, authored: "author_id" },
      ...tables,
    ],
  });
  const addPlugin = (m: Member, manifest = notesManifest(), pluginId = "example.notes-view") =>
    m.api.plugin("channels").call("add-plugin", { plugin_id: pluginId, version: "1.0.0", manifest, package: packageRef });
  // Raw table writes, as a changed or hostile app would make them: this member's ledger checks the policy.
  const write = (m: Member, table: string, kind: "insert" | "update" | "delete", id: number, values: Record<string, string | number | boolean | null> = {}) =>
    m.ledger.write({ ext: "notes", table, kind, id, values });
  it("lets members with Edit content add and change rows of a declared channel's table", async () => {
    const { a, b, c, categoryId } = await server();
    const { id: everyone } = await a.api.plugin("roles").call<{ id: number }>("ensure-everyone");
    await sync(a, b, c);
    await addPlugin(a);
    const { id: notes } = await addChannel(a, categoryId, "notes", "notes");
    const { id: anotherNotes } = await addChannel(a, categoryId, "notes-other", "notes");
    const { id: general } = await addChannel(a, categoryId, "general");
    await sync(a, b, c);
    loadDeclared(a.ledger, a.backend); loadDeclared(b.ledger, b.backend); loadDeclared(c.ledger, c.backend);

    write(b, "example_notes_view_notes", "insert", 1, { note: "b note", channel_id: notes, author_id: b.id });
    await sync(a, b, c);
    expect(await a.api.plugin("notes").read("example_notes_view_notes", { channel_id: notes }))
      .toMatchObject([{ note: "b note", author_id: b.id }]);

    // Added as yourself, in a channel of the plugin's type: a careless or hostile client is refused.
    expect(() => write(c, "example_notes_view_notes", "insert", 2, { note: "not mine", channel_id: notes, author_id: b.id })).toThrow(/as yourself/);
    expect(() => write(c, "example_notes_view_notes", "insert", 3, { note: "wrong channel", channel_id: general, author_id: c.id })).toThrow(/notes/);
    expect(() => write(c, "example_notes_view_notes", "insert", 4, { note: "nowhere", author_id: c.id })).toThrow(/notes/);

    // A read-only channel takes Edit content away through its rule, so nothing changes there, not even your own row.
    await a.api.plugin("channels").call("set-edit", { target: "channel", target_id: notes, subject: "role", subject_id: everyone, edit: false });
    await sync(a, b, c);
    expect(() => write(c, "example_notes_view_notes", "insert", 5, { note: "read only", channel_id: notes, author_id: c.id })).toThrow(/Edit content/);
    expect(() => write(b, "example_notes_view_notes", "update", 1, { note: "changed" })).toThrow(/Edit content/);
    await a.api.plugin("channels").call("set-edit", { target: "channel", target_id: notes, subject: "role", subject_id: everyone, edit: null });
    await sync(a, b, c);

    // It is one shared table: anyone with Edit content may change a row, but the authored column stays.
    write(c, "example_notes_view_notes", "update", 1, { note: "changed by c" });
    await sync(a, b, c);
    expect(await a.api.plugin("notes").read("example_notes_view_notes", { channel_id: notes }))
      .toMatchObject([{ note: "changed by c", author_id: b.id }]);
    expect(() => write(c, "example_notes_view_notes", "update", 1, { author_id: c.id })).toThrow(/can't be changed/);
    expect(() => write(c, "example_notes_view_notes", "update", 1, { channel_id: anotherNotes })).toThrow(/channel_id can't be changed/);
    write(c, "example_notes_view_notes", "delete", 1);
    await sync(a, b, c);
    expect(await a.api.plugin("notes").read("example_notes_view_notes", { channel_id: notes })).toEqual([]);
  });

  it("keeps owned rows to their creator or Manage messages, and channel-wide tables to the owner", async () => {
    const { a, b, c, categoryId } = await server();
    await a.api.plugin("roles").call("ensure-everyone");
    await sync(a, b, c);
    await addPlugin(a, notesManifest(
      { name: "example_notes_view_locks", parent: null, columns: { channel_id: "bigint", owner_id: "bigint" }, channel: true, owned: true },
      { name: "example_notes_view_meta", parent: null, columns: { channel_id: "bigint", locked: "bool" }, channel: false },
    ));
    const { id: notes } = await addChannel(a, categoryId, "notes", "notes");
    await sync(a, b, c);
    loadDeclared(a.ledger, a.backend); loadDeclared(b.ledger, b.backend); loadDeclared(c.ledger, c.backend);

    // Anyone with Edit content may add an owned row; after that, only its creator or Manage messages may change it.
    write(b, "example_notes_view_locks", "insert", 10, { channel_id: notes, owner_id: b.id });
    await sync(a, b, c);
    expect(() => write(c, "example_notes_view_locks", "update", 10, { owner_id: c.id })).toThrow(/Manage messages/);
    expect(() => write(c, "example_notes_view_locks", "delete", 10)).toThrow(/Manage messages/);
    const rolesA = a.api.plugin("roles");
    const { id: mods } = await rolesA.call<{ id: number }>("create-role", { name: "mods", permissions: "manage_messages" });
    await rolesA.call("assign-role", { user_id: c.id, role_id: mods });
    await sync(a, b, c);
    write(c, "example_notes_view_locks", "delete", 10);
    await sync(a, b, c);
    expect(await a.api.plugin("notes").read("example_notes_view_locks", { channel_id: notes })).toEqual([]);

    // A channel-wide table has no channel to check, so only the owner changes it.
    expect(() => write(b, "example_notes_view_meta", "insert", 20, { channel_id: notes, locked: true })).toThrow(/only the owner/);
    write(a, "example_notes_view_meta", "insert", 20, { channel_id: notes, locked: true });
    await sync(a, b, c);
    expect(await a.api.plugin("notes").read("example_notes_view_meta")).toMatchObject([{ locked: true }]);
  });

  it("adds an immutable declared plugin only with Manage plugins", async () => {
    const { a, b, categoryId } = await server();
    await a.api.plugin("roles").call("ensure-everyone");
    await sync(a, b);
    await expect(addPlugin(b)).rejects.toThrow(/Manage plugins/);

    // The row must be well formed: plugin_id, version, package and a usable manifest, and no built-in's name.
    const bad = (over: Record<string, string>) =>
      a.api.plugin("channels").call("add-plugin", { plugin_id: "example.notes-view", version: "1.0.0", manifest: notesManifest(), package: packageRef, ...over });
    await expect(bad({ plugin_id: "Notes View" })).rejects.toThrow(/plugin_id/);
    await expect(bad({ version: "" })).rejects.toThrow(/version/);
    await expect(bad({ package: "https://example.com/notes.mwp" })).rejects.toThrow(/mwc:/);
    await expect(bad({ manifest: "not json" })).rejects.toThrow(/JSON/);
    await expect(bad({ manifest: JSON.stringify({ name: "chat", version: "1.0.0", tables: [{ name: "chat_notes", columns: { note: "text" } }] }) }))
      .rejects.toThrow(/built-in system plugin/);
    expect(await a.api.plugin("channels").read("channels_plugins")).toEqual([]);

    await addPlugin(a);
    expect((await a.api.plugin("channels").read("channels_plugins"))[0])
      .toMatchObject({ plugin_id: "example.notes-view", version: "1.0.0", package: packageRef });
    // One row per plugin, and one per data name, in this workspace.
    await expect(addPlugin(a)).rejects.toThrow(/already in this workspace/);
    await expect(addPlugin(a, notesManifest(), "other.notes-view")).rejects.toThrow(/already in this workspace/);

    const { id: notes } = await addChannel(a, categoryId, "notes", "notes");
    await sync(a, b);

    // A Manage plugins member can't change or remove the registration, even after its channel is deleted.
    const rolesA = a.api.plugin("roles");
    const { id: admins } = await rolesA.call<{ id: number }>("create-role", { name: "admins", permissions: "manage_workspace" });
    await rolesA.call("assign-role", { user_id: b.id, role_id: admins });
    await sync(a, b);
    const channels = b.api.plugin("channels");
    const [row] = await channels.read("channels_plugins");
    await expect(channels.update("channels_plugins", { plugin_id: "other.id" }, { id: row.id })).rejects.toThrow(/plugin_id can't be changed/);
    await expect(channels.delete("channels_plugins", { id: row.id })).rejects.toThrow(/signed history/);
    await a.api.plugin("channels").call("delete-channel", { channel_id: notes });
    await sync(a, b);
    await expect(channels.delete("channels_plugins", { id: row.id })).rejects.toThrow(/signed history/);
    expect(await a.api.plugin("channels").read("channels_plugins")).toHaveLength(1);
  });

  it("serves a declared table from the workspace and catches up a member who lacked the plugin", async () => {
    const { a, b, c, categoryId } = await server();
    await a.api.plugin("roles").call("ensure-everyone");
    await sync(a, b, c);
    await addPlugin(a);
    const { id: notes } = await addChannel(a, categoryId, "notes", "notes");
    await sync(a, b, c);

    // a and b know the plugin; c does not (yet). c keeps the commits to the table, rejected until loadDeclared.
    loadDeclared(a.ledger, a.backend);
    loadDeclared(b.ledger, b.backend);
    const id = await b.api.plugin("notes").insert("example_notes_view_notes", { note: "first", channel_id: notes });
    await sync(a, b, c);
    expect(await a.api.plugin("notes").read("example_notes_view_notes", { channel_id: notes }))
      .toMatchObject([{ id, note: "first", channel_id: notes, author_id: b.id }]);
    expect(c.ledger.select("notes", "example_notes_view_notes", {})).toEqual([]);

    // Once the plugin is known, the kept commit is re-checked and applied.
    loadDeclared(c.ledger, c.backend);
    expect(await c.api.plugin("notes").read("example_notes_view_notes", { channel_id: notes }))
      .toMatchObject([{ id, note: "first", author_id: b.id }]);
  });
});

describe("welcome message", () => {
  it("lets a new member post the join message in the welcome channel", async () => {
    const { a, b, categoryId } = await server();
    await a.api.plugin("roles").call("ensure-everyone");
    const { id: welcome } = await addChannel(a, categoryId, "welcome");
    await a.api.plugin("channels").insert("channels_workspace", { name: "s", welcome_channel_id: welcome });
    await sync(a, b);
    const { created } = await b.api.plugin("members").call<{ created: boolean }>("set-profile", { display_name: "B", color: "" });
    expect(created).toBe(true);
    await b.api.plugin("chat").call("post-join", { channel_id: welcome });
    await sync(a, b);
    expect((await a.api.plugin("chat").read("chat_messages")).map((m) => [m.kind, m.channel_id])).toEqual([["join", welcome]]);
  });
});

describe("kicks", () => {
  it("refuses a kicked member's changes until they join again", async () => {
    const { a, b, categoryId } = await server();
    await a.api.plugin("roles").call("ensure-everyone");
    const { id: general } = await addChannel(a, categoryId, "general");
    const profile = { display_name: "B", color: "" };
    await a.api.plugin("members").call("set-profile", { display_name: "A", color: "" });
    await b.api.plugin("members").call("set-profile", profile);
    await sync(a, b);
    await expect(b.api.plugin("members").call("kick", { user_id: a.id })).rejects.toThrow(/Kick members|owner/);

    await a.api.plugin("roles").call("kick", { user_id: b.id });
    await a.api.plugin("members").call("kick", { user_id: b.id });
    await a.api.plugin("chat").call("post-kick", { channel_id: general, user_id: b.id, name: "B" });
    await sync(a, b);
    expect(await b.api.plugin("members").read("members_kicks")).toMatchObject([{ user_id: b.id, kicked_by: a.id }]);
    await expect(b.api.plugin("chat").call("post-message", { channel_id: general, body: "still here?" })).rejects.toThrow(/removed/);

    // Joining again with an invite sends the profile, which is allowed, and then everything else is again.
    await b.api.plugin("members").call("set-profile", profile);
    await b.api.plugin("chat").call("post-message", { channel_id: general, body: "back" });
    await sync(a, b);
    expect((await a.api.plugin("chat").read("chat_messages")).map((m) => m.kind === "kick" ? JSON.parse(String(m.body)).name : m.body))
      .toEqual(["B", "back"]);
  });
});

describe("bans", () => {
  it("removes a banned member, and only a moderator with Ban members is needed", async () => {
    const { a, b, c, categoryId } = await server();
    const roles = a.api.plugin("roles");
    await roles.call("ensure-everyone");
    const { id: mods } = await roles.call<{ id: number }>("create-role", { name: "mods", permissions: "ban_members" });
    await roles.call("assign-role", { user_id: c.id, role_id: mods });
    const { id: general } = await addChannel(a, categoryId, "general");
    await b.api.plugin("members").call("set-profile", { display_name: "B", color: "" });
    await sync(a, b, c);

    await c.api.plugin("roles").call("ban", { user_id: b.id, name: "B" });
    await c.api.plugin("roles").call("kick", { user_id: b.id });
    await c.api.plugin("members").call("kick", { user_id: b.id });
    await c.api.plugin("chat").call("post-kick", { channel_id: general, user_id: b.id, name: "B", ban: true });
    await sync(a, b, c);
    expect(await a.api.plugin("members").read("members_profiles")).toEqual([]);
    // Joining again doesn't help.
    await expect(b.api.plugin("members").call("set-profile", { display_name: "B", color: "" })).rejects.toThrow(/banned/);
    expect(JSON.parse(String((await a.api.plugin("chat").read("chat_messages"))[0].body))).toEqual({ user_id: b.id, name: "B", ban: true });
    expect(await a.api.plugin("roles").read("roles_bans")).toMatchObject([{ user_id: b.id, name: "B", banned_by: c.id }]);

    // After an unban they can join again.
    await c.api.plugin("roles").call("unban", { user_id: b.id });
    await sync(a, b, c);
    await b.api.plugin("members").call("set-profile", { display_name: "B", color: "" });
    await b.api.plugin("chat").call("post-message", { channel_id: general, body: "thanks" });
    await sync(a, b, c);
    expect((await a.api.plugin("chat").read("chat_messages")).at(-1)?.body).toBe("thanks");
  });
});

describe("invites", () => {
  it("creates an invite with an expiry date", async () => {
    const { a } = await server();
    const prepared = inviteArgs(a, { label: "Day", expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString() });
    const { id } = await a.api.plugin("members").call<{ id: number }>("create-invite", prepared.args);
    const [row] = (await a.api.plugin("members").read("members_invites")).filter((invite) => invite.id === id);
    expect(Date.parse(String(row.expires_at))).toBeGreaterThan(Date.now());
  });

  it("requires a signed invite use, consumes its limit once, and refuses a forged use marker", async () => {
    const { a, b, c } = await server();
    const prepared = inviteArgs(a, { label: "One person", max_uses: 1 });
    const { id: inviteId, token } = await a.api.plugin("members").call<{ id: number; token: string }>("create-invite", prepared.args);
    await sync(a, b, c);
    const tokenKey = inviteTokenKey(token)!;

    await expect(c.api.plugin("members").call("set-profile", { display_name: "C", color: "" }))
      .rejects.toThrow(/invite/i);
    await expect(c.api.plugin("members").insert("members_invite_uses", {
      invite_id: inviteId, user_id: c.id, token_key: tokenKey, proof: "forged", uses: 0, used_at: new Date().toISOString(),
    })).rejects.toThrow(/authorized/i);

    const { created } = await b.api.plugin("members").call<{ created: boolean }>("set-profile", {
      display_name: "B", color: "", invite_token: token,
    });
    expect(created).toBe(true);
    expect(await b.api.plugin("members").read("members_invite_uses")).toEqual([]);
    await sync(a, b, c);
    // The join is a row of its own (v2); the counter on the invite is only for v1 uses.
    expect(await a.api.plugin("members").read("members_invites")).toMatchObject([{ id: inviteId, uses: 0, max_uses: 1 }]);
    expect(await a.api.plugin("members").read("members_invite_joins")).toMatchObject([{ invite_id: inviteId, user_id: b.id }]);

    await expect(c.api.plugin("members").call("set-profile", {
      display_name: "C", color: "", invite_token: token,
    })).rejects.toThrow(/use limit/i);
  });

  it("lets two people join with one invite at the same moment, and refuses only a join past its limit", async () => {
    const { a, b, c } = await server();
    const open = inviteArgs(a, { label: "Everyone" });
    const { token } = await a.api.plugin("members").call<{ token: string }>("create-invite", open.args);
    await sync(a, b, c);
    // B and C each join on their own copy before hearing of the other (v1 proofs named the same use count, and every
    // member refused the second join).
    await b.api.plugin("members").call("set-profile", { display_name: "B", color: "", invite_token: token });
    await c.api.plugin("members").call("set-profile", { display_name: "C", color: "", invite_token: token });
    await sync(a, b, c);
    for (const m of [a, b, c]) expect((await m.api.plugin("members").read("members_profiles")).map((p) => p.user_id).sort())
      .toEqual([b.id, c.id].sort());

    const { a: owner, b: first, c: second } = await server();
    const one = inviteArgs(owner, { label: "One", max_uses: 1 });
    const { token: single } = await owner.api.plugin("members").call<{ token: string }>("create-invite", one.args);
    await sync(owner, first, second);
    await first.api.plugin("members").call("set-profile", { display_name: "First", color: "", invite_token: single });
    await second.api.plugin("members").call("set-profile", { display_name: "Second", color: "", invite_token: single });
    await sync(owner, first, second);
    const joined = (await owner.api.plugin("members").read("members_profiles")).map((p) => p.user_id);
    expect(joined).toHaveLength(1);
    const late = joined[0] === first.id ? second : first;
    const refused = late.ledger.log().filter(({ commit }) => commit.action === "members.set-profile" && commit.author === late.ledger.author)
      .map(({ commit }) => late.ledger.refusal(commit));
    expect(refused).toEqual([expect.stringMatching(/use limit/)]);
  });

  it("counts a join only with a signed use of its invite, once", async () => {
    const { a, b } = await server();
    const prepared = inviteArgs(a, { label: "Two", max_uses: 2 });
    const { id: inviteId } = await a.api.plugin("members").call<{ id: number }>("create-invite", prepared.args);
    await sync(a, b);
    // Burning an invite's uses without its token: refused.
    expect(() => b.ledger.write({ ext: "members", table: "members_invite_joins", kind: "insert", id: 900, values: {
      invite_id: inviteId, user_id: b.id, use_id: 1, joined_at: new Date().toISOString(),
    } })).toThrow(/signed use/);
  });

  it("checks a public invite's token, and still replays a v1 invite use", async () => {
    const { a, b, c } = await server();
    await a.api.plugin("roles").call("ensure-everyone");
    const { id: inviters } = await a.api.plugin("roles").call<{ id: number }>("create-role", { name: "inviters", permissions: "manage_invites" });
    await a.api.plugin("roles").call("assign-role", { user_id: c.id, role_id: inviters });
    await sync(a, b, c);
    const token = newInviteToken();
    const sealed = inviteArgs(a).args.sealed_token;
    await expect(c.api.plugin("members").insert("members_invites", {
      token_key: inviteTokenKey(token), sealed_token: inviteArgs(c).args.sealed_token, label: "Page", created_by: c.id,
      created_at: new Date().toISOString(), expires_at: null, max_uses: null, uses: 0, revoked: false, public_token: newInviteToken(),
    })).rejects.toThrow(/public token/);
    const { id } = await a.api.plugin("members").call<{ id: number }>("create-invite", { token, sealed_token: sealed, label: "Page", public: true });
    expect((await a.api.plugin("members").read("members_invites")).find((row) => row.id === id)).toMatchObject({ public_token: token });

    // A join the way apps before 2026-10-16 wrote it: the use names the count, which goes up in the same commit.
    await sync(a, b);
    const now = new Date().toISOString();
    b.ledger.transact("members.set-profile", () => {
      b.ledger.write({ ext: "members", table: "members_invite_uses", kind: "insert", id: 901, values: {
        invite_id: id, user_id: b.id, token_key: inviteTokenKey(token)!, proof: inviteProof(token, inviteUseText(id, b.id, 0))!, uses: 0, used_at: now,
      } });
      b.ledger.write({ ext: "members", table: "members_invites", kind: "update", id, values: { uses: 1 } });
      b.ledger.write({ ext: "members", table: "members_profiles", kind: "insert", id: 902, values: { user_id: b.id, display_name: "B" } });
      b.ledger.write({ ext: "members", table: "members_invite_uses", kind: "delete", id: 901 });
    });
    await sync(a, b);
    expect((await a.api.plugin("members").read("members_profiles")).map((p) => p.user_id)).toEqual([b.id]);
  });

  it("takes only a member's own key in their profile", async () => {
    const { a } = await server();
    const own = await signer();
    const stranger = await signer();
    const d = await member(a.ledger.workspaceId, own);
    await sync(a, d);
    const profile = { display_name: "D", color: "" };
    await expect(d.api.plugin("members").call("set-profile", { ...profile, key_x: stranger.key.x, key_y: stranger.key.y })).rejects.toThrow(/owner's key/);
    await d.api.plugin("members").call("set-profile", { ...profile, key_x: own.key.x, key_y: own.key.y });
  });

  it("refuses a revoked invitation", async () => {
    const { a, b } = await server();
    const prepared = inviteArgs(a);
    const { id, token } = await a.api.plugin("members").call<{ id: number; token: string }>("create-invite", prepared.args);
    await a.api.plugin("members").call("revoke-invite", { id });
    await sync(a, b);
    await expect(b.api.plugin("members").call("set-profile", {
      display_name: "B", color: "", invite_token: token,
    })).rejects.toThrow(/invite/i);
  });

  it("refuses to permanently delete an open invite", async () => {
    const { a, c } = await server();
    await a.api.plugin("roles").call("ensure-everyone");
    const { id: inviters } = await a.api.plugin("roles").call<{ id: number }>("create-role", { name: "inviters", permissions: "manage_invites" });
    await a.api.plugin("roles").call("assign-role", { user_id: c.id, role_id: inviters });
    const { id } = await a.api.plugin("members").call<{ id: number }>("create-invite", inviteArgs(a, { label: "Open" }).args);
    await sync(a, c);
    // An open invite is not removable by a manager, through the API or around it. (The owner bypasses table rules;
    // their own gate is the invite check in the plugin's handler.)
    await expect(c.api.plugin("members").call("delete-invite", { id })).rejects.toThrow(/closed invite/);
    expect(() => c.ledger.write({ ext: "members", table: "members_invites", kind: "delete", id }))
      .toThrow(/closed invite/);
    expect(await a.api.plugin("members").read("members_invites")).toHaveLength(1);
  });

  it("permanently deletes a revoked invite for everyone, keeping its join record", async () => {
    const { a, b } = await server();
    const prepared = inviteArgs(a, { label: "Shared" });
    const { id, token } = await a.api.plugin("members").call<{ id: number; token: string }>("create-invite", prepared.args);
    await sync(a, b);
    await b.api.plugin("members").call("set-profile", { display_name: "B", color: "", invite_token: token });
    // A revoke that reaches a member before its join commit does would refuse that join (policy.ts).
    await sync(a, b);
    await a.api.plugin("members").call("revoke-invite", { id });
    await sync(a, b);
    // A plain member opens no invites and removes no closed ones.
    await expect(b.api.plugin("members").call("delete-invite", { id })).rejects.toThrow(/Manage invites/);
    await a.api.plugin("members").call("delete-invite", { id });
    await sync(a, b);
    for (const m of [a, b]) expect(await m.api.plugin("members").read("members_invites")).toEqual([]);
    // Who was let in through it stays on record.
    for (const m of [a, b])
      expect(await m.api.plugin("members").read("members_invite_joins")).toMatchObject([{ invite_id: id, user_id: b.id }]);
  });

  it("permanently deletes an expired invite", async () => {
    const { a, b } = await server();
    const prepared = inviteArgs(a, { label: "Old" });
    // create-invite refuses an expiry in the past, so the row is written the way an old invite looks now.
    a.ledger.write({
      ext: "members", table: "members_invites", kind: "insert", id: 903, values: {
        token_key: inviteTokenKey(prepared.token)!, sealed_token: prepared.args.sealed_token, label: "Old", created_by: a.id,
        created_at: new Date(Date.now() - 7200_000).toISOString(), expires_at: new Date(Date.now() - 3600_000).toISOString(),
        max_uses: null, uses: 0, revoked: false, public_token: "",
      },
    });
    await sync(a, b);
    const { deleted } = await a.api.plugin("members").call<{ deleted: boolean }>("delete-invite", { id: 903 });
    expect(deleted).toBe(true);
    expect(await a.api.plugin("members").read("members_invites")).toEqual([]);
    // B replays the delete at the commit's own time, so it lands there too.
    await sync(a, b);
    expect(await b.api.plugin("members").read("members_invites")).toEqual([]);
  });

  it("permanently deletes a used-up invite", async () => {
    const { a, b } = await server();
    const prepared = inviteArgs(a, { label: "One", max_uses: 1 });
    const { id, token } = await a.api.plugin("members").call<{ id: number; token: string }>("create-invite", prepared.args);
    await sync(a, b);
    await b.api.plugin("members").call("set-profile", { display_name: "B", color: "", invite_token: token });
    await sync(a, b);
    await a.api.plugin("members").call("delete-invite", { id });
    await sync(a, b);
    for (const m of [a, b]) expect(await m.api.plugin("members").read("members_invites")).toEqual([]);
    for (const m of [a, b]) expect(await m.api.plugin("members").read("members_invite_joins")).toHaveLength(1);
  });
});

describe("mutes", () => {
  it("refuses a chat-muted member's messages until unmuted, and only lower members can be muted", async () => {
    const { a, b, c, categoryId } = await server();
    const roles = a.api.plugin("roles");
    await roles.call("ensure-everyone");
    const { id: mods } = await roles.call<{ id: number }>("create-role", { name: "mods", permissions: "mute_members" });
    await roles.call("assign-role", { user_id: c.id, role_id: mods });
    const { id: general } = await addChannel(a, categoryId, "general");
    await sync(a, b, c);

    await expect(b.api.plugin("roles").call("mute", { user_id: c.id, kind: "chat" })).rejects.toThrow(/Mute members/);
    await expect(c.api.plugin("roles").call("mute", { user_id: a.id, kind: "chat" })).rejects.toThrow(/owner/);
    await c.api.plugin("roles").call("mute", { user_id: b.id, kind: "chat" });
    await c.api.plugin("roles").call("mute", { user_id: b.id, kind: "voice" });
    await sync(a, b, c);
    await expect(b.api.plugin("chat").call("post-message", { channel_id: general, body: "hi" })).rejects.toThrow(/Send messages/);
    expect(await a.api.plugin("roles").read("roles_mutes")).toMatchObject([
      { user_id: b.id, kind: "chat", muted_by: c.id }, { user_id: b.id, kind: "voice", muted_by: c.id },
    ]);

    await c.api.plugin("roles").call("unmute", { user_id: b.id, kind: "chat" });
    await sync(a, b, c);
    await b.api.plugin("chat").call("post-message", { channel_id: general, body: "back" });
    await sync(a, b, c);
    expect((await a.api.plugin("chat").read("chat_messages")).at(-1)?.body).toBe("back");
    expect(await a.api.plugin("roles").read("roles_mutes")).toMatchObject([{ kind: "voice" }]);
  });

  it("lets a node add only itself, waiting, and only Manage nodes decide on it", async () => {
    const { a, b, c } = await server();
    await a.api.plugin("roles").call("ensure-everyone");
    await sync(a, b, c);
    const node = c.api.plugin("nodes");
    expect((await node.call<{ name: string }>("register", { key_x: "x", key_y: "y", address: "203.0.113.5" })).name).toBe("node#1");
    await expect(node.call("decide", { user_id: c.id, status: "authorized" })).rejects.toThrow(/status can.t be changed/);
    await node.call("register", { key_x: "x", key_y: "y", address: "203.0.113.6" });
    await sync(a, b, c);
    await expect(b.api.plugin("nodes").call("decide", { user_id: c.id, status: "authorized" })).rejects.toThrow(/Manage nodes/);
    await expect(b.api.plugin("nodes").call("remove", { user_id: c.id })).rejects.toThrow(/Manage nodes/);

    const { id: admins } = await a.api.plugin("roles").call<{ id: number }>("create-role", { name: "nodes", permissions: "manage_nodes" });
    await a.api.plugin("roles").call("assign-role", { user_id: b.id, role_id: admins });
    await sync(a, b, c);
    await b.api.plugin("nodes").call("decide", { user_id: c.id, status: "authorized" });
    await sync(a, b, c);
    const [row] = await a.api.plugin("nodes").read("nodes_nodes");
    expect(row).toMatchObject({ user_id: c.id, status: "authorized", decided_by: b.id, address: "203.0.113.6" });
    // The node describes itself again without losing its authorization.
    await node.call("register", { key_x: "x", key_y: "y", address: "203.0.113.7" });
    await sync(a, b, c);
    expect((await a.api.plugin("nodes").read("nodes_nodes"))[0]).toMatchObject({ status: "authorized", address: "203.0.113.7" });
  });

  it("lets a member with Manage nodes add a node with its own key, authorized, and the node joins without an invite", async () => {
    const { a, b, c } = await server();
    await a.api.plugin("roles").call("ensure-everyone");
    await a.api.plugin("members").call("create-invite", inviteArgs(a).args);
    const { id: admins } = await a.api.plugin("roles").call<{ id: number }>("create-role", { name: "nodes", permissions: "manage_nodes" });
    await a.api.plugin("roles").call("assign-role", { user_id: b.id, role_id: admins });
    const identity = await createIdentity(false);
    const key = { x: identity.publicKey.x!, y: identity.publicKey.y! };
    const node = await member(a.ledger.workspaceId, { author: identity.id, key, privateKey: identity.privateKey, replica: crypto.randomUUID() });
    await sync(a, b, c, node);
    const add = (m: Member, values: Record<string, string | number>) => m.api.plugin("nodes").call("add", { user_id: node.id, key_x: key.x, key_y: key.y, page: "", ...values });

    await expect(add(c, {})).rejects.toThrow(/Manage nodes/);
    const other = await createIdentity(false);
    await expect(add(b, { key_x: other.publicKey.x!, key_y: other.publicKey.y! })).rejects.toThrow(/key doesn't match/);
    await expect(add(b, { page: "not a path" })).rejects.toThrow(/page path/);
    await add(b, { page: "join-us" });
    await sync(a, b, c, node);
    expect((await node.api.plugin("nodes").read("nodes_nodes"))[0]).toMatchObject({ user_id: node.id, status: "authorized", decided_by: b.id, page: "join-us" });

    // The node's profile needs no invite; anyone else's still does, whatever they claim.
    await node.api.plugin("members").call("set-profile", { username: "node", display_name: "node#1", color: "", node: true });
    await expect(c.api.plugin("members").call("set-profile", { display_name: "C", color: "", node: true })).rejects.toThrow(/invite/i);
    // Its page is a Manage nodes choice; the node describes itself without changing it.
    await expect(c.api.plugin("nodes").call("set-page", { user_id: node.id, page: "mine" })).rejects.toThrow(/Manage nodes/);
    await b.api.plugin("nodes").call("set-page", { user_id: node.id, page: "welcome" });
    await sync(a, b, c, node);
    await node.api.plugin("nodes").call("register", { key_x: key.x, key_y: key.y, address: "203.0.113.9" });
    await sync(a, b, c, node);
    expect((await a.api.plugin("nodes").read("nodes_nodes"))[0]).toMatchObject({ status: "authorized", page: "welcome", address: "203.0.113.9" });
  });

  it("splits only files of 20 GB and more", async () => {
    const { a } = await server();
    const nodesApi = a.api.plugin("nodes");
    await expect(nodesApi.call("set-storage", { stripe_mb: 16 })).rejects.toThrow(/20 GB/);
    await expect(nodesApi.call("set-storage", { stripe_mb: 20_479 })).rejects.toThrow(/20 GB/);
    await expect(nodesApi.call("set-storage", { stripe_mb: 2_000_000 })).rejects.toThrow(/between/);
    await nodesApi.call("set-storage", { stripe_mb: 0 });
    await nodesApi.call("set-storage", { stripe_mb: 20_480 });
    await nodesApi.call("set-storage", { stripe_mb: 300 * 1024 });
    expect((await nodesApi.read("nodes_settings"))[0]).toMatchObject({ stripe_mb: 300 * 1024 });
  });

  it("keeps one piece list per file: added as yourself, never changed, removed by its author or Manage nodes", async () => {
    const { a, b, c } = await server();
    await a.api.plugin("roles").call("ensure-everyone");
    await sync(a, b, c);
    const file = `mwc:${"ab".repeat(32)}`;
    const list = `mwc:${"cd".repeat(32)}`;
    const other = `mwc:${"ef".repeat(32)}`;
    expect(await b.api.plugin("nodes").call("add-pieces", { content: file, manifest: list })).toEqual({ manifest: list });
    await sync(a, b, c);
    // Another list for the same file: the first one counts, and a second row is refused.
    expect(await c.api.plugin("nodes").call("add-pieces", { content: file, manifest: other })).toEqual({ manifest: list });
    // Written past the plugin, as a changed app would: the policy refuses it on every member.
    const write = (m: Member, kind: "insert" | "update" | "delete", id: number, values?: Record<string, string | number>) =>
      m.ledger.write({ ext: "nodes", table: "nodes_pieces", kind, id, values });
    expect(() => write(c, "insert", 900, { content: file, manifest: other, author_id: c.id, created_at: new Date().toISOString() })).toThrow(/already has a piece list/);
    expect(() => write(c, "insert", 901, { content: other, manifest: list, author_id: b.id, created_at: new Date().toISOString() })).toThrow(/yourself|author/i);
    const [row] = await b.api.plugin("nodes").read("nodes_pieces");
    expect(() => write(b, "update", row.id, { manifest: other })).toThrow(/can.t be changed/);
    expect(() => write(c, "delete", row.id)).toThrow(/Manage nodes/);
    write(a, "delete", row.id);
    expect(await a.api.plugin("nodes").read("nodes_pieces")).toEqual([]);
  });
});

describe("custom emoji policy", () => {
  const ref = `mwc:${"a".repeat(64)}`;
  const thumb = "data:image/webp;base64,AAAA";
  const values = { name: "party_parrot", url: ref, thumb, mime: "image/png", size: 1000, width: 64, height: 64 };
  const add = (m: Member, changes: Record<string, unknown> = {}) =>
    m.api.plugin("emoji").call<{ id: number }>("add-emoji", { ...values, ...changes });

  it("needs Manage emoji once @everyone exists, and validates every row even for the owner", async () => {
    const { a, b, c } = await server();
    await add(b);
    await sync(a, b, c);
    expect((await a.api.plugin("emoji").read("emoji_emojis"))[0].name).toBe("party_parrot");

    await a.api.plugin("roles").call("ensure-everyone");
    await sync(a, b, c);
    await expect(add(c, { name: "other_one" })).rejects.toThrow(/Manage emoji/);
    const { id: role } = await a.api.plugin("roles").call<{ id: number }>("create-role", { name: "emoji", permissions: "manage_emojis" });
    await a.api.plugin("roles").call("assign-role", { user_id: c.id, role_id: role });
    await sync(a, b, c);
    await add(c, { name: "other_one" });
    await sync(a, b, c);
    expect((await a.api.plugin("emoji").read("emoji_emojis")).map((row) => row.name).sort()).toEqual(["other_one", "party_parrot"]);

    // A changed app writing past the plugin is refused by policy, also when the owner writes it.
    const write = (m: Member, kind: "insert" | "update" | "delete", id: number, values?: Record<string, string | number | boolean | null>) =>
      m.ledger.write({ ext: "emoji", table: "emoji_emojis", kind, id, values });
    expect(() => write(a, "insert", 900, { ...values, name: "bad_one", url: "https://example.com/a.png", author_id: a.id, created_at: new Date().toISOString() })).toThrow(/content/);
    expect(() => write(a, "insert", 901, { ...values, name: "bad_two", mime: "image/svg+xml", author_id: a.id, created_at: new Date().toISOString() })).toThrow(/PNG/);
    expect(() => write(c, "insert", 902, { ...values, name: "bad_three", author_id: a.id, created_at: new Date().toISOString() })).toThrow(/yourself/);
    expect(() => write(a, "insert", 903, { ...values, author_id: a.id, created_at: new Date().toISOString() })).toThrow(/already/);
    const [row] = await a.api.plugin("emoji").read("emoji_emojis");
    expect(() => write(a, "update", row.id, { name: "renamed" })).toThrow(/Only whether/);
    expect(() => write(a, "delete", row.id)).toThrow(/history/);
  });
});

describe("watch party policy", () => {
  it("lets a member plan a party, others join and play it, and only the host announce it", async () => {
    const { a, b, c, categoryId } = await server();
    const { id: voice } = await addChannel(a, categoryId, "lounge", "voice");
    const { id: text } = await addChannel(a, categoryId, "general");
    await sync(a, b, c);
    const { id } = await b.api.plugin("watch").call<{ id: number }>("create-party", {
      channel_id: voice, chat_channel_id: text, title: "Movie night", starts_at: new Date().toISOString(),
      items: JSON.stringify([{ file_id: 1, name: "a.mp4", url: `mwc:${"a".repeat(64)}`, mime: "video/mp4", size: 10 }]),
    });
    await b.api.plugin("watch").call("set-message", { party_id: id, message_id: 5 });
    await sync(a, b, c);
    await c.api.plugin("watch").call("join-party", { party_id: id });
    await c.api.plugin("watch").call("set-playback", { party_id: id, item: 0, playing: true, position: 3 });
    await sync(a, b, c);
    const { party } = await a.api.plugin("watch").call<{ party: Record<string, unknown> }>("get-party", { party_id: id });
    expect(party).toMatchObject({ message_id: 5, playing: true, changed_by: c.id, guests: [b.id, c.id] });
    expect(party.items as unknown[]).toHaveLength(1);
    await expect(c.api.plugin("watch").call("set-message", { party_id: id, message_id: 6 })).rejects.toThrow();
  });

  it("lets only the host start a party early", async () => {
    const { a, b, c, categoryId } = await server();
    const { id: voice } = await addChannel(a, categoryId, "lounge", "voice");
    const { id: text } = await addChannel(a, categoryId, "general");
    await a.api.plugin("roles").call("ensure-everyone");
    await sync(a, b, c);
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const { id } = await b.api.plugin("watch").call<{ id: number }>("create-party", {
      channel_id: voice, chat_channel_id: text, title: "Later", starts_at: later,
      items: JSON.stringify([{ file_id: 1, name: "a.mp4", url: `mwc:${"a".repeat(64)}`, mime: "video/mp4", size: 10 }]),
    });
    await sync(a, b, c);
    await expect(c.api.plugin("watch").call("start-now", { party_id: id })).rejects.toThrow();
    await b.api.plugin("watch").call("start-now", { party_id: id });
    await sync(a, b, c);
    const { party } = await a.api.plugin("watch").call<{ party: Record<string, unknown> }>("get-party", { party_id: id });
    expect(Date.parse(String(party.starts_at))).toBeLessThanOrEqual(Date.now());
  });
});
