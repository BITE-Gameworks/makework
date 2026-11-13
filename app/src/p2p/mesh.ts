// The members of a workspace's room, reached directly or through another member. Many home and mobile networks can't
// connect to each other directly; when two such members are both connected to a third, it passes their messages
// along. Media never: a stream goes only over the direct connection to its receiver, one copy each, so no go-between
// decodes and sends it again and nothing comes round twice (ADR 0019). A direct connection that failed
// wants TURN for the next attempt, even while a go-between passes the member's messages (TURN costs money, so it is
// asked for only then; sync.ts adds it).
//
// Members tell their direct peers whom they reach directly. A peer heard of that way becomes a relayed peer after
// `relayAfterMs` (direct connections usually form sooner) or as soon as a direct attempt fails.
// In the hub topology (sync.ts) members connect only to nodes and reach each other through them: no direct connection
// is coming, so they relay at once (`relayAfter`).
//
// Nodes in groups (sync.ts) reach members of other groups through another node: two go-betweens. So do members in the
// grid of a workspace without nodes (sync.ts), through a row-mate and then its column-mate. Such a peer (`shareRoutes`)
// also tells its direct peers its route table (`routes`, kept apart from the direct lists, which decide who passes
// commits on): each peer it relays and the go-betweens on the way. A receiver puts the sender in front of each route
// and takes it only for a peer it doesn't reach directly, when the route names neither the receiver nor a peer twice
// and has at most `maxGoBetweens`; of the routes to a peer it keeps the shortest. Each sender's list replaces its last
// one, so a route nobody tells any more is gone. The far lists before (`mesh-far`) named whom a peer reached through
// others, whoever had told it: nodes connected to each other kept a member who had left through each other, for good.
// A relayed message carries the rest of its route (`path`), so it can't go round while two tables disagree.
//
// A peer gets the full list of whom this one reaches when it connects (and every `listEveryMs`); changes go out as
// batched `mesh-delta` messages. Sending the whole list to everyone on each join cost a node with n members n full
// lists per join (n^2 for a burst of joins). The lists name only peers that members' messages reach (`isMember`): a
// joiner a node announced while it was one got every member's presence through the node, which the node couldn't pass
// on. When members' messages with a peer start (its join landed, or ours), it is announced, and gets the full list,
// as if it had just connected.
//
// An app that is going (quit, reload, a window closing) says `bye`: first to its direct peers, then (for go-betweens
// of older apps, which don't pass a leaver on) to each member it reaches through one. Its peer id is gone for good then
// (Trystero's id is per page load), so the others count it as left at once (`onQuit`, `hasQuit`), not as a connection
// lost for a moment that may come back (voice.ts waits for that). A direct peer of the leaver names it in its next
// `mesh-delta` (`quit`), so the members it relays hear it from one message, and it drops the relayed byes that follow.
// Only the leaver itself says it over a direct link, and only the leaver's own direct peer in a delta (one that named
// it as a neighbor and removes it): a bye or a delta naming one's own direct peer is ignored, so nobody can hide a
// member reached directly. A feature that knows a peer is gone for good otherwise (a restarted app names the one it
// replaces, voice.ts) says so with `gone`.
import type { SyncRoom } from "./roomGroup";

// Short: a direct connection that forms later still takes over (`update` drops peers that became direct).
const relayAfterMs = 3_000;
const failureMs = 180_000;
const listEveryMs = 30_000;
const checkEveryMs = 5_000;
const deltaAfterMs = 1_000;
// Sends waiting on one peer's connection at once; more wait in this peer's outbox, in order. Trystero makes every send
// to a connection whose buffer is full wait for it to drain, with listeners on the data channel each. In werift (bots,
// nodes) a burst of small messages to one busy member passed 100 of them (mesh-test s9, MaxListenersExceededWarning),
// and a node passing things on for hundreds of members would hold one waiting send per message.
const inFlightPerPeer = 16;
// A message relayed from a sender the go-between doesn't name yet waits this long for its news (its batched delta, or
// its list when members' messages with it just started), at most `heldPerRelay` per go-between.
const relayedWaitMs = 5_000;
const heldPerRelay = 64;
// How long a peer that said bye stays known as gone (its id never comes back; lists naming it are soon replaced).
const quitKeptMs = 600_000;
// The mesh's own action (and the `ch` of a relayed bye), never a feature's channel.
const byeChannel = "bye";
// Go-betweens a route may have: two between members of different node groups or grid cells, one more when a link
// between two nodes failed.
const maxGoBetweens = 3;
// Route lists go out again this often, each peer at its own time so they don't all come at once.
const routeEveryMs = () => 10_000 + Math.random() * 5_000;
// A whole route list asked for and not come is asked for again after this long.
const askAgainMs = 5_000;

export type StreamMeta = Record<string, string | number | boolean | null>;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
// `path`: the go-betweens still ahead (none: the target is the receiver's direct peer). `origin`: the sender, set by
// the first go-between.
type Relayed = { to: string; ch: string; data: Json; origin?: string; path?: string[] };
// A route list, numbered by its sender. `routes` (each [peer, ...go-betweens]) replaces what the sender said before.
// `base`: list `n` is list `base` changed (`add`: new or changed routes, `remove`: peers no longer relayed). Neither:
// nothing changed since list `n`. `ask`: the receiver lacks list `n` (or a change's base) and wants the whole list.
type RouteList = { n?: number; routes?: string[][]; base?: number; add?: string[][]; remove?: string[]; ask?: boolean };
type Delivered = { from: string; ch: string; data: Json };
type HeldRelayed = { message: Delivered; at: number };
// `quit`: peers among `remove` that said bye to the sender (they left for good, not lost for a moment).
type Delta = { add?: string[]; remove?: string[]; quit?: string[] };

