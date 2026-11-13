// One Room-like object over the Trystero rooms of a server (see sync.ts): the hub room, where members connect only
// to nodes; the member room, joined while no node is reachable; and a room per call. A peer has the same id in every
// room (Trystero's selfId is per app instance), so the features (mesh, content streams, presence) address peers
// without knowing which room carries them: a send goes through the first room the peer joined among those it is still
// in, a broadcast once per peer. Rooms are added and removed while the workspace is open.
import type { Room } from "trystero";

// What the features use of a Trystero room. `onPeerMoved`, `onPeerMember`: a group's only (see RoomGroup).
export type SyncRoom = Pick<Room, "makeAction" | "getPeers" | "addStream" | "removeStream" | "leave" | "onPeerJoin" | "onPeerLeave" | "onPeerStream">
  & {
    onPeerMoved?: ((peerId: string) => void) | null;
    onPeerMember?: ((peerId: string, member: boolean) => void) | null;
    isMember?: (peer: string) => boolean;
  };

type Target = string | string[] | null | undefined;
// What a peer may do in these rooms: a member, someone joining with an invite, or nothing yet.
type PeerAccess = "member" | "invite" | null;
type Handler = ((...args: never[]) => unknown) | null;
type Access = "member" | "invite" | "auth";
type Config = { kind?: "message" | "request"; onMessage?: Handler; onRequest?: Handler; mwAccess?: Access; [key: string]: unknown };
type Underlying = {
  send: (data: unknown, options?: Record<string, unknown>) => Promise<void>;
  request: (data: unknown, options: Record<string, unknown>) => Promise<unknown>;
};
type Made = { name: string; config: Config | undefined; access: Access; handlers: { onMessage: Handler; onRequest: Handler }; perRoom: Map<string, Underlying> };
// A hello, a mesh list, a presence update or two: what a peer sends right after it authorized this one.
const earlyLimit = 16;
// Streams can be many more: a go-between passes on every member's mic and camera it carries. Trystero itself keeps at
// most 64 streams' metadata waiting per peer.
const earlyStreamLimit = 64;
type StreamMeta = Parameters<NonNullable<Room["onPeerStream"]>>[2];

// Whether a stream is gone: every track ended (or taken off). Shown or kept, it would count as heard, in silence.
export function streamEnded(stream: MediaStream): boolean {
  return stream.getTracks().every((track) => track.readyState === "ended");
}

export class RoomGroup implements SyncRoom {
  private readonly rooms = new Map<string, Room>();
  // The rooms each peer is in, in the order it joined them.
  private readonly peerRooms = new Map<string, string[]>();
  private readonly peerAccess = new Map<string, Exclude<Access, "auth">>();
  // Messages from a peer that weren't let through yet, at most `earlyLimit`, delivered once they are: it wasn't
  // authorized here yet, or members' messages didn't pass yet (it or this device is a joiner whose join is on its way).
  private readonly early = new Map<string, { access: Access; handle: () => void }[]>();
  // The same for streams, by stream id. Each side sends its streams as soon as it has authorized the other, so the
  // faster side's arrived first, were dropped and never came again: a member back from a dropped connection stayed
  // "Connecting…" for good, not hearing the member whose side was faster.
  private readonly earlyStreams = new Map<string, Map<string, { stream: MediaStream; meta: StreamMeta }>>();
  private readonly made: Made[] = [];
  private authenticationRequired = false;
  private localAccess: Exclude<Access, "auth"> | null = "member";
  onPeerJoin: ((peerId: string) => void) | null = null;
  onPeerLeave: ((peerId: string) => void) | null = null;
  onPeerConnect: ((peerId: string) => void) | null = null;
  onPeerStream: Room["onPeerStream"] = null;
  // The connection carrying a peer's media (its first room) closed while the peer stays in another room: no leave, but
  // what was sent over it is gone (mesh.ts places it again). A call between members of the member room went silent
  // once that room was left, while its own room still connected them; the other side logs "User-Initiated Abort".
  onPeerMoved: ((peerId: string) => void) | null = null;
  // Members' messages with a peer that stays connected started (true) or stopped (false), because its access or this
  // device's changed: a joiner whose join landed. What was sent to it on joining was held back then; the mesh sends its
  // list again (mesh.ts), or the new member reached the others only with the node's next list, 30 s later (mesh-test s13).
  onPeerMember: ((peerId: string, member: boolean) => void) | null = null;

