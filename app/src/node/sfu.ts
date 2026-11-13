// The node's side of a call through it (ADR 0005): one mediasoup router per call (a voice channel), a send and a
// recv WebRTC transport per member. The node is the arbiter of a call (it decides whether it serves, who may join
// and what they may send), so every member agrees whether the call is an SFU call. The heavy mediasoup worker hides
// behind the Sfu* interfaces so tests run without the native addon ever loading.
import { plural } from "../core/plural";
import { mediaKind, type SfuKind, type SfuNotify, type SfuProducerInfo } from "../p2p/sfuProtocol";

// The parts of a mediasoup worker, router, transport, producer and consumer the node uses. The real worker
// (openMediasoupWorker) satisfies these; tests build a fake.
export interface SfuWorkerLike {
  createRouter(options: { mediaCodecs: { kind: string; mimeType: string; clockRate: number; channels?: number }[] }): Promise<SfuRouterLike>;
  // Returns a stop: listeners of a worker every hosted server shares must go with their server.
  onDied(callback: () => void): () => void;
  close(): void;
}

export interface SfuRouterLike {
  rtpCapabilities: unknown;
  canConsume(producerId: string, rtpCapabilities: unknown): boolean;
  // A member's transport, on the worker's one media port (`mediaListenInfos`): the worker decides where it listens.
  createWebRtcTransport(): Promise<SfuTransportLike>;
  // A transport to another node's router (a call split across nodes, ADR 0007): plain RTP over UDP, with RTX for loss
  // on the way and SRTP so the media is encrypted between the nodes.
  createPipeTransport(options: {
    listenInfo: { protocol: "udp"; ip: string; announcedAddress?: string };
    enableRtx: boolean;
    enableSrtp: boolean;
  }): Promise<SfuPipeTransportLike>;
  close(): void;
}

export interface SfuPipeTransportLike {
  readonly id: string;
  // Where the other node sends to (the announced address), and the keys it encrypts with.
  readonly tuple: { localAddress: string; localPort: number };
  readonly srtpParameters: unknown;
  connect(options: { ip: string; port: number; srtpParameters?: unknown }): Promise<void>;
  // Sends a producer of this router to the other node; the result is what the other node produces with.
  consume(options: { producerId: string }): Promise<SfuPipeConsumerLike>;
  // Takes the other node's producer into this router, under the id it has there.
  produce(options: { id: string; kind: "audio" | "video"; rtpParameters: unknown; paused: boolean; appData: Record<string, unknown> }): Promise<SfuProducerLike>;
  close(): void;
}

export interface SfuPipeConsumerLike {
  readonly id: string;
  readonly kind: "audio" | "video";
  readonly rtpParameters: unknown;
  readonly producerPaused: boolean;
  close(): void;
}

export interface SfuTransportLike {
  readonly id: string;
  readonly iceParameters: unknown;
  readonly iceCandidates: unknown;
  readonly dtlsParameters: unknown;
  connect(dtlsParameters: unknown): Promise<void>;
  // mediasoup's ICE state ("new", "connected", "completed", "disconnected"), for the node's log.
  onIceState?(callback: (state: string) => void): void;
  // `kind` is mediasoup's media kind, never a call kind ("mic"/"camera"): the interface speaks mediasoup's contract.
  produce(options: { kind: "audio" | "video"; rtpParameters: unknown; appData: Record<string, unknown> }): Promise<SfuProducerLike>;
  consume(options: { producerId: string; rtpCapabilities: unknown }): Promise<SfuConsumerLike>;
  close(): void;
}

export interface SfuProducerLike {
  readonly id: string;
  appData: Record<string, unknown>;
  // Fires when the producer leaves the router (its transport closed, its router closed, it was closed remotely).
  onClosed(callback: () => void): void;
  close(): void;
}

export interface SfuConsumerLike {
  readonly id: string;
  readonly producerId: string;
  readonly paused: boolean;
  rtpParameters: unknown;
  resume(): Promise<void>;
  close(): void;
}

// How long a member's transport may go without ICE, once the member started using it, before the node warns that its
// media port isn't reached.
const noMediaMs = 20_000;

