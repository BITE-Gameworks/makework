// A call split across nodes (src/node/sfuBridge.ts, ADR 0007): a node serves up to `sfu_capacity` members of a call,
// the next members go to the next node, and the nodes serving the call bridge to each other with pipe transports, so
// every member still hears and sees every other. Several nodes here, each with its own calls over a fake mediasoup
// worker, their `sfu-bridge` requests wired straight to each other; the pipe transport refuses what mediasoup refuses
// (a second producer with an id it has, consuming a producer the router doesn't have).
import { describe, expect, it } from "vitest";
import { SfuCalls, sfuMediaCodecs, type SfuWorkerLike } from "../../src/node/sfu";
import { SfuBridges, type BridgeReply, type BridgeRequest } from "../../src/node/sfuBridge";
import type { SfuNotify, SfuProducerInfo } from "../../src/p2p/sfuProtocol";

let counter = 0;

class FakeProducer {
  private gone: (() => void)[] = [];
  closed = false;
  constructor(readonly id: string, readonly kind: string, readonly appData: Record<string, unknown>, private readonly router: FakeRouter) {}
  onClosed(callback: () => void) {
    this.gone.push(callback);
  }
  close() {
    this.closed = true;
    this.router.producers.delete(this.id);
  }
  transportClosed() {
    this.close();
    for (const callback of this.gone.splice(0)) callback();
  }
}

class FakeTransport {
  readonly id = `t${++counter}`;
  readonly iceParameters = {};
  readonly iceCandidates = [];
  readonly dtlsParameters = {};
  readonly producers = new Set<FakeProducer>();
  constructor(private readonly router: FakeRouter) {}
  async connect() {}
  async produce(options: { kind: string; appData: Record<string, unknown> }) {
    const producer = new FakeProducer(`p${++counter}`, options.kind, options.appData, this.router);
    this.producers.add(producer);
    this.router.producers.set(producer.id, producer);
    return producer;
  }
  async consume(options: { producerId: string }) {
    return { id: `c${++counter}`, producerId: options.producerId, paused: false, rtpParameters: {}, resume: async () => {}, close: () => {} };
  }
  close() {
    for (const producer of this.producers) producer.transportClosed();
  }
}

class FakePipeTransport {
  readonly id = `pipe${++counter}`;
  readonly tuple: { localAddress: string; localPort: number };
  readonly srtpParameters = { cryptoSuite: "AEAD_AES_256_GCM", keyBase64: `key${counter}` };
  remote: { ip: string; port: number; srtpParameters?: unknown } | null = null;
  readonly produced = new Set<FakeProducer>();
  // The producers this pipe sent to the other node.
  readonly consumed: string[] = [];
  closed = false;
  constructor(private readonly router: FakeRouter, readonly listenInfo: { ip: string; announcedAddress?: string }) {
    this.tuple = { localAddress: listenInfo.announcedAddress ?? listenInfo.ip, localPort: 40000 + counter };
  }
  async connect(options: { ip: string; port: number; srtpParameters?: unknown }) {
    if (this.remote) throw new Error("connect() already called");
    this.remote = options;
  }
  async consume(options: { producerId: string }) {
    const producer = this.router.producers.get(options.producerId);
    if (!producer) throw new Error(`Producer with id "${options.producerId}" not found`);
    // The worker made the consumer; its answer is on the way (the producer can close meanwhile).
    if (this.router.consumeHold) await this.router.consumeHold;
    this.consumed.push(options.producerId);
    return { id: `pc${++counter}`, kind: producer.kind as "audio" | "video", rtpParameters: { codecs: [] }, producerPaused: false, close: () => {} };
  }
  async produce(options: { id: string; kind: string; appData: Record<string, unknown> }) {
    if (this.router.producers.has(options.id)) throw new Error(`a Producer with same producerId "${options.id}" already exists`);
    const producer = new FakeProducer(options.id, options.kind, options.appData, this.router);
    this.produced.add(producer);
    this.router.producers.set(producer.id, producer);
    return producer;
  }
  close() {
    this.closed = true;
    for (const producer of this.produced) producer.transportClosed();
  }
}

