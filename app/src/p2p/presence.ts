// Channel presence for a serverless workspace, sent straight to the other members. Changes go out at most every
// 50 ms; while a state is set it is repeated every few seconds, and other members drop it when that stops.
//
// Only members viewing the same channel get the state (cursor moves, typing) and its keep-alives; everyone hears when
// a member switches channels (and every `whereEveryMs`), and a member who comes into the channel gets the state at
// once. Sent to everyone, each cursor move cost one relayed message per member through the nodes (hub topology).
import {
  receiveChannelEvent, receiveChannelStream, registerPresenceLink, setPeerPresence, setPeerStatuses, setPeerVersions, type PeerPresence,
  type PresenceLink,
  type PresenceState, type SharedPresenceStatus,
} from "../core/presence";
import { appVersion, compareVersions, validVersion } from "../core/version";
import type { WorkspaceSync } from "./sync";

const sendEveryMs = 50;
const keepAliveMs = 3000;
const expireMs = 8000;
const whereEveryMs = 30_000;

// `bot`: a bot this member hosts, one entry per channel it is in (a null state removes it).
// `app`: the app version, sent only along with a status, so a hidden member doesn't share it.
type Message = { userId: number; channelId: number | null; state: PresenceState | null; status?: SharedPresenceStatus | null; app?: string; bot?: true };
type Entry = Omit<Message, "bot"> & { peer: string; at: number; bot?: true };
type ChannelEvent = { userId: number; channelId: number; message: PresenceState };

export class PresenceChannel implements PresenceLink {
  private readonly sendState: (message: Message, peer?: string) => void;
  private readonly sendEvent: (event: ChannelEvent, to?: number) => void;
  private readonly peers = new Map<string, Entry>();
  // Bots hosted on this device, by "<bot>:<channel>".
  private readonly bots = new Map<string, { userId: number; channelId: number; state: PresenceState }>();
  private mine: Message;
  private lastSent = 0;
  // The channel everyone was last told, and when.
  private told: number | null | undefined = undefined;
  private toldAt = 0;
  private pending: ReturnType<typeof setTimeout> | undefined;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly cleanups: (() => void)[] = [];
  // This member's channel stream, the peers it is on, and the ones that came from others (by peer).
  private ownStream: { channelId: number; stream: MediaStream } | null = null;
  private streamPeers = new Set<string>();
  private readonly incoming = new Map<string, { channelId: number; userId: number; stream: MediaStream }>();
  private readonly mesh: WorkspaceSync["mesh"];