// How often the node looks at what a call carries (logged only when it changed), and how many members its line names.
const summaryEveryMs = 5_000;
const summaryListMax = 12;

// The media codecs a router accepts: the same as mesh calls (opus mic, VP8 camera).
export const sfuMediaCodecs = [
  { kind: "audio" as const, mimeType: "audio/opus", clockRate: 48000, channels: 2 },
  { kind: "video" as const, mimeType: "video/VP8", clockRate: 90000 },
];

// Where members' call media comes in: one port (UDP and TCP) for every member, announced as the node's public address
// (`address`), and its own address on the route out (`lanAddress`, a home node's LAN address) when that differs.
export interface MediaPlace {
  port: number;
  address: string;
  lanAddress?: string | null;
}

export type MediaListenInfo = {
  protocol: "udp" | "tcp";
  ip: string;
  port: number;
  announcedAddress?: string;
  exposeInternalIp?: boolean;
};

// The listeners of the worker's media port. Behind a home router a member on the node's own network dialed the
// public address and reached nothing (no NAT hairpin), so the LAN address is offered beside it; the socket is bound to
// it, where the router forwards the port to. A machine whose own address is the public one listens everywhere.
export function mediaListenInfos(place: MediaPlace): MediaListenInfo[] {
  const local = place.lanAddress && place.lanAddress !== place.address ? place.lanAddress : null;
  return (["udp", "tcp"] as const).map((protocol) => ({
    protocol,
    ip: local ?? "0.0.0.0",
    port: place.port,
    ...(place.address ? { announcedAddress: place.address } : {}),
    ...(local && place.address ? { exposeInternalIp: true } : {}),
  }));
}

// The real worker. The import is dynamic so loading this file in a test never touches the native addon. Members'
// transports share one WebRtcServer on `media.port`, so a node behind a router needs that one port forwarded (each
// transport took a random port of the range before: 50,000 ports to forward, so a home node's calls never connected).
// Pipe transports between nodes (sfuBridge.ts) still take theirs from the range.
export async function openMediasoupWorker(options: { rtcMinPort?: number; rtcMaxPort?: number; media: MediaPlace }): Promise<SfuWorkerLike> {
  const mediasoup = await import("mediasoup");
  const worker = await mediasoup.createWorker({
    ...(options.rtcMinPort ? { rtcMinPort: options.rtcMinPort } : {}),
    ...(options.rtcMaxPort ? { rtcMaxPort: options.rtcMaxPort } : {}),
  });
  let server: Awaited<ReturnType<typeof worker.createWebRtcServer>>;
  try {
    server = await worker.createWebRtcServer({ listenInfos: mediaListenInfos(options.media) });
  } catch (e) {
    worker.close();
    throw new Error(`call media can't listen on port ${options.media.port} (UDP and TCP): ${(e as Error).message}. Pick another with --rtc-port.`);
  }
  return {
    async createRouter(routes) {
      const router = await worker.createRouter({ mediaCodecs: routes.mediaCodecs as never });
      return {
        get rtpCapabilities() {
          return router.rtpCapabilities;
        },
        // mediasoup takes both by name; given a bare id it found no producer and refused every consumer.
        canConsume: (producerId, rtpCapabilities) => router.canConsume({ producerId: String(producerId), rtpCapabilities: rtpCapabilities as never }),
        // Both UDP and TCP, so a member behind a strict NAT falls back to TCP (a reachable node needs no TURN).
        async createWebRtcTransport() {
          const transport = await router.createWebRtcTransport({ webRtcServer: server, enableUdp: true, enableTcp: true, preferUdp: true });
          return {
            get id() {
              return transport.id;
            },
            get iceParameters() {
              return transport.iceParameters;
            },
            get iceCandidates() {
              return transport.iceCandidates;
            },
            get dtlsParameters() {
              return transport.dtlsParameters;
            },
            connect: (dtls) => transport.connect({ dtlsParameters: dtls as never }),
            onIceState: (callback) => {
              transport.on("icestatechange", (state) => callback(state));
            },
            async produce(options) {
              const producer = await transport.produce(options as never);
              const sfuProducer: SfuProducerLike = {
                get id() {
                  return producer.id;
                },
                appData: options.appData,
                onClosed: (cb) => {
                  producer.once("transportclose", () => cb());
                },
                close: () => producer.close(),
              };
              return sfuProducer;
            },
            async consume(options) {
              const consumer = await transport.consume(options as never);
              return {
                get id() {
                  return consumer.id;
                },
                get producerId() {
                  return consumer.producerId;
                },
                get paused() {
                  return consumer.paused;
                },
                get rtpParameters() {
                  return consumer.rtpParameters;
                },
                resume: () => consumer.resume(),
                close: () => consumer.close(),
              };
            },
            close: () => transport.close(),
          };
        },
        async createPipeTransport(options) {
          const pipe = await router.createPipeTransport(options as never);
          return {
            get id() {
              return pipe.id;
            },
            get tuple() {
              return { localAddress: pipe.tuple.localAddress, localPort: pipe.tuple.localPort };
            },
            get srtpParameters() {
              return pipe.srtpParameters;
            },
            connect: (remote) => pipe.connect(remote as never),
            async consume(consumeOptions) {
              const consumer = await pipe.consume(consumeOptions);
              return {
                get id() {
                  return consumer.id;
                },
                get kind() {
                  return consumer.kind;
                },
                get rtpParameters() {
                  return consumer.rtpParameters;
                },
                get producerPaused() {
                  return consumer.producerPaused;
                },
                close: () => consumer.close(),
              };
            },
            async produce(produceOptions) {
              const producer = await pipe.produce(produceOptions as never);
              return {
                get id() {
                  return producer.id;
                },
                appData: produceOptions.appData,
                onClosed: (cb) => {
                  producer.once("transportclose", () => cb());
                },
                close: () => producer.close(),
              };
            },
            close: () => pipe.close(),
          };
        },
        close: () => router.close(),
      };
    },
    onDied: (cb) => {
      worker.on("died", cb);
      return () => void worker.off("died", cb);
    },
    close: () => worker.close(),
  };
}

