// The node's side of a call through it (src/node/sfu.ts), over a fake mediasoup. The native addon never loads: the
// Sfu* interfaces exist for exactly this. What is checked is the node's own deciding: how many members a call takes,
// which producers a joining member is told about, that a consumer learns the producer's kind, and that the others
// hear when a producer goes away.
import { describe, expect, it, vi } from "vitest";
import { mediaListenInfos, SfuCalls, sharedWorker, sfuMediaCodecs, type SfuRouterLike, type SfuWorkerLike } from "../../src/node/sfu";
import type { SfuNotify } from "../../src/p2p/sfuProtocol";

let counter = 0;

class FakeProducer {
  appData: Record<string, unknown>;
  private gone: (() => void)[] = [];
  constructor(readonly id: string, readonly kind: string, appData: Record<string, unknown>) {
    this.appData = appData;
  }
  onClosed(callback: () => void) {
    this.gone.push(callback);
  }
  closed = false;
  close() {
    // mediasoup's producer.close() is silent; only its transport closing fires "transportclose".
    this.closed = true;
  }
  transportClosed() {
    for (const callback of this.gone.splice(0)) callback();
  }
}

class FakeConsumer {
  paused = true;
  rtpParameters = { codecs: [] };
  constructor(readonly id: string, readonly producerId: string) {}
  resume() {
    this.paused = false;
    return Promise.resolve();
  }
  closed = false;
  close() {
    this.paused = true;
    this.closed = true;
  }
}

class FakeTransport {
  readonly id = `t${++counter}`;
  readonly iceParameters = { ufrag: this.id };
  readonly iceCandidates = [{ ip: "0.0.0.0", port: 40000 + counter }];
  readonly dtlsParameters = { role: "auto" as const };
  readonly producers = new Set<FakeProducer>();
  readonly consumers = new Set<FakeConsumer>();
  connected = false;
  closed = false;
  // mediasoup's "icestatechange" listeners; `ice(state)` plays one.
  private readonly iceListeners: ((state: string) => void)[] = [];
  constructor(private readonly router: FakeRouter) {}
  onIceState(callback: (state: string) => void) {
    this.iceListeners.push(callback);
  }
  ice(state: string) {
    for (const listener of this.iceListeners) listener(state);
  }
  connect() {
    this.connected = true;
    return Promise.resolve();
  }
  produce(options: { kind: string; appData: Record<string, unknown> }) {
    const producer = new FakeProducer(`p${++counter}`, options.kind, options.appData);
    this.producers.add(producer);
    this.router.producers.set(producer.id, producer);
    return Promise.resolve(producer);
  }
  consume(options: { producerId: string }) {
    const consumer = new FakeConsumer(`c${++counter}`, options.producerId);
    this.consumers.add(consumer);
    return Promise.resolve(consumer);
  }
  close() {
    this.closed = true;
    for (const producer of this.producers) producer.transportClosed();
    this.producers.clear();
    this.consumers.clear();
  }
}

class FakeRouter {
  rtpCapabilities = { codecs: sfuMediaCodecs };
  allow = true;
  closed = false;
  readonly transports: FakeTransport[] = [];
  readonly producers = new Map<string, FakeProducer>();
  canConsume(producerId: string) {
    return this.allow && this.producers.has(producerId);
  }
  createWebRtcTransport() {
    const transport = new FakeTransport(this);
    this.transports.push(transport);
    return Promise.resolve(transport);
  }
  close() {
    for (const transport of this.transports) transport.close();
    this.closed = true;
  }
}

function fakeWorker() {
  const routers: FakeRouter[] = [];
  const listeners = new Set<() => void>();
  let closed = false;
  const worker = {
    async createRouter() {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const router = new FakeRouter();
      routers.push(router);
      return router as unknown as SfuRouterLike;
    },
    onDied(callback: () => void) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    close() {
      closed = true;
    },
  };
  const die = () => [...listeners].forEach((listener) => listener());
  return { worker: worker as SfuWorkerLike, routers, die, closed: () => closed, listeners: () => listeners.size };
}

function setup() {
  const fake = fakeWorker();
  const notices: { channelId: number; peer: string; notice: SfuNotify }[] = [];
  const calls = new SfuCalls(fake.worker, (channelId, peer, notice) => notices.push({ channelId, peer, notice }));
  return { ...fake, calls, notices };
}

const idOf = (transport: Record<string, unknown>) => transport.id as string;

