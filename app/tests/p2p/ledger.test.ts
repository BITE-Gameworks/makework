import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../src/api/client";
import type { ServerEvent } from "../../src/api/types";
import { createIdentity } from "../../src/core/identity";
import {
  applyWorkspaceRevert, applyWorkspaceUndo, planWorkspaceRevert, planWorkspaceUndo,
} from "../../src/core/workspaceHistoryActions";
import { channels } from "../../src/system/channels";
import { artboard } from "../../src/system/artboard";
import { chat } from "../../src/system/chat";
import { members } from "../../src/system/members";
import { tasks } from "../../src/system/tasks";
import { MockTransport } from "../../src/mock/transport";
import { memoryCommits } from "../../src/p2p/commits";
import { Ledger, createLedgerBackend, newRowId, type CommitStore, type Signer, type StoredCheckpoint } from "../../src/p2p/ledger";
import { replayCommit, signCommit, userNumberOf, workspaceIdOf } from "../../src/p2p/log";
import { workspacePolicy } from "../../src/p2p/policy";
import { declaredManifestsFromSnapshot, loadDeclared } from "../../src/system/declared";
import { signedSnapshot } from "./signedSnapshot";

async function signer(): Promise<Signer> {
  const identity = await createIdentity(false);
  return {
    author: identity.id, key: { x: identity.publicKey.x!, y: identity.publicKey.y! }, privateKey: identity.privateKey,
    replica: crypto.randomUUID(),
  };
}

async function member(workspaceId: string, who: Signer, store: CommitStore = memoryCommits(), policy = workspacePolicy) {
  const ledger = new Ledger(workspaceId, who, policy, store);
  const backend = createLedgerBackend(ledger);
  for (const plugin of [channels, members, chat, tasks, artboard]) backend.load(plugin);
  await ledger.load();
  const events: ServerEvent[] = [];
  backend.subscribe((e) => events.push(e));
  return { ledger, who, backend, api: new ApiClient(new MockTransport(backend)), events };
}

function durableCommits() {
  const commits = memoryCommits();
  let checkpoint: StoredCheckpoint | null = null;
  return Object.assign(commits, {
    loadCheckpoint: async () => checkpoint,
    saveCheckpoint: async (_workspaceId: string, value: StoredCheckpoint) => { checkpoint = value; },
    deleteCheckpoint: async () => { checkpoint = null; },
  });
}

async function server() {
  const owner = await signer();
  const { workspaceId, genesis } = await Ledger.createGenesis(owner);
  const a = await member(workspaceId, owner);
  await a.ledger.adopt(genesis);
  const b = await member(workspaceId, await signer());
  return { workspaceId, a, b };
}

// Sends everything one side has that the other lacks, like the sync handshake.
async function exchange(from: Ledger, to: Ledger) {
  await from.flush();
  return to.receive(from.missing(to.vector()).map((c) => JSON.parse(JSON.stringify(c))));
}