// One mediasoup worker for the whole node (a process each, sharing one `--rtc-ports` range), started with the first call
// any hosted server serves, and started again after it died.
export function sharedWorker(open: () => Promise<SfuWorkerLike>): { get(): Promise<SfuWorkerLike>; close(): void } {
  let current: Promise<SfuWorkerLike> | null = null;
  let running: SfuWorkerLike | null = null;
  let closed = false;
  return {
    get() {
      if (closed) return Promise.reject(new Error("the node is stopping"));
      if (current) return current;
      const made = open();
      current = made;
      made.then((worker) => {
        // Stopped while it was starting: it goes too, or its process outlived the node.
        if (closed) return worker.close();
        running = worker;
        worker.onDied(() => {
          if (current !== made) return;
          current = null;
          running = null;
        });
      }, () => {
        if (current === made) current = null;
      });
      return made;
    },
    close() {
      closed = true;
      running?.close();
      running = null;
      current = null;
    },
  };
}

// All the calls on one hosted server. A call is a router; a router closes when its call empties, so a busy server
// has a handful of routers, not one per channel ever joined.
export class SfuCalls {
  private readonly calls = new Map<number, SfuCall>();
  private readonly opening = new Map<number, Promise<SfuCall>>();

  constructor(
    private readonly worker: SfuWorkerLike,
    private readonly onNotice: (channelId: number, peer: string, notice: SfuNotify) => void,
  ) {
    this.stopWatching = worker.onDied(() => this.close());
  }

  private readonly stopWatching: () => void;

  // The call for a channel, with a router when it isn't open yet. Whether a member fits is `SfuCall.tryJoin`'s to
  // say: checked here, before the await that joining members share, every one of them saw room.
  async open(channelId: number): Promise<SfuCall> {
    return this.calls.get(channelId) ?? this.create(channelId);
  }

