import { afterEach, describe, expect, it, vi } from "vitest";
import type { Room } from "trystero";
import { ApiClient, type PluginClient } from "../../src/api/client";
import { createIdentity } from "../../src/core/identity";
import { chat } from "../../src/system/chat";
import { members } from "../../src/system/members";
import { MockTransport } from "../../src/mock/transport";
import { memoryCommits } from "../../src/p2p/commits";
import { Ledger, createLedgerBackend, type Signer, type SnapshotLoader, type StoredCheckpoint } from "../../src/p2p/ledger";
import { WorkspaceSync, gridCell } from "../../src/p2p/sync";
import { logVersion, wire } from "../../src/p2p/log";
import { workspacePolicy } from "../../src/p2p/policy";
import { Network } from "./fakeNetwork";
import { signedSnapshot } from "./signedSnapshot";
import { inviteTokenKey, newInviteToken } from "../../src/p2p/invite";

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

async function signer(): Promise<Signer> {
  const identity = await createIdentity(false);
  return { author: identity.id, key: { x: identity.publicKey.x!, y: identity.publicKey.y! }, privateKey: identity.privateKey, replica: crypto.randomUUID() };
}

async function open(workspaceId: string, who: Signer, loadSnapshot?: SnapshotLoader) {
  const ledger = new Ledger(workspaceId, who, workspacePolicy, memoryCommits(), loadSnapshot);
  const backend = createLedgerBackend(ledger);
  backend.load(chat);
  backend.load(members);
  await ledger.load();
  const api = new ApiClient(new MockTransport(backend));
  return { ledger, api, chat: api.plugin("chat") };
}

describe("ledger sync between tabs", () => {
  it("brings a new member up to date and then passes on live changes", async () => {
    const owner = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(owner);
    const a = await open(workspaceId, owner);
    await a.ledger.adopt(genesis);
    await a.chat.call("post-message", { channel_id: 1, body: "before" });
    const syncA = new WorkspaceSync(a.ledger, workspaceId, "secret", { network: false });
    await settle();

    const b = await open(workspaceId, await signer());
    const ready = b.ledger.ready();
    const syncB = new WorkspaceSync(b.ledger, workspaceId, "secret", { network: false });
    await ready;
    await settle();
    expect((await b.chat.read("chat_messages")).map((m) => m.body)).toEqual(["before"]);

    await b.chat.call("post-message", { channel_id: 1, body: "live" });
    await settle();
    expect((await a.chat.read("chat_messages")).map((m) => m.body)).toEqual(["before", "live"]);
    syncA.close();
    syncB.close();
  });

});