  has(key: string): boolean {
    return this.rooms.has(key);
  }

  // Whether `peer` gets members-only messages from here (both sides members, or no authentication at all).
  isMember(peer: string): boolean {
    return this.allowed(peer, "member");
  }

  unauthenticatedPeers(): string[] {
    return [...this.peerRooms.keys()].filter((peer) => !this.peerAccess.has(peer));
  }

  // Peers connected in one room.
  peersIn(key: string): number {
    return Object.keys(this.rooms.get(key)?.getPeers() ?? {}).filter((peer) => this.allowed(peer, "member")).length;
  }

  requirePeerAuthentication(localAccess: PeerAccess): void {
    this.authenticationRequired = true;
    this.localAccess = localAccess;
  }

  setLocalAccess(access: PeerAccess): void {
    if (access === this.localAccess) return;
    const before = new Map([...this.peerAccess.keys()].map((peer) => [peer, this.allowed(peer, "member")]));
    this.localAccess = access;
    for (const [peer, was] of before) if (this.allowed(peer, "member") !== was) this.onPeerMember?.(peer, !was);
    for (const peer of new Set([...this.early.keys(), ...this.earlyStreams.keys()])) this.release(peer);
  }

  authorizePeer(peer: string, access: PeerAccess): void {
    const before = this.peerAccess.get(peer);
    if (access === null) {
      this.forget(peer);
      if (before) this.onPeerLeave?.(peer);
      return;
    }
    const wasMember = before !== undefined && this.allowed(peer, "member");
    this.peerAccess.set(peer, access);
    if (!before) this.onPeerJoin?.(peer);
    else if (this.allowed(peer, "member") !== wasMember) this.onPeerMember?.(peer, !wasMember);
    // What it sent while its proof was being checked here (it had checked ours first): its hello above all, without
    // which its commits were dropped as coming from an unknown protocol until the next hello 20 s later.
    this.release(peer);
  }

  add(key: string, room: Room): void {
    if (this.rooms.has(key)) return;
    this.rooms.set(key, room);
    for (const made of this.made) this.wire(made, key, room);
    this.listen(key, room);
  }

  // The same Trystero room under another key, without leaving it: its peers stay connected.
  rename(from: string, to: string): boolean {
    const room = this.rooms.get(from);
    if (!room || this.rooms.has(to)) return false;
    this.rooms.delete(from);
    this.rooms.set(to, room);
    for (const made of this.made) {
      const action = made.perRoom.get(from);
      made.perRoom.delete(from);
      if (action) made.perRoom.set(to, action);
    }
    for (const keys of this.peerRooms.values()) {
      const at = keys.indexOf(from);
      if (at >= 0) keys[at] = to;
    }
    this.listen(to, room);
    return true;
  }

  async remove(key: string): Promise<void> {
    const room = this.rooms.get(key);
    if (!room) return;
    this.rooms.delete(key);
    for (const made of this.made) made.perRoom.delete(key);
    // Every peer's list first, then the leave events: handlers send to the peers still here.
    const gone: string[] = [];
    const moved: string[] = [];
    for (const [peer, keys] of [...this.peerRooms]) {
      if (!keys.includes(key)) continue;
      const rest = keys.filter((k) => k !== key);
      if (rest.length > 0) {
        this.peerRooms.set(peer, rest);
        if (keys[0] === key) moved.push(peer);
      } else {
        this.peerRooms.delete(peer);
        gone.push(peer);
      }
    }
    for (const peer of gone) {
      this.forget(peer);
      this.onPeerLeave?.(peer);
    }
    for (const peer of moved) this.onPeerMoved?.(peer);
    room.onPeerJoin = null;
    room.onPeerLeave = null;
    room.onPeerStream = null;
    await room.leave();
  }

