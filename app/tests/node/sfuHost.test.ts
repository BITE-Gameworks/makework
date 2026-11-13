// The node's arbiter over calls through it (src/node/host.ts `sfuJoin`, ADR 0005): the whole decision path (the
// signed join's auth, the member count the asking device reported, the server's call settings, and the senders a
// node takes), with a fake mediasoup worker so no native addon loads. p2p/sfuProtocol.test.ts covers the settings
// and order on their own; this drives the real closures the room's action routes to.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Room } from "trystero";
import { accountId, createIdentity, sign, type Identity } from "../../src/core/identity";
import { ApiClient } from "../../src/api/client";
import { MockTransport } from "../../src/mock/transport";
import { HostedServer } from "../../src/node/host";
import { fileContent } from "../../src/node/storage";
import { type SfuProducerLike, type SfuRouterLike, type SfuTransportLike, type SfuWorkerLike } from "../../src/node/sfu";
import { memoryCommits } from "../../src/p2p/commits";
import { Ledger, createLedgerBackend } from "../../src/p2p/ledger";
import { userNumberOf } from "../../src/p2p/log";
import { jwk } from "../../src/p2p/nodes";
import { localPlugins, plugins } from "../../src/p2p/plugins";
import { workspacePolicy } from "../../src/p2p/policy";
import { sfuJoinText, type SfuJoin } from "../../src/p2p/sfuProtocol";
import { Network } from "../p2p/fakeNetwork";

// The pieces of the fake worker: its router opens trips to the call members (one send transport a piece, sharing
// whose kinds the tests can read back), and nothing else mediasoup does.
function fakeRouter(): { router: SfuRouterLike; producedKinds: string[] } {
  const producedKinds: string[] = [];
  const router: SfuRouterLike = {
    rtpCapabilities: { caps: true },
    canConsume: () => true,
    async createWebRtcTransport() {
      const transport: SfuTransportLike = {
        id: "tr1",
        iceParameters: { ice: 1 },
        iceCandidates: [],
        dtlsParameters: { dtls: 1 },
        connect: async () => {},
        async produce(options) {
          // Like mediasoup's Transport.produce, which takes only a media kind.
          if (options.kind !== "audio" && options.kind !== "video") throw new TypeError(`invalid kind ${String(options.kind)}`);
          producedKinds.push(options.kind);
          const producer: SfuProducerLike = { id: `p${producedKinds.length}`, appData: options.appData, onClosed: () => {}, close: () => {} };
          return producer;
        },
        async consume() {
          return { id: "c1", producerId: "p1", paused: false, rtpParameters: {}, resume: async () => {}, close: () => {} };
        },
        close: () => {},
      };
      return transport;
    },
    // One node here: a pipe to another node is never asked for (tests/node/sfuBridge.test.ts covers those).
    createPipeTransport: () => Promise.reject(new Error("no other node in this test")),
    close: () => {},
  };
  return { router, producedKinds };
}

const dirs: string[] = [];
const closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "mw-sfu-host-"));
  dirs.push(dir);
  return dir;
}

async function member(): Promise<{ identity: Identity; user: number }> {
  const identity = await createIdentity(false);
  const user = userNumberOf(await accountId(jwk({ x: identity.publicKey!.x!, y: identity.publicKey!.y! })));
  return { identity, user };
}

function joinOf(workspaceId: string, who: { identity: Identity; user: number }, call: number, members: number): Promise<SfuJoin> {
  return (async () => {
    const time = Date.now();
    const sig = await sign(who.identity.privateKey, sfuJoinText(workspaceId, call, who.user, time));
    return { user: who.user, key: { x: who.identity.publicKey!.x!, y: who.identity.publicKey!.y! }, time, sig, call, members };
  })();
}

// Whether the node answered serve (the reply union carries `serve` on its two serving variants).
async function served(server: HostedServer, peer: string, join: SfuJoin): Promise<boolean> {
  const reply = await server.sfuRequest(peer, { join });
  return "serve" in reply && reply.serve;
}

// The seeded channels' ids (time-ordered randoms, never 1, 2): the first, and the second for a move between calls.
const callId = (server: HostedServer) => Number(server.ledger.select("channels", "channels_channels", {})[0]?.id);
const otherCallId = (server: HostedServer) => Number(server.ledger.select("channels", "channels_channels", {})[1]?.id);