  // Members joining at once share the router being made: each used to make its own while the first was still being
  // created, and only the last stayed the call's, so the others' media reached nobody and they heard of no one
  // (mesh-test s10, 6 joining together).
  private create(channelId: number): Promise<SfuCall> {
    let pending = this.opening.get(channelId);
    if (!pending) {
      pending = this.worker.createRouter({ mediaCodecs: sfuMediaCodecs }).then((router) => {
        const call = new SfuCall(channelId, router, (peer, producers) => {
          for (const producer of producers) this.onNotice(channelId, peer, { producerClosed: { id: producer.id } });
        });
        this.calls.set(channelId, call);
        return call;
      }).finally(() => this.opening.delete(channelId));
      this.opening.set(channelId, pending);
    }
    return pending;
  }

  get(channelId: number): SfuCall | undefined {
    return this.calls.get(channelId);
  }

  // The channels with an open call on this node.
  channels(): number[] {
    return [...this.calls.keys()];
  }

  // The call emptied: its router is dropped (the member side asks again when the next one joins).
  drop(channelId: number): void {
    this.calls.delete(channelId);
  }

  // This server's calls only: the worker serves the node's other servers too (`sharedWorker`).
  close(): void {
    for (const call of this.calls.values()) call.close();
    this.calls.clear();
    this.stopWatching();
  }
}

// One channel's call: the router and every member on it. Members are keyed by their device (peer) id; a member
// reconnecting over a new device just joins again (the old device's rows drop when its connection goes).
export class SfuCall {
  readonly router: SfuRouterLike;
  private readonly members = new Map<string, SfuPeer>();
  // Producers of members on other nodes serving this call, piped in under their own ids (node/sfuBridge.ts).
  private readonly remote = new Map<string, { info: SfuProducerInfo; producer: SfuProducerLike }>();
  // The check of what the call carries (`logSummary`), running from its first member on, and the last line logged.
  private summaryCheck: ReturnType<typeof setInterval> | undefined;
  private summarized = "";
  private closed = false;

  constructor(
    readonly channelId: number,
    router: SfuRouterLike,
    private readonly onGone: (peer: string, producers: SfuProducerInfo[]) => void,
  ) {
    this.router = router;
  }

  // A member joining (first on a new call, or replacing its old device). The old device's producers go down in the
  // join; everyone else in the call hears it and the new one starts producing over the new device. Only through
  // `tryJoin`, so no caller skips the capacity.
  private join(peer: string, user: number): SfuPeer {
    this.members.get(peer)?.drop();
    this.members.delete(peer);
    const member = new SfuPeer(this, user, (producers) => {
      this.forgetConsumers(producers.map((producer) => producer.id));
      this.onGone(peer, producers);
    });
    this.members.set(peer, member);
    // A join that reached the call after it closed (it emptied meanwhile) starts no check nothing would stop.
    if (!this.summaryCheck && !this.closed) {
      this.summaryCheck = setInterval(() => this.logSummary(), summaryEveryMs);
      (this.summaryCheck as { unref?: () => void }).unref?.();
    }
    return member;
  }

  // A member joins only while the call has room on this node (`cap`, the server's `sfu_capacity`), counted and joined
  // in one step: nothing may run between the two, or members joining at once all find room (6 on a capacity of 3).
  // A device already here (rejoining) keeps its place.
  tryJoin(peer: string, user: number, cap: number): SfuPeer | null {
    if (!this.members.has(peer) && this.members.size >= cap) return null;
    return this.join(peer, user);
  }

  leave(peer: string): void {
    const member = this.members.get(peer);
    if (!member) return;
    this.members.delete(peer);
    member.drop();
  }

  // What the call carries, for the node's log: whether the media goes through this node at all (the client falls back
  // to the mesh while its transports don't connect), who sends what to how many members here, and which member's used
  // transport isn't connected.
  // A call of more than `summaryListMax` members gets totals instead of a part per member (a line per member's media
  // in a call of hundreds was tens of KB).
  summary(): string {
    const members = [...this.members.values()].map((member) => ({ member, received: member.received() }));
    const receivers = new Map<string, number>();
    for (const { received } of members) for (const id of received) receivers.set(id, (receivers.get(id) ?? 0) + 1);
    const parts = [`${plural(members.length, "member")} here`];
    if (members.length <= summaryListMax) {
      parts.push(...members.map(({ member, received }) => member.describe(receivers, received)));
    } else {
      const sending = members.filter(({ member }) => member.own().length > 0).length;
      const receiving = members.filter(({ received }) => received.size > 0).length;
      parts.push(`${sending} sending, ${receiving} receiving`);
      const unconnected = members.flatMap(({ member }) => member.unconnected().map((kind) => `user ${member.user} ${kind}`));
      const more = unconnected.length - summaryListMax;
      if (unconnected.length) parts.push(`not connected: ${unconnected.slice(0, summaryListMax).join(", ")}${more > 0 ? ` and ${more} more` : ""}`);
    }
    if (this.remote.size) parts.push(`${plural(this.remote.size, "stream")} from other nodes`);
    return `[sfu] call ${this.channelId}: ${parts.join("; ")}`;
  }