class FakeRouter {
  rtpCapabilities = { codecs: sfuMediaCodecs };
  readonly producers = new Map<string, FakeProducer>();
  readonly pipes: FakePipeTransport[] = [];
  // While set, a pipe transport is made only once it resolves (a busy worker); and a pipe consume answers only then.
  hold: Promise<void> | null = null;
  consumeHold: Promise<void> | null = null;
  canConsume(producerId: string) {
    return this.producers.has(producerId);
  }
  async createWebRtcTransport() {
    return new FakeTransport(this);
  }
  async createPipeTransport(options: { listenInfo: { ip: string; announcedAddress?: string } }) {
    if (this.hold) await this.hold;
    const pipe = new FakePipeTransport(this, options.listenInfo);
    this.pipes.push(pipe);
    return pipe;
  }
  close() {
    for (const pipe of this.pipes) pipe.close();
  }
}

type FakeNode = {
  name: string;
  user: number;
  worker: SfuWorkerLike;
  calls: SfuCalls;
  bridges: SfuBridges;
  routers: FakeRouter[];
  notices: SfuNotify[];
  online: boolean;
};

// Nodes named "A", "B", ... with user numbers 1, 2, ...: they reach each other directly, as the server's room does.
// `holdOnce(type)`: the next request of that type between any two nodes waits until the returned release is called.
// `dropOnce(type)`: the next one is lost (no answer, never delivered). `lateOnce(type)`: the next one is delivered and
// acted on, but its answer comes too late (the asker sees none).
// `lan`: each node's LAN address (a node behind a router), none by default.
function network(count: number, options: { address?: (name: string) => string; lan?: (name: string) => string | null } = {}) {
  const held = new Map<string, Promise<void>>();
  const dropped = new Set<string>();
  const late = new Set<string>();
  const nodes = new Map<string, FakeNode>();
  for (let i = 0; i < count; i++) {
    const name = String.fromCharCode(65 + i);
    const routers: FakeRouter[] = [];
    const worker: SfuWorkerLike = {
      async createRouter() {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const router = new FakeRouter();
        routers.push(router);
        return router as never;
      },
      onDied: () => () => {},
      close: () => {},
    };
    const node: FakeNode = { name, user: i + 1, worker, calls: undefined as never, bridges: undefined as never, routers, notices: [], online: true };
    node.calls = new SfuCalls(worker, (_call, _peer, notice) => node.notices.push(notice));
    node.bridges = new SfuBridges({
      calls: () => node.calls,
      address: () => options.address?.(name) ?? `10.0.0.${i + 1}`,
      lanAddress: () => options.lan?.(name) ?? null,
      self: () => node.user,
      nodeUser: (peer) => nodes.get(peer)?.user ?? null,
      onlineNodes: () => new Map([...nodes.values()].filter((n) => n !== node && n.online).map((n) => [n.user, n.name])),
      // JSON in and out, like the room: nothing is shared by reference between nodes.
      ask: async (peer, request) => {
        const type = Object.keys(request)[0];
        const wait = held.get(type);
        if (wait) {
          held.delete(type);
          await wait;
        }
        const target = nodes.get(peer);
        if (!target?.online) return null;
        if (dropped.delete(type)) return null;
        if (late.delete(type)) {
          void target.bridges.handle(name, JSON.parse(JSON.stringify(request)) as BridgeRequest);
          return null;
        }
        return JSON.parse(JSON.stringify(await target.bridges.handle(name, JSON.parse(JSON.stringify(request)) as BridgeRequest))) as BridgeReply;
      },
      notify: (_call, notice) => node.notices.push(notice),
      retryMs: 20,
    });
    nodes.set(name, node);
  }
  const holdOnce = (type: string) => {
    let release!: () => void;
    held.set(type, new Promise<void>((resolve) => (release = resolve)));
    return () => release();
  };
  return Object.assign(nodes, {
    holdOnce,
    dropOnce: (type: string) => void dropped.add(type),
    lateOnce: (type: string) => void late.add(type),
  });
}