describe("a node's calls", () => {
  it("takes members up to its cap, keeps a rejoining device's place, and refuses past it", async () => {
    const { calls } = setup();
    const call = await calls.open(5);
    expect(await calls.open(5)).toBe(call);
    expect(call.tryJoin("a", 11, 2)).not.toBeNull();
    expect(call.tryJoin("b", 22, 2)).not.toBeNull();
    expect(call.tryJoin("c", 33, 2)).toBeNull();
    // The same device again (reconnecting) is already counted.
    expect(call.tryJoin("a", 11, 2)).not.toBeNull();
    expect(call.size).toBe(2);
    call.leave("b");
    expect(call.tryJoin("c", 33, 2)).not.toBeNull();
  });

  it("gives members opening a call at once the same call, with one router", async () => {
    const { calls, routers } = setup();
    // The fake router comes back after a turn of the event loop, like mediasoup's worker answering.
    const [a, b, c] = await Promise.all([calls.open(5), calls.open(5), calls.open(5)]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(routers).toHaveLength(1);
    expect(calls.get(5)).toBe(a);
    // A later call on another channel gets its own router.
    expect(await calls.open(6)).not.toBe(a);
    expect(routers).toHaveLength(2);
  });

  it("tells a joining member the producers already in the call, not its own", async () => {
    const { calls, routers } = setup();
    const call = await calls.open(5);
    const a = call.tryJoin("a", 11, 100)!;
    await a.create("send");
    const mic = await a.produce("mic", {});
    const camera = await a.produce("camera", {});
    expect(call.producers(11)).toEqual([]);
    expect(call.producers(22).map((p) => p.kind).sort()).toEqual(["camera", "mic"]);
    expect(call.producerInfo(mic.id)?.kind).toBe("mic");
    expect(call.producerInfo(camera.id)?.user).toBe(11);
    expect(call.producerInfo("nope")).toBeNull();
    // The wire keeps the call kinds; mediasoup only knows audio and video.
    expect(routers[0].producers.get(mic.id)?.kind).toBe("audio");
    expect(routers[0].producers.get(camera.id)?.kind).toBe("video");
  });

  it("names a producer's media kind when a member consumes it", async () => {
    const { calls, routers } = setup();
    const call = await calls.open(5);
    const a = call.tryJoin("a", 11, 100)!;
    await a.create("send");
    const mic = await a.produce("mic", {});
    const b = call.tryJoin("b", 22, 100)!;
    await b.create("recv");
    const consumed = await b.consume(mic.id, {}) as { id: string; producerId: string; kind: string; paused: boolean };
    expect(consumed.producerId).toBe(mic.id);
    expect(consumed.kind).toBe("audio");
    expect(consumed.paused).toBe(true);
    await b.resume(consumed.id);
    // The router refuses a producer it doesn't have (or that the member's capabilities can't take).
    routers[0].allow = false;
    expect(await b.consume(mic.id, {})).toBeNull();
  });

  it("tells the rest of the call when a producer goes away", async () => {
    const { calls, notices } = setup();
    const call = await calls.open(5);
    const a = call.tryJoin("a", 11, 100)!;
    await a.create("send");
    const mic = await a.produce("mic", {});
    await a.close(mic.id);
    expect(notices).toContainEqual({ channelId: 5, peer: "a", notice: { producerClosed: { id: mic.id } } });
    expect(call.producers(22)).toEqual([]);
  });

  it("tells the rest of the call about every producer of a member that left", async () => {
    const { calls, notices } = setup();
    const call = await calls.open(5);
    const a = call.tryJoin("a", 11, 100)!;
    await a.create("send");
    const mic = await a.produce("mic", {});
    const camera = await a.produce("camera", {});
    call.leave("a");
    expect(call.isEmpty).toBe(true);
    const closed = notices.map((n) => (n.notice as { producerClosed: { id: string } }).producerClosed.id).sort();
    expect(closed).toEqual([mic.id, camera.id].sort());
  });

  it("drops a member's producers and consumers when it reconnects on a new device", async () => {
    const { calls, notices } = setup();
    const call = await calls.open(5);
    const a = call.tryJoin("a", 11, 100)!;
    await a.create("send");
    const mic = await a.produce("mic", {});
    const again = call.tryJoin("a", 11, 100)!;
    expect(call.size).toBe(1);
    expect(call.producers(22)).toEqual([]);
    expect(notices).toContainEqual({ channelId: 5, peer: "a", notice: { producerClosed: { id: mic.id } } });
    // The new device starts from nothing.
    await again.create("send");
    expect((await again.produce("mic", {})).user).toBe(11);
  });

  it("sends a member's two transports and connects them by id", async () => {
    const { calls, routers } = setup();
    const call = await calls.open(5);
    const a = call.tryJoin("a", 11, 100)!;
    const send = await a.create("send");
    const recv = await a.create("recv");
    expect(idOf(send)).not.toBe(idOf(recv));
    expect(routers[0].transports).toHaveLength(2);
    await a.connect(idOf(send), { role: "auto" });
    await a.connect(idOf(recv), { role: "auto" });
    await expect(a.connect("nope", {})).rejects.toThrow("no such transport");
  });

  it("warns when a member's media never reaches the node, and not once it did or the member left", async () => {
    const { calls, routers } = setup();
    const call = await calls.open(5);
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      // The member answered over the mesh and started its transport, but ICE never got through (the port not forwarded).
      const a = call.tryJoin("a", 11, 100)!;
      await a.connect(idOf(await a.create("send")), {});
      // This one's media came in.
      const b = call.tryJoin("b", 22, 100)!;
      await b.connect(idOf(await b.create("send")), {});
      routers[0].transports[1].ice("connected");
      // This one left before the wait was over.
      const c = call.tryJoin("c", 33, 100)!;
      await c.connect(idOf(await c.create("recv")), {});
      call.leave("c");
      vi.advanceTimersByTime(20_000);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/user 11 send got no media.*--rtc-port/);
      expect(info).toHaveBeenCalledWith("[sfu] call 5: user 22 send ICE connected");
    } finally {
      warn.mockRestore();
      info.mockRestore();
      vi.useRealTimers();
    }
  });

  it("doesn't warn about a transport the member never started using", async () => {
    const { calls } = setup();
    const call = await calls.open(5);
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      // The client makes its recv transport before asking to consume; the node couldn't send yet, so the browser never
      // connected it and no ICE could arrive, whether the media port is reachable or not.
      const a = call.tryJoin("a", 11, 100)!;
      const recv = await a.create("recv");
      vi.advanceTimersByTime(60_000);
      expect(warn).not.toHaveBeenCalled();
      // Used later: timed from then.
      await a.connect(idOf(recv), {});
      vi.advanceTimersByTime(19_000);
      expect(warn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_000);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/user 11 recv got no media/);
    } finally {
      warn.mockRestore();
      info.mockRestore();
      vi.useRealTimers();
    }
  });

  it("logs what a call carries when it changes: who sends what to how many, and whose media isn't connected", async () => {
    const { calls, routers } = setup();
    const call = await calls.open(5);
    vi.useFakeTimers();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const summaries = () => info.mock.calls.map((args) => String(args[0])).filter((line) => /: \d+ members? here/.test(line));
    try {
      // A member shares its screen with two others; one of them never got its media through.
      const a = call.tryJoin("a", 11, 100)!;
      await a.connect(idOf(await a.create("send")), {});
      const screen = await a.produce("screen", {});
      const mic = await a.produce("mic", {});
      const b = call.tryJoin("b", 22, 100)!;
      await b.connect(idOf(await b.create("recv")), {});
      const c = call.tryJoin("c", 33, 100)!;
      await c.connect(idOf(await c.create("recv")), {});
      for (const member of [b, c]) for (const producer of [screen, mic]) await member.resume(idOf((await member.consume(producer.id, {}))!));
      routers[0].transports[0].ice("connected");
      routers[0].transports[1].ice("connected");
      // User 33's consumers exist, but nothing reaches it through the node: it isn't counted as receiving.
      vi.advanceTimersByTime(5_000);
      expect(summaries()).toEqual([
        "[sfu] call 5: 3 members here; user 11 sends screen (to 1), mic (to 1); user 22 receives 2; user 33 recv not connected",
      ]);
      // A change that leaves the line the same logs nothing again; one that changes it does.
      routers[0].transports[1].ice("completed");
      vi.advanceTimersByTime(5_000);
      expect(summaries()).toHaveLength(1);
      routers[0].transports[2].ice("connected");
      vi.advanceTimersByTime(5_000);
      expect(summaries()[1]).toBe("[sfu] call 5: 3 members here; user 11 sends screen (to 2), mic (to 2); user 22 receives 2; user 33 receives 2");
      // The call ends: the log says so, since its last line named members who are gone.
      call.close();
      expect(info).toHaveBeenLastCalledWith("[sfu] call 5: closed");
    } finally {
      info.mockRestore();
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("logs a busy call within 5 s, and a big one in totals", async () => {
    const { calls, routers } = setup();
    const call = await calls.open(5);
    vi.useFakeTimers();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const summaries = () => info.mock.calls.map((args) => String(args[0])).filter((line) => /: \d+ members? here/.test(line));
    try {
      // Members joining a second apart: the call never stops changing, and is logged 5 s after its first member.
      let firstAt = -1;
      for (let i = 0; i < 13; i++) {
        const member = call.tryJoin(`p${i}`, 100 + i, 100)!;
        await member.connect(idOf(await member.create("send")), {});
        await member.produce("mic", {});
        vi.advanceTimersByTime(1_000);
        if (firstAt < 0 && summaries().length) firstAt = i + 1;
      }
      expect(firstAt).toBe(5);
      // 13 members: totals, with the one whose media isn't connected named.
      for (const transport of routers[0].transports.slice(1)) transport.ice("connected");
      vi.advanceTimersByTime(5_000);
      expect(summaries().at(-1)).toBe("[sfu] call 5: 13 members here; 13 sending, 0 receiving; not connected: user 100 send");
    } finally {
      info.mockRestore();
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("closes a transport the router made after its member left", async () => {
    const { calls, routers } = setup();
    const call = await calls.open(5);
    const a = call.tryJoin("a", 11, 100)!;
    // The member asked for a transport, then left before the router made it.
    const made = a.create("send");
    call.leave("a");
    await expect(made).rejects.toThrow("left the call");
    expect(routers[0].transports[0].closed).toBe(true);
  });

  it("closes a consumer or producer mediasoup made after its member left", async () => {
    const { calls, routers } = setup();
    const call = await calls.open(5);
    const a = call.tryJoin("a", 11, 100)!;
    await a.create("send");
    const mic = await a.produce("mic", {});
    const b = call.tryJoin("b", 22, 100)!;
    await b.create("recv");
    await b.create("send");
    // What mediasoup hands back (the transports forget theirs when they close with the member).
    const [, recv, send] = routers[0].transports;
    const made: { closed: boolean }[] = [];
    const consume = recv.consume.bind(recv);
    recv.consume = (options) => consume(options).then((consumer) => (made.push(consumer), consumer));
    const produce = send.produce.bind(send);
    send.produce = (options) => produce(options).then((producer) => (made.push(producer), producer));
    const consumed = b.consume(mic.id, {});
    const produced = b.produce("mic", {});
    call.leave("b");
    await expect(consumed).rejects.toThrow("left the call");
    await expect(produced).rejects.toThrow("left the call");
    expect(made.map((item) => item.closed)).toEqual([true, true]);
  });

  it("starts no summary on a call that closed before a late join reached it", async () => {
    const { calls } = setup();
    const call = await calls.open(5);
    vi.useFakeTimers();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      call.close();
      call.tryJoin("a", 11, 100);
      vi.advanceTimersByTime(20_000);
      expect(info).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
      vi.useRealTimers();
    }
  });

  it("doesn't warn about a transport whose ICE connected before its connect answered, or log an old one's ICE", async () => {
    const { calls, routers } = setup();
    const call = await calls.open(5);
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const a = call.tryJoin("a", 11, 100)!;
      const send = idOf(await a.create("send"));
      const [first] = routers[0].transports;
      // Media came in and dropped for a moment while the connect was answered.
      first.connect = () => {
        first.ice("connected");
        first.ice("disconnected");
        return Promise.resolve();
      };
      await a.connect(send, {});
      vi.advanceTimersByTime(20_000);
      expect(warn).not.toHaveBeenCalled();
      // A replaced transport's ICE isn't the member's media any more.
      await a.create("send");
      info.mockClear();
      first.ice("disconnected");
      expect(info).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      info.mockRestore();
      vi.useRealTimers();
    }
  });

  it("doesn't wait for media on a transport whose connect failed", async () => {
    const { calls, routers } = setup();
    const call = await calls.open(5);
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const a = call.tryJoin("a", 11, 100)!;
      const send = await a.create("send");
      routers[0].transports[0].connect = () => Promise.reject(new Error("bad DTLS parameters"));
      await expect(a.connect(idOf(send), {})).rejects.toThrow("bad DTLS parameters");
      vi.advanceTimersByTime(20_000);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      info.mockRestore();
      vi.useRealTimers();
    }
  });

  it("refuses to produce twice on one kind, and to consume before a recv transport exists", async () => {
    const { calls } = setup();
    const call = await calls.open(5);
    const a = call.tryJoin("a", 11, 100)!;
    await expect(a.produce("mic", {})).rejects.toThrow("create the send transport first");
    await a.create("send");
    await a.produce("mic", {});
    await expect(a.produce("mic", {})).rejects.toThrow("already sending mic");
    await expect(a.consume("x", {})).rejects.toThrow("create the recv transport first");
  });

  it("forgets a member's consumers of a producer that went away, and those of a replaced recv transport", async () => {
    const { calls } = setup();
    const call = await calls.open(5);
    const a = call.tryJoin("a", 11, 100)!;
    await a.create("send");
    const camera = await a.produce("camera", {});
    const mic = await a.produce("mic", {});
    const b = call.tryJoin("b", 22, 100)!;
    await b.create("recv");
    const ofCamera = (await b.consume(camera.id, {})) as { id: string };
    const ofMic = (await b.consume(mic.id, {})) as { id: string };
    // The camera turned off: its consumers on the other members go (mediasoup closed them).
    await a.close(camera.id);
    await expect(b.resume(ofCamera.id)).rejects.toThrow("no such consumer");
    await b.resume(ofMic.id);
    // A new recv transport: the old one's consumers closed with it.
    await b.create("recv");
    await expect(b.resume(ofMic.id)).rejects.toThrow("no such consumer");
  });

  it("closes every call when the worker dies", async () => {
    const { calls, die } = setup();
    const call = await calls.open(5);
    call.tryJoin("a", 11, 100)!;
    die();
    expect(calls.get(5)).toBeUndefined();
  });

  it("closes only its own calls, never the worker every hosted server shares, and stops listening to it", async () => {
    const { calls, closed, routers, listeners } = setup();
    await calls.open(5);
    expect(listeners()).toBe(1);
    calls.close();
    expect(routers[0].closed).toBe(true);
    expect(closed()).toBe(false);
    // Nothing of this server stays reachable through the shared worker.
    expect(listeners()).toBe(0);
  });

  it("gives every hosted server one worker, and a new one after it died", async () => {
    const made: ReturnType<typeof fakeWorker>[] = [];
    const shared = sharedWorker(async () => {
      const fake = fakeWorker();
      made.push(fake);
      return fake.worker;
    });
    const [a, b] = await Promise.all([shared.get(), shared.get()]);
    expect(b).toBe(a);
    expect(made).toHaveLength(1);
    made[0].die();
    expect(await shared.get()).not.toBe(a);
    expect(made).toHaveLength(2);
    shared.close();
    expect(made[1].closed()).toBe(true);
  });

  it("closes a worker that was still starting when the node stopped", async () => {
    const fake = fakeWorker();
    let release!: (worker: SfuWorkerLike) => void;
    const shared = sharedWorker(() => new Promise<SfuWorkerLike>((resolve) => (release = resolve)));
    const starting = shared.get();
    shared.close();
    release(fake.worker);
    await starting.catch(() => {});
    await Promise.resolve();
    expect(fake.closed()).toBe(true);
  });

  it("takes the opus mic and VP8 camera codecs", () => {
    expect(sfuMediaCodecs.some((codec) => codec.mimeType === "audio/opus")).toBe(true);
    expect(sfuMediaCodecs.some((codec) => codec.mimeType === "video/VP8")).toBe(true);
  });
});

// Where members' call media comes in: one port, UDP and TCP (a member behind a strict NAT falls back to TCP).
describe("the node's media port", () => {
  it("listens on the LAN address behind a router, announcing the public one and offering the LAN one too", () => {
    // 2026-10-15: a node on the sharer's LAN announced only its public address; the sharer dialed it from inside (no
    // NAT hairpin) and nothing came through the node.
    expect(mediaListenInfos({ port: 40000, address: "203.0.113.7", lanAddress: "192.168.1.20" })).toEqual([
      { protocol: "udp", ip: "192.168.1.20", port: 40000, announcedAddress: "203.0.113.7", exposeInternalIp: true },
      { protocol: "tcp", ip: "192.168.1.20", port: 40000, announcedAddress: "203.0.113.7", exposeInternalIp: true },
    ]);
  });

  it("listens everywhere on a machine whose own address is the public one", () => {
    for (const lanAddress of [null, "203.0.113.7"]) {
      expect(mediaListenInfos({ port: 40000, address: "203.0.113.7", lanAddress })).toEqual([
        { protocol: "udp", ip: "0.0.0.0", port: 40000, announcedAddress: "203.0.113.7" },
        { protocol: "tcp", ip: "0.0.0.0", port: 40000, announcedAddress: "203.0.113.7" },
      ]);
    }
  });

  it("announces nothing without a public address (such a node serves no call)", () => {
    expect(mediaListenInfos({ port: 40000, address: "" }).map((info) => info.announcedAddress)).toEqual([undefined, undefined]);
  });
});