describe("ledger sync between members", () => {
  let syncs: WorkspaceSync[] = [];
  afterEach(() => {
    syncs.forEach((s) => s.close());
    syncs = [];
  });

  // A member on the fake network (no tab channel, so only the network carries commits).
  async function member(network: Network, id: string, workspaceId: string, who: Signer,
    options: { stallMs?: number; onIncompatible?: (peer: string) => void } = {}) {
    const m = await open(workspaceId, who);
    const sync = new WorkspaceSync(m.ledger, workspaceId, "secret", { room: network.room(id) as unknown as Room, self: id, tabs: false, ...options });
    syncs.push(sync);
    return m;
  }

  async function serverOf(network: Network, options: { stallMs?: number; onIncompatible?: (peer: string) => void } = {}) {
    const owner = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(owner);
    const a = await member(network, "a", workspaceId, owner, options);
    await a.ledger.adopt(genesis);
    return { workspaceId, a };
  }

  it("refuses history sync with a peer on the old log protocol", async () => {
    const network = new Network();
    const incompatible: string[] = [];
    const { workspaceId, a } = await serverOf(network, { onIncompatible: (peer) => incompatible.push(peer) });
    await a.chat.call("post-message", { channel_id: 1, body: "before" });
    await a.ledger.flush();
    const b = await member(network, "b", workspaceId, await signer());
    network.link("a", "b");
    await settle();
    expect((await b.chat.read("chat_messages")).map((m) => m.body)).toEqual(["before"]);

    await network.rooms.get("b")!.actions.get("hello")!.send({ vector: {}, reply: false }, { target: "a" });
    await settle();
    expect(incompatible).toEqual(["b"]);
    await a.chat.call("post-message", { channel_id: 1, body: "after" });
    await settle();
    expect((await b.chat.read("chat_messages")).map((m) => m.body)).toEqual(["before"]);
  });

  it("gets the whole history when the snapshot it was sent can't be used here", async () => {
    const network = new Network();
    const owner = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(owner);
    const a = await open(workspaceId, owner);
    await a.ledger.adopt(genesis);
    await a.chat.call("post-message", { channel_id: 1, body: "before snapshot" });
    const state = await a.ledger.snapshotState();
    const snapshot = await signedSnapshot(a.ledger, owner, state);
    await a.ledger.accept([snapshot], async () => state);
    await a.chat.call("post-message", { channel_id: 1, body: "after snapshot" });
    await a.ledger.flush();
    syncs.push(new WorkspaceSync(a.ledger, workspaceId, "secret", { room: network.room("a") as unknown as Room, self: "a", tabs: false }));

    // The joiner gets the state, but it holds a table this app doesn't have (another app version): refused.
    const unusable = { ...state, tables: [...state.tables, ["unknown/unknown_rows", []]] } as StoredCheckpoint;
    const b = await open(workspaceId, await signer(), async () => unusable);
    syncs.push(new WorkspaceSync(b.ledger, workspaceId, "secret", {
      room: network.room("b") as unknown as Room, self: "b", tabs: false, ensureContent: async () => true,
    }));
    network.link("a", "b");
    for (let i = 0; i < 40 && b.ledger.log().length < a.ledger.log().length; i++) await settle();
    expect(b.ledger.log()).toHaveLength(a.ledger.log().length);
    expect((await b.chat.read("chat_messages")).map((m) => m.body)).toEqual(["before snapshot", "after snapshot"]);
  });

  it("takes up the snapshot once its state arrives, when the whole history is nowhere", async () => {
    const network = new Network();
    const owner = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(owner);
    const a = await open(workspaceId, owner);
    await a.ledger.adopt(genesis);
    await a.chat.call("post-message", { channel_id: 1, body: "before snapshot" });
    const state = await a.ledger.snapshotState();
    const snapshot = await signedSnapshot(a.ledger, owner, state);
    await a.ledger.accept([snapshot], async () => state);
    // Its maker keeps only what is after the snapshot, so nobody can send the whole history.
    await a.ledger.compactSnapshot();
    syncs.push(new WorkspaceSync(a.ledger, workspaceId, "secret", { room: network.room("a") as unknown as Room, self: "a", tabs: false }));

    // The state can't be fetched when the joiner gets the snapshot, only a moment later.
    let here = false;
    const b = await open(workspaceId, await signer(), async () => (here ? state : null));
    syncs.push(new WorkspaceSync(b.ledger, workspaceId, "secret", {
      room: network.room("b") as unknown as Room, self: "b", tabs: false, ensureContent: async () => here, snapshotRetryMs: 100,
    }));
    network.link("a", "b");
    await settle();
    expect(await b.chat.read("chat_messages")).toEqual([]);
    here = true;
    for (let i = 0; i < 20 && (await b.chat.read("chat_messages")).length === 0; i++) await settle();
    expect((await b.chat.read("chat_messages")).map((m) => m.body)).toEqual(["before snapshot"]);
    expect(b.ledger.snapshotForBootstrap()?.commit.hash).toBe(snapshot.hash);
  });

  it("sends a new member what it lacks once when they connect", async () => {
    const network = new Network();
    const { workspaceId, a } = await serverOf(network);
    await a.chat.call("post-message", { channel_id: 1, body: "before" });
    await a.ledger.flush();
    const b = await member(network, "b", workspaceId, await signer());
    network.link("a", "b");
    await settle();
    expect((await b.chat.read("chat_messages")).map((m) => m.body)).toEqual(["before"]);
    expect(network.count("a", "b", "commits")).toBe(1);
  });

  it("moves a valid old-code invitee from a recovery room to the current secret", async () => {
    const network = new Network();
    const owner = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(owner);
    const host = await open(workspaceId, owner);
    await host.ledger.adopt(genesis);
    const token = newInviteToken();
    await host.api.plugin("members").call("create-invite", {
      token, sealed_token: JSON.stringify({
        v: 1, id: crypto.randomUUID(), from: owner.author, to: owner.author, at: Date.now(), iv: "iv", data: "data",
      }),
      label: "Existing invite", expires_at: null, max_uses: null,
    });
    const hostSync = new WorkspaceSync(host.ledger, workspaceId, "current-room-secret", {
      tabs: false, self: "host", recoverySecrets: ["old-room-secret"],
      peerAuth: { localAccess: "member" },
      joinRoom: (roomId) => network.join("host", roomId, false) as unknown as Room,
    });
    syncs.push(hostSync);

    const guest = await open(workspaceId, await signer());
    const guestSync = new WorkspaceSync(guest.ledger, workspaceId, "old-room-secret", {
      tabs: false, self: "guest",
      peerAuth: { localAccess: "invite", inviteToken: token },
      joinRoom: (roomId) => network.join("guest", roomId, false) as unknown as Room,
    });
    syncs.push(guestSync);
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect(guestSync.activeSecret()).toBe("current-room-secret");
    expect(guest.ledger.select("members", "members_invites", {})).toHaveLength(1);
    await guest.api.plugin("members").call("set-profile", {
      display_name: "Guest", color: "", invite_token: token,
    });
    await settle();
    expect(host.ledger.select("members", "members_profiles", { user_id: guest.ledger.me })).toHaveLength(1);
  });

  it("admits an invitee it meets in the member room (no node online)", async () => {
    const network = new Network();
    const owner = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(owner);
    const host = await open(workspaceId, owner);
    await host.ledger.adopt(genesis);
    await host.chat.call("post-message", { channel_id: 1, body: "hello" });
    const token = newInviteToken();
    await host.api.plugin("members").call("create-invite", {
      token, sealed_token: JSON.stringify({
        v: 1, id: crypto.randomUUID(), from: owner.author, to: owner.author, at: Date.now(), iv: "iv", data: "data",
      }),
      label: "Invite", expires_at: null, max_uses: null,
    });
    // Rooms as the app joins them: members passive in the hub, so these two can only meet in the member room
    // (the host active there, with data and no node; the guest passive, with nothing yet).
    const hostSync = new WorkspaceSync(host.ledger, workspaceId, "member-room-secret", {
      tabs: false, self: "room-host", peerAuth: { localAccess: "member" },
      joinRoom: (roomId, passive) => network.join("room-host", roomId, passive) as unknown as Room,
    });
    syncs.push(hostSync);
    const guest = await open(workspaceId, await signer());
    syncs.push(new WorkspaceSync(guest.ledger, workspaceId, "member-room-secret", {
      tabs: false, self: "room-guest", peerAuth: { localAccess: "invite", inviteToken: token },
      joinRoom: (roomId, passive) => network.join("room-guest", roomId, passive) as unknown as Room,
    }));
    for (let i = 0; i < 20 && guest.ledger.owner === null; i++) await settle();
    expect(hostSync.inMemberRoom()).toBe(true);
    expect((await guest.chat.read("chat_messages")).map((m) => m.body)).toEqual(["hello"]);
  });

  // Every member and node rotates at the same moment: leaving the old hub and joining it again as a recovery room
  // made them all rejoin one Trystero room together, which races (vendor/trystero-core/README.md) and failed
  // handshakes with "incorrect password for overlapping room".
  it.each(["member", "node"] as const)("keeps a %s's old hub as its recovery room when the room secret changes", async (role) => {
    const network = new Network();
    const owner = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(owner);
    const host = await open(workspaceId, owner);
    await host.ledger.adopt(genesis);
    const joins: string[] = [];
    const leaves: string[] = [];
    const sync = new WorkspaceSync(host.ledger, workspaceId, "first-room-secret", {
      tabs: false, self: `rotating-${role}`, role,
      joinRoom: (roomId, passive) => {
        joins.push(roomId);
        const room = network.join(`rotating-${role}`, roomId, passive);
        const leave = room.leave.bind(room);
        room.leave = () => {
          leaves.push(roomId);
          return leave();
        };
        return room as unknown as Room;
      },
    });
    syncs.push(sync);
    await settle();
    const hubs = () => joins.filter((id) => /:room:[^:]+$/.test(id));
    const [oldHub] = hubs();

    await sync.rotateSecret("second-room-secret");
    await settle();

    expect(leaves).not.toContain(oldHub);
    expect(hubs()).toHaveLength(2);

    // Two members handing a joiner the same secret at once: the second one changes nothing.
    await Promise.all([sync.rotateSecret("third-room-secret"), sync.rotateSecret("third-room-secret")]);
    await settle();
    expect(hubs()).toHaveLength(3);
    expect(leaves.filter((id) => /:room:[^:]+$/.test(id))).toEqual([]);
  });

  // Peers changing rooms on the same event (a commit, the online count) left and joined the same room again within
  // milliseconds of each other, a race inside Trystero (vendor/trystero-core/README.md; mesh-test s2: most of the
  // "incorrect password for overlapping room" left after the Trystero fixes).
  it("waits a moment before joining a room it just left again", async () => {
    const network = new Network();
    const owner = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(owner);
    const host = await open(workspaceId, owner);
    await host.ledger.adopt(genesis);
    const events: { at: number; what: "join" | "leave"; id: string; passive: boolean }[] = [];
    const sync = new WorkspaceSync(host.ledger, workspaceId, "room-secret", {
      tabs: false, self: "lonely", lonelyMs: 100, fallbackAfterMs: 100, hubAfterMs: 100, rejoinDelayMs: () => 400,
      joinRoom: (roomId, passive) => {
        events.push({ at: performance.now(), what: "join", id: roomId, passive });
        const room = network.join("lonely", roomId, passive);
        const leave = room.leave.bind(room);
        room.leave = () => {
          events.push({ at: performance.now(), what: "leave", id: roomId, passive });
          return leave();
        };
        return room as unknown as Room;
      },
    });
    syncs.push(sync);
    // Alone for `lonelyMs`, its hub turns active: left passive, joined again active.
    const hub = (e: { id: string }) => /:room:[^:]+$/.test(e.id);
    await expect.poll(() => events.some((e) => hub(e) && e.what === "join" && !e.passive), { timeout: 3_000 }).toBe(true);
    const left = events.find((e) => hub(e) && e.what === "leave")!;
    const joined = events.find((e) => hub(e) && e.what === "join" && !e.passive)!;
    expect(joined.at - left.at).toBeGreaterThanOrEqual(390);
  });

  it("stays connected through the kept room to a member that missed the change, and sees it leave", async () => {
    const network = new Network();
    const owner = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(owner);
    const node = await open(workspaceId, owner);
    await node.ledger.adopt(genesis);
    const nodeSync = new WorkspaceSync(node.ledger, workspaceId, "first-room-secret", {
      tabs: false, self: "kept-node", role: "node",
      joinRoom: (roomId, passive) => network.join("kept-node", roomId, passive) as unknown as Room,
    });
    syncs.push(nodeSync);
    const away = await open(workspaceId, await signer());
    const awaySync = new WorkspaceSync(away.ledger, workspaceId, "first-room-secret", {
      tabs: false, self: "kept-away",
      joinRoom: (roomId, passive) => network.join("kept-away", roomId, passive) as unknown as Room,
    });
    await expect.poll(() => nodeSync.mesh!.directPeers()).toContain("kept-away");

    await nodeSync.rotateSecret("second-room-secret");
    await settle();
    expect(nodeSync.mesh!.directPeers()).toContain("kept-away");

    awaySync.close();
    await expect.poll(() => nodeSync.mesh!.directPeers()).not.toContain("kept-away");
  });

  it("stops sending commits to a kicked member after rotating the room secret", async () => {
    const network = new Network();
    const owner = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(owner);
    const host = await open(workspaceId, owner);
    await host.ledger.adopt(genesis);
    const guest = await open(workspaceId, await signer());
    const token = newInviteToken();
    await host.api.plugin("members").call("create-invite", {
      token, sealed_token: JSON.stringify({
        v: 1, id: crypto.randomUUID(), from: owner.author, to: owner.author, at: Date.now(), iv: "iv", data: "data",
      }),
      label: "One use", expires_at: null, max_uses: 1,
    });
    const hostSync = new WorkspaceSync(host.ledger, workspaceId, "current-room-secret", {
      tabs: false, self: "kick-host", recoverySecrets: ["old-room-secret"], peerAuth: { localAccess: "member" },
      joinRoom: (roomId) => network.join("kick-host", roomId, false) as unknown as Room,
    });
    syncs.push(hostSync);
    const guestSync = new WorkspaceSync(guest.ledger, workspaceId, "old-room-secret", {
      tabs: false, self: "kick-guest", peerAuth: { localAccess: "invite", inviteToken: token },
      joinRoom: (roomId) => network.join("kick-guest", roomId, false) as unknown as Room,
    });
    syncs.push(guestSync);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(guest.ledger.owner).not.toBeNull();
    await guest.api.plugin("members").call("set-profile", {
      display_name: "Guest", color: "", invite_token: token,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    await host.api.plugin("members").call("kick", { user_id: guest.ledger.me });
    await hostSync.rotateSecret("rotated-room-secret");
    await host.chat.call("post-message", { channel_id: 1, body: "after kick" });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(await guest.chat.read("chat_messages")).toHaveLength(0);
  });

  it.each(["expired", "revoked", "used-up"] as const)("does not send history to an %s invite", async (state) => {
    const network = new Network();
    const owner = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(owner);
    const host = await open(workspaceId, owner);
    await host.ledger.adopt(genesis);
    const token = newInviteToken();
    const sealedToken = JSON.stringify({
      v: 1, id: crypto.randomUUID(), from: owner.author, to: owner.author, at: Date.now(), iv: "iv", data: "data",
    });
    const id = state === "expired"
      ? await host.api.plugin("members").insert("members_invites", {
        token_key: inviteTokenKey(token), sealed_token: sealedToken, label: "Temporary", created_by: host.ledger.me,
        created_at: new Date().toISOString(), expires_at: new Date(Date.now() - 1_000).toISOString(),
        max_uses: null, uses: 0, revoked: false,
      })
      : (await host.api.plugin("members").call<{ id: number }>("create-invite", {
        token, sealed_token: sealedToken, label: "Temporary", expires_at: null,
        max_uses: state === "used-up" ? 1 : null,
      })).id;
    if (state === "revoked") await host.api.plugin("members").call("revoke-invite", { id });
    if (state === "used-up")
      await host.api.plugin("members").call("set-profile", { display_name: "Owner", color: "", invite_token: token });
    // A real-length secret (16+ characters): a shorter one fails the handoff whatever the invite, and the test with it.
    const hostSync = new WorkspaceSync(host.ledger, workspaceId, "workspace-room-secret", {
      tabs: false, self: `host-${state}`, peerAuth: { localAccess: "member" },
      joinRoom: (roomId) => network.join(`host-${state}`, roomId, false) as unknown as Room,
    });
    syncs.push(hostSync);
    const guest = await open(workspaceId, await signer());
    const guestSync = new WorkspaceSync(guest.ledger, workspaceId, "workspace-room-secret", {
      tabs: false, self: `guest-${state}`, peerAuth: { localAccess: "invite", inviteToken: token },
      joinRoom: (roomId) => network.join(`guest-${state}`, roomId, false) as unknown as Room,
    });
    syncs.push(guestSync);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(host.ledger.log().length).toBeGreaterThan(0);
    expect(guest.ledger.owner).toBeNull();
    expect(guest.ledger.log()).toHaveLength(0);
  });

  it("passes a new commit on only to members the sender doesn't reach itself", async () => {
    const network = new Network();
    const { workspaceId, a } = await serverOf(network);
    const b = await member(network, "b", workspaceId, await signer());
    const c = await member(network, "c", workspaceId, await signer());
    const d = await member(network, "d", workspaceId, await signer());
    // A, B and C all reach each other; D only reaches C.
    network.link("a", "b");
    network.link("a", "c");
    network.link("b", "c");
    network.link("c", "d");
    // Changes to whom each one reaches go out in batches every second (mesh.ts).
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const before = (from: string, to: string) => network.count(from, to, "commits");
    const counts = { bc: before("b", "c"), cb: before("c", "b"), cd: before("c", "d"), bd: before("b", "d") };

    await a.chat.call("post-message", { channel_id: 1, body: "news" });
    await settle();
    for (const m of [b, c, d]) expect((await m.chat.read("chat_messages")).map((x) => x.body)).toEqual(["news"]);
    // B and C got it from A directly: neither sends it to the other. C passes it to D, whom A doesn't reach.
    expect(before("b", "c") - counts.bc).toBe(0);
    expect(before("c", "b") - counts.cb).toBe(0);
    expect(before("c", "d") - counts.cd).toBe(1);
  });

  // A far behind (402 commits = 3 batches) and A's commit sends slow, counting how many to B are in flight at once.
  async function slowCatchUp() {
    const network = new Network();
    const { workspaceId, a } = await serverOf(network);
    for (let i = 0; i < 401; i++) await a.chat.call("post-message", { channel_id: 1, body: `m${i}` });
    await a.ledger.flush();
    const b = await member(network, "b", workspaceId, await signer());
    const action = network.rooms.get("a")!.actions.get("commits")!;
    const real = action.send;
    const flight = { now: 0, most: 0 };
    action.send = async (data, options) => {
      flight.now++;
      flight.most = Math.max(flight.most, flight.now);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await real(data, options);
      flight.now--;
    };
    return { network, b, flight };
  }

  async function messagesOf(m: { chat: { read(table: string): Promise<unknown[]> } }, count: number) {
    for (let i = 0; i < 100 && (await m.chat.read("chat_messages")).length < count; i++) await settle();
    return (await m.chat.read("chat_messages")).length;
  }

  it("sends a catch-up to a member one batch at a time", async () => {
    const { network, b, flight } = await slowCatchUp();
    network.link("a", "b");
    expect(await messagesOf(b, 401)).toBe(401);
    expect(network.count("a", "b", "commits")).toBe(3);
    expect(flight.most).toBe(1);
  });

  it("doesn't send a catch-up twice when the member says hello again meanwhile", async () => {
    const { network, b, flight } = await slowCatchUp();
    network.link("a", "b");
    // Like B's 20 s re-hello arriving while A is still sending: B has nothing yet.
    void network.rooms.get("b")!.actions.get("hello")!.send({ protocol: logVersion, vector: {}, reply: false }, { target: "a" });
    expect(await messagesOf(b, 401)).toBe(401);
    expect(network.count("a", "b", "commits")).toBe(3);
    expect(flight.most).toBe(1);
  });

  // A, B and C hold a history of 3 batches; D joins and connects to all three at once.
  async function threeHolders() {
    const network = new Network();
    const { workspaceId, a } = await serverOf(network);
    for (let i = 0; i < 401; i++) await a.chat.call("post-message", { channel_id: 1, body: `m${i}` });
    await a.ledger.flush();
    await member(network, "b", workspaceId, await signer());
    await member(network, "c", workspaceId, await signer());
    network.link("a", "b");
    network.link("a", "c");
    network.link("b", "c");
    for (let i = 0; i < 50 && network.count("a", "c", "commits") + network.count("b", "c", "commits") < 3; i++) await settle();
    await settle();
    return { network, workspaceId };
  }

  const sentTo = (network: Network, to: string) => ["a", "b", "c"].reduce((n, from) => n + network.count(from, to, "commits"), 0);

  it("gets a joiner's history from one member, not from every member it reaches", async () => {
    const { network, workspaceId } = await threeHolders();
    // A source never counts as stalled here: on a loaded machine (the whole suite, mesh-test containers) a slow catch-up
    // made it ask a second member, and the count below came out higher though nothing was wrong.
    const d = await member(network, "d", workspaceId, await signer(), { stallMs: 60_000 });
    network.link("a", "d");
    network.link("b", "d");
    network.link("c", "d");
    for (let i = 0; i < 200 && (await d.chat.read("chat_messages")).length < 401; i++) await settle();
    expect(await d.chat.read("chat_messages")).toHaveLength(401);
    // 3 batches from its source; before, each of the three sent all of them (9).
    expect(sentTo(network, "d")).toBe(3);
  });

  it("asks the next member when its source stops sending", async () => {
    const { network, workspaceId } = await threeHolders();
    const d = await member(network, "d", workspaceId, await signer(), { stallMs: 300 });
    // A takes the request but never delivers.
    network.rooms.get("a")!.actions.get("commits")!.send = () => new Promise(() => {});
    network.link("a", "d");
    network.link("b", "d");
    network.link("c", "d");
    for (let i = 0; i < 50 && (await d.chat.read("chat_messages")).length < 401; i++) await settle();
    expect(await d.chat.read("chat_messages")).toHaveLength(401);
  });

  it("still answers a hello from an app without sources (no ask field)", async () => {
    const { network } = await threeHolders();
    const before = network.count("a", "b", "commits");
    // B's sync is replaced by an old-style hello: everything since nothing.
    await network.rooms.get("b")!.actions.get("hello")!.send({ protocol: logVersion, vector: {}, reply: false }, { target: "a" });
    for (let i = 0; i < 20 && network.count("a", "b", "commits") - before < 3; i++) await settle();
    expect(network.count("a", "b", "commits") - before).toBe(3);
  });

  it("switches to a member that has more when its first source has nothing yet", async () => {
    const { network, workspaceId } = await threeHolders();
    const e = await member(network, "e", workspaceId, await signer());
    const d = await member(network, "d", workspaceId, await signer());
    network.link("d", "e");
    network.link("a", "d");
    network.link("b", "d");
    for (let i = 0; i < 50 && (await d.chat.read("chat_messages")).length < 401; i++) await settle();
    expect(await d.chat.read("chat_messages")).toHaveLength(401);
    // A became the source once its hello showed it has everything; B was asked only for what A lacks (nothing).
    expect(network.count("a", "d", "commits") + network.count("b", "d", "commits")).toBe(3);
    void e;
  });

  it("keeps going when sends to a member fail, and catches up later", async () => {
    const network = new Network();
    const { workspaceId, a } = await serverOf(network);
    await a.chat.call("post-message", { channel_id: 1, body: "before" });
    await a.ledger.flush();
    const b = await member(network, "b", workspaceId, await signer());
    // Like Trystero when the member stops taking data: every send of A's rejects (unhandled, it fails the run).
    const actions = network.rooms.get("a")!.actions;
    const working = new Map([...actions].map(([name, action]) => [name, action.send]));
    for (const action of actions.values()) action.send = () => Promise.reject(new Error("Trystero: data channel stopped draining"));
    network.link("a", "b");
    await settle();
    expect(await b.chat.read("chat_messages")).toEqual([]);

    for (const [name, action] of actions) action.send = working.get(name)!;
    network.unlink("a", "b");
    network.link("a", "b");
    await settle();
    expect((await b.chat.read("chat_messages")).map((m) => m.body)).toEqual(["before"]);
  });
});

// Getting into a workspace with rooms joined as the app joins them (members passive in the hub and in old-secret
// rooms, nodes active): the modes where a valid invite or a member used to stay outside for good.
describe("admission", () => {
  let syncs: WorkspaceSync[] = [];
  afterEach(() => {
    syncs.forEach((s) => s.close());
    syncs = [];
  });
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (check: () => boolean, ms = 5_000) => {
    for (const end = Date.now() + ms; !check() && Date.now() < end;) await wait(25);
    return check();
  };
  const sealed = (author: string) => JSON.stringify({ v: 1, id: crypto.randomUUID(), from: author, to: author, at: Date.now(), iv: "iv", data: "data" });

  // A peer on the fake network: every room joined under its own id (the room secret is part of the id), passive as asked.
  function start(network: Network, id: string, m: { ledger: Ledger }, workspaceId: string, secret: string,
    options: { role?: "member" | "node"; recoverySecrets?: string[]; inviteToken?: string; member?: boolean; nodes?: (peer: string) => boolean } = {}) {
    const sync = new WorkspaceSync(m.ledger, workspaceId, secret, {
      tabs: false, self: id, role: options.role, recoverySecrets: options.recoverySecrets, lonelyMs: 300, fallbackAfterMs: 150, hubAfterMs: 150,
      rejoinDelayMs: () => 20,
      peerAuth: { localAccess: options.member === false ? "invite" : "member", ...(options.inviteToken ? { inviteToken: options.inviteToken } : {}) },
      joinRoom: (roomId, passive) => network.join(id, roomId, passive) as unknown as Room,
    });
    if (options.nodes) sync.setNodes({ known: () => true, isNode: options.nodes });
    syncs.push(sync);
    return sync;
  }

  async function workspace() {
    const owner = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(owner);
    const host = await open(workspaceId, owner);
    await host.ledger.adopt(genesis);
    await host.chat.call("post-message", { channel_id: 1, body: "hello" });
    return { workspaceId, host, owner };
  }

  // A member who joined before any invite existed (no invite needed then), synced by hand.
  async function memberOf(workspaceId: string, host: Awaited<ReturnType<typeof open>>, name: string) {
    const m = await open(workspaceId, await signer());
    const copy = async (from: { ledger: Ledger }, to: { ledger: Ledger }) => {
      await from.ledger.flush();
      await to.ledger.receive(from.ledger.missing(to.ledger.vector()));
    };
    await copy(host, m);
    await m.api.plugin("members").call("set-profile", { display_name: name, color: "" });
    await copy(m, host);
    return { ...m, update: () => copy(host, m) };
  }

  it("retries a lost authentication challenge on a connection that stays open", async () => {
    const network = new Network();
    const { workspaceId, host } = await workspace();
    const away = await memberOf(workspaceId, host, "Away");
    const hostRoom = network.room("host");
    const awayRoom = network.room("away");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const hostSync = new WorkspaceSync(host.ledger, workspaceId, "secret", {
        room: hostRoom as unknown as Room, tabs: false, self: "host", peerAuth: { localAccess: "member" },
      });
      const awaySync = new WorkspaceSync(away.ledger, workspaceId, "secret", {
        room: awayRoom as unknown as Room, tabs: false, self: "away", peerAuth: { localAccess: "member" },
      });
      syncs.push(hostSync, awaySync);
      const auth = awayRoom.actions.get("peer-auth")!;
      const receive = auth.onMessage!;
      let dropped = false;
      auth.onMessage = (data, context) => {
        if (!dropped && (data as { kind: string }).kind === "challenge") { dropped = true; return; }
        return receive(data, context);
      };
      network.link("host", "away");
      await settle();
      expect(dropped).toBe(true);
      expect(hostSync.room!.isMember("away")).toBe(false);
      vi.advanceTimersByTime(5_000);
      await settle();
      expect(hostSync.room!.isMember("away")).toBe(true);
      expect(awaySync.room!.isMember("host")).toBe(true);
      expect(hostSync.room!.unauthenticatedPeers()).toEqual([]);
    } finally {
      syncs.forEach((sync) => sync.close());
      syncs = [];
      vi.useRealTimers();
    }
  });

  async function invite(m: Awaited<ReturnType<typeof open>>, author: string, values: { max_uses?: number } = {}) {
    const token = newInviteToken();
    await m.api.plugin("members").call("create-invite", { token, sealed_token: sealed(author), label: "Invite", expires_at: null, max_uses: values.max_uses ?? null });
    await m.ledger.flush();
    return token;
  }

  it("admits a code sent before the room secret changed, with no node online", async () => {
    const network = new Network();
    const { workspaceId, host, owner } = await workspace();
    const token = await invite(host, owner.author);
    // The host rotated its secret after the code went out (a kick, say): it sits passive in the old secret's room.
    start(network, "host", host, workspaceId, "current-room-secret", { recoverySecrets: ["old-room-secret"] });
    const guest = await open(workspaceId, await signer());
    const guestSync = start(network, "guest", guest, workspaceId, "old-room-secret", { inviteToken: token, member: false });
    expect(await until(() => guest.ledger.owner !== null, 3_000)).toBe(true);
    expect(await until(() => guestSync.activeSecret() === "current-room-secret")).toBe(true);
    expect((await guest.chat.read("chat_messages")).map((m) => m.body)).toEqual(["hello"]);
  });

  it("admits a code without a room secret: the joiner learns it in the invite's room", async () => {
    const network = new Network();
    const { workspaceId, host, owner } = await workspace();
    const token = await invite(host, owner.author);
    start(network, "host", host, workspaceId, "current-room-secret");
    const guest = await open(workspaceId, await signer());
    const guestSync = start(network, "guest", guest, workspaceId, "", { inviteToken: token, member: false });
    expect(await until(() => guestSync.activeSecret() === "current-room-secret", 3_000)).toBe(true);
    expect(await until(() => guest.ledger.owner !== null)).toBe(true);
    await guest.api.plugin("members").call("set-profile", { display_name: "Guest", color: "", invite_token: token });
    expect(await until(() => host.ledger.select("members", "members_profiles", { user_id: guest.ledger.me }).length === 1)).toBe(true);
  });

  it("lets a member who missed a secret change back in, with no node online", async () => {
    const network = new Network();
    const { workspaceId, host } = await workspace();
    const away = await memberOf(workspaceId, host, "Away");
    start(network, "host", host, workspaceId, "current-room-secret", { recoverySecrets: ["old-room-secret"] });
    start(network, "away", away, workspaceId, "old-room-secret");
    await host.chat.call("post-message", { channel_id: 1, body: "while you were away" });
    expect(await until(() => away.ledger.select("chat", "chat_messages", {}).some((m) => m.body === "while you were away"), 3_000)).toBe(true);
  });

  it("admits a joiner once the invite it proved reaches the member it met", async () => {
    const network = new Network();
    const { workspaceId, host, owner } = await workspace();
    const other = await memberOf(workspaceId, host, "Other");
    // The invite is made after `other` last synced: `other` meets the guest without knowing it.
    const token = await invite(host, owner.author);
    const room = (id: string, m: { ledger: Ledger }, peerAuth: { localAccess: "member" | "invite"; inviteToken?: string }) => {
      const sync = new WorkspaceSync(m.ledger, workspaceId, "workspace-room-secret", { room: network.room(id) as unknown as Room, self: id, tabs: false, peerAuth });
      syncs.push(sync);
    };
    const guest = await open(workspaceId, await signer());
    room("other", other, { localAccess: "member" });
    room("guest", guest, { localAccess: "invite", inviteToken: token });
    room("host", host, { localAccess: "member" });
    network.link("other", "guest");
    await wait(300);
    expect(guest.ledger.owner).toBeNull();
    network.link("host", "other");
    expect(await until(() => guest.ledger.owner !== null, 3_000)).toBe(true);
  });

  it("gets a joiner's profile to the node at once, not at the next hello", async () => {
    const network = new Network();
    const { workspaceId, host, owner } = await workspace();
    const node = await memberOf(workspaceId, host, "Node");
    const token = await invite(host, owner.author);
    await node.update();
    const isNode = (peer: string) => peer === "node";
    start(network, "node", node, workspaceId, "workspace-room-secret", { role: "node" });
    const guest = await open(workspaceId, await signer());
    start(network, "guest", guest, workspaceId, "workspace-room-secret", { inviteToken: token, member: false, nodes: isNode });
    expect(await until(() => guest.ledger.owner !== null, 3_000)).toBe(true);
    await wait(300);
    await guest.api.plugin("members").call("set-profile", { display_name: "Guest", color: "", invite_token: token });
    expect(await until(() => node.ledger.select("members", "members_profiles", { user_id: guest.ledger.me }).length === 1, 2_000)).toBe(true);
  });

  // A call's room is locked by the room secret like the others. After a change (a member removed, an invite revoked),
  // members who joined the call later were in the new secret's call room and those already there in the old one: no
  // direct connection between them, so no sound in a mesh call (mesh-test s13). Those in the call keep the old room
  // (left and joined again by everyone at once, Trystero's handshakes race) and join the new one too.
  it("keeps a call's members together across a room secret change, without them leaving the call's room", async () => {
    const network = new Network();
    const { workspaceId, host } = await workspace();
    const early = await memberOf(workspaceId, host, "Early");
    const late = await memberOf(workspaceId, host, "Late");
    const members = [["host", host], ["early", early], ["late", late]] as const;
    const synced = members.map(([id, m]) => start(network, id, m, workspaceId, "first-room-secret"));
    const [hostSync, earlySync, lateSync] = synced;
    const callRooms = () => [...network.rooms.values()].filter((r) => r.name.includes(":call:") && !r.left);
    // Who is linked to whom in the call's rooms, by room.
    const callLinks = () => new Set(callRooms().flatMap((r) => [...r.peers].map((p) => `${r.id}-${p}@${r.name}`)));
    hostSync.joinCall(7);
    earlySync.joinCall(7);
    expect(await until(() => callRooms().some((r) => r.id === "host" && r.peers.has("early")), 2_000)).toBe(true);
    const before = callRooms().filter((r) => r.id === "host" || r.id === "early");
    await Promise.all(synced.map((s) => s.rotateSecret("second-room-secret")));
    lateSync.joinCall(7);
    expect(await until(() => callRooms().some((r) => r.id === "late" && r.peers.has("host") && r.peers.has("early")), 2_000)).toBe(true);
    // The rooms they were in stay joined, with the same links.
    expect(before.every((r) => !r.left)).toBe(true);
    expect(callLinks()).toContain(`host-early@${before[0].name}`);
    // Leaving the call leaves every room of it.
    hostSync.joinCall(null);
    expect(await until(() => callRooms().every((r) => r.id !== "host"), 2_000)).toBe(true);
  }, 15_000);

  // A joiner meets the node in its invite's room as a joiner, when members' messages (mesh lists, relays, voice) don't
  // pass yet. Once its join lands it reaches the other members through the node at once: the node's list used to come
  // only with its 30 s timer, and everything relayed to the new member was dropped until then (mesh-test s13).
  it("lets a new member reach the others through the node as soon as its join lands", async () => {
    const network = new Network();
    const { workspaceId, host, owner } = await workspace();
    const node = await memberOf(workspaceId, host, "Node");
    const token = await invite(host, owner.author);
    await node.update();
    const isNode = (peer: string) => peer === "node";
    start(network, "node", node, workspaceId, "workspace-room-secret", { role: "node" });
    const hostSync = start(network, "host", host, workspaceId, "workspace-room-secret", { nodes: isNode });
    const guest = await open(workspaceId, await signer());
    const guestSync = start(network, "guest", guest, workspaceId, "workspace-room-secret", { inviteToken: token, member: false, nodes: isNode });
    const got: string[] = [];
    guestSync.mesh!.channel<string>("probe", (text, from) => got.push(`${from}: ${text}`));
    const probe = hostSync.mesh!.channel<string>("probe", () => {});
    expect(await until(() => guest.ledger.owner !== null, 3_000)).toBe(true);
    await guest.api.plugin("members").call("set-profile", { display_name: "Guest", color: "", invite_token: token });
    expect(await until(() => node.ledger.select("members", "members_profiles", { user_id: guest.ledger.me }).length === 1, 2_000)).toBe(true);
    // All of it within 2 s of the node having the join.
    const by = Date.now() + 2_000;
    expect(await until(() => guestSync.mesh!.relayOf("host") === "node", by - Date.now())).toBe(true);
    expect(await until(() => hostSync.mesh!.relayOf("guest") === "node", by - Date.now())).toBe(true);
    probe("hello", "guest");
    expect(await until(() => got.includes("host: hello"), by - Date.now())).toBe(true);
  });

  // What features send a peer when it shows up (online status, bot hosts: `onPeers`) went to the node while the
  // joiner's members' messages didn't pass, and never again.
  it("tells a peer it reached as a joiner what it tells a new peer, once its join lands", async () => {
    const network = new Network();
    const { workspaceId, host, owner } = await workspace();
    const node = await memberOf(workspaceId, host, "Node");
    const token = await invite(host, owner.author);
    await node.update();
    const nodeSync = start(network, "node", node, workspaceId, "workspace-room-secret", { role: "node" });
    const greeted: string[] = [];
    nodeSync.mesh!.channel<string>("greet", (text, from) => greeted.push(`${from}: ${text}`));
    const guest = await open(workspaceId, await signer());
    const guestSync = start(network, "guest", guest, workspaceId, "workspace-room-secret", { inviteToken: token, member: false, nodes: (peer) => peer === "node" });
    const greet = guestSync.mesh!.channel<string>("greet", () => {});
    guestSync.onPeers((peer) => greet("hello", peer), () => {});
    expect(await until(() => guest.ledger.owner !== null, 3_000)).toBe(true);
    expect(greeted).toEqual([]);
    await guest.api.plugin("members").call("set-profile", { display_name: "Guest", color: "", invite_token: token });
    expect(await until(() => node.ledger.select("members", "members_profiles", { user_id: guest.ledger.me }).length === 1, 2_000)).toBe(true);
    expect(await until(() => greeted.includes("guest: hello"), 2_000)).toBe(true);
  });
});

describe("hub topology", () => {
  let syncs: WorkspaceSync[] = [];
  afterEach(() => {
    syncs.forEach((s) => s.close());
    syncs = [];
  });

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  // Waits until `check` holds (timers run late when the whole suite runs at once).
  const until = async (check: () => boolean, ms = 5_000) => {
    for (const end = Date.now() + ms; !check() && Date.now() < end;) await wait(25);
    return check();
  };
  const nameOf = (roomId: string) => (roomId.endsWith(":members") ? "members" : roomId.includes(":members:") ? `members-${roomId.split(":members:")[1]}`
    : roomId.includes(":call:") ? `call-${roomId.split(":call:")[1]}`
    : roomId.endsWith(":nodes") ? "nodes" : roomId.includes(":group:") ? `group-${roomId.split(":group:")[1]}` : "hub");

  // Joins its rooms like the app (discovery on the fake network); peers whose id starts with "n" are nodes.
  async function peer(
    network: Network, id: string, workspaceId: string, who: Signer, role: "member" | "node" = "member", hasNodes = true,
    groups?: () => { count: number; order: number[] }, gridOver?: number,
  ) {
    const m = await open(workspaceId, who);
    const sync = new WorkspaceSync(m.ledger, workspaceId, "secret", {
      self: id, tabs: false, role, fallbackAfterMs: 150, hubAfterMs: 150, lonelyMs: 300, gridOver, rejoinDelayMs: () => 20,
      joinRoom: (roomId, passive) => network.join(id, nameOf(roomId), passive) as unknown as Room,
    });
    sync.setNodes({ known: () => hasNodes, isNode: (p) => p.startsWith("n") });
    if (groups) sync.setGroups(groups);
    syncs.push(sync);
    return { ...m, sync };
  }

  async function owner(network: Network) {
    const who = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(who);
    const a = await peer(network, "a", workspaceId, who);
    await a.ledger.adopt(genesis);
    return { workspaceId, a };
  }

  async function arrives(m: { chat: PluginClient }, body: string) {
    for (let i = 0; i < 40; i++) {
      if ((await m.chat.read("chat_messages")).some((r) => r.body === body)) return true;
      await wait(50);
    }
    return false;
  }

  it("connects members only to nodes, and they still reach each other through them", async () => {
    const network = new Network();
    const { workspaceId, a } = await owner(network);
    await peer(network, "n1", workspaceId, await signer(), "node");
    const b = await peer(network, "b", workspaceId, await signer());
    // Members hear of each other from the node in its next batch of changes (1 s, mesh.ts).
    expect(await until(() => a.sync.mesh!.relayOf("b") === "n1")).toBe(true);
    expect(network.linked("a", "n1")).toBe(true);
    expect(network.linked("b", "n1")).toBe(true);
    expect(network.linked("a", "b")).toBe(false);
    expect(network.linked("a", "b", "members")).toBe(false);
    expect(a.sync.inMemberRoom()).toBe(false);
    expect(a.sync.mesh!.directPeers()).toEqual(["n1"]);
    expect(a.sync.mesh!.relayOf("b")).toBe("n1");
    await a.chat.call("post-message", { channel_id: 1, body: "through the node" });
    expect(await arrives(b, "through the node")).toBe(true);
  });

  it("passes a member's new commit on through one node, so each member gets it once", async () => {
    const network = new Network();
    const { workspaceId, a } = await owner(network);
    const n1 = await peer(network, "n1", workspaceId, await signer(), "node");
    const n2 = await peer(network, "n2", workspaceId, await signer(), "node");
    const b = await peer(network, "b", workspaceId, await signer());
    const c = await peer(network, "c", workspaceId, await signer());
    expect(await until(() => ["a", "b", "c"].every((m) => network.linked(m, "n1") && network.linked(m, "n2")))).toBe(true);
    await wait(1_200);
    const into = (to: string) => ["n1", "n2"].reduce((n, from) => n + network.count(from, to, "commits") + network.count(from, to, "commits-fwd"), 0);
    const before = { b: into("b"), c: into("c") };
    await a.chat.call("post-message", { channel_id: 1, body: "once" });
    for (const m of [b, c, n1, n2]) expect(await arrives(m, "once")).toBe(true);
    await wait(200);
    expect(into("b") - before.b).toBe(1);
    expect(into("c") - before.c).toBe(1);
    // A sent it to one node only.
    expect(network.count("a", "n1", "commits-fwd") + network.count("a", "n2", "commits-fwd")).toBe(1);
  });

  it("without nodes, puts members in a grid of rooms: fewer connections, everyone still reached", async () => {
    const network = new Network();
    const who = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(who);
    const a = await peer(network, "a", workspaceId, who, "member", false, undefined, 4);
    await a.ledger.adopt(genesis);
    await a.api.plugin("members").call("set-profile", { display_name: "a", color: "" });
    const ids = ["b", "c", "d", "e", "f", "g", "h", "i"];
    const others: (typeof a)[] = [];
    for (const id of ids) others.push(await peer(network, id, workspaceId, await signer(), "member", false, undefined, 4));
    // Joiners get the data from A (active in the member room), add their profiles, then move to the grid.
    for (const m of others) {
      expect(await until(() => m.ledger.owner !== null, 8_000)).toBe(true);
      await m.api.plugin("members").call("set-profile", { display_name: "x", color: "" });
    }
    const all = [a, ...others];
    // 9 members: a 2 x 2 grid. Each connects directly only to members of its row and its column, and still knows every
    // other member (members in neither are reached through one in between).
    const cellOf = (m: (typeof all)[number]) => gridCell(m.ledger.me, 2);
    const names = new Map(all.map((m, i) => [m, ["a", ...ids][i]]));
    const expected = (m: (typeof all)[number]) => all.filter((o) => o !== m && (cellOf(o).row === cellOf(m).row || cellOf(o).col === cellOf(m).col))
      .map((o) => names.get(o)!).sort();
    const settled = () => all.every((m) => m.sync.mesh!.peers().length === 8
      && JSON.stringify([...m.sync.mesh!.directPeers()].sort()) === JSON.stringify(expected(m)));
    // About 5 s alone; it ran past 20 s while the mesh-test suite loaded the computer (load average 30).
    expect(await until(settled, 40_000)).toBe(true);
    await others[3].chat.call("post-message", { channel_id: 1, body: "grid" });
    for (const m of all.filter((x) => x !== others[3])) expect(await arrives(m, "grid")).toBe(true);
  }, 60_000);

  it("falls back to the grid when the node goes, sized by the members seen through it", async () => {
    const network = new Network();
    const who = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(who);
    const a = await peer(network, "a", workspaceId, who, "member", true, undefined, 4);
    await a.ledger.adopt(genesis);
    await a.api.plugin("members").call("set-profile", { display_name: "a", color: "" });
    const node = await peer(network, "n1", workspaceId, await signer(), "node", true, undefined, 4);
    const others: (typeof a)[] = [];
    for (const id of ["b", "c", "d", "e", "f", "g", "h", "i"]) others.push(await peer(network, id, workspaceId, await signer(), "member", true, undefined, 4));
    for (const m of others) {
      expect(await until(() => m.ledger.owner !== null, 8_000)).toBe(true);
      await m.api.plugin("members").call("set-profile", { display_name: "x", color: "" });
    }
    const all = [a, ...others];
    // Through the node: everyone sees everyone, with one connection each.
    expect(await until(() => all.every((m) => m.sync.mesh!.peers().length === 9 && m.sync.mesh!.directPeers().length === 1), 15_000)).toBe(true);
    await wait(500); // a few room checks, which count who is online
    node.sync.close();
    // The node is gone: a 2 x 2 grid (9 members seen online fill it), not a full mesh.
    const names = new Map(all.map((m, i) => [m, ["a", "b", "c", "d", "e", "f", "g", "h", "i"][i]]));
    const cellOf = (m: (typeof all)[number]) => gridCell(m.ledger.me, 2);
    const expected = (m: (typeof all)[number]) => all.filter((o) => o !== m && (cellOf(o).row === cellOf(m).row || cellOf(o).col === cellOf(m).col))
      .map((o) => names.get(o)!).sort();
    // Never a full mesh on the way (it overloaded 50 members in mesh-test s9): at most the row and column at any time.
    const tooMany = new Set<string>();
    const inGrid = () => {
      for (const m of all) if (m.sync.mesh!.directPeers().length > expected(m).length) tooMany.add(names.get(m)!);
      return all.every((m) => m.sync.mesh!.peers().length === 8
        && JSON.stringify([...m.sync.mesh!.directPeers()].sort()) === JSON.stringify(expected(m)));
    };
    expect(await until(inGrid, 20_000)).toBe(true);
    expect([...tooMany]).toEqual([]);
  }, 60_000);

  it("keeps the member room when few of the members are online (a sparse grid would cut members off)", async () => {
    const network = new Network();
    const who = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(who);
    const a = await peer(network, "a", workspaceId, who, "member", false, undefined, 4);
    await a.ledger.adopt(genesis);
    await a.api.plugin("members").call("set-profile", { display_name: "a", color: "" });
    // 10 members who are offline now: their profiles are in the server's data (15 members: a 3 x 3 grid).
    for (let i = 0; i < 10; i++) {
      const away = await open(workspaceId, await signer());
      await away.ledger.adopt(genesis);
      await away.api.plugin("members").call("set-profile", { display_name: `away${i}`, color: "" });
      await away.ledger.flush();
      await a.ledger.accept(away.ledger.log().map((entry) => wire(entry.commit)));
    }
    const others: (typeof a)[] = [];
    for (const id of ["b", "c", "d", "e"]) others.push(await peer(network, id, workspaceId, await signer(), "member", false, undefined, 4));
    for (const m of others) {
      expect(await until(() => m.ledger.owner !== null, 8_000)).toBe(true);
      await m.api.plugin("members").call("set-profile", { display_name: "x", color: "" });
    }
    // 5 online can't fill 9 cells: everyone stays in the member room, connected to everyone.
    const all = [a, ...others];
    expect(await until(() => all.every((m) => m.sync.mesh!.directPeers().length === 4), 8_000)).toBe(true);
    await wait(1_000);
    expect(all.every((m) => m.sync.mesh!.directPeers().length === 4)).toBe(true);
  }, 60_000);

  it("connects a member only to its group of nodes, and still reaches members of other groups through two nodes", async () => {
    const network = new Network();
    // Groups: n1 n2 (group 0, also in the hub for joiners) and n3 n4 (group 1). A prefers group 0, B group 1.
    const of = (order: number[]) => () => ({ count: 2, order });
    const who = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(who);
    const a = await peer(network, "a", workspaceId, who, "member", true, of([0, 1]));
    await a.ledger.adopt(genesis);
    for (const [id, g] of [["n1", 0], ["n2", 0], ["n3", 1], ["n4", 1]] as const) await peer(network, id, workspaceId, await signer(), "node", true, of([g]));
    const b = await peer(network, "b", workspaceId, await signer(), "member", true, of([1, 0]));
    // B joins through the hub (group 0's nodes), gets the data, then moves to its own group.
    expect(await until(() => network.linked("b", "n3", "group-1") && network.linked("b", "n4", "group-1"), 8_000)).toBe(true);
    expect(await until(() => !network.linked("b", "n1") && !network.linked("b", "n2"), 8_000)).toBe(true);
    expect(network.linked("a", "n1", "group-0") && network.linked("a", "n2", "group-0")).toBe(true);
    expect(network.linked("a", "n3", "group-1") || network.linked("a", "n3")).toBe(false);
    expect(network.linked("n1", "n3", "nodes") && network.linked("n2", "n4", "nodes")).toBe(true);
    expect(a.sync.mesh!.directPeers().sort()).toEqual(["n1", "n2"]);
    // Two hops: A sees B (through a group 0 node that reaches it through a group 1 node), and messages arrive.
    expect(await until(() => a.sync.mesh!.peers().includes("b") && b.sync.mesh!.peers().includes("a"), 8_000)).toBe(true);
    await a.chat.call("post-message", { channel_id: 1, body: "across groups" });
    expect(await arrives(b, "across groups")).toBe(true);
    await b.chat.call("post-message", { channel_id: 1, body: "and back" });
    expect(await arrives(a, "and back")).toBe(true);
  }, 60_000);

  it("connects members to each other while no node is reachable, and goes back to the hub when one is", async () => {
    const network = new Network();
    const { workspaceId, a } = await owner(network);
    const b = await peer(network, "b", workspaceId, await signer());
    expect(await until(() => a.sync.inMemberRoom() && b.sync.inMemberRoom())).toBe(true);
    expect(await until(() => network.linked("a", "b", "members"))).toBe(true);
    await a.chat.call("post-message", { channel_id: 1, body: "no node" });
    expect(await arrives(b, "no node")).toBe(true);

    await peer(network, "n1", workspaceId, await signer(), "node");
    expect(await until(() => !a.sync.inMemberRoom() && !b.sync.inMemberRoom())).toBe(true);
    expect(network.linked("a", "b", "members")).toBe(false);
    await a.chat.call("post-message", { channel_id: 1, body: "node back" });
    expect(await arrives(b, "node back")).toBe(true);
  });


  it("lets a joiner reach the members of a server without nodes", async () => {
    const network = new Network();
    const who = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(who);
    const a = await peer(network, "a", workspaceId, who, "member", false);
    await a.ledger.adopt(genesis);
    // A has the data and the server has no node: A is active in the member room.
    expect(await until(() => a.sync.inMemberRoom())).toBe(true);
    const b = await peer(network, "b", workspaceId, await signer(), "member", false);
    expect(await until(() => network.linked("a", "b", "members"))).toBe(true);
    await a.chat.call("post-message", { channel_id: 1, body: "for joiners" });
    expect(await arrives(b, "for joiners")).toBe(true);
  });

  it("keeps joiners from connecting to each other until they have been alone for a while", async () => {
    const network = new Network();
    const who = await signer();
    const { workspaceId } = await Ledger.createGenesis(who);
    const b = await peer(network, "b", workspaceId, await signer(), "member", false);
    const c = await peer(network, "c", workspaceId, await signer(), "member", false);
    // Both are passive in the member room (a burst of joiners doesn't become a full mesh)...
    await wait(100);
    expect(network.linked("b", "c", "members")).toBe(false);
    // ...until nobody at all answered for a while (300 ms in this test): then they look for each other.
    expect(await until(() => network.linked("b", "c", "members"))).toBe(true);
    // One turning active is enough: the other has a peer then and stays passive.
    expect(b.sync.inMemberRoom() || c.sync.inMemberRoom()).toBe(true);
  });

  it("connects the members of a call to each other directly", async () => {
    const network = new Network();
    const { workspaceId, a } = await owner(network);
    await peer(network, "n1", workspaceId, await signer(), "node");
    const b = await peer(network, "b", workspaceId, await signer());
    expect(await until(() => network.linked("a", "n1") && network.linked("b", "n1"))).toBe(true);
    a.sync.joinCall(7);
    b.sync.joinCall(7);
    expect(await until(() => network.linked("a", "b", "call-7"))).toBe(true);
    expect(a.sync.mesh!.directPeers().sort()).toEqual(["b", "n1"]);
    a.sync.joinCall(null);
    expect(await until(() => !network.linked("a", "b", "call-7"))).toBe(true);
    expect(a.sync.mesh!.directPeers()).toEqual(["n1"]);
  });
});