export interface MeshOptions {
  // How long a peer heard of through a neighbor waits for a direct connection before it is relayed.
  relayAfter?: () => number;
  // How long changes to whom this one reaches are gathered before they go out (0: at once).
  deltaAfterMs?: number;
  // Nodes, and members in a grid (sync.ts): tell direct peers this one's route table (the others tell only whom they
  // reach directly).
  shareRoutes?: boolean | (() => boolean);
}

export class Mesh {
  private readonly direct = new Set<string>();
  // Each direct peer's own direct peers.
  private readonly neighbors = new Map<string, Set<string>>();
  // Peers heard of through a neighbor but not connected, since when.
  private readonly seen = new Map<string, number>();
  // The route table: each relayed peer and the go-betweens to it, the first one a direct peer.
  private readonly via = new Map<string, string[]>();
  private readonly failed = new Map<string, number>();
  // Peers that said bye, since when: never reachable again under that id.
  private readonly quit = new Map<string, number>();
  private saidBye = false;
  private readonly quitHandlers = new Set<(peer: string) => void>();
  // What the features were last told is there.
  private reachable = new Set<string>();
  private turn = false;

  private readonly joined = new Set<(peer: string) => void>();
  private readonly left = new Set<(peer: string) => void>();
  private readonly directJoined = new Set<(peer: string) => void>();
  private readonly directLeft = new Set<(peer: string) => void>();
  private readonly channels = new Map<string, { send: (data: never, peer: string) => void; receive: (data: never, peer: string) => void }>();
  private readonly streamHandlers = new Set<(stream: MediaStream, peer: string, meta: StreamMeta) => void>();
  private readonly placedHandlers = new Set<(stream: MediaStream, target: string) => void>();

  // Media each peer should get from here, and whether it is on the direct connection to it now (`path`: the peer, or
  // null while there is no direct link).
  private readonly sends = new Map<string, Map<MediaStream, { meta: StreamMeta; path: string | null }>>();
  // Streams on each direct connection and the peers they are there for.
  private readonly physical = new Map<string, Map<MediaStream, Set<string>>>();
  // Repairs coalesce per physical stream, wait for metadata attachment and SDP to settle, and are spaced per link.
  private readonly repairs = new Map<string, Map<MediaStream, () => void>>();
  private readonly attaching = new Map<RTCPeerConnection | string, number>();
  private readonly attachmentTails = new Map<RTCPeerConnection | string, Promise<void>>();
  private readonly repaired = new Map<RTCPeerConnection | string, number>();
  private closed = false;

  private readonly sendList: (list: string[], peer?: string) => void;
  private readonly sendDelta: (delta: Delta) => void;
  // Each direct peer's route list (peer -> its go-betweens after that direct peer) with its number, and when this one
  // last asked it for the whole list.
  private readonly routeLists = new Map<string, { n: number; routes: Map<string, string[]> }>();
  private readonly asked = new Map<string, number>();
  // This one's route list as last told (peer -> go-betweens), its number, the number each direct peer got (-1: it had
  // a list from here but may have missed what came since), and whether this one shared routes then.
  private shared = new Map<string, string[]>();
  private listNumber = 0;
  private readonly sentNumbers = new Map<string, number>();
  private sharedRoutes = false;
  private routesTimer: ReturnType<typeof setTimeout> | undefined;
  private roundTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly sendRouteList: (list: RouteList, peer: string) => void;
  private delta: { add: Set<string>; remove: Set<string>; quit: Set<string> } = { add: new Set(), remove: new Set(), quit: new Set() };
  private deltaTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly sendOut: (message: Relayed, peer: string) => Promise<void>;
  private readonly sendIn: (message: Delivered, peer: string) => void;
  private readonly sendBye: (peer: string) => Promise<void>;
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private readonly outbox = new Map<string, { active: number; queue: (() => Promise<unknown>)[] }>();
  // Relayed messages waiting for their go-between to name the sender, per go-between.
  private readonly heldRelayed = new Map<string, HeldRelayed[]>();

  constructor(
    private readonly room: SyncRoom, private readonly self: string, private readonly onTurnNeeded: () => void = () => {},
    private readonly options: MeshOptions = {},
  ) {
    const list = room.makeAction<string[]>("mesh", { onMessage: (peers, { peerId }) => this.receiveList(peerId, peers) });
    const delta = room.makeAction<Delta>("mesh-delta", { onMessage: (change, { peerId }) => this.receiveDelta(peerId, change) });
    this.sendDelta = (change) => this.toEveryone((peer) => delta.send(change, { target: peer }));
    const routes = room.makeAction<RouteList>("routes", { onMessage: (list, { peerId }) => this.receiveRoutes(peerId, list) });
    this.sendRouteList = (list, peer) => this.post(peer, () => routes.send(list, { target: peer }));
    // Older apps' far lists are taken and dropped: they kept members who had left (see the top). So are their orders to
    // pass media on: no member passes media on (ADR 0019).
    room.makeAction<never>("mesh-far", { onMessage: () => {} });
    room.makeAction<never>("relay-media", { onMessage: () => {} });
    const out = room.makeAction<Relayed>("relay-out", { onMessage: (m, { peerId }) => this.passOn(peerId, m) });
    const into = room.makeAction<Delivered>("relay-in", { onMessage: (m, { peerId }) => this.deliver(peerId, m) });
    this.sendList = (peers, peer) => this.toPeers(peer, (to) => list.send(peers, { target: to }));
    this.sendOut = (m, peer) => this.postDone(peer, () => out.send(m, { target: peer }));
    this.sendIn = (m, peer) => this.post(peer, () => into.send(m, { target: peer }));
    const bye = room.makeAction<true>(byeChannel, { onMessage: (_, { peerId }) => this.receiveBye(peerId, true) });
    this.sendBye = (peer) => this.postDone(peer, () => bye.send(true, { target: peer }));

    room.onPeerJoin = (peer) => this.peerJoined(peer);
    room.onPeerLeave = (peer) => this.peerLeft(peer);
    room.onPeerStream = (stream, peer, meta) => this.receiveStream(stream, peer, (meta ?? {}) as StreamMeta);
    room.onPeerMoved = (peer) => this.peerMoved(peer);
    room.onPeerMember = (peer, member) => this.peerMember(peer, member);
    this.timers.push(setInterval(() => this.sendList(this.announced()), listEveryMs), setInterval(() => this.update(), checkEveryMs));
    this.roundTimer = setTimeout(this.routeRound, routeEveryMs());
    this.timers.push(setInterval(() => this.flushRepairs(), 1_000));
  }