  constructor(private readonly workspaceId: string, sync: WorkspaceSync, userId: number, status: SharedPresenceStatus | null = null) {
    this.mine = { userId, channelId: null, state: null, status };
    this.mesh = sync.mesh;
    if (sync.mesh) {
      this.cleanups.push(sync.mesh.onStream((stream, peerId, meta) => {
        if (meta.kind !== "channel" || typeof meta.channelId !== "number" || typeof meta.userId !== "number") return;
        const entry = { channelId: meta.channelId, userId: meta.userId, stream };
        this.incoming.set(peerId, entry);
        receiveChannelStream(workspaceId, entry.channelId, entry.userId, stream);
        const ended = () => {
          if (this.incoming.get(peerId)?.stream !== stream || stream.getTracks().some((t) => t.readyState !== "ended")) return;
          this.dropIncoming(peerId);
        };
        stream.addEventListener("removetrack", ended);
        stream.getTracks().forEach((t) => t.addEventListener("ended", ended));
      }));
      this.sendState = sync.mesh.channel<Message>("presence", (message, peerId) => {
        if (message.bot === true) {
          const key = `${peerId}:${message.userId}:${message.channelId}`;
          if (message.state === null || message.channelId === null) this.peers.delete(key);
          else this.peers.set(key, { peer: peerId, userId: message.userId, channelId: message.channelId, state: message.state, at: Date.now(), bot: true });
          this.publish();
          return;
        }
        const before = this.peers.get(peerId)?.channelId;
        const previous = this.peers.get(peerId);
        const status = message.status === undefined ? previous?.status : validStatus(message.status) ? message.status : null;
        const app = !status ? undefined : validVersion(message.app) ? message.app : previous?.app;
        this.peers.set(peerId, { ...previous, ...message, peer: peerId, status, app, at: Date.now() });
        this.publish();
        // A member heard from first: ours to it may have been lost too (its online dot was missing until the next
        // refresh, up to `whereEveryMs`).
        if (!previous) this.sendState(this.whereMessage(), peerId);
        // Someone came into this channel: they get this member's state now, not at the next keep-alive.
        if (message.channelId !== null && message.channelId === this.mine.channelId && before !== message.channelId) {
          this.sendState(this.whereMessage(), peerId);
          this.sendBots(message.channelId, peerId);
        }
      });
      const sendEvent = sync.mesh.channel<ChannelEvent>("chan-event", (event) => {
        if (event.userId !== userId) receiveChannelEvent(workspaceId, event.channelId, event.userId, event.message);
      });
      this.sendEvent = (event, to) => {
        for (const peer of this.viewers(event.channelId, to)) sendEvent(event, peer);
      };
      this.cleanups.push(sync.onPeers((peerId) => this.sendState(this.whereMessage(), peerId), (peerId) => this.dropPeer(peerId)));
      // Its app said bye (mesh.ts): gone at once, also when it wasn't reachable any more.
      this.cleanups.push(sync.mesh.onQuit((peerId) => this.dropPeer(peerId)));
    } else {
      this.sendState = () => {};
      this.sendEvent = () => {};
    }
    this.timer = setInterval(() => {
      if (((this.mine.state !== null || this.bots.size > 0) && Date.now() - this.lastSent > keepAliveMs) || Date.now() - this.toldAt > whereEveryMs) this.flush();
      const now = Date.now();
      let expired = false;
      // A state stops (the channel is still known: only viewers get keep-alives).
      for (const [key, entry] of this.peers)
        if (entry.state !== null && now - entry.at > expireMs) {
          if (entry.bot) this.peers.delete(key);
          else entry.state = null;
          expired = true;
        }
      if (expired) this.publish();
    }, 1000);
    this.cleanups.push(registerPresenceLink(workspaceId, this));
  }

  set(channelId: number, state: PresenceState | null): void {
    // Clearing another channel's state (a view closing late) must not wipe the current one.
    if (state === null && this.mine.channelId !== channelId) return;
    this.mine = { ...this.mine, channelId: state === null ? null : channelId, state };
    if (this.pending) return;
    const wait = Math.max(0, sendEveryMs - (Date.now() - this.lastSent));
    this.pending = setTimeout(() => this.flush(), wait);
  }

  // A bot this device hosts is in a channel (a cursor, "typing"); null when it leaves. Shown here too.
  setAs(botUserId: number, channelId: number, state: PresenceState | null): void {
    const key = `${botUserId}:${channelId}`;
    const local = `local:${key}`;
    if (state === null) {
      this.bots.delete(key);
      this.peers.delete(local);
      for (const peer of this.viewers(channelId)) this.sendState({ userId: botUserId, channelId, state: null, bot: true }, peer);
    } else {
      this.bots.set(key, { userId: botUserId, channelId, state });
      this.peers.set(local, { peer: "local", userId: botUserId, channelId, state, at: Date.now(), bot: true });
      this.pending ??= setTimeout(() => this.flush(), Math.max(0, sendEveryMs - (Date.now() - this.lastSent)));
    }
    this.publish();
  }

  setStatus(status: SharedPresenceStatus | null): void {
    if (this.mine.status === status) return;
    this.mine = { ...this.mine, status };
    this.sendState(status ? this.whereMessage() : { ...this.mine, status });
  }

  send(channelId: number, message: PresenceState, to?: number): void {
    this.sendEvent({ userId: this.mine.userId, channelId, message }, to);
  }

  shareStream(channelId: number, stream: MediaStream | null): void {
    if (this.ownStream && this.ownStream.stream !== stream) {
      for (const peer of this.streamPeers) this.mesh?.removeStream(this.ownStream.stream, peer);
      this.streamPeers = new Set();
    }
    this.ownStream = stream ? { channelId, stream } : null;
    this.routeStream();
  }

  // The stream goes to whoever views its channel, and is taken back from members who left it.
  private routeStream() {
    if (!this.mesh) return;
    const own = this.ownStream;
    const want = new Set(own ? this.viewers(own.channelId) : []);
    for (const peer of this.streamPeers) if (!want.has(peer) && own) this.mesh.removeStream(own.stream, peer);
    for (const peer of want) {
      if (!this.streamPeers.has(peer) && own) this.mesh.addStream(own.stream, peer, { kind: "channel", channelId: own.channelId, userId: this.mine.userId });
    }
    this.streamPeers = want;
  }