// A fresh server with the call settings written before the node (sharing one commit store, so the node loads them
// without a network catch-up) and a fake worker for calls.
async function setup(
  settings: Record<string, number | boolean>,
  options: { openSfu?: (() => Promise<SfuWorkerLike>) | null; address?: string; bot?: { user: number; host: number } } = {},
): Promise<{ server: HostedServer; workspaceId: string; producedKinds: string[]; workers: { die(): void; listeners(): number }[]; opened: () => number }> {
  const network = new Network();
  const owner = await createIdentity(false);
  const signer = {
    author: owner.id,
    key: { x: owner.publicKey!.x!, y: owner.publicKey!.y! },
    privateKey: owner.privateKey, replica: crypto.randomUUID(),
  };
  const { workspaceId, genesis } = await Ledger.createGenesis(signer);
  const commits = memoryCommits();
  const ledger = new Ledger(workspaceId, signer, workspacePolicy, commits);
  const backend = createLedgerBackend(ledger, localPlugins);
  for (const plugin of plugins) backend.load(plugin);
  await ledger.load();
  await ledger.adopt(genesis);
  const api = new ApiClient(new MockTransport(backend));
  // A new server as the app seeds one (no log until the app wrote its channels), so `canJoin` finds a call channel.
  await api.plugin("roles").call("ensure-everyone");
  const ext = api.plugin("channels");
  await ext.insert("channels_workspace", { name: "Test", short: "", color: "", icon: "" });
  const categoryId = await ext.insert("channels_categories", { name: "general", position: 0 });
  await ext.call<{ id: number }>("add-channel", { category_id: categoryId, name: "welcome", type: "chat" });
  await ext.call<{ id: number }>("add-channel", { category_id: categoryId, name: "second", type: "chat" });
  await api.plugin("nodes").call("set-storage", settings);
  if (options.bot) await api.plugin("bots").call("create", { user_id: options.bot.user, type: "mediabot", nickname: "Media", host: options.bot.host });
  await ledger.flush();

  const { router, producedKinds } = fakeRouter();
  // The real worker answers over IPC, a turn of the event loop later: joins arriving together wait on it together.
  // Each one opened can die (its `died` listeners run, as mediasoup's do).
  const workers: { die(): void; listeners(): number }[] = [];
  let opened = 0;
  const openWorker = async (): Promise<SfuWorkerLike> => {
    opened++;
    const died = new Set<() => void>();
    workers.push({ die: () => [...died].forEach((listener) => listener()), listeners: () => died.size });
    return {
      async createRouter() {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return router;
      },
      onDied: (listener) => {
        died.add(listener);
        return () => died.delete(listener);
      },
      close: () => {},
    };
  };
  const identity = await createIdentity(false);
  const server = await HostedServer.open({ id: workspaceId, secret: "secret", replica: crypto.randomUUID() }, {
    identity: { id: identity.id, key: { x: identity.publicKey!.x!, y: identity.publicKey!.y! }, privateKey: identity.privateKey },
    commits, content: fileContent(await scratch()), senders: 8, healAfterMs: 60_000, self: "n1", openSfu: options.openSfu === null ? undefined : options.openSfu ?? openWorker,
    joinRoom: (roomId, passive) => network.join("n1", roomId, passive) as unknown as Room,
  }, () => ({ address: options.address ?? "203.0.113.5", url: "", place: null }));
  closers.push(() => server.close().catch(() => {}));
  return { server, workspaceId, producedKinds, workers, opened: () => opened };
}