  close(): void {
    this.closed = true;
    this.repairs.clear();
    this.repaired.clear();
    this.timers.forEach(clearInterval);
    clearTimeout(this.deltaTimer);
    clearTimeout(this.routesTimer);
    clearTimeout(this.roundTimer);
    this.roundTimer = undefined;
  }

  // Every member reachable now, directly or not (one that said bye no longer counts, while its link closes).
  peers(): string[] {
    return [...[...this.direct].filter((peer) => !this.quit.has(peer)), ...this.via.keys()];
  }

  // Whether the peer said bye: its app quit or reloaded, it isn't coming back under this id.
  hasQuit(peer: string): boolean {
    return this.quit.has(peer);
  }

  // This app is going: every member reachable hears it once. The direct peers first, so a go-between's bye never waits
  // behind the relayed ones (it then tells the members it relays itself); the relayed ones only for older go-betweens.
  // Settles when every send went out or failed.
  bye(): Promise<void> {
    if (this.saidBye || this.closed) return Promise.resolve();
    this.saidBye = true;
    const sent = [...this.direct].map((peer) => this.sendBye(peer));
    for (const [peer, route] of this.via) sent.push(this.sendOut(relayed(peer, route, byeChannel, true), route[0]));
    return Promise.allSettled(sent).then(() => {});
  }

  // A feature found a peer gone for good (its member's app restarted under a new id and named it): as if it had said
  // bye here.
  gone(peer: string): void {
    if (!this.markQuit(peer)) return;
    this.update();
    this.tellQuit([peer]);
  }

  // A peer said bye (or is `gone`), told once, also when it was no longer reachable (its link lost first).
  onQuit(handler: (peer: string) => void): () => void {
    this.quitHandlers.add(handler);
    return () => this.quitHandlers.delete(handler);
  }

  directPeers(): string[] {
    return [...this.direct];
  }

  // Whom a direct peer reaches directly, as it last told us.
  neighborsOf(peer: string): ReadonlySet<string> {
    return this.neighbors.get(peer) ?? new Set();
  }

  // The direct peer a relayed peer's messages go to first.
  relayOf(peer: string): string | undefined {
    return this.via.get(peer)?.[0];
  }

  // The go-betweens to a relayed peer, in order.
  routeOf(peer: string): readonly string[] | undefined {
    return this.via.get(peer);
  }

  get needsTurn(): boolean {
    return this.turn;
  }

  onPeers(joined: (peer: string) => void, left: (peer: string) => void): () => void {
    this.joined.add(joined);
    this.left.add(left);
    return () => {
      this.joined.delete(joined);
      this.left.delete(left);
    };
  }

  onDirectPeers(joined: (peer: string) => void, left: (peer: string) => void): () => void {
    this.directJoined.add(joined);
    this.directLeft.add(left);
    return () => {
      this.directJoined.delete(joined);
      this.directLeft.delete(left);
    };
  }

  // A direct connection to this peer could not be made.
  noteFailure(peer: string): void {
    this.failed.set(peer, Date.now());
    this.update();
  }

  // JSON messages to any member; `peer` left out sends to everyone.
  channel<T>(name: string, receive: (data: T, peer: string) => void): (data: T, peer?: string) => void {
    const action = this.room.makeAction<never>(name, { onMessage: (data, { peerId }) => receive(data as T, peerId) });
    const send = (data: T, peer: string) => {
      const route = this.via.get(peer);
      if (route) void this.sendOut(relayed(peer, route, name, data as Json), route[0]);
      else this.post(peer, () => action.send(data as never, { target: peer }));
    };
    this.channels.set(name, { send: send as never, receive: receive as never });
    return (data, peer) => {
      if (peer) return send(data, peer);
      this.toEveryone((to) => action.send(data as never, { target: to }));
      for (const relayed of this.via.keys()) send(data, relayed);
    };
  }

  // A send through the peer's outbox that settles once it went out (or failed).
  private postDone(peer: string, send: () => Promise<unknown>): Promise<void> {
    return new Promise((resolve) => this.post(peer, () => send().finally(resolve)));
  }

  // One send to a peer through its outbox (`inFlightPerPeer`); a failed send (the peer left) is dropped.
  private post(peer: string, send: () => Promise<unknown>): void {
    let box = this.outbox.get(peer);
    if (!box) this.outbox.set(peer, (box = { active: 0, queue: [] }));
    if (box.active >= inFlightPerPeer) box.queue.push(send);
    else this.start(peer, box, send);
  }