describe("ledger", () => {
  it("replays old signed wire names into the renamed workspace tables", async () => {
    const owner = await signer();
    const genesis = await signCommit({
      server: "", author: owner.author, key: owner.key, replica: owner.replica, seq: 0, clock: 0,
      time: Date.now(), action: "server.create", ops: [],
    }, owner.privateKey);
    const workspaceId = await workspaceIdOf(genesis);
    const legacy = await signCommit({
      server: workspaceId, author: owner.author, key: owner.key, replica: owner.replica, seq: 1, clock: 1,
      time: Date.now(), action: "server.import",
      ops: [
        { ext: "channels", table: "channels_server", kind: "insert", id: 1, values: { name: "Legacy", short: "", color: "", icon: "" } },
        { ext: "channels", table: "channels_channels", kind: "insert", id: 2, values: { category_id: 1, name: "board", type: "ref_sheet", position: 1 } },
        { ext: "ref_sheet", table: "ref_sheet_items", kind: "insert", id: 3, values: { channel_id: 2, name: "image", mime: "image/png", url: "mwc:" + "a".repeat(64), x: 0, y: 0, scale: 1, rotation: 0, flip: false, z: 1, width: 1, height: 1, author_id: userNumberOf(owner.author), created_at: new Date().toISOString(), deleted: false } },
      ],
    }, owner.privateKey);
    const workspace = await member(workspaceId, owner);
    expect(await workspace.ledger.receive([genesis, legacy])).toBe(2);
    expect(workspace.ledger.log().map(({ rejected }) => rejected)).toEqual([null, null]);
    expect(await workspace.api.plugin("channels").read("channels_workspace")).toMatchObject([{ id: 1, name: "Legacy" }]);
    expect(await workspace.api.plugin("channels").read("channels_channels")).toMatchObject([{ id: 2, type: "artboard" }]);
    expect(await workspace.api.plugin("artboard").read("artboard_items")).toMatchObject([{ id: 3, name: "image" }]);
    expect(workspace.ledger.log().map(({ commit }) => commit.action)).toEqual(["server.create", "server.import"]);
  });

  it("normalizes the old workspace-profile action without changing signed history", async () => {
    const owner = await signer();
    const commit = await signCommit({
      server: "workspace-id", author: owner.author, key: owner.key, replica: owner.replica, seq: 1, clock: 1,
      time: Date.now(), action: "members.set-server-profile", ops: [],
    }, owner.privateKey);
    const replayed = replayCommit(commit);
    expect(replayed.action).toBe("members.set-workspace-profile");
    expect(replayed.sig).toBe(commit.sig);
    expect(commit.action).toBe("members.set-server-profile");
  });

  it("shows one member's writes to the other, with events", async () => {
    const { a, b } = await server();
    const { id } = await a.api.plugin("chat").call<{ id: number }>("post-message", { channel_id: 1, body: "hi" });
    await exchange(a.ledger, b.ledger);
    expect(await b.api.plugin("chat").read("chat_messages")).toMatchObject([{ id, body: "hi", author_id: a.ledger.me }]);
    expect(b.events).toContainEqual({ plugin: "chat", table: "chat_messages", change: "insert", ids: [id] });
  });

  it("drops commits whose content was changed after signing", async () => {
    const { a, b } = await server();
    await a.api.plugin("chat").call("post-message", { channel_id: 1, body: "original" });
    await a.ledger.flush();
    const forged = a.ledger.missing({}).map((c) => JSON.parse(JSON.stringify(c)));
    forged[1].ops[0].values.body = "forged";
    expect(await b.ledger.receive(forged)).toBe(1);
    expect(await b.api.plugin("chat").read("chat_messages")).toEqual([]);
  });

  it("takes a commit that arrives from several members at once as new only once", async () => {
    const { a } = await server();
    await a.api.plugin("chat").call("post-message", { channel_id: 1, body: "once" });
    await a.ledger.flush();
    // Storage takes a moment (IndexedDB), as in the app: the copies arrive while the first is being stored.
    const store = memoryCommits();
    const add = store.add.bind(store);
    store.add = async (workspaceId, commits) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return add(workspaceId, commits);
    };
    const b = await member(a.ledger.workspaceId, await signer(), store);
    const copy = () => a.ledger.missing({}).map((c) => JSON.parse(JSON.stringify(c)));
    const results = await Promise.all([b.ledger.accept(copy()), b.ledger.accept(copy()), b.ledger.accept(copy())]);
    expect(results.flat().map((c) => c.hash).sort()).toEqual(a.ledger.missing({}).map((c) => c.hash).sort());
    expect(await b.ledger.receive(copy())).toBe(0);
  });

  it("still takes a genuine commit after a forged copy of it was dropped", async () => {
    const { a, b } = await server();
    await a.api.plugin("chat").call("post-message", { channel_id: 1, body: "genuine" });
    await a.ledger.flush();
    const genuine = a.ledger.missing({}).map((c) => JSON.parse(JSON.stringify(c)));
    const forged = structuredClone(genuine);
    forged[1].ops[0].values.body = "forged";
    expect(await b.ledger.receive(forged)).toBe(1);
    expect(await b.ledger.receive(genuine)).toBe(1);
    expect((await b.api.plugin("chat").read("chat_messages")).map((m) => m.body)).toEqual(["genuine"]);
  });

  it("never signs two commits with the same replica and seq once its old commits come back", async () => {
    const { a, b } = await server();
    await exchange(a.ledger, b.ledger);
    await b.api.plugin("chat").call("post-message", { channel_id: 1, body: "before leaving" });
    await exchange(b.ledger, a.ledger);
    // The same replica on an empty copy (left and joined again), then the server's data arrives.
    const again = await member(a.ledger.workspaceId, b.who);
    await exchange(a.ledger, again.ledger);
    await again.api.plugin("chat").call("post-message", { channel_id: 1, body: "after rejoining" });
    await again.ledger.flush();
    const mine = again.ledger.missing({}).filter((c) => c.replica === b.who.replica);
    expect(new Set(mine.map((c) => c.seq)).size).toBe(mine.length);
  });

  it("refuses a change the author may not make, locally and from a peer", async () => {
    const { a, b } = await server();
    await a.api.plugin("channels").insert("channels_workspace", { name: "S", short: "", color: "", icon: "" });
    await exchange(a.ledger, b.ledger);
    const [row] = await b.api.plugin("channels").read("channels_workspace");
    await expect(b.api.plugin("channels").update("channels_workspace", { name: "mine" }, { id: row.id })).rejects.toThrow(/Manage workspace/);

    // A tampered client signs the change anyway.
    const commit = await signCommit({
      server: b.ledger.workspaceId, author: b.who.author, key: b.who.key, replica: b.who.replica, seq: 0, clock: 50,
      time: Date.now(), action: "channels.update",
      ops: [{ ext: "channels", table: "channels_workspace", kind: "update", id: row.id, values: { name: "mine" } }],
    }, b.who.privateKey);
    expect(await a.ledger.receive([JSON.parse(JSON.stringify(commit))])).toBe(1);
    expect((await a.api.plugin("channels").read("channels_workspace"))[0].name).toBe("S");
    expect(a.ledger.log().at(-1)!.rejected).toMatch(/Manage workspace/);
  });

  it("only lets members change their own profile", async () => {
    const { a, b } = await server();
    await a.api.plugin("members").call("set-profile", { display_name: "A", color: "" });
    await exchange(a.ledger, b.ledger);
    expect(() => b.backend.data("members").update("members_profiles", { display_name: "x" }, { user_id: a.ledger.me }))
      .toThrow(/own profile/);
    await b.api.plugin("members").call("set-profile", { display_name: "B", color: "" });
    await exchange(b.ledger, a.ledger);
    const names = (await a.api.plugin("members").read("members_profiles")).map((p) => p.display_name);
    expect(names).toEqual(["A", "B"]);
    expect(userNumberOf(b.who.author)).toBe(b.ledger.me);
  });

  it("persists a checkpoint on close and replays only the later commits on reopen", async () => {
    const owner = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(owner);
    const store = durableCommits();
    const first = await member(workspaceId, owner, store);
    await first.ledger.adopt(genesis);
    for (let i = 0; i < 255; i++)
      await first.api.plugin("chat").call("post-message", { channel_id: 1, body: `message ${i}` });
    await first.ledger.flushCheckpoint();
    expect((await store.loadCheckpoint(workspaceId))?.index).toBe(256);

    await first.api.plugin("chat").call("post-message", { channel_id: 1, body: "after checkpoint" });
    await first.ledger.flush();
    let policyCalls = 0;
    const countedPolicy = (context: Parameters<typeof workspacePolicy>[0]) => {
      policyCalls++;
      return workspacePolicy(context);
    };
    const reopened = await member(workspaceId, owner, store, countedPolicy);

    expect(policyCalls).toBe(1);
    expect(await reopened.api.plugin("chat").read("chat_messages")).toHaveLength(256);
  });

  it("falls back to full replay when a late commit sorts before the checkpoint", async () => {
    const owner = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(owner);
    const store = durableCommits();
    const first = await member(workspaceId, owner, store);
    await first.ledger.adopt(genesis);
    for (let i = 0; i < 255; i++)
      await first.api.plugin("chat").call("post-message", { channel_id: 1, body: `message ${i}` });
    await first.ledger.flushCheckpoint();
    const late = await signCommit({
      server: workspaceId, author: owner.author, key: owner.key, replica: "000-late", seq: 0, clock: 1,
      time: Date.now(), action: "chat.post-message",
      ops: [{
        ext: "chat", table: "chat_messages", kind: "insert", id: newRowId(),
        values: {
          channel_id: 1, author_id: userNumberOf(owner.author), thread_id: null, kind: "message", body: "late",
          created_at: new Date().toISOString(), edited_at: null, deleted: false,
        },
      }],
    }, owner.privateKey);
    await store.add(workspaceId, [late]);

    let policyCalls = 0;
    const countedPolicy = (context: Parameters<typeof workspacePolicy>[0]) => {
      policyCalls++;
      return workspacePolicy(context);
    };
    const reopened = await member(workspaceId, owner, store, countedPolicy);

    expect(policyCalls).toBeGreaterThan(1);
    expect((await reopened.api.plugin("chat").read("chat_messages")).some((row) => row.body === "late")).toBe(true);
  });

  it("stores and applies batches in the order they came in, even when an earlier one takes longer", async () => {
    const { workspaceId, a } = await server();
    await a.api.plugin("chat").call("post-message", { channel_id: 1, body: "before snapshot" });
    const state = await a.ledger.snapshotState();
    const snapshot = await signedSnapshot(a.ledger, a.who, state);
    await a.ledger.accept([snapshot], async () => state);
    await a.api.plugin("chat").call("post-message", { channel_id: 1, body: "after snapshot" });
    await a.ledger.flush();
    const all = a.ledger.missing({}, true);
    const store = memoryCommits();
    const sizes: number[] = [];
    const add = store.add;
    store.add = (id, commits) => (sizes.push(commits.length), add(id, commits));
    const b = await member(workspaceId, await signer(), store);
    // The first batch holds the snapshot, whose state takes a moment to load; the second is checked meanwhile. Taken
    // first, the second landed behind the log's start and the whole log was replayed (from commit 0 on a joiner).
    const first = b.ledger.accept(all.slice(0, -1), async () => (await new Promise((r) => setTimeout(r, 50)), state));
    const second = b.ledger.accept(all.slice(-1));
    await Promise.all([first, second]);
    expect(sizes).toEqual([all.length - 1, 1]);
    expect((await b.api.plugin("chat").read("chat_messages")).map((m) => m.body)).toEqual(["before snapshot", "after snapshot"]);
  });

  it("validates snapshots against full history and bootstraps a new member from the snapshot", async () => {
    const { workspaceId, a } = await server();
    await a.api.plugin("chat").call("post-message", { channel_id: 1, body: "before snapshot" });
    const state = await a.ledger.snapshotState();
    const snapshot = await signedSnapshot(a.ledger, a.who, state);
    const full = await member(workspaceId, await signer());
    await full.ledger.accept([...a.ledger.missing({}), snapshot], async () => state);
    expect(full.ledger.log().at(-1)?.rejected).toBeNull();
    expect(await full.api.plugin("chat").read("chat_messages")).toMatchObject([{ body: "before snapshot" }]);

    const altered = structuredClone(state);
    const messages = altered.tables.find(([key]) => key === "chat/chat_messages")![1];
    messages[0][1].values.body = "fabricated";
    const forgedData = await member(workspaceId, await signer());
    await forgedData.ledger.accept([...a.ledger.missing({}), snapshot], async () => altered);
    expect(forgedData.ledger.log().at(-1)?.rejected).toMatch(/don't match the signed history/);
    expect(await forgedData.api.plugin("chat").read("chat_messages")).toMatchObject([{ body: "before snapshot" }]);

    const bootstrap = await member(workspaceId, await signer());
    const genesis = a.ledger.missing({})[0];
    await bootstrap.ledger.accept([genesis, snapshot], async () => state);
    expect(await bootstrap.api.plugin("chat").read("chat_messages")).toMatchObject([{ body: "before snapshot" }]);
    expect(bootstrap.ledger.snapshotForBootstrap()?.commit.hash).toBe(snapshot.hash);
    expect(bootstrap.ledger.vector()).toMatchObject(snapshot.snapshot!.vector);
  });

  it("counts the commits after the snapshot a member started from, so peers stop sending them", async () => {
    const { workspaceId, a } = await server();
    await a.api.plugin("chat").call("post-message", { channel_id: 1, body: "before snapshot" });
    const state = await a.ledger.snapshotState();
    const snapshot = await signedSnapshot(a.ledger, a.who, state);
    await a.ledger.accept([snapshot], async () => state);
    await a.api.plugin("chat").call("post-message", { channel_id: 1, body: "after snapshot" });
    await a.ledger.flush();

    const bootstrap = await member(workspaceId, await signer());
    const sent = a.ledger.missing({});
    expect(sent.length).toBeLessThan(a.ledger.log().length);
    await bootstrap.ledger.accept(sent, async () => state);
    expect((await bootstrap.api.plugin("chat").read("chat_messages")).map((m) => m.body)).toEqual(["before snapshot", "after snapshot"]);
    // Before: its own replica's commit after the cutoff wasn't counted, so `a` sent it again at every hello.
    expect(a.ledger.missing(bootstrap.ledger.vector())).toEqual([]);
  });

  it("registers declared data tables from a snapshot before bootstrapping them", async () => {
    const { workspaceId, a } = await server();
    const manifest = JSON.stringify({
      name: "notes", version: "1.0.0", tables: [{
        name: "example_notes_view_notes", parent: null,
        columns: { note: "text", channel_id: "bigint", author_id: "bigint" },
        channel: true, authored: "author_id",
      }],
    });
    await a.api.plugin("channels").call("add-plugin", {
      plugin_id: "example.notes-view", version: "1.0.0", manifest, package: `mwc:${"0".repeat(64)}`,
    });
    const stopDeclared = loadDeclared(a.ledger, a.backend);
    a.ledger.transact("notes.add", () => a.ledger.write({
      ext: "notes", table: "example_notes_view_notes", kind: "insert", id: newRowId(),
      values: { note: "from snapshot", channel_id: 1, author_id: a.ledger.me },
    }));
    stopDeclared();
    const state = await a.ledger.snapshotState();
    const snapshot = await signedSnapshot(a.ledger, a.who, state);
    const bootstrapWho = await signer();
    const allow = () => null;
    let bootstrapLedger!: Ledger;
    bootstrapLedger = new Ledger(workspaceId, bootstrapWho, allow, memoryCommits(), async () => {
      for (const declared of declaredManifestsFromSnapshot(state)) bootstrapLedger.register(declared);
      return state;
    });
    const backend = createLedgerBackend(bootstrapLedger);
    for (const plugin of [channels, members, chat, tasks, artboard]) backend.load(plugin);
    await bootstrapLedger.load();
    await bootstrapLedger.accept([a.ledger.missing({})[0], snapshot]);
    const stopBootstrap = loadDeclared(bootstrapLedger, backend);
    const api = new ApiClient(new MockTransport(backend));

    expect(await api.plugin("notes").read("example_notes_view_notes")).toMatchObject([{ note: "from snapshot" }]);
    stopBootstrap();
  });

  it("rejects a late pre-cutoff commit without invalidating a full-history snapshot", async () => {
    const { workspaceId, a } = await server();
    await a.api.plugin("chat").call("post-message", { channel_id: 1, body: "at cutoff" });
    const state = await a.ledger.snapshotState();
    const snapshot = await signedSnapshot(a.ledger, a.who, state);
    const late = await signCommit({
      server: workspaceId, author: a.who.author, key: a.who.key, replica: "000-late", seq: 0,
      clock: 1, time: Date.now(), action: "chat.post-message",
      ops: [{
        ext: "chat", table: "chat_messages", kind: "insert", id: newRowId(),
        values: {
          channel_id: 1, author_id: userNumberOf(a.who.author), thread_id: null, kind: "message", body: "late",
          created_at: new Date().toISOString(), edited_at: null, deleted: false,
        },
      }],
    }, a.who.privateKey);
    const full = await member(workspaceId, await signer());

    await full.ledger.accept([...a.ledger.missing({}), late, snapshot], async () => state);

    const entries = full.ledger.log();
    expect(entries.find(({ commit }) => commit.hash === late.hash)?.rejected)
      .toBe("This change arrived after the workspace snapshot cutoff.");
    expect(entries.find(({ commit }) => commit.hash === snapshot.hash)?.rejected).toBeNull();
    expect(await full.api.plugin("chat").read("chat_messages")).toMatchObject([{ body: "at cutoff" }]);
  });

  it("compacts only after a verified snapshot and keeps a logical index for the next snapshot", async () => {
    const owner = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(owner);
    const store = memoryCommits();
    const a = await member(workspaceId, owner, store);
    await a.ledger.adopt(genesis);
    await a.api.plugin("chat").call("post-message", { channel_id: 1, body: "before snapshot" });
    const state = await a.ledger.snapshotState();
    const first = await signedSnapshot(a.ledger, owner, state);
    await a.ledger.accept([first], async () => state);
    expect(a.ledger.snapshotForBootstrap()?.commit.hash).toBe(first.hash);

    expect(await a.ledger.compactSnapshot()).toBe(1);
    expect(a.ledger.log().map(({ commit }) => commit.hash)).toEqual([genesis.hash, first.hash]);
    const nextState = await a.ledger.snapshotState();
    expect(nextState.index).toBe(state.index + 1);
    const second = await signedSnapshot(a.ledger, owner, nextState);
    await a.ledger.accept([second], async () => nextState);
    expect(a.ledger.log().at(-1)?.rejected).toBeNull();
    expect(await a.ledger.compactSnapshot()).toBe(1);
    await expect(a.ledger.snapshotState().then((value) => value.index)).resolves.toBe(state.index + 2);
  });

  it("doesn't restore snapshot data when its signer isn't allowed to manage history", async () => {
    const { a } = await server();
    await a.api.plugin("chat").call("post-message", { channel_id: 1, body: "private history" });
    const state = await a.ledger.snapshotState();
    const unauthorized = await signer();
    const snapshot = await signedSnapshot(a.ledger, unauthorized, state);
    const bootstrap = await member(a.ledger.workspaceId, await signer());
    await bootstrap.ledger.accept([a.ledger.missing({})[0], snapshot], async () => state);
    expect(bootstrap.ledger.log().at(-1)?.rejected).toMatch(/Manage history/);
    expect(await bootstrap.api.plugin("chat").read("chat_messages")).toEqual([]);
  });

  it("undoes one history entry as a new policy-checked commit and warns about overlapping edits", async () => {
    const { a } = await server();
    const { id } = await a.api.plugin("chat").call<{ id: number }>("post-message", { channel_id: 1, body: "first" });
    await a.ledger.flush();
    const posted = a.ledger.log().at(-1)!.commit;
    await a.api.plugin("chat").call("edit-message", { message_id: id, body: "later" });
    await a.ledger.flush();
    const plan = await planWorkspaceUndo(a.ledger, posted.hash);
    expect(plan.conflicts.join(" ")).toMatch(/body/);
    expect(plan.operations).toMatchObject([{ ext: "chat", table: "chat_messages", kind: "delete", id }]);
    const commitsBefore = a.ledger.log().length;
    await applyWorkspaceUndo(a.ledger, plan, true);
    expect(a.ledger.log()).toHaveLength(commitsBefore + 1);
    expect(await a.api.plugin("chat").read("chat_messages")).toEqual([]);
    expect(a.ledger.log().at(-1)?.commit.action).toBe("history.undo");
  });

  it("reverts a channel to a history entry with ordinary policy-checked writes", async () => {
    const { a } = await server();
    const { id } = await a.api.plugin("chat").call<{ id: number }>("post-message", { channel_id: 1, body: "at this point" });
    await a.ledger.flush();
    const historyIndex = a.ledger.log().length - 1;
    await a.api.plugin("chat").call("edit-message", { message_id: id, body: "later edit" });
    await a.ledger.flush();
    const plan = await planWorkspaceRevert(a.ledger, historyIndex, 1);
    expect(plan.operations).toContainEqual(expect.objectContaining({
      ext: "chat", table: "chat_messages", kind: "update", id, values: expect.objectContaining({ body: "at this point" }),
    }));
    await applyWorkspaceRevert(a.ledger, plan);
    expect(await a.api.plugin("chat").read("chat_messages")).toMatchObject([{ id, body: "at this point" }]);
    expect(a.ledger.log().at(-1)?.commit.action).toBe("history.revert");
  });

  it("notifies the author when a later remote commit overwrites one of their fields", async () => {
    const owner = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(owner);
    const allow = () => null;
    const a = await member(workspaceId, owner, memoryCommits(), allow);
    await a.ledger.adopt(genesis);
    const b = await member(workspaceId, await signer(), memoryCommits(), allow);
    await exchange(a.ledger, b.ledger);
    const notices: import("../../src/p2p/ledger").HistoryNotice[][] = [];
    a.ledger.subscribeNotices((batch) => notices.push(batch));
    const { id } = await a.api.plugin("chat").call<{ id: number }>("post-message", { channel_id: 1, body: "mine" });
    await a.ledger.flush();
    const own = a.ledger.log().at(-1)!.commit;
    await exchange(a.ledger, b.ledger);
    b.ledger.transact("test.overwrite", () => b.ledger.write({
      ext: "chat", table: "chat_messages", kind: "update", id, values: { body: "theirs" },
    }));
    await b.ledger.flush();
    await exchange(b.ledger, a.ledger);
    expect(notices.flat()).toContainEqual(expect.objectContaining({
      kind: "overwritten", commit: expect.objectContaining({ hash: own.hash }),
      by: expect.objectContaining({ author: b.who.author }), fields: expect.arrayContaining(["body"]),
    }));
  });

  it("ends with the same tables on both sides after offline edits, in any arrival order", async () => {
    const { a, b } = await server();
    const { id } = await a.api.plugin("tasks").call<{ id: number }>("add-task", { channel_id: 1, title: "t" });
    await exchange(a.ledger, b.ledger);
    // Offline: both edit the same task.
    a.backend.data("tasks").update("tasks_tasks", { title: "from a" }, { id });
    b.backend.data("tasks").update("tasks_tasks", { title: "from b", notes: "b's notes" }, { id });
    a.backend.data("tasks").update("tasks_tasks", { notes: "a's notes" }, { id });
    await exchange(b.ledger, a.ledger);
    await exchange(a.ledger, b.ledger);
    const read = async (m: typeof a) => m.api.plugin("tasks").read("tasks_tasks");
    expect(await read(a)).toEqual(await read(b));

    // A third member who gets the commits in another order agrees too.
    const c = await member(a.ledger.workspaceId, await signer());
    const all = a.ledger.missing({}).map((x) => JSON.parse(JSON.stringify(x)));
    for (const commit of all.reverse()) await c.ledger.receive([commit]);
    expect(await read(c)).toEqual(await read(a));
  });

  it("keeps its commits across a restart", async () => {
    const owner = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(owner);
    const store = memoryCommits();
    const first = new Ledger(workspaceId, owner, workspacePolicy, store);
    const backend = createLedgerBackend(first);
    backend.load(chat);
    await first.load();
    await first.adopt(genesis);
    await new ApiClient(new MockTransport(backend)).plugin("chat").call("post-message", { channel_id: 1, body: "kept" });
    await first.flush();

    const again = new Ledger(workspaceId, owner, workspacePolicy, store);
    const backend2 = createLedgerBackend(again);
    backend2.load(chat);
    await again.load();
    const api = new ApiClient(new MockTransport(backend2));
    expect((await api.plugin("chat").read("chat_messages")).map((m) => m.body)).toEqual(["kept"]);
    await api.plugin("chat").call("post-message", { channel_id: 1, body: "next" });
    await again.flush();
    expect(new Set(again.missing({}).map((c) => `${c.replica}:${c.seq}`)).size).toBe(again.missing({}).length);
  });
});