  makeAction = ((name: string, config?: Config) => {
    const made: Made = { name, config, access: config?.mwAccess ?? "member", handlers: { onMessage: config?.onMessage ?? null, onRequest: config?.onRequest ?? null }, perRoom: new Map() };
    this.made.push(made);
    for (const [key, room] of this.rooms) this.wire(made, key, room);
    return {
      get onMessage() {
        return made.handlers.onMessage;
      },
      set onMessage(handler: Handler) {
        made.handlers.onMessage = handler;
      },
      get onRequest() {
        return made.handlers.onRequest;
      },
      set onRequest(handler: Handler) {
        made.handlers.onRequest = handler;
      },
      onReceiveProgress: null,
      onReceive: null,
      send: (data: unknown, options: Record<string, unknown> = {}) =>
        this.route(options.target as Target, (key, target) => made.perRoom.get(key)?.send(data, { ...options, target }) ?? Promise.resolve(), made.access),
      request: (data: unknown, options: Record<string, unknown>) => {
        const key = this.roomOf(options.target as string);
        const action = key === undefined ? undefined : made.perRoom.get(key);
        if (!this.allowed(options.target as string, made.access)) return Promise.reject(Object.assign(new Error("Peer is not authorized."), { kind: "disconnected" }));
        // Marked like Trystero's own error for a peer it isn't connected to, so callers tell it from a timeout.
        return action ? action.request(data, options) : Promise.reject(Object.assign(new Error(`No connection to ${String(options.target)}.`), { kind: "disconnected" }));
      },
      requestMany: () => Promise.reject(new Error("requestMany isn't supported across rooms.")),
    };
  }) as unknown as Room["makeAction"];

  getPeers(): Record<string, RTCPeerConnection> {
    const all: Record<string, RTCPeerConnection> = {};
    for (const [peer, keys] of this.peerRooms) {
      const connection = this.rooms.get(keys[0])?.getPeers()[peer];
      if (connection && this.allowed(peer, "invite")) all[peer] = connection;
    }
    return all;
  }

  addStream(stream: MediaStream, options: { target?: Target; metadata?: unknown } = {}): Promise<void>[] {
    const sent: Promise<void>[] = [];
    void this.route(options.target, (key, target) => {
      sent.push(...(this.rooms.get(key)?.addStream(stream, { ...options, target } as never) ?? []));
      return Promise.resolve();
    }, "member");
    return sent;
  }

  removeStream(stream: MediaStream, options: { target?: Target } = {}): void {
    void this.route(options.target, (key, target) => {
      this.rooms.get(key)?.removeStream(stream, { target });
      return Promise.resolve();
    }, "member");
  }

  async leave(): Promise<void> {
    await Promise.all([...this.rooms.keys()].map((key) => this.remove(key)));
  }

  private roomOf(peer: string): string | undefined {
    return this.peerRooms.get(peer)?.[0];
  }

  // A peer gone or refused: its access and whatever it sent that still waited. Held streams stay when only one of its
  // connections closes (a move): one from the closed connection has ended and is skipped on release, and the peer
  // places its streams again over the other one; dropped, one that came over the other was lost for good.
  private forget(peer: string) {
    this.peerAccess.delete(peer);
    this.early.delete(peer);
    this.earlyStreams.delete(peer);
  }

  private drop(peer: string, key: string) {
    const before = this.peerRooms.get(peer) ?? [];
    const keys = before.filter((k) => k !== key);
    if (keys.length > 0) {
      this.peerRooms.set(peer, keys);
      if (before[0] === key) this.onPeerMoved?.(peer);
    } else if (this.peerRooms.delete(peer)) {
      this.forget(peer);
      this.onPeerLeave?.(peer);
    }
  }

  // A room's peer events, under its key.
  private listen(key: string, room: Room): void {
    room.onPeerJoin = (peer) => {
      const keys = this.peerRooms.get(peer) ?? [];
      // Already here: a new connection replaced the old one in this room (Trystero's "peer replaced" says no leave for
      // the old one). What was placed on the old one is gone, so it goes again (mesh.ts), as after a move. Without
      // this, the mesh counted our streams as sent over the dead connection and never placed them again.
      if (keys.includes(key)) {
        if (keys[0] === key) this.onPeerMoved?.(peer);
        return;
      }
      keys.push(key);
      this.peerRooms.set(peer, keys);
      if (keys.length === 1) {
        if (this.authenticationRequired) this.onPeerConnect?.(peer);
        else this.onPeerJoin?.(peer);
      }
    };
    room.onPeerLeave = (peer) => this.drop(peer, key);
    room.onPeerStream = (stream, peer, meta) => {
      if (this.allowed(peer, "member")) return this.onPeerStream?.(stream, peer, meta);
      if (!this.passesLater(peer, "member")) return;
      const held = this.earlyStreams.get(peer) ?? this.earlyStreams.set(peer, new Map()).get(peer)!;
      // One placed again goes to the end: handed over in the order last placed.
      if (!held.delete(stream.id) && held.size >= earlyStreamLimit) return;
      held.set(stream.id, { stream, meta });
    };
  }