  private start(peer: string, box: { active: number; queue: (() => Promise<unknown>)[] }, send: () => Promise<unknown>): void {
    box.active++;
    void send().catch(() => {}).finally(() => {
      box.active--;
      const next = box.queue.shift();
      if (next) this.start(peer, box, next);
      else if (box.active === 0 && this.outbox.get(peer) === box) this.outbox.delete(peer);
    });
  }

  // To every peer connected to this one's rooms (a send without a target, one outbox each), or to `peer` alone.
  private toEveryone(send: (peer: string) => Promise<unknown>): void {
    for (const peer of Object.keys(this.room.getPeers())) this.post(peer, () => send(peer));
  }

  private toPeers(peer: string | undefined, send: (peer: string) => Promise<unknown>): void {
    if (peer) this.post(peer, () => send(peer));
    else this.toEveryone(send);
  }

  onStream(handler: (stream: MediaStream, peer: string, meta: StreamMeta) => void): () => void {
    this.streamHandlers.add(handler);
    return () => this.streamHandlers.delete(handler);
  }

  // A stream of ours is on a connection now: Trystero sends its metadata first and adds the tracks after, so this is
  // when its senders exist (per-sender settings like the screen-share quality hook in here).
  onPlaced(handler: (stream: MediaStream, target: string) => void): () => void {
    this.placedHandlers.add(handler);
    return () => this.placedHandlers.delete(handler);
  }

  addStream(stream: MediaStream, peer: string, meta: StreamMeta): void {
    const sends = this.sends.get(peer) ?? new Map();
    this.sends.set(peer, sends);
    if (sends.has(stream)) return;
    sends.set(stream, { meta, path: null });
    this.place(peer, stream);
  }

  removeStream(stream: MediaStream, peer: string): void {
    this.unplace(peer, stream);
    this.sends.get(peer)?.delete(stream);
  }

  // The peer says a stream of ours doesn't arrive: it goes onto its connection again (taken off first).
  resend(stream: MediaStream, peer: string): void {
    const entry = this.sends.get(peer)?.get(stream);
    if (!entry) return;
    const path = entry.path;
    if (path === null) return this.place(peer, stream);
    const placement = this.physical.get(path)?.get(stream);
    this.queueRepair(path, stream, () => {
      if (this.physical.get(path)?.get(stream) === placement) this.replacePhysical(path, stream);
    });
  }

  private replacePhysical(path: string, stream: MediaStream): void {
    const reasons = this.physical.get(path)?.get(stream) ?? new Set<string>();
    if (!reasons.size || !this.direct.has(path)) return;
    const meta = [...reasons].map((peer) => this.sends.get(peer)?.get(stream)?.meta).find((meta) => !!meta);
    if (!meta) return;
    this.physical.get(path)?.delete(stream);
    try {
      this.room.removeStream(stream, { target: path });
    } catch (e) {
      console.warn("Stream not removed:", e);
    }
    this.addPhysical(path, stream, meta, reasons.values().next().value!);
    for (const reason of reasons) this.physical.get(path)!.get(stream)!.add(reason);
  }

  private queueRepair(target: string, stream: MediaStream, repair: () => void): void {
    if (this.closed) return;
    const jobs = this.repairs.get(target) ?? new Map();
    this.repairs.set(target, jobs);
    const pc = this.room.getPeers()[target];
    jobs.set(stream, () => {
      if (this.room.getPeers()[target] === pc) repair();
    });
    this.flushRepairs();
  }

  private flushRepairs(): void {
    const peers = this.room.getPeers();
    for (const key of this.repaired.keys()) {
      const gone = typeof key === "string" ? !this.direct.has(key) : !Object.values(peers).includes(key);
      if (gone) this.repaired.delete(key);
    }
    for (const [target, jobs] of this.repairs) {
      if (!this.direct.has(target)) {
        this.repairs.delete(target);
        continue;
      }
      const pc = peers[target];
      const key = pc ?? target;
      if ((this.attaching.get(key) ?? 0) > 0 ||
          (pc?.signalingState && pc.signalingState !== "stable") ||
          (pc?.connectionState && pc.connectionState !== "connected") ||
          Date.now() - (this.repaired.get(key) ?? -Infinity) < 6_000) continue;
      const job = jobs.entries().next().value;
      if (!job) continue;
      jobs.delete(job[0]);
      if (!jobs.size) this.repairs.delete(target);
      this.repaired.set(key, Date.now());
      job[1]();
    }
  }