  // Looked at every `summaryEveryMs` rather than told of each change: nothing that changes the call can be missed, and
  // a busy call (joins, consumes, ICE) is logged as often as a quiet one.
  private logSummary(): void {
    const line = this.summary();
    if (line === this.summarized) return;
    this.summarized = line;
    console.info(line);
  }

  // Who is already here, and where to reach them.
  peers(): string[] {
    return [...this.members.keys()];
  }

  // Each member's producers, in join order, then those piped in from other nodes (a join's reply lists them all so
  // the new member consumes everyone in the call, wherever they are).
  producers(excluding: number): SfuProducerInfo[] {
    const info: SfuProducerInfo[] = [];
    for (const member of this.members.values()) if (member.user !== excluding) info.push(...member.own());
    for (const { info: remote } of this.remote.values()) if (remote.user !== excluding) info.push(remote);
    return info;
  }

  // How many producers came in from other nodes (status.json).
  get remoteCount(): number {
    return this.remote.size;
  }

  // The producers of this node's own members: the only ones it pipes to other nodes, so nothing loops.
  local(): SfuProducerInfo[] {
    return [...this.members.values()].flatMap((member) => member.own());
  }

  addRemote(info: SfuProducerInfo, producer: SfuProducerLike): void {
    this.remote.set(info.id, { info, producer });
  }

  // A piped-in producer gone (unpiped, or its bridge closed); null when it wasn't here.
  removeRemote(id: string): SfuProducerInfo | null {
    const entry = this.remote.get(id);
    if (!entry) return null;
    this.remote.delete(id);
    entry.producer.close();
    this.forgetConsumers([id]);
    return entry.info;
  }

  // A producer went: mediasoup closed its consumers, so no member keeps them (they only grew in a long call).
  private forgetConsumers(producerIds: string[]): void {
    for (const member of this.members.values()) for (const id of producerIds) member.forgetConsumersOf(id);
  }

  get size(): number {
    return this.members.size;
  }

  get isEmpty(): boolean {
    return this.members.size === 0;
  }

  // Whose producer this is (a consume request names a producer another member sends).
  producerInfo(id: string): SfuProducerInfo | null {
    for (const member of this.members.values()) {
      const found = member.own().find((producer) => producer.id === id);
      if (found) return found;
    }
    return this.remote.get(id)?.info ?? null;
  }

  close(): void {
    this.closed = true;
    clearInterval(this.summaryCheck);
    this.summaryCheck = undefined;
    // The last line logged named members who are gone now.
    if (this.summarized) console.info(`[sfu] call ${this.channelId}: closed`);
    for (const member of [...this.members.values()]) member.drop();
    this.members.clear();
    this.remote.clear();
    this.router.close();
  }
}

// One of a member's transports, with what the node knows of its media: whether the member started using it
// (`connect`), whether its ICE is connected now and whether it ever was (media reached the port: no warning, even after
// a moment's `disconnected`), and the wait for its first media.
interface SfuSide {
  readonly transport: SfuTransportLike;
  used: boolean;
  connected: boolean;
  reached: boolean;
  wait?: ReturnType<typeof setTimeout>;
}

// One member's share of a call: a send and a recv transport, and what they carry. The client is one device; the
// member's rows drop when its connection (or a late `leave`) clears them.
export class SfuPeer {
  private send: SfuSide | null = null;
  private recv: SfuSide | null = null;
  private readonly producers = new Map<string, SfuProducerInfo>();
  private readonly real = new Map<string, SfuProducerLike>();
  private readonly consumers = new Map<string, SfuConsumerLike>();
  private closing = false;
  // Left the call (`drop`): a transport the router finishes after that is closed, never kept on a member that's gone.
  private gone = false;

