// Trystero's core (the patched copy in vendor/trystero-core) between real peers in one process. Each peer loads its
// own copy of the core (its own selfId and shared connections), they meet on an in-memory relay, and connect over
// werift WebRTC like a node. tests/p2p/fakeNetwork.ts replaces Trystero, so it can't see races inside Trystero's
// shared connections; these tests can. One test per bug in vendor/trystero-core/README.md.
import { afterAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { RTCPeerConnection } from "werift";
import type { Room } from "trystero";
import { fileContent } from "../../src/node/storage";
import { Mesh } from "../../src/p2p/mesh";
import { RoomGroup } from "../../src/p2p/roomGroup";
import { ContentStreams } from "../../src/p2p/stream";

type Core = typeof import("@trystero-p2p/core");
type Handler = (topic: string, message: string) => void;
type JoinError = { error: string; roomId: string; peerId: string };

const copies: string[] = [];
afterAll(() => copies.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// A fresh copy of the installed core, so this peer's module state is its own.
async function loadCore(): Promise<Core> {
  const dist = dirname(createRequire(import.meta.url).resolve("@trystero-p2p/core"));
  const dir = mkdtempSync(join(tmpdir(), "mw-trystero-"));
  copies.push(dir);
  cpSync(dist, dir, { recursive: true });
  return import(/* @vite-ignore */ pathToFileURL(join(dir, "index.mjs")).href);
}

function relay() {
  const topics = new Map<string, Set<Handler>>();
  return {
    subscribe(topic: string, handler: Handler) {
      const handlers = topics.get(topic) ?? new Set();
      handlers.add(handler);
      topics.set(topic, handlers);
      return () => void handlers.delete(handler);
    },
    publish(topic: string, message: unknown) {
      const text = typeof message === "string" ? message : JSON.stringify(message);
      for (const handler of topics.get(topic) ?? []) setTimeout(() => handler(topic, text), 2);
    },
  };
}

async function peer(bus: ReturnType<typeof relay>, errors: JoinError[]) {
  const core = await loadCore();
  const joinRoom = core.createTopicStrategy<ReturnType<typeof relay>>({
    steadyAnnounceIntervalMs: 500,
    init: () => bus,
    subscribeTopic: (relay, topic, onMessage) => relay.subscribe(topic, (t, m) => void onMessage(t, m)),
    publishTopic: (relay, topic, message, { kind }) => {
      relay.publish(topic, message);
      return kind === "announce" ? { nextAnnounceMs: 500 } : undefined;
    },
    unpublishTopic: () => {},
  });
  return (roomId: string, password: string, passive: boolean): Room =>
    joinRoom(
      {
        appId: "makework-test", password, passive, _test_only_sharedPeerIdleMs: 100,
        rtcPolyfill: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection, rtcConfig: { iceServers: [] },
      } as never,
      roomId,
      { handshakeTimeoutMs: 3_000, onJoinError: (e: JoinError) => void errors.push(e) },
    ) as unknown as Room;
}

const peersIn = (room: Room) => Object.keys(room.getPeers()).length;
const connected = (rooms: Room[]) => rooms.every((room) => peersIn(room) > 0);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Two connections racing for the first contact, one of them failing, is how Trystero meets: not a problem.
const handshakeErrors = (errors: JoinError[]) => errors.map((e) => e.error).filter((error) => !error.includes("after exchanging SDP"));

// Runs `attempt` with fresh peers `times` times, leaving every room it joined even when it fails.
async function attempts(times: number, attempt: (join: (room: Room) => Room, bus: ReturnType<typeof relay>, errors: JoinError[]) => Promise<void>) {
  for (let i = 0; i < times; i++) {
    const rooms: Room[] = [];
    const errors: JoinError[] = [];
    try {
      await attempt((room) => (rooms.push(room), room), relay(), errors);
    } finally {
      await Promise.all(rooms.map((room) => room.leave()));
    }
  }
}

describe("Trystero rooms sharing one connection", () => {
  // A member is passive in its hub and in each recovery room (or each open invite's room), a node active in all of
  // them: every room answers the node at once, and the duplicate connections closing made the member's room say
  // "left" and "here" again before it was attached. The node then restarted the handshake, got the member's answer to
  // its first challenge, and logged "incorrect password for overlapping room" (or a timeout), at every start.
  it("lets a passive peer meet an active one in five rooms at once without a failed handshake", async () => {
    await attempts(6, async (join, bus, errors) => {
      const [node, member] = [await peer(bus, errors), await peer(bus, errors)];
      const rooms: Room[] = [];
      for (let k = 0; k < 5; k++) rooms.push(join(node(`room${k}`, `secret${k}`, false)), join(member(`room${k}`, `secret${k}`, true)));
      await expect.poll(() => connected(rooms), { timeout: 15_000, interval: 50 }).toBe(true);
      await wait(300);
      expect(handshakeErrors(errors)).toEqual([]);
    });
  }, 120_000);

  // A joiner is active in its invite's room, where members wait passive; once it is a member it joins that room again
  // passive (sync.ts), while another room of the app id keeps their connection. The member's passive room, left alone,
  // told the joiner "left", whose new room took that as leaving and said "left" too, and both said "here" again on
  // the next "here": a loop restarting the handshake each time (mesh-test s2: 200 failures in 2 s between two members).
  it("lets a peer join a room again passive where the other peer waits passive", async () => {
    await attempts(4, async (join, bus, errors) => {
      const [joiner, member] = [await peer(bus, errors), await peer(bus, errors)];
      const shared = [join(joiner("other", "secret0", false)), join(member("other", "secret0", false))];
      const invite = join(joiner("invite", "secret1", false));
      const memberInvite = join(member("invite", "secret1", true));
      await expect.poll(() => connected([...shared, invite, memberInvite]), { timeout: 15_000, interval: 50 }).toBe(true);
      await invite.leave();
      join(joiner("invite", "secret1", true));
      await wait(1_500);
      expect(handshakeErrors(errors)).toEqual([]);
    });
  }, 120_000);

  // The fix above must still tell everyone else that a passive room went quiet: a peer that heard "here" (over a
  // connection shared for another room) and never "left" would take it for still there when it joins that room
  // later, passive too, and two passive peers would connect.
  it("tells a peer that heard a passive room was active that it went quiet again", async () => {
    await attempts(3, async (join, bus, errors) => {
      const [member, other, node] = [await peer(bus, errors), await peer(bus, errors), await peer(bus, errors)];
      const shared = [join(member("other", "secret0", false)), join(other("other", "secret0", false))];
      const memberRoom = join(member("room", "secret1", true));
      const nodeRoom = join(node("room", "secret1", false));
      await expect.poll(() => connected([...shared, memberRoom, nodeRoom]), { timeout: 15_000, interval: 50 }).toBe(true);
      await nodeRoom.leave();
      await expect.poll(() => peersIn(memberRoom), { timeout: 5_000, interval: 50 }).toBe(0);
      await wait(300);
      const otherRoom = join(other("room", "secret1", true));
      await wait(1_500);
      expect(peersIn(otherRoom)).toBe(0);
      expect(handshakeErrors(errors)).toEqual([]);
    });
  }, 120_000);
});

// Not a bug in the copy: what the app relies on. File content times out on frames moving, not whole chunks
// (p2p/stream.ts, 2026-11-10), so both ends must hear each frame of a big message: the sender through `onProgress`,
// the receiver through `onReceiveProgress` with the message's metadata, before the message itself.
describe("Trystero progress of a big message", () => {
  it("reports each frame to both ends, the receiver's with the message's metadata", async () => {
    await attempts(1, async (join, bus, errors) => {
      const [holder, receiver] = [await peer(bus, errors), await peer(bus, errors)];
      const from = join(holder("files", "secret", false));
      const to = join(receiver("files", "secret", false));
      await expect.poll(() => connected([from, to]), { timeout: 15_000, interval: 50 }).toBe(true);
      const heard: { progress: number; metadata: unknown }[] = [];
      let arrived: { bytes: number; heardBefore: number } | null = null;
      to.makeAction<Uint8Array>("content-part", {
        onMessage: (data) => void (arrived = { bytes: data.byteLength, heardBefore: heard.length }),
        onReceiveProgress: (progress, { metadata }) => void heard.push({ progress, metadata }),
      });
      const sent: number[] = [];
      const part = from.makeAction<Uint8Array>("content-part");
      const metadata = { hash: "a".repeat(64), offset: 4 * 1024 * 1024 };
      await part.send(new Uint8Array(1024 * 1024), { target: Object.keys(from.getPeers())[0], metadata, onProgress: (p) => void sent.push(p) });
      await expect.poll(() => arrived, { timeout: 15_000, interval: 50 }).not.toBeNull();
      expect(sent.length).toBeGreaterThan(10);
      expect(arrived!.bytes).toBe(1024 * 1024);
      expect(arrived!.heardBefore).toBeGreaterThan(10);
      expect(heard.every((h) => JSON.stringify(h.metadata) === JSON.stringify(metadata))).toBe(true);
    });
  }, 60_000);
});

// A node's link to a member under the load that broke it (diagnosis 2026-11-26), over real WebRTC: the member uploads a
// big file to the node while the node relays a burst for it (call presence, mesh news) and more members join. The
// member asks the node "are you there" the way NodeLink does (p2p/nodes.ts): through an urgent channel, and for
// comparison through the outbox every other message waits in. The link must hold, and the urgent answers must come
// in well under the 15 s a member waits.
describe("a node's link under load", () => {
  it("keeps a member uploading to the node while the node relays a burst and others join", async () => {
    const warnings: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warnings.push(args.map(String).join(" ")));
    const dir = mkdtempSync(join(tmpdir(), "mw-load-"));
    copies.push(dir);
    const closing: (() => void)[] = [];
    try {
      await attempts(1, async (enter, bus, errors) => {
        const side = async (passive: boolean, name: string) => {
          const room = enter((await peer(bus, errors))("hub", "secret", passive));
          const group = new RoomGroup();
          group.add("hub", room);
          const mesh = new Mesh(group as never, name, () => {}, { deltaAfterMs: 0 });
          const left: string[] = [];
          mesh.onDirectPeers(() => {}, (peerId) => void left.push(peerId));
          closing.push(() => mesh.close());
          return { room, group, mesh, left };
        };
        const node = await side(false, "node");
        const member = await side(true, "member");
        await expect.poll(() => connected([node.room, member.room]), { timeout: 15_000, interval: 50 }).toBe(true);
        const memberId = Object.keys(node.room.getPeers())[0];
        const nodeId = Object.keys(member.room.getPeers())[0];

        // The member's file, and the node taking it in (p2p/stream.ts, as node/host.ts does).
        const bytes = randomBytes(16 * 1024 * 1024);
        const hash = createHash("sha256").update(bytes).digest("hex");
        const memberStore = fileContent(join(dir, "member"));
        const writer = await memberStore.openWriter(hash);
        await writer.append(new Uint8Array(bytes) as Uint8Array<ArrayBuffer>);
        await writer.finish(hash);
        const nodeStore = fileContent(join(dir, "node"));
        const memberStreams = new ContentStreams(member.group as never, memberStore);
        const nodeStreams = new ContentStreams(node.group as never, nodeStore, { senders: 8 });
        closing.push(() => memberStreams.close(), () => nodeStreams.close());

        // Pings both ways the member checks the node: answered on the channel they came on.
        const rtts = { urgent: [] as number[], queued: [] as number[] };
        const pings = (name: string, urgent: boolean, into: number[]) => {
          const answer = node.mesh.channel<number>(name, (t, from) => answer(t, from), { urgent });
          return member.mesh.channel<number>(name, (t) => void into.push(performance.now() - t), { urgent });
        };
        const urgentPing = pings("load-ping", true, rtts.urgent);
        const queuedPing = pings("load-ping-q", false, rtts.queued);
        const pinging = setInterval(() => {
          urgentPing(performance.now(), nodeId);
          queuedPing(performance.now(), nodeId);
        }, 200);
        closing.push(() => clearInterval(pinging));

        // What the node relays to the member meanwhile.
        let relayed = 0;
        const burst = node.mesh.channel<string>("load-burst", () => {});
        member.mesh.channel<string>("load-burst", () => void relayed++);

        const delay = monitorEventLoopDelay({ resolution: 10 });
        delay.enable();
        const started = performance.now();
        const download = nodeStreams.download(hash, memberId);
        for (let i = 0; i < 400; i++) burst(JSON.stringify({ presence: i, cursor: [i, i], pad: "x".repeat(200) }), memberId);
        // Members joining the node mid-transfer, passive like members in a hub.
        await wait(1_000);
        const joiners = await Promise.all(Array.from({ length: 6 }, (_, i) => side(true, `joiner${i}`)));
        expect(await download).toBe("done");
        const transferMs = performance.now() - started;
        await expect.poll(() => joiners.every((j) => peersIn(j.room) > 0), { timeout: 30_000, interval: 100 }).toBe(true);
        await expect.poll(() => relayed, { timeout: 30_000, interval: 100 }).toBe(400);
        await wait(1_000);
        delay.disable();

        expect(createHash("sha256").update(await readFile(join(dir, "node", "content", hash))).digest("hex")).toBe(hash);
        const worst = (list: number[]) => Math.max(0, ...list);
        console.log(`[load] 16 MiB in ${(transferMs / 1000).toFixed(1)} s; ping round trip worst ${worst(rtts.urgent).toFixed(0)} ms `
          + `urgent (${rtts.urgent.length} answers), ${worst(rtts.queued).toFixed(0)} ms through the outbox (${rtts.queued.length}); `
          + `event loop p99 ${(delay.percentile(99) / 1e6).toFixed(0)} ms, max ${(delay.max / 1e6).toFixed(0)} ms`);
        expect(member.left).toEqual([]);
        expect(node.left).toEqual([]);
        expect(joiners.flatMap((j) => j.left)).toEqual([]);
        expect(warnings.filter((w) => w.includes("disconnecting peer"))).toEqual([]);
        expect(rtts.urgent.length).toBeGreaterThan(0);
        expect(worst(rtts.urgent)).toBeLessThan(5_000);
      });
    } finally {
      closing.forEach((close) => close());
      warn.mockRestore();
    }
  }, 120_000);
});