  // The action in each room, calling the group's handlers (set later by some features).
  private wire(made: Made, key: string, room: Room) {
    const { mwAccess: _, ...settings } = made.config ?? {};
    const config = made.config?.kind === "request"
      ? { ...settings, onRequest: (data: never, context: never) => {
        const peer = (context as { peerId?: string }).peerId;
        return peer && this.allowed(peer, made.access)
          ? (made.handlers.onRequest as ((d: never, c: never) => unknown) | null)?.(data, context)
          : undefined;
      } }
      : { ...settings, onMessage: (data: never, context: never) => {
        const peer = (context as { peerId?: string }).peerId;
        const handle = () => (made.handlers.onMessage as ((d: never, c: never) => unknown) | null)?.(data, context);
        if (peer && this.allowed(peer, made.access)) return handle();
        if (!peer || !this.passesLater(peer, made.access)) return;
        const held = this.early.get(peer) ?? this.early.set(peer, []).get(peer)!;
        if (held.length < earlyLimit) held.push({ access: made.access, handle });
      } };
    made.perRoom.set(key, room.makeAction(made.name, config as never) as unknown as Underlying);
  }

  // Runs `send` once per room for the target peers it carries (every peer when there is no target).
  private route(target: Target, send: (key: string, target: string | string[]) => Promise<void>, access: Access): Promise<void> {
    const peers = target === null || target === undefined ? [...this.peerRooms.keys()] : Array.isArray(target) ? target : [target];
    const byRoom = new Map<string, string[]>();
    for (const peer of peers) {
      if (!this.allowed(peer, access)) continue;
      const key = this.roomOf(peer);
      if (key !== undefined) (byRoom.get(key) ?? byRoom.set(key, []).get(key)!).push(peer);
    }
    return Promise.all([...byRoom].map(([key, list]) => send(key, list.length === 1 ? list[0] : list))).then(() => {});
  }

  // Whether what a peer sends may be let through later, and so waits: it isn't authorized here yet, or it is a
  // members' message or stream while it or this device isn't a member yet.
  private passesLater(peer: string, access: Access): boolean {
    if (access === "auth" || !this.authenticationRequired || !this.peerRooms.has(peer)) return false;
    return !this.peerAccess.has(peer) || (access === "member" && this.localAccess !== null);
  }

  // Hands over what a peer sent that is let through now, in order, its streams after its messages; the rest keeps
  // waiting.
  // Each list is taken out before it is handed over: a handler that authorizes the peer again runs `release` again,
  // which then finds nothing twice.
  private release(peer: string): void {
    const held = this.early.get(peer);
    if (held) {
      this.early.delete(peer);
      const waiting = held.filter(({ access, handle }) => {
        if (!this.allowed(peer, access)) return true;
        handle();
        return false;
      });
      if (waiting.length > 0) this.early.set(peer, [...waiting, ...(this.early.get(peer) ?? [])]);
    }
    const streams = this.earlyStreams.get(peer);
    if (!streams || !this.allowed(peer, "member")) return;
    this.earlyStreams.delete(peer);
    // One whose tracks all ended (or were taken off) meanwhile is gone.
    for (const { stream, meta } of streams.values()) if (!streamEnded(stream)) this.onPeerStream?.(stream, peer, meta);
  }

  private allowed(peer: string, access: Access): boolean {
    if (!this.authenticationRequired) return true;
    if (access === "auth") return this.peerRooms.has(peer);
    if (!this.localAccess || !this.peerAccess.has(peer)) return false;
    if (access === "invite") return true;
    return this.localAccess === "member" && this.peerAccess.get(peer) === "member";
  }
}