  // Attach completion means metadata and the local operation succeeded, not that RTP arrived. Ignore completions
  // from an old room/stream, and schedule failures through the same bounded repair queue as receiver requests.
  private attach(target: string, stream: MediaStream, meta: StreamMeta, current: () => boolean, retry: () => void,
    placed: () => void = () => {}): void {
    const pc = this.room.getPeers()[target];
    const key = pc ?? target;
    this.attaching.set(key, (this.attaching.get(key) ?? 0) + 1);
    const valid = () => !this.closed && current() && this.room.getPeers()[target] === pc;
    const failed = (error: unknown) => {
      if (!valid()) return;
      console.warn("Stream attachment failed; repair queued:", error);
      this.repaired.set(key, Date.now());
      this.queueRepair(target, stream, retry);
    };
    const run = async () => {
      if (!valid()) return;
      let pending: Promise<void>[];
      try {
        pending = this.room.addStream(stream, { target, metadata: meta });
      } catch (error) {
        pending = [Promise.reject(error)];
      }
      const results = await Promise.allSettled(pending);
      if (!this.closed && !current() && this.room.getPeers()[target] === pc) {
        // Removal may have raced the metadata send: addStream attaches only after metadata finishes.
        // A new placement of the same stream waits behind this one, so its tracks aren't attached yet.
        this.room.removeStream(stream, { target });
      }
      const rejected = results.find((result) => result.status === "rejected");
      if (!results.length || rejected) failed(rejected?.reason ?? "no authorized media target");
      else if (valid()) placed();
    };
    // Finish cancellation cleanup before another stream using the same tracks can attach to this connection.
    const before = this.attachmentTails.get(key);
    const tail = (before ? before.then(run) : run()).catch((error) => {
      console.warn("Stream attachment handler failed:", error);
    }).finally(() => {
      const count = (this.attaching.get(key) ?? 1) - 1;
      if (count > 0) this.attaching.set(key, count);
      else this.attaching.delete(key);
      if (this.attachmentTails.get(key) === tail) this.attachmentTails.delete(key);
    });
    this.attachmentTails.set(key, tail);
  }

  private peerJoined(peer: string) {
    // Connected again under the same id: its bye was a page kept for going back to, or not its own.
    this.quit.delete(peer);
    this.direct.add(peer);
    this.failed.delete(peer);
    this.announce(peer);
  }

  // Members' messages with a direct peer started or stopped (RoomGroup.onPeerMember). Started: what went to it on
  // connecting was held back, so it all goes again, and the others hear this one reaches it. It was reachable all
  // along, so `update` doesn't say so again: the features that greet a new peer (`onPeers`) are told here.
  private peerMember(peer: string, member: boolean) {
    if (!this.direct.has(peer)) return;
    if (!member) {
      this.changed(peer, false);
      this.update();
      return;
    }
    this.announce(peer);
    this.joined.forEach((handler) => handler(peer));
  }

  // Tells a direct peer whom this one reaches, and the others that this one reaches it (once members' messages pass).
  private announce(peer: string) {
    this.sendList(this.announced(), peer);
    this.resendRoutes(peer);
    if (this.isMember(peer)) this.changed(peer, true);
    this.directJoined.forEach((handler) => handler(peer));
    this.update(peer);
  }

  private isMember(peer: string): boolean {
    return this.room.isMember?.(peer) ?? true;
  }

  // The direct peers named in this one's lists.
  private announced(): string[] {
    return [...this.direct].filter((peer) => this.isMember(peer) && !this.quit.has(peer));
  }

  // A peer says bye: over its own direct link (`direct`), or passed on by a go-between, which counts only for a peer
  // this one has no direct link to. Its direct peers name it in their next delta, for the members they relay it to.
  private receiveBye(peer: string, direct: boolean) {
    if (!direct && this.direct.has(peer)) return;
    if (!this.markQuit(peer)) return;
    if (direct) {
      this.delta.quit.add(peer);
      this.changed(peer, false);
    }
    this.update();
    this.tellQuit([peer]);
  }

  private markQuit(peer: string): boolean {
    if (peer === this.self || this.quit.has(peer)) return false;
    this.quit.set(peer, Date.now());
    return true;
  }

  private tellQuit(peers: string[]): void {
    for (const peer of peers) this.quitHandlers.forEach((handler) => handler(peer));
  }

  private peerLeft(peer: string) {
    // What still waited to go to it is dropped (each send would only fail).
    const box = this.outbox.get(peer);
    if (box) box.queue.length = 0;
    this.outbox.delete(peer);
    this.direct.delete(peer);
    this.neighbors.delete(peer);
    this.routeLists.delete(peer);
    this.asked.delete(peer);
    this.sentNumbers.delete(peer);
    this.heldRelayed.delete(peer);
    this.physical.delete(peer);
    this.repairs.delete(peer);
    this.changed(peer, false);
    this.directLeft.forEach((handler) => handler(peer));
    this.update(undefined, peer);
  }

  // The connection carrying this direct peer's media closed while the peer stays reachable through another room
  // (RoomGroup): what was placed on it is gone, so it goes again, over the new one. Incoming streams from it end with
  // their tracks; the other side sends them again the same way. A route list on its way over it may be lost too.
  private peerMoved(peer: string) {
    if (!this.direct.has(peer)) return;
    this.resendRoutes(peer);
    this.repairs.delete(peer);
    this.physical.delete(peer);
    for (const [stream, entry] of this.sends.get(peer) ?? []) {
      if (entry.path !== peer) continue;
      entry.path = null;
      this.place(peer, stream);
    }
  }

  private receiveList(peer: string, peers: unknown) {
    if (!Array.isArray(peers)) return;
    this.neighbors.set(peer, new Set(peers.filter((p): p is string => typeof p === "string")));
    this.update();
    this.releaseRelayed(peer);
  }

  // A direct peer's whole route list replaces its last one; a change applies to the list it was made from. A change to,
  // or "nothing changed" since, a list that never came here asks for the whole list, and what the peer said before
  // stays until it comes: dropped at once, everyone reached through it left and came back a moment later.
  private receiveRoutes(peer: string, list: RouteList) {
    if (!list || typeof list !== "object" || !this.direct.has(peer)) return;
    if (list.ask === true) {
      this.sentNumbers.set(peer, -1);
      this.sendRoutes(peer);
      return;
    }
    if (typeof list.n !== "number") return;
    const known = this.routeLists.get(peer);
    if (Array.isArray(list.routes)) {
      this.routeLists.set(peer, { n: list.n, routes: new Map(routeEntries(list.routes)) });
      this.asked.delete(peer);
    } else if (typeof list.base === "number" && known?.n === list.base) {
      for (const p of Array.isArray(list.remove) ? list.remove : []) if (typeof p === "string") known.routes.delete(p);
      for (const [to, through] of routeEntries(list.add)) known.routes.set(to, through);
      known.n = list.n;
    } else {
      if (known?.n !== list.n) this.askRoutes(peer);
      return;
    }
    this.update();
    this.releaseRelayed(peer);
  }

  private askRoutes(peer: string) {
    const now = Date.now();
    if (now - (this.asked.get(peer) ?? -Infinity) < askAgainMs) return;
    this.asked.set(peer, now);
    this.sendRouteList({ ask: true }, peer);
  }

  private receiveDelta(peer: string, change: Delta) {
    const known = this.neighbors.get(peer);
    if (!known || !change || typeof change !== "object") return;
    // A leaver only its own direct peer names: one this peer said it reached and now removes, never one reached here
    // directly.
    const removed = new Set(Array.isArray(change.remove) ? change.remove : []);
    const quit = (Array.isArray(change.quit) ? change.quit : []).filter((p): p is string =>
      typeof p === "string" && removed.has(p) && known.has(p) && !this.direct.has(p) && this.markQuit(p));
    for (const p of Array.isArray(change.add) ? change.add : []) if (typeof p === "string") known.add(p);
    for (const p of removed) known.delete(p);
    this.update();
    this.releaseRelayed(peer);
    this.tellQuit(quit);
  }

  // A direct peer came or went: the others hear of it in the next batch.
  private changed(peer: string, joined: boolean) {
    (joined ? this.delta.remove : this.delta.add).delete(peer);
    (joined ? this.delta.add : this.delta.remove).add(peer);
    if (joined) this.delta.quit.delete(peer);
    const flush = () => {
      this.deltaTimer = undefined;
      const { add, remove, quit } = this.delta;
      this.delta = { add: new Set(), remove: new Set(), quit: new Set() };
      const said = [...quit].filter((p) => remove.has(p));
      if (add.size || remove.size) this.sendDelta({ add: [...add], remove: [...remove], ...(said.length > 0 && { quit: said }) });
    };
    // A lost connection goes out at once (with whatever else is waiting), gathered only within this tick: until the
    // others hear of it, they think this one still reaches that peer and don't pass it messages from here.
    const after = this.options.deltaAfterMs ?? deltaAfterMs;
    if (after === 0) flush();
    else if (!joined) {
      clearTimeout(this.deltaTimer);
      this.deltaTimer = setTimeout(flush, 0);
    } else this.deltaTimer ??= setTimeout(flush, after);
  }

  // Works out who is relayed through whom and tells the features which members came and went.
  // `joinedDirect`/`leftDirect`: a direct connection that just opened or closed.
  private update(joinedDirect?: string, leftDirect?: string) {
    const now = Date.now();
    // The routes on offer to each peer not reached directly: through a direct peer that reaches it directly, or one
    // whose route list names it (that one in front). None naming this one or a peer twice (a route that went round),
    // none too long.
    const offered = new Map<string, string[][]>();
    const offer = (peer: string, route: string[]) => {
      if (peer === this.self || this.direct.has(peer) || route.length > maxGoBetweens) return;
      if (this.quit.has(peer) || route.some((p) => this.quit.has(p))) return;
      if (route.includes(this.self) || route.includes(peer) || new Set(route).size !== route.length) return;
      const routes = offered.get(peer);
      if (routes) routes.push(route);
      else offered.set(peer, [route]);
    };
    for (const [neighbor, peers] of this.neighbors) for (const peer of peers) offer(peer, [neighbor]);
    for (const [neighbor, list] of this.routeLists) for (const [peer, through] of list.routes) offer(peer, [neighbor, ...through]);
    for (const peer of this.seen.keys()) if (!offered.has(peer)) this.seen.delete(peer);
    for (const peer of offered.keys()) if (!this.seen.has(peer)) this.seen.set(peer, now);
    for (const [peer, at] of this.failed) if (now - at > failureMs || this.direct.has(peer)) this.failed.delete(peer);
    for (const [peer, at] of this.quit) if (now - at > quitKeptMs) this.quit.delete(peer);

    const changed = new Set<string>();
    if (joinedDirect) changed.add(joinedDirect);
    if (leftDirect) changed.add(leftDirect);
    for (const [peer, routes] of offered) {
      // A peer whose direct connection just closed is relayed at once: waiting for a direct one, it counted as gone and
      // vanished from the call's list for seconds (a member leaving the member room for the hub, mesh-test s13).
      const ready = this.via.has(peer) || this.failed.has(peer) || peer === leftDirect
        || now - this.seen.get(peer)! >= (this.options.relayAfter?.() ?? relayAfterMs);
      if (!ready) continue;
      const current = this.via.get(peer);
      const next = shortest(routes, current);
      if (next !== current) {
        this.via.set(peer, next);
        changed.add(peer);
      }
    }
    for (const peer of [...this.via.keys()])
      if (!offered.has(peer)) {
        this.via.delete(peer);
        changed.add(peer);
      }
    for (const peer of changed) this.reroute(peer);

    const reachable = new Set(this.peers());
    for (const peer of reachable) if (!this.reachable.has(peer)) this.joined.forEach((handler) => handler(peer));
    for (const peer of this.reachable)
      if (!reachable.has(peer)) {
        this.sends.delete(peer);
        this.left.forEach((handler) => handler(peer));
      }
    this.reachable = reachable;

    // Media goes only over a direct link: a failed attempt wants TURN for the next, even while a go-between passes the
    // member's messages (failures of peers direct since were dropped above).
    const turn = this.failed.size > 0;
    if (turn && !this.turn) this.onTurnNeeded();
    this.turn = turn;
    if (changed.size > 0 || this.sharing() !== this.sharedRoutes) this.tellRoutes();
  }

  // A relayed message goes on along the route its sender chose: to the next go-between when it is a direct peer here
  // (never back, never past `maxGoBetweens`), at the end to the target. Older nodes' messages have no path (they
  // passed one on by their own table, `hops: 1`): delivered when the target is a direct peer here, else dropped.
  private passOn(from: string, message: Relayed) {
    if (!message || typeof message.to !== "string") return;
    const origin = typeof message.origin === "string" ? message.origin : from;
    // The leaver said bye straight to this one first, whose delta named it to every peer here already.
    if (message.ch === byeChannel && origin === from && this.quit.has(from)) return;
    const path = Array.isArray(message.path) ? message.path.filter((p): p is string => typeof p === "string") : [];
    if (path.length === 0) {
      if (this.direct.has(message.to)) this.sendIn({ from: origin, ch: message.ch, data: message.data }, message.to);
      return;
    }
    const [next, ...rest] = path;
    if (this.direct.has(next) && next !== from && path.length < maxGoBetweens)
      void this.sendOut({ to: message.to, ch: message.ch, data: message.data, origin, ...(rest.length > 0 && { path: rest }) }, next);
  }

  private sharing(): boolean {
    const share = this.options.shareRoutes;
    return typeof share === "function" ? share() : !!share;
  }

  // What changed in this one's route list: its routes with room for one more go-between (the receiver comes in
  // front), none when it doesn't share routes.
  private routeChanges(): { now: Map<string, string[]>; add: string[][]; remove: string[] } {
    const now = new Map<string, string[]>();
    if (this.sharing()) for (const [peer, route] of this.via) if (route.length < maxGoBetweens) now.set(peer, route);
    const add: string[][] = [];
    for (const [peer, route] of now) if (!sameRoute(this.shared.get(peer), route)) add.push([peer, ...route]);
    const remove = [...this.shared.keys()].filter((peer) => !now.has(peer));
    return { now, add, remove };
  }

  // The route list changed: the direct peers hear of it within this tick when a route was lost or changed (until they
  // do, they send through a route that's gone; a burst of leaves goes as one change), after `deltaAfterMs` when routes
  // were only added.
  private tellRoutes() {
    this.sharedRoutes = this.sharing();
    const { add, remove } = this.routeChanges();
    if (add.length === 0 && remove.length === 0) return;
    const after = this.options.deltaAfterMs ?? deltaAfterMs;
    if (after === 0) return this.flushRoutes();
    if (remove.length > 0 || add.some(([peer]) => this.shared.has(peer))) {
      clearTimeout(this.routesTimer);
      this.routesTimer = setTimeout(this.flushRoutes, 0);
    } else this.routesTimer ??= setTimeout(this.flushRoutes, after);
  }

  // A new list number, and the change to each direct peer that has the list before it (the whole list to the others):
  // a whole list on every change cost a node relaying hundreds of members megabytes per member who left.
  private readonly flushRoutes = () => {
    this.routesTimer = undefined;
    const { now, add, remove } = this.routeChanges();
    if (add.length === 0 && remove.length === 0) return;
    const base = this.listNumber;
    this.shared = now;
    this.listNumber++;
    const change: RouteList = { n: this.listNumber, base, ...(add.length > 0 && { add }), ...(remove.length > 0 && { remove }) };
    for (const peer of this.direct) {
      if (this.sentNumbers.get(peer) !== base) {
        this.sendRoutes(peer);
        continue;
      }
      this.sentNumbers.set(peer, this.listNumber);
      this.sendRouteList(change, peer);
    }
  };

  // A direct peer gets the whole route list when it doesn't have this one's latest: an empty one only if it had a
  // list from here before. On the periodic round one that has it gets "nothing changed", so one that missed a change
  // (a send that failed) asks for the list, an empty one included.
  private sendRoutes(peer: string, round = false) {
    const had = this.sentNumbers.get(peer);
    if (had === this.listNumber) {
      if (round) this.sendRouteList({ n: this.listNumber }, peer);
      return;
    }
    if (had === undefined && this.shared.size === 0) return;
    this.sentNumbers.set(peer, this.listNumber);
    this.sendRouteList({ n: this.listNumber, routes: [...this.shared].map(([to, route]) => [to, ...route]) }, peer);
  }

  // A direct peer may have missed route lists (members' messages were held back, its connection moved): it gets the
  // whole list again, an empty one too if it had one from here.
  private resendRoutes(peer: string) {
    if (this.sentNumbers.has(peer)) this.sentNumbers.set(peer, -1);
    this.sendRoutes(peer);
  }

  private readonly routeRound = () => {
    for (const peer of this.direct) this.sendRoutes(peer, true);
    if (this.roundTimer !== undefined) this.roundTimer = setTimeout(this.routeRound, routeEveryMs());
  };