describe("the node as a call's arbiter", () => {
  it("leaves a call below the threshold a mesh call", async () => {
    const { server, workspaceId } = await setup({ sfu_calls: true, sfu_min_members: 5, sfu_capacity: 2 });
    expect(await server.sfuRequest("peerA", { join: await joinOf(workspaceId, await member(), callId(server), 4) })).toEqual({ serve: false, reason: "none" });
  });

  it("serves a call at or above the threshold and takes the member's transports", async () => {
    const { server, workspaceId } = await setup({ sfu_calls: true, sfu_min_members: 5, sfu_capacity: 2 });
    const me = await member();
    const servedReply = await server.sfuRequest("peerA", { join: await joinOf(workspaceId, me, callId(server), 6) });
    expect("serve" in servedReply && servedReply.serve).toBe(true);
    if ("serve" in servedReply && servedReply.serve) expect(servedReply.producers).toEqual([]);
    const made = (await server.sfuRequest("peerA", { create: { kind: "send" } })) as { ok: boolean; data?: Record<string, unknown> | null };
    expect(made.ok).toBe(true);
    expect(String(made.data?.id)).toBe("tr1");
    expect(await server.sfuRequest("peerA", { leave: true })).toEqual({ ok: true });
  });

  it("hands mediasoup the media kind, never a call kind", async () => {
    const { server, workspaceId, producedKinds } = await setup({ sfu_calls: true, sfu_min_members: 5, sfu_capacity: 2 });
    const me = await member();
    expect(await served(server, "peerA", await joinOf(workspaceId, me, callId(server), 6))).toBe(true);
    await server.sfuRequest("peerA", { create: { kind: "send" } });
    expect(await server.sfuRequest("peerA", { produce: { kind: "mic", rtpParameters: {} } })).toMatchObject({ ok: true });
    expect(producedKinds).toEqual(["audio"]);
  });

  it("takes a screen share as two producers: its picture as video, the computer's sound as audio", async () => {
    const { server, workspaceId, producedKinds } = await setup({ sfu_calls: true, sfu_min_members: 5, sfu_capacity: 2 });
    expect(await served(server, "peerA", await joinOf(workspaceId, await member(), callId(server), 6))).toBe(true);
    await server.sfuRequest("peerA", { create: { kind: "send" } });
    expect(await server.sfuRequest("peerA", { produce: { kind: "screen", rtpParameters: {} } })).toMatchObject({ ok: true });
    expect(await server.sfuRequest("peerA", { produce: { kind: "screen-sound", rtpParameters: {} } })).toMatchObject({ ok: true });
    expect(producedKinds).toEqual(["video", "audio"]);
  });

  it("takes a producer from a bot the member hosts, as the bot, and refuses one it does not host", async () => {
    const me = await member();
    const { server, workspaceId } = await setup({ sfu_calls: true, sfu_min_members: 5, sfu_capacity: 2 }, { bot: { user: 777, host: me.user } });
    expect(await served(server, "peerA", await joinOf(workspaceId, me, callId(server), 6))).toBe(true);
    await server.sfuRequest("peerA", { create: { kind: "send" } });
    expect(await server.sfuRequest("peerA", { produce: { kind: "mic", rtpParameters: {}, as: 888 } })).toMatchObject({ ok: false });
    const reply = await server.sfuRequest("peerA", { produce: { kind: "mic", rtpParameters: {}, as: 777 } });
    expect(reply).toMatchObject({ ok: true });
    // The member's own mic is still free: the bot's is a separate one.
    expect(await server.sfuRequest("peerA", { produce: { kind: "mic", rtpParameters: {} } })).toMatchObject({ ok: true });
    expect(await server.sfuRequest("peerA", { produce: { kind: "mic", rtpParameters: {}, as: 777 } })).toMatchObject({ ok: false });
  });

  it("serves below the threshold when the server forced calls through nodes", async () => {
    const { server, workspaceId } = await setup({ sfu_calls: true, sfu_min_members: 5, sfu_capacity: 2, sfu_forced: true });
    expect(await served(server, "peerA", await joinOf(workspaceId, await member(), callId(server), 2))).toBe(true);
  });

  it("refuses every call when the server switched calls through nodes off", async () => {
    const { server, workspaceId } = await setup({ sfu_calls: false, sfu_min_members: 5, sfu_capacity: 2 });
    expect(await server.sfuRequest("peerA", { join: await joinOf(workspaceId, await member(), callId(server), 6) })).toEqual({ serve: false, reason: "none" });
  });

  it("answers busy once the call has its `sfu_capacity` members", async () => {
    const { server, workspaceId } = await setup({ sfu_calls: true, sfu_min_members: 2, sfu_capacity: 2 });
    const a = await member();
    const b = await member();
    const c = await member();
    expect(await served(server, "peerA", await joinOf(workspaceId, a, callId(server), 6))).toBe(true);
    expect(await served(server, "peerB", await joinOf(workspaceId, b, callId(server), 6))).toBe(true);
    expect(await server.sfuRequest("peerC", { join: await joinOf(workspaceId, c, callId(server), 6) })).toEqual({ serve: false, reason: "busy" });
    // The over-cap ask took no place: a member leaving frees it for another join.
    expect(await server.sfuRequest("peerA", { leave: true })).toEqual({ ok: true });
    expect(await served(server, "peerC", await joinOf(workspaceId, c, callId(server), 6))).toBe(true);
  });

  it("takes a member past its capacity when it is the member's last node to ask, so the call stays whole", async () => {
    const { server, workspaceId } = await setup({ sfu_calls: true, sfu_min_members: 2, sfu_capacity: 1 });
    expect(await served(server, "peerA", await joinOf(workspaceId, await member(), callId(server), 3))).toBe(true);
    const b = await member();
    expect(await served(server, "peerB", await joinOf(workspaceId, b, callId(server), 3))).toBe(false);
    // Every node it reaches said busy: it asks again as its last resort, and this one takes it.
    expect(await served(server, "peerB", { ...(await joinOf(workspaceId, b, callId(server), 3)), last: true })).toBe(true);
  });

  it("takes exactly `sfu_capacity` members when more join at once", async () => {
    const { server, workspaceId } = await setup({ sfu_calls: true, sfu_min_members: 5, sfu_capacity: 3 });
    const joins = await Promise.all([1, 2, 3, 4, 5, 6].map(async () => joinOf(workspaceId, await member(), callId(server), 6)));
    // All six ask before any is answered: the count and the join must not be split by an await.
    const answers = await Promise.all(joins.map((join, i) => served(server, `peer${i}`, join)));
    expect(answers.filter(Boolean)).toHaveLength(3);
  });

  it("serves calls again after its mediasoup worker died, with a new one", async () => {
    const { server, workspaceId, workers, opened } = await setup({ sfu_calls: true, sfu_min_members: 2, sfu_capacity: 10 });
    expect(await served(server, "peerA", await joinOf(workspaceId, await member(), callId(server), 3))).toBe(true);
    workers[0].die();
    expect(await served(server, "peerB", await joinOf(workspaceId, await member(), callId(server), 3))).toBe(true);
    expect(opened()).toBe(2);
  });

  it("makes no calls for a server closed while its worker was still starting", async () => {
    let release!: (worker: SfuWorkerLike) => void;
    let routers = 0;
    const starting = new Promise<SfuWorkerLike>((resolve) => (release = resolve));
    const { server, workspaceId } = await setup({ sfu_calls: true, sfu_min_members: 2, sfu_capacity: 10 }, { openSfu: () => starting });
    const answer = server.sfuRequest("peerA", { join: await joinOf(workspaceId, await member(), callId(server), 3) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await server.close();
    release({ createRouter: async () => (routers++, ({} as never)), onDied: () => () => {}, close: () => {} });
    expect(await answer).toEqual({ serve: false, reason: "busy" });
    expect(routers).toBe(0);
  });

  it("lets go of the shared worker when the server closes", async () => {
    const { server, workspaceId, workers } = await setup({ sfu_calls: true, sfu_min_members: 2, sfu_capacity: 10 });
    expect(await served(server, "peerA", await joinOf(workspaceId, await member(), callId(server), 3))).toBe(true);
    expect(workers[0].listeners()).toBeGreaterThan(0);
    await server.close();
    // Nothing of a server the node stopped hosting stays reachable through the worker the others still use.
    expect(workers[0].listeners()).toBe(0);
  });

  it("serves no call when it was given no worker (it never starts one nothing would close)", async () => {
    const { server, workspaceId } = await setup({ sfu_calls: true, sfu_min_members: 2, sfu_capacity: 10 }, { openSfu: null });
    expect(await served(server, "peerA", await joinOf(workspaceId, await member(), callId(server), 3))).toBe(false);
  });

  it("serves no call without a public address to announce (members couldn't reach it)", async () => {
    const { server, workspaceId } = await setup({ sfu_calls: true, sfu_min_members: 2, sfu_capacity: 10 }, { address: "" });
    expect(await server.sfuRequest("peerA", { join: await joinOf(workspaceId, await member(), callId(server), 3) })).toEqual({ serve: false, reason: "none" });
  });

  it("takes a device out of its old call when it joins another without having left", async () => {
    const { server, workspaceId } = await setup({ sfu_calls: true, sfu_min_members: 2, sfu_capacity: 1 });
    const a = await member();
    expect(await served(server, "peerA", await joinOf(workspaceId, a, callId(server), 3))).toBe(true);
    // Its `leave` was lost on the way: the join for the other call comes first.
    expect(await served(server, "peerA", await joinOf(workspaceId, a, otherCallId(server), 3))).toBe(true);
    // The first call no longer holds its place (capacity 1).
    expect(await served(server, "peerB", await joinOf(workspaceId, await member(), callId(server), 3))).toBe(true);
  });

  it("refuses a join that does not sign over its own user number", async () => {
    const { server, workspaceId } = await setup({ sfu_calls: true, sfu_min_members: 5, sfu_capacity: 2 });
    const me = await member();
    const join = await joinOf(workspaceId, me, callId(server), 6);
    expect(await server.sfuRequest("peerA", { join: { ...join, user: join.user + 1 } })).toEqual({ serve: false, reason: "none" });
  });
});