// A small seeded generator, so a failing order can be replayed.
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Every table of every plugin, for comparing two ledgers.
function tables(ledger: Ledger) {
  return Object.fromEntries(ledger.allManifests().flatMap((m) => m.tables.map((t) => [`${m.name}/${t.name}`, ledger.select(m.name, t.name, {})])));
}

describe("ledger replays", () => {
  // Three members edit the same tasks offline for many rounds and sync with one another now and then, so the log
  // holds hundreds of interleaved commits; a tampered member also signs changes it may not make at random clocks.
  async function history(seed: number) {
    const random = seeded(seed);
    const { a, b } = await server();
    const c = await member(a.ledger.workspaceId, await signer());
    await a.api.plugin("channels").insert("channels_workspace", { name: "S", short: "", color: "", icon: "" });
    for (const other of [b, c]) await exchange(a.ledger, other.ledger);
    const [serverRow] = await a.api.plugin("channels").read("channels_workspace");
    const people = [a, b, c];
    const forged = [];
    for (let round = 0; round < 30; round++) {
      for (const m of people) {
        for (let k = 0; k < 7; k++) {
          const tasks = m.ledger.select("tasks", "tasks_tasks", {});
          const pick = tasks[Math.floor(random() * tasks.length)];
          const r = random();
          if (!pick || r < 0.4) await m.api.plugin("tasks").call("add-task", { channel_id: 1, title: `t${round}.${k}` });
          else if (r < 0.85) m.backend.data("tasks").update("tasks_tasks", { title: `${m.who.author.slice(0, 4)} ${round}.${k}` }, { id: pick.id });
          else m.backend.data("tasks").delete("tasks_tasks", { id: pick.id });
        }
      }
      if (round % 5 === 2) {
        forged.push(await signCommit({
          server: b.ledger.workspaceId, author: b.who.author, key: b.who.key, replica: crypto.randomUUID(), seq: 0,
          clock: Math.floor(random() * 400), time: Date.now(), action: "channels.update",
          ops: [{ ext: "channels", table: "channels_workspace", kind: "update", id: serverRow.id, values: { name: `forged ${round}` } }],
        }, b.who.privateKey));
      }
      const [x, y] = [people[Math.floor(random() * 3)], people[Math.floor(random() * 3)]];
      if (x !== y) await exchange(x.ledger, y.ledger);
    }
    for (const x of people) for (const y of people) if (x !== y) await exchange(x.ledger, y.ledger);
    await a.ledger.flush();
    const all = [...a.ledger.missing({}), ...forged].map((x) => JSON.parse(JSON.stringify(x)));
    return { workspaceId: a.ledger.workspaceId, all, random };
  }

  it("ends with the same tables and rejections as a full replay, whatever the arrival order", async () => {
    for (const seed of [1, 2, 3]) {
      const { workspaceId, all, random } = await history(seed);
      expect(all.length).toBeGreaterThan(600);
      const reference = await member(workspaceId, await signer());
      await reference.ledger.receive(all);

      // In random batches and orders, some at the same time (they replay together).
      const shuffled = [...all].sort(() => random() - 0.5);
      const test = await member(workspaceId, await signer());
      for (let i = 0; i < shuffled.length;) {
        const n = 1 + Math.floor(random() * 40);
        const batch = shuffled.slice(i, i + n);
        i += n;
        if (random() < 0.3) await Promise.all([test.ledger.receive(batch.slice(0, n / 2)), test.ledger.receive(batch.slice(n / 2))]);
        else await test.ledger.receive(batch);
      }
      expect(tables(test.ledger)).toEqual(tables(reference.ledger));
      const rejected = (l: Ledger) => l.log().filter((e) => e.rejected).map((e) => e.commit.hash).sort();
      expect(rejected(test.ledger)).toEqual(rejected(reference.ledger));
      expect(rejected(test.ledger).length).toBeGreaterThan(0);
    }
  }, 120_000);

  it("replays a late commit from the closest checkpoint, not from the start", async () => {
    const { workspaceId, all } = await history(4);
    const sorted = (await (async () => {
      const r = await member(workspaceId, await signer());
      await r.ledger.receive(all);
      return r.ledger.log().map((e) => e.commit);
    })()).map((x) => JSON.parse(JSON.stringify(x)));
    const late = sorted[sorted.length - 40];
    const test = await member(workspaceId, await signer());
    await test.ledger.receive(sorted.filter((c) => c !== late));
    const applied = vi.spyOn(Ledger.prototype as unknown as { applyCommit: () => void }, "applyCommit");
    await test.ledger.receive([late]);
    // From the checkpoint at or before it: under 300 commits applied again, not all of them.
    expect(applied.mock.calls.length).toBeLessThan(300);
    expect(applied.mock.calls.length).toBeGreaterThan(39);
    applied.mockRestore();
  }, 60_000);
});