  constructor(
    private readonly call: SfuCall,
    readonly user: number,
    private readonly onProducersEnd: (producers: SfuProducerInfo[]) => void,
  ) {}

  own(): SfuProducerInfo[] {
    return [...this.producers.values()];
  }

  // A transport to send or receive over. Recreating one closes the old (a client moves its devices forward).
  async create(kind: "send" | "recv"): Promise<Record<string, unknown>> {
    const transport = await this.call.router.createWebRtcTransport();
    if (this.gone) {
      transport.close();
      throw new Error("left the call");
    }
    const side: SfuSide = { transport, used: false, connected: false, reached: false };
    this.watchIce(side, kind);
    if (kind === "send") {
      this.closeSide(this.send);
      this.send = side;
    } else {
      // The old recv transport takes its consumers with it.
      this.closeSide(this.recv);
      this.consumers.clear();
      this.recv = side;
    }
    return { id: transport.id, iceParameters: transport.iceParameters, iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters };
  }

  // A transport replaced or closed, and its wait for media with it.
  private closeSide(side: SfuSide | null): void {
    if (!side) return;
    clearTimeout(side.wait);
    side.transport.close();
  }

  // A member's media as the node sees it: each transport's ICE state in the log, while it is the member's transport
  // (a replaced one's would read as the member's media dropping).
  private watchIce(side: SfuSide, kind: "send" | "recv"): void {
    side.transport.onIceState?.((state) => {
      if (this[kind] !== side) return;
      console.info(`${this.where(kind)} ICE ${state}`);
      side.connected = state === "connected" || state === "completed";
      if (!side.connected) return;
      side.reached = true;
      clearTimeout(side.wait);
    });
  }

  // The producers this member receives through the node: none while its recv transport isn't connected (it gets the
  // call over the mesh then), and not those it paused.
  received(): Set<string> {
    const ids = new Set<string>();
    if (!this.recv?.connected) return ids;
    for (const consumer of this.consumers.values()) if (!consumer.paused) ids.add(consumer.producerId);
    return ids;
  }

  // The member's transports it started using whose ICE isn't connected now (its call stays on the mesh meanwhile).
  unconnected(): ("send" | "recv")[] {
    return (["send", "recv"] as const).filter((kind) => {
      const side = this[kind];
      return !!side && side.used && !side.connected;
    });
  }

  // This member's part of the call summary (`SfuCall.summary`): `receivers` has how many members receive each
  // producer, `received` what this member receives (`received()`, worked out once per summary).
  describe(receivers: Map<string, number>, received: Set<string>): string {
    const parts: string[] = [];
    const sends = this.own().map((producer) => `${producer.kind}${producer.user === this.user ? "" : ` as user ${producer.user}`} (to ${receivers.get(producer.id) ?? 0})`);
    if (sends.length) parts.push(`sends ${sends.join(", ")}`);
    if (received.size) parts.push(`receives ${received.size}`);
    for (const kind of this.unconnected()) parts.push(`${kind} not connected`);
    return `user ${this.user} ${parts.length ? parts.join(", ") : "neither sends nor receives"}`;
  }

  private where(kind: "send" | "recv"): string {
    return `[sfu] call ${this.call.channelId}: user ${this.user} ${kind}`;
  }