  private dropPeer(peerId: string) {
    for (const [key, entry] of this.peers) if (entry.peer === peerId) this.peers.delete(key);
    this.streamPeers.delete(peerId);
    this.dropIncoming(peerId);
    this.publish();
  }

  private dropIncoming(peerId: string) {
    const entry = this.incoming.get(peerId);
    if (!entry) return;
    this.incoming.delete(peerId);
    receiveChannelStream(this.workspaceId, entry.channelId, entry.userId, null);
  }

  close(): void {
    if (this.ownStream) this.shareStream(this.ownStream.channelId, null);
    for (const peer of [...this.incoming.keys()]) this.dropIncoming(peer);
    clearInterval(this.timer);
    clearTimeout(this.pending);
    this.cleanups.forEach((cleanup) => cleanup());
  }

  // To everyone when the channel changed (or now and then), else to the members viewing the same channel.
  private flush() {
    clearTimeout(this.pending);
    this.pending = undefined;
    this.lastSent = Date.now();
    if (this.mine.channelId !== this.told || Date.now() - this.toldAt > whereEveryMs) {
      this.told = this.mine.channelId;
      this.toldAt = Date.now();
      this.sendState(this.whereMessage());
    } else if (this.mine.channelId !== null) {
      // With the status: one lost status message no longer leaves a viewer without this member's online dot.
      for (const peer of this.viewers(this.mine.channelId)) this.sendState(this.whereMessage(), peer);
    }
    for (const [key, bot] of this.bots) {
      const local = this.peers.get(`local:${key}`);
      if (local) local.at = Date.now();
      for (const peer of this.viewers(bot.channelId)) this.sendState({ userId: bot.userId, channelId: bot.channelId, state: bot.state, bot: true }, peer);
    }
  }

  private sendBots(channelId: number, peer: string) {
    for (const bot of this.bots.values())
      if (bot.channelId === channelId) this.sendState({ userId: bot.userId, channelId, state: bot.state, bot: true }, peer);
  }

  private whereMessage(): Message {
    const { status, ...where } = this.mine;
    return status ? { ...where, status, app: appVersion } : where;
  }

  private viewers(channelId: number, userId?: number): string[] {
    return [...new Set([...this.peers.values()]
      .filter((entry) => entry.channelId === channelId && !entry.bot && (userId === undefined || entry.userId === userId))
      .map((entry) => entry.peer))];
  }

  private publish() {
    const byChannel: Record<number, PeerPresence[]> = {};
    const byUser: Record<number, SharedPresenceStatus> = {};
    const appsByUser: Record<number, Set<string>> = {};
    for (const entry of this.peers.values())
      if (entry.channelId !== null && entry.state !== null && entry.userId !== this.mine.userId)
        (byChannel[entry.channelId] ??= []).push({ userId: entry.userId, state: entry.state });
    for (const entry of this.peers.values()) {
      if (entry.userId === this.mine.userId || !entry.status) continue;
      if (entry.app) (appsByUser[entry.userId] ??= new Set()).add(entry.app);
      const previous = byUser[entry.userId];
      if (!previous || statusRank(entry.status) > statusRank(previous)) byUser[entry.userId] = entry.status;
    }
    setPeerPresence(this.workspaceId, byChannel);
    setPeerStatuses(this.workspaceId, byUser);
    setPeerVersions(this.workspaceId, Object.fromEntries(Object.entries(appsByUser).map(
      ([user, apps]) => [user, [...apps].sort(compareVersions).join(", ")])));
    // A member who left the channel takes their stream along.
    for (const [peer, entry] of this.incoming) {
      const where = this.peers.get(peer);
      if (where && where.channelId !== entry.channelId) this.dropIncoming(peer);
    }
    this.routeStream();
  }
}

function validStatus(value: unknown): value is SharedPresenceStatus {
  return value === "online" || value === "away" || value === "dnd";
}

function statusRank(status: SharedPresenceStatus): number {
  return status === "dnd" ? 3 : status === "online" ? 2 : 1;
}