// Two devices can draw the same row id: `newRowId` is the millisecond times 2048 plus a random part, so two members
// writing in the same millisecond clash once in 2048. The ledger refuses the second insert of an id on every member,
// which silently lost a message in mesh-test s3 and s8 (bursts of posts from many members at once).
describe("row ids two members drew at once", () => {
  // A message by `ledger`'s member under a chosen id, shaped like `template` (another message's row).
  function writeMessage(ledger: Ledger, id: number, template: Record<string, unknown>, body: string) {
    const { id: _, ...values } = template;
    ledger.transact("chat.post-message", () => ledger.write({
      ext: "chat", table: "chat_messages", kind: "insert", id, values: { ...values, author_id: ledger.me, body } as never,
    }));
  }
  const bodies = (ledger: Ledger) => ledger.select("chat", "chat_messages", {}).map((m) => m.body).sort();
  const ids = (ledger: Ledger) => ledger.select("chat", "chat_messages", {}).map((m) => m.id);

  async function clashed() {
    const owner = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(owner);
    const stores = { a: memoryCommits(), b: memoryCommits() };
    const a = await member(workspaceId, owner, stores.a);
    await a.ledger.adopt(genesis);
    const b = await member(workspaceId, await signer(), stores.b);
    await exchange(a.ledger, b.ledger);
    // b posts; a, not knowing yet, writes its own message under the same id.
    const { id } = await b.api.plugin("chat").call<{ id: number }>("post-message", { channel_id: 1, body: "from b" });
    writeMessage(a.ledger, id, b.ledger.select("chat", "chat_messages", { id })[0], "from a");
    for (let i = 0; i < 3; i++) {
      await exchange(a.ledger, b.ledger);
      await exchange(b.ledger, a.ledger);
    }
    return { workspaceId, a, b, stores, id };
  }

  it("writes a message again under a new id when another member's took its id first, so neither is lost", async () => {
    const { a, b, id } = await clashed();
    expect(bodies(a.ledger)).toEqual(["from a", "from b"]);
    expect(bodies(b.ledger)).toEqual(["from a", "from b"]);
    expect(ids(b.ledger)).toEqual(ids(a.ledger));
    // The new id stays in the same millisecond, so the message keeps its place in creation order.
    const moved = ids(a.ledger).find((other) => other !== id)!;
    expect(Math.floor(moved / 2048)).toBe(Math.floor(id / 2048));
  });

  it("doesn't write it a third time when the app starts again", async () => {
    const { workspaceId, a, b, stores } = await clashed();
    const commits = { a: a.ledger.log().length, b: b.ledger.log().length };
    const a2 = await member(workspaceId, a.who, stores.a);
    const b2 = await member(workspaceId, b.who, stores.b);
    expect(bodies(a2.ledger)).toEqual(["from a", "from b"]);
    expect(bodies(b2.ledger)).toEqual(["from a", "from b"]);
    expect({ a: a2.ledger.log().length, b: b2.ledger.log().length }).toEqual(commits);
  });

  it("draws another id when the one it drew is already taken by a message that arrived", async () => {
    const { a, b } = await server();
    await exchange(a.ledger, b.ledger);
    const { id: first } = await a.api.plugin("chat").call<{ id: number }>("post-message", { channel_id: 1, body: "first" });
    // A moment from now, so this device's own ids are all below it.
    const now = Date.now() + 60_000;
    const taken = now * 2048 + 7;
    writeMessage(a.ledger, taken, a.ledger.select("chat", "chat_messages", { id: first })[0], "from a");
    await exchange(a.ledger, b.ledger);
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.spyOn(Math, "random").mockReturnValue(7 / 2048);
    try {
      const { id } = await b.api.plugin("chat").call<{ id: number }>("post-message", { channel_id: 1, body: "from b" });
      expect(id).not.toBe(taken);
    } finally {
      vi.restoreAllMocks();
    }
    expect(bodies(b.ledger)).toEqual(["first", "from a", "from b"]);
  });
});