  // The browser starts ICE on a transport only when it first uses it (its first produce or consume sends this
  // connect), so the wait for media starts once it connected: a recv transport made before the node had anything to
  // send it sat unused and was warned about, though the media port was reachable. A warning when nothing came: the
  // member's media never got to the media port (not forwarded, a firewall).
  async connect(id: string, dtlsParameters: unknown): Promise<void> {
    const kind = this.send?.transport.id === id ? "send" : this.recv?.transport.id === id ? "recv" : null;
    const side = kind ? this[kind] : null;
    if (!kind || !side) throw new Error("no such transport");
    await side.transport.connect(dtlsParameters);
    if (side.used) return;
    side.used = true;
    // Replaced or closed meanwhile, reached already, or a transport that tells no ICE: nothing to wait for.
    if (this[kind] !== side || side.reached || !side.transport.onIceState) return;
    side.wait = setTimeout(() => {
      if (side.reached || this[kind] !== side) return;
      console.warn(`${this.where(kind)} got no media in ${noMediaMs / 1000} s: members must reach this node's media port (--rtc-port) over UDP or TCP. Forward or open it to this machine.`);
    }, noMediaMs);
    (side.wait as { unref?: () => void }).unref?.();
  }

  // `as`: a bot this member hosts sends this producer (the caller checked that); it belongs to the bot's user.
  async produce(kind: SfuKind, rtpParameters: unknown, as?: number): Promise<SfuProducerInfo> {
    const transport = this.send?.transport;
    if (!transport) throw new Error("create the send transport first");
    const user = as ?? this.user;
    if ([...this.producers.values()].some((producer) => producer.kind === kind && producer.user === user)) throw new Error(`already sending ${kind}`);
    const producer = await transport.produce({ kind: mediaKind(kind), rtpParameters, appData: { kind } });
    if (this.gone) {
      producer.close();
      throw new Error("left the call");
    }
    const info: SfuProducerInfo = { id: producer.id, kind, user };
    this.producers.set(info.id, info);
    this.real.set(info.id, producer);
    let gone = false;
    producer.onClosed(() => {
      if (gone || this.closing) return;
      gone = true;
      this.producers.delete(info.id);
      this.real.delete(info.id);
      this.onProducersEnd([info]);
    });
    return info;
  }

  async consume(producerId: string, rtpCapabilities: unknown): Promise<Record<string, unknown> | null> {
    const transport = this.recv?.transport;
    if (!transport) throw new Error("create the recv transport first");
    if (!this.call.router.canConsume(producerId, rtpCapabilities)) return null;
    const producer = this.call.producerInfo(producerId);
    const consumer = await transport.consume({ producerId, rtpCapabilities });
    if (this.gone) {
      consumer.close();
      throw new Error("left the call");
    }
    this.consumers.set(consumer.id, consumer);
    return {
      id: consumer.id,
      producerId: consumer.producerId,
      // The client hands this straight to mediasoup-client, so it is the media kind, not the call kind.
      kind: mediaKind(producer?.kind ?? "mic"),
      paused: consumer.paused,
      rtpParameters: consumer.rtpParameters,
    };
  }

  forgetConsumersOf(producerId: string): void {
    for (const [id, consumer] of this.consumers) if (consumer.producerId === producerId) this.consumers.delete(id);
  }

  async resume(id: string): Promise<void> {
    const consumer = this.consumers.get(id);
    if (!consumer) throw new Error("no such consumer");
    if (consumer.paused) await consumer.resume();
  }

  // A transport or producer to drop. Closing a send transport takes its producers with it (each tells the call);
  // closing a producer tells the call too. A consumer closes silently (only its own tracks end).
  async close(id: string): Promise<void> {
    if (this.send?.transport.id === id) {
      this.closeSide(this.send);
      this.send = null;
      return;
    }
    if (this.recv?.transport.id === id) {
      this.closeSide(this.recv);
      this.recv = null;
      this.consumers.clear();
      return;
    }
    const info = this.producers.get(id);
    const producer = this.real.get(id);
    if (info && producer) {
      this.producers.delete(id);
      this.real.delete(id);
      producer.close();
      this.onProducersEnd([info]);
      return;
    }
    const consumer = this.consumers.get(id);
    if (consumer) {
      consumer.close();
      this.consumers.delete(id);
    }
  }

  // The member left or reconnected: drop everything, telling the rest of the call about the producers.
  drop(): void {
    this.gone = true;
    this.closing = true;
    const producers = this.own();
    this.producers.clear();
    this.real.clear();
    this.closeSide(this.send);
    this.send = null;
    this.closeSide(this.recv);
    this.recv = null;
    this.consumers.clear();
    this.closing = false;
    if (producers.length) this.onProducersEnd(producers);
  }
}