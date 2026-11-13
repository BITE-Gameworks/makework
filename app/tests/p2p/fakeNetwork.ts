// Trystero rooms on one fake in-process network, for the mesh and sync tests: `link` connects two of them directly,
// like a working WebRTC connection. Actions are delivered synchronously and counted per sender, receiver and name.
// Rooms have names (the hub by default); `join` works like Trystero's discovery: the new room connects (a moment
// later) to every other copy of the same room, except when both are passive.
type Handler = (data: unknown, context: { peerId: string; metadata?: unknown }) => unknown;
type Action = {
  onMessage: Handler | null;
  onRequest?: Handler | null;
  send: (data: unknown, options?: { target?: string | string[]; metadata?: unknown }) => Promise<void>;
  request?: (data: unknown, options: { target: string; timeoutMs?: number }) => Promise<unknown>;
};

// Rooms are kept by "<room>/<member>", the hub's by the member id alone.
export const roomKey = (name: string, id: string) => (name === "hub" ? id : `${name}/${id}`);

export class Network {
  readonly rooms = new Map<string, FakeRoom>();
  // "<from>><to>:<action>" -> messages sent.
  readonly sent = new Map<string, number>();
  // Connections whose send buffer is full ("<from>><to>"): like Trystero, every send to it waits for the buffer to
  // drain, one `bufferedamountlow` listener each (`waiting`), until `drain`.
  private readonly full = new Map<string, { waiting: number; drained: Promise<void>; drain: () => void }>();
  fill(from: string, to: string) {
    let drain = () => {};
    const drained = new Promise<void>((resolve) => (drain = resolve));
    this.full.set(`${from}>${to}`, { waiting: 0, drained, drain });
  }
  drain(from: string, to: string) {
    this.full.get(`${from}>${to}`)?.drain();
    this.full.delete(`${from}>${to}`);
  }
  waiting(from: string, to: string): number {
    return this.full.get(`${from}>${to}`)?.waiting ?? 0;
  }
  async waitToSend(from: string, to: string) {
    const full = this.full.get(`${from}>${to}`);
    if (!full) return;
    full.waiting++;
    await full.drained;
    full.waiting--;
  }
  isFull(from: string, to: string): boolean {
    return this.full.has(`${from}>${to}`);
  }
  room(id: string, name = "hub") {
    const room = new FakeRoom(id, this, name);
    this.rooms.set(roomKey(name, id), room);
    return room;
  }
  join(id: string, name: string, passive: boolean) {
    const room = this.room(id, name);
    room.passive = passive;
    queueMicrotask(() => {
      if (room.left) return;
      for (const other of this.rooms.values())
        if (other !== room && other.name === name && other.discoverable && !other.left && !(passive && other.passive)) this.link(id, other.id, name);
      room.discoverable = true;
    });
    return room;
  }
  // Like Trystero's handshake: both sides know of each other before anything sent on joining arrives (a message sent
  // from the first side's onPeerJoin is held until the second side's ran, as the handshake comes first on the wire).
  link(a: string, b: string, name = "hub") {
    const [x, y] = [this.rooms.get(roomKey(name, a))!, this.rooms.get(roomKey(name, b))!];
    if (x.peers.has(b)) return;
    x.peers.add(b);
    y.peers.add(a);
    const held: (() => void)[] = [];
    this.linking.set(`${name}/${a}>${b}`, held);
    this.linking.set(`${name}/${b}>${a}`, held);
    x.onPeerJoin?.(b);
    y.onPeerJoin?.(a);
    this.linking.delete(`${name}/${a}>${b}`);
    this.linking.delete(`${name}/${b}>${a}`);
    for (const deliver of held) deliver();
  }
  // Messages between two rooms being linked, held until both know of each other.
  readonly linking = new Map<string, (() => void)[]>();
  unlink(a: string, b: string, name = "hub") {
    const [x, y] = [this.rooms.get(roomKey(name, a))!, this.rooms.get(roomKey(name, b))!];
    if (!x.peers.has(b)) return;
    x.peers.delete(b);
    y.peers.delete(a);
    x.connections.delete(b);
    y.connections.delete(a);
    x.onPeerLeave?.(b);
    y.onPeerLeave?.(a);
  }
  // Whether two members are connected in a room.
  linked(a: string, b: string, name = "hub"): boolean {
    return this.rooms.get(roomKey(name, a))?.peers.has(b) ?? false;
  }
  count(from: string, to: string, action: string): number {
    return this.sent.get(`${from}>${to}:${action}`) ?? 0;
  }
}

export class FakeRoom {
  readonly peers = new Set<string>();
  readonly connections = new Map<string, RTCPeerConnection>();
  readonly actions = new Map<string, Action>();
  // Streams on each connection: target -> stream ids.
  readonly streams = new Map<string, Set<string>>();
  onPeerJoin: ((peer: string) => void) | null = null;
  onPeerLeave: ((peer: string) => void) | null = null;
  onPeerStream: ((stream: MediaStream, peer: string, meta?: unknown) => void) | null = null;
  passive = false;
  discoverable = false;
  left = false;
  constructor(readonly id: string, private readonly network: Network, readonly name = "hub") {}

  getPeers() {
    return Object.fromEntries([...this.peers].map((peer) => {
      let connection = this.connections.get(peer);
      if (!connection) this.connections.set(peer, (connection = {} as RTCPeerConnection));
      return [peer, connection];
    }));
  }

  // Like Trystero: the handler comes with the config (mesh.ts) or is assigned to `onMessage` later (sync.ts).
  // Request actions (`kind: "request"`) answer through `onRequest`; only they have `request`, as in Trystero (a client
  // asking through a message action got "action.request is not a function" there). Binary data is passed as is.
  makeAction(name: string, config?: { onMessage?: Handler; onRequest?: Handler; kind?: string }) {
    // Like Trystero (@trystero-p2p/core actions.mjs): a second action of a name already made is the first one, and its
    // handler is ignored. Replacing it here hid a node's `node-have` going to NodeLink and never to the host (s8/s9).
    const existing = this.actions.get(name);
    if (existing) return existing;
    const copy = (data: unknown) => (data instanceof Uint8Array || data instanceof ArrayBuffer ? data : structuredClone(data));
    const action: Action = {
      onMessage: config?.onMessage ?? null,
      onRequest: config?.onRequest ?? null,
      send: async (data, options) => {
        const target = options?.target;
        for (const peer of target ? (Array.isArray(target) ? target : [target]) : [...this.peers]) {
          if (!this.peers.has(peer)) continue;
          if (this.network.isFull(this.id, peer)) {
            await this.network.waitToSend(this.id, peer);
            if (!this.peers.has(peer)) continue;
          }
          const key = `${this.id}>${peer}:${name}`;
          this.network.sent.set(key, (this.network.sent.get(key) ?? 0) + 1);
          const copied = copy(data);
          const deliver = () => this.network.rooms.get(roomKey(this.name, peer))!.actions.get(name)?.onMessage?.(copied, { peerId: this.id, metadata: options?.metadata });
          const held = this.network.linking.get(`${this.name}/${this.id}>${peer}`);
          if (held) held.push(deliver);
          else deliver();
        }
      },
      request: config?.kind !== "request" ? undefined : async (data, options) => {
        // Trystero's error for a peer it has no connection to (@trystero-p2p/core actions.mjs `requestOne`).
        if (!this.peers.has(options.target)) throw Object.assign(new Error(`no active peer with id ${options.target}`), { kind: "disconnected" });
        const key = `${this.id}>${options.target}:${name}`;
        this.network.sent.set(key, (this.network.sent.get(key) ?? 0) + 1);
        const handler = this.network.rooms.get(roomKey(this.name, options.target))!.actions.get(name)?.onRequest;
        if (!handler) throw new Error("no handler");
        return copy(await handler(copy(data), { peerId: this.id }));
      },
    };
    this.actions.set(name, action);
    return action;
  }

  addStream(stream: MediaStream, options: { target: string; metadata?: unknown }) {
    const set = this.streams.get(options.target) ?? new Set();
    this.streams.set(options.target, set);
    set.add(stream.id);
    this.network.rooms.get(roomKey(this.name, options.target))!.onPeerStream?.(stream, this.id, options.metadata);
    return [Promise.resolve()];
  }

  removeStream(stream: MediaStream, options: { target: string }) {
    this.streams.get(options.target)?.delete(stream.id);
  }

  leave() {
    this.left = true;
    for (const peer of [...this.peers]) this.network.unlink(this.id, peer, this.name);
    return Promise.resolve();
  }
}

// One live track, as a go-between passes on only streams with live tracks.
export const fakeStream = (id: string, tracks: { readyState: MediaStreamTrackState }[] = [
  { readyState: "live" },
]) =>
  ({ id, getTracks: () => tracks, addEventListener: () => {} }) as unknown as MediaStream;