  // A relayed message is taken only from a go-between that says it reaches the sender. One whose sender it doesn't name
  // yet waits for its news (`relayedWaitMs`): a node batches it for a second, and a new member's presence relayed
  // meanwhile was dropped until the next 20 s refresh (mesh-test s13).
  private deliver(relay: string, message: Delivered) {
    if (!message || typeof message.from !== "string" || message.from === this.self) return;
    if (this.vouches(relay, message.from)) return this.toChannel(message);
    const now = Date.now();
    const held = (this.heldRelayed.get(relay) ?? []).filter((h) => now - h.at <= relayedWaitMs);
    if (held.length < heldPerRelay) held.push({ message, at: now });
    this.heldRelayed.set(relay, held);
  }

  // A route through this one is one that went round: it vouches for nothing.
  private vouches(relay: string, from: string): boolean {
    if (this.neighbors.get(relay)?.has(from)) return true;
    const through = this.routeLists.get(relay)?.routes.get(from);
    return !!through && !through.includes(this.self);
  }

  private toChannel(message: Delivered) {
    if (message.ch === byeChannel) return this.receiveBye(message.from, false);
    (this.channels.get(message.ch)?.receive as ((data: unknown, peer: string) => void) | undefined)?.(message.data, message.from);
  }

  // The go-between's news came: what it vouches for now goes on, in order; what waited too long is dropped.
  private releaseRelayed(relay: string) {
    const held = this.heldRelayed.get(relay);
    if (!held) return;
    const now = Date.now();
    const waiting: HeldRelayed[] = [];
    for (const h of held) {
      if (now - h.at > relayedWaitMs) continue;
      if (this.vouches(relay, h.message.from)) this.toChannel(h.message);
      else waiting.push(h);
    }
    if (waiting.length > 0) this.heldRelayed.set(relay, waiting);
    else this.heldRelayed.delete(relay);
  }

  // Media goes only onto the direct connection to its peer; without one it waits (`reroute` places it once the link
  // comes).
  private place(peer: string, stream: MediaStream) {
    const entry = this.sends.get(peer)?.get(stream);
    if (!entry) return;
    entry.path = this.direct.has(peer) ? peer : null;
    if (entry.path) this.addPhysical(peer, stream, entry.meta, peer);
  }

  private unplace(peer: string, stream: MediaStream) {
    const entry = this.sends.get(peer)?.get(stream);
    if (!entry?.path) return;
    const path = entry.path;
    entry.path = null;
    this.removePhysical(path, stream, peer);
  }

  private reroute(peer: string) {
    const target = this.direct.has(peer) ? peer : null;
    for (const [stream, entry] of this.sends.get(peer) ?? []) {
      if (entry.path === target) continue;
      this.unplace(peer, stream);
      this.place(peer, stream);
    }
  }

  private addPhysical(target: string, stream: MediaStream, meta: StreamMeta, reason: string) {
    const streams = this.physical.get(target) ?? new Map<MediaStream, Set<string>>();
    this.physical.set(target, streams);
    const reasons = streams.get(stream) ?? new Set<string>();
    streams.set(stream, reasons);
    if (reasons.size === 0) {
      this.attach(target, stream, { ...meta, sid: stream.id },
        () => this.physical.get(target)?.get(stream) === reasons,
        () => {
          if (this.physical.get(target)?.get(stream) === reasons) this.replacePhysical(target, stream);
        },
        () => this.placedHandlers.forEach((handler) => handler(stream, target)));
    }
    reasons.add(reason);
  }

  private removePhysical(target: string, stream: MediaStream, reason: string) {
    const reasons = this.physical.get(target)?.get(stream);
    if (!reasons?.delete(reason) || reasons.size > 0) return;
    this.physical.get(target)!.delete(stream);
    if (!this.direct.has(target)) return;
    try {
      this.room.removeStream(stream, { target });
    } catch (e) {
      console.warn("Stream not removed:", e);
    }
  }

  // A stream an older app's go-between passed on (`from`) is its sender's: it already came, at the go-between's cost,
  // so it is taken (dropped, the member would only hear nothing). This app never asks for that, nor does it.
  private receiveStream(stream: MediaStream, peer: string, meta: StreamMeta) {
    const { sid: _sid, from, ...rest } = meta;
    const sender = typeof from === "string" ? from : peer;
    this.streamHandlers.forEach((handler) => handler(stream, sender, rest));
  }
}

// A message to a relayed peer along its route: to the first go-between, with the rest of the way.
function relayed(to: string, route: readonly string[], ch: string, data: Json): Relayed {
  return { to, ch, data, ...(route.length > 1 && { path: route.slice(1) }) };
}

// The shortest of the routes on offer. Of equally short ones the current one stays (a refresh doesn't move streams),
// as the same array; else the first by name, so every device picks alike.
function shortest(routes: string[][], current: string[] | undefined): string[] {
  const length = Math.min(...routes.map((route) => route.length));
  const best = routes.filter((route) => route.length === length);
  if (best.some((route) => sameRoute(route, current))) return current!;
  return best.reduce((a, b) => (compareRoutes(b, a) < 0 ? b : a), best[0]);
}

function sameRoute(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  return !!a && !!b && a.length === b.length && a.every((p, i) => p === b[i]);
}

function compareRoutes(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length - b.length;
}

// A route list's entries ([peer, ...go-betweens], strings only). The receiver comes in front, so an entry with
// `maxGoBetweens` go-betweens already is too long.
function routeEntries(list: unknown): [string, string[]][] {
  const entries: [string, string[]][] = [];
  if (!Array.isArray(list)) return entries;
  for (const entry of list)
    if (Array.isArray(entry) && entry.length >= 2 && entry.length <= maxGoBetweens && entry.every((p) => typeof p === "string"))
      entries.push([entry[0], entry.slice(1)]);
  return entries;
}