const call = 5;
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

// A member of `node` in the call, sending one kind; the node opens the call (asking the others) when it is its first.
async function memberOn(node: FakeNode, peer: string, user: number, kind: SfuProducerInfo["kind"]): Promise<SfuProducerInfo> {
  const sfuCall = await node.calls.open(call);
  const first = sfuCall.size === 0;
  const member = sfuCall.tryJoin(peer, user, 10)!;
  if (first) await node.bridges.opened(call);
  await member.create("send");
  const info = await member.produce(kind, {});
  node.bridges.produced(call, info);
  await settle();
  return info;
}

const remoteOn = (node: FakeNode, excluding: number) => node.calls.get(call)!.producers(excluding);

describe("a call split across nodes", () => {
  it("brings each node's members' producers to the other, under the same id, user and kind", async () => {
    const nodes = network(2);
    const [a, b] = [nodes.get("A")!, nodes.get("B")!];
    const mic = await memberOn(a, "a1", 101, "mic");
    const camera = await memberOn(b, "b1", 202, "camera");
    expect(remoteOn(b, 202)).toEqual([mic]);
    expect(remoteOn(a, 101)).toEqual([camera]);
    // Consumable there like a member's own, and announced to that node's members.
    expect(b.routers[0].canConsume(mic.id)).toBe(true);
    expect(b.notices).toContainEqual({ newProducer: mic });
    expect(a.notices).toContainEqual({ newProducer: camera });
    // Each pipe connected to the other side's announced address, encrypted.
    const [pipeA, pipeB] = [a.routers[0].pipes[0], b.routers[0].pipes[0]];
    expect(pipeA.remote).toMatchObject({ ip: "10.0.0.2", port: pipeB.tuple.localPort, srtpParameters: pipeB.srtpParameters });
    expect(pipeB.remote).toMatchObject({ ip: "10.0.0.1", port: pipeA.tuple.localPort, srtpParameters: pipeA.srtpParameters });
  });

  it("brings a producer that starts after the link, and tells the other node when it ends", async () => {
    const nodes = network(2);
    const [a, b] = [nodes.get("A")!, nodes.get("B")!];
    await memberOn(a, "a1", 101, "mic");
    await memberOn(b, "b1", 202, "mic");
    const member = a.calls.get(call)!.tryJoin("a2", 102, 10)!;
    await member.create("send");
    const camera = await member.produce("camera", {});
    a.bridges.produced(call, camera);
    await settle();
    expect(remoteOn(b, 202)).toContainEqual(camera);
    await member.close(camera.id);
    a.bridges.ended(call, [camera.id]);
    await settle();
    expect(remoteOn(b, 202)).not.toContainEqual(camera);
    expect(b.notices).toContainEqual({ producerClosed: { id: camera.id } });
  });

  it("sends only a node's own members' producers on, so three nodes never loop", async () => {
    const nodes = network(3);
    const infos = [];
    for (const [i, node] of [...nodes.values()].entries()) infos.push(await memberOn(node, `m${i}`, 100 + i, "mic"));
    for (const [i, node] of [...nodes.values()].entries()) {
      const remote = remoteOn(node, 100 + i);
      expect(remote).toHaveLength(2);
      expect(remote).toEqual(expect.arrayContaining(infos.filter((_, j) => j !== i)));
      // What it sent on is its own member's mic, once to each other node: nothing that came in from elsewhere.
      expect(node.routers[0].pipes.flatMap((p) => p.consumed)).toEqual([infos[i].id, infos[i].id]);
    }
    // So each producer arrived straight from its own node: B going away takes only B's member with it.
    const [a, b, c] = [nodes.get("A")!, nodes.get("B")!, nodes.get("C")!];
    b.online = false;
    a.bridges.nodeLeft("B");
    c.bridges.nodeLeft("B");
    expect(remoteOn(c, 102)).toEqual([infos[0]]);
    expect(remoteOn(a, 100)).toEqual([infos[2]]);
  });

  it("makes one bridge per pair of nodes when both open the call at once", async () => {
    const nodes = network(2);
    const [a, b] = [nodes.get("A")!, nodes.get("B")!];
    await Promise.all([memberOn(a, "a1", 101, "mic"), memberOn(b, "b1", 202, "mic")]);
    await settle();
    expect(a.routers[0].pipes).toHaveLength(1);
    expect(b.routers[0].pipes).toHaveLength(1);
    // And the two ends are each other's.
    const [pipeA, pipeB] = [a.routers[0].pipes[0], b.routers[0].pipes[0]];
    expect(pipeA.remote?.port).toBe(pipeB.tuple.localPort);
    expect(pipeB.remote?.port).toBe(pipeA.tuple.localPort);
    expect(remoteOn(a, 101)).toHaveLength(1);
    expect(remoteOn(b, 202)).toHaveLength(1);
  });

  it("takes a node's members' producers off the others when that node goes away", async () => {
    const nodes = network(2);
    const [a, b] = [nodes.get("A")!, nodes.get("B")!];
    const mic = await memberOn(a, "a1", 101, "mic");
    await memberOn(b, "b1", 202, "mic");
    a.online = false;
    b.bridges.nodeLeft("A");
    expect(remoteOn(b, 202)).toEqual([]);
    expect(b.notices).toContainEqual({ producerClosed: { id: mic.id } });
  });

  it("unlinks the other nodes when its call empties", async () => {
    const nodes = network(2);
    const [a, b] = [nodes.get("A")!, nodes.get("B")!];
    const mic = await memberOn(a, "a1", 101, "mic");
    await memberOn(b, "b1", 202, "mic");
    a.calls.get(call)!.leave("a1");
    a.bridges.emptied(call);
    await settle();
    expect(remoteOn(b, 202)).toEqual([]);
    expect(b.notices).toContainEqual({ producerClosed: { id: mic.id } });
  });

  it("links a node that comes online while the call is going", async () => {
    const nodes = network(2);
    const [a, b] = [nodes.get("A")!, nodes.get("B")!];
    b.online = false;
    const mic = await memberOn(a, "a1", 101, "mic");
    // B was unreachable when A opened the call; it serves it now and comes online.
    const camera = await memberOn(b, "b1", 202, "camera");
    expect(remoteOn(b, 202)).toEqual([]);
    b.online = true;
    await a.bridges.nodeOnline("B");
    await settle();
    expect(remoteOn(b, 202)).toEqual([mic]);
    expect(remoteOn(a, 101)).toEqual([camera]);
  });

  it("bridges only with authorized nodes", async () => {
    const nodes = network(1);
    await memberOn(nodes.get("A")!, "a1", 101, "mic");
    expect(await nodes.get("A")!.bridges.handle("stranger", { serving: { call } })).toEqual({ ok: false, error: "not a node of this server" });
  });

  // Two nodes at home behind one router share its public address. Linked through it, the packets had to come back in
  // through the router (NAT hairpin) to the right machine, with both nodes' ports forwarded on one address: the links
  // of the node test closed soon after (2026-10-17). They link over their LAN addresses.
  it("links two nodes behind the same router over their LAN addresses", async () => {
    const nodes = network(3, { address: (name) => (name === "C" ? "198.51.100.9" : "203.0.113.7"), lan: (name) => `192.168.2.${name.charCodeAt(0)}` });
    const [a, b, c] = [nodes.get("A")!, nodes.get("B")!, nodes.get("C")!];
    await memberOn(a, "a1", 101, "mic");
    await memberOn(b, "b1", 202, "mic");
    await memberOn(c, "c1", 303, "mic");
    const remotes = (n: FakeNode) => n.routers[0].pipes.map((p) => p.remote?.ip).sort();
    // A and B: same public address, so each other's LAN address; C elsewhere: its public one, and theirs to it.
    expect(remotes(a)).toEqual(["192.168.2.66", "198.51.100.9"]);
    expect(remotes(b)).toEqual(["192.168.2.65", "198.51.100.9"]);
    expect(remotes(c)).toEqual(["203.0.113.7", "203.0.113.7"]);
    expect(remoteOn(a, 101).map((p) => p.user).sort()).toEqual([202, 303]);
  });

  it("doesn't bridge without an address to announce", async () => {
    const nodes = network(2, { address: (name) => (name === "B" ? "" : `10.0.0.1`) });
    const [a, b] = [nodes.get("A")!, nodes.get("B")!];
    await memberOn(a, "a1", 101, "mic");
    await memberOn(b, "b1", 202, "mic");
    expect(a.routers[0].pipes).toHaveLength(0);
    expect(b.routers[0].pipes).toHaveLength(0);
  });

  it("closes a pipe transport that was still being made when its bridge closed", async () => {
    const nodes = network(2);
    const [a, b] = [nodes.get("A")!, nodes.get("B")!];
    await memberOn(a, "a1", 101, "mic");
    let release!: () => void;
    a.routers[0].hold = new Promise((resolve) => (release = resolve));
    // B opens the call: A (the smaller user number) starts linking, its pipe transport not made yet.
    const opening = memberOn(b, "b1", 202, "mic");
    await new Promise((resolve) => setTimeout(resolve, 10));
    a.bridges.nodeLeft("B");
    release();
    await opening;
    await settle();
    expect(a.routers[0].pipes.every((p) => p.closed)).toBe(true);
  });

  it("keeps the newer bridge when an older link to the same node fails or arrives late", async () => {
    const nodes = network(2);
    const [a, b] = [nodes.get("A")!, nodes.get("B")!];
    await memberOn(a, "a1", 101, "mic");
    // A's first link to B hangs on the way.
    const releaseLink = nodes.holdOnce("link");
    const camera = await memberOn(b, "b1", 202, "camera");
    // B drops away and comes back: A links again, and that link goes through.
    a.bridges.nodeLeft("B");
    await a.bridges.nodeOnline("B");
    await settle();
    expect(remoteOn(a, 101)).toEqual([camera]);
    // Now the first link arrives at B, late.
    releaseLink();
    await settle();
    expect(remoteOn(a, 101)).toEqual([camera]);
    expect(remoteOn(b, 202)).toHaveLength(1);
    const open = (node: FakeNode) => node.routers[0].pipes.filter((p) => !p.closed);
    expect(open(a)).toHaveLength(1);
    expect(open(b)).toHaveLength(1);
    expect(open(a)[0].remote?.port).toBe(open(b)[0].tuple.localPort);
  });

  it("links again after its worker died and a member came back", async () => {
    const nodes = network(2);
    const [a, b] = [nodes.get("A")!, nodes.get("B")!];
    await memberOn(a, "a1", 101, "mic");
    await memberOn(b, "b1", 202, "mic");
    // A's worker dies: its calls went with it, and the node starts over (host.ts drops its calls and bridges).
    a.calls.close();
    a.calls = new SfuCalls(a.worker, (_call, _peer, notice) => a.notices.push(notice));
    a.bridges.reset();
    await settle();
    const mic = await memberOn(a, "a2", 102, "mic");
    expect(remoteOn(b, 202)).toEqual([mic]);
  });

  it("takes a producer back, and sends it again, when the other node answered its pipe too late", async () => {
    const nodes = network(2);
    const [a, b] = [nodes.get("A")!, nodes.get("B")!];
    // Whichever node's pipe goes first is the one answered too late.
    nodes.lateOnce("pipe");
    const micA = await memberOn(a, "a1", 101, "mic");
    const micB = await memberOn(b, "b1", 202, "mic");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await settle();
    // Each node has the other's mic once, and a live one (fed by a pipe consumer the sender still keeps).
    expect(remoteOn(b, 202)).toEqual([micA]);
    expect(remoteOn(a, 101)).toEqual([micB]);
    for (const [node, id] of [[b, micA.id], [a, micB.id]] as const) {
      expect([...node.routers[0].pipes[0].produced].filter((p) => p.id === id && !p.closed)).toHaveLength(1);
    }
    // The late one was sent twice: three consumes in all.
    expect([...a.routers[0].pipes[0].consumed, ...b.routers[0].pipes[0].consumed]).toHaveLength(3);
  });

  it("links again when a link got no answer", async () => {
    const nodes = network(2);
    const [a, b] = [nodes.get("A")!, nodes.get("B")!];
    nodes.dropOnce("link");
    const mic = await memberOn(a, "a1", 101, "mic");
    await memberOn(b, "b1", 202, "mic");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await settle();
    expect(remoteOn(b, 202)).toEqual([mic]);
  });

  it("sends no producer that ended while its pipe was being made", async () => {
    const nodes = network(2);
    const [a, b] = [nodes.get("A")!, nodes.get("B")!];
    await memberOn(a, "a1", 101, "mic");
    await memberOn(b, "b1", 202, "mic");
    const member = a.calls.get(call)!.tryJoin("a2", 102, 10)!;
    await member.create("send");
    const camera = await member.produce("camera", {});
    let release!: () => void;
    a.routers[0].consumeHold = new Promise((resolve) => (release = resolve));
    a.bridges.produced(call, camera);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The camera turns off before the pipe's consumer came back.
    await member.close(camera.id);
    a.bridges.ended(call, [camera.id]);
    release();
    await settle();
    expect(remoteOn(b, 202).map((p) => p.id)).not.toContain(camera.id);
  });

  it("sends again a producer whose pipe was lost on the way, and the other node takes it", async () => {
    const nodes = network(2);
    const [a, b] = [nodes.get("A")!, nodes.get("B")!];
    // Lost, never delivered: the "take it back" that follows is about a pipe the other node never saw.
    nodes.dropOnce("pipe");
    const micA = await memberOn(a, "a1", 101, "mic");
    const micB = await memberOn(b, "b1", 202, "mic");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await settle();
    expect(remoteOn(b, 202)).toEqual([micA]);
    expect(remoteOn(a, 101)).toEqual([micB]);
    for (const [node, id] of [[b, micA.id], [a, micB.id]] as const) {
      expect([...node.routers[0].pipes[0].produced].filter((p) => p.id === id && !p.closed)).toHaveLength(1);
    }
  });

  it("links two nodes when the recheck finds a call both serve unlinked (its 'serving' was lost)", async () => {
    const nodes = network(2);
    const [a, b] = [nodes.get("A")!, nodes.get("B")!];
    await memberOn(a, "a1", 101, "mic");
    nodes.dropOnce("serving");
    const micB = await memberOn(b, "b1", 202, "mic");
    expect(remoteOn(a, 101)).toEqual([]);
    await a.bridges.recheck();
    await settle();
    expect(remoteOn(a, 101)).toEqual([micB]);
  });

  it("drops a bridge the other node no longer has (its 'unlink' was lost), and links again", async () => {
    const nodes = network(2);
    const [a, b] = [nodes.get("A")!, nodes.get("B")!];
    await memberOn(a, "a1", 101, "mic");
    const old = await memberOn(b, "b1", 202, "mic");
    // B's members leave; its "unlink" never reaches A (the node that links), which keeps B's old mic and its bridge.
    nodes.dropOnce("unlink");
    b.calls.get(call)!.leave("b1");
    b.bridges.emptied(call);
    b.calls.drop(call);
    await settle();
    expect(remoteOn(a, 101)).toEqual([old]);
    // A member comes back to B: A learns B has no bridge, drops its stale one, and the two link again.
    const mic = await memberOn(b, "b2", 203, "mic");
    await settle();
    expect(remoteOn(a, 101)).toEqual([mic]);
  });
});
