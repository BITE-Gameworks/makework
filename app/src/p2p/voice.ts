// Voice for a serverless workspace. Presence is short-lived: each member keeps the `voice` table in memory, sends
// its own row to the others whenever it changes, and drops a member's row when their connection goes.
// Media goes over the callers' direct links only (the call's room links them; ADR 0019), never through another member,
// and only to members in the same voice channel: the mic to every caller, a shared picture or a camera only to the
// callers who view it (their presence says so), one copy each.
import type { MockBackend } from "../system/backend";
import type { JsonRow } from "../system/data";
import {
  clearRemote, registerMediaLink, remoteStream, remoteTracksChanged, setRemoteStream, setReportedSizes, type LocalStreams,
  type MediaKind,
  type MediaLink,
} from "../voice/media";
import {
  applyCallPriorities, applyShareQuality, defaultShareQuality, effectiveBitrate, readOutbound, summarizeShare,
  type OutboundSample, type ScreenSenders, type ShareQuality, type ShareStats,
} from "../voice/shareQuality";
import { noteActivity, noteCallEvent, recentCallEvents } from "../voice/activity";
import type { Ledger } from "./ledger";
import type { Mesh, StreamMeta } from "./mesh";
import { micTrack, readMicStats } from "../voice/health";
import { SfuLink, type SfuMode } from "./sfu";
import type { WorkspaceSync } from "./sync";

const table = "voice_participants";
const kinds: ReadonlySet<MediaKind> = new Set(["mic", "camera", "screen"]);
// How often a member in a call sends its presence again (a lost one heals within this).
const presenceRefreshMs = 20_000;
// How many refreshes after leaving a call still say so (one lost "left" left a ghost participant).
const leftResends = 3;
// How many of a member's refreshes may go missing before its call row is taken out (it left, and every "left" was
// lost, or its app stopped). Only for members whose app says it refreshes: older apps never do and are never dropped.
const missedRefreshes = 3.5;
// The call heals itself: each member checks this often that the mic of everyone unmuted in its call arrives, asks a
// member whose mic is missing for `askAfterMs` to send it again, and asks again at twice the wait each time, at most
// `askAgainMaxMs`. A sender takes such a request at most once per `resendGapMs` per member.
const healEveryMs = 1_000;
const askAfterMs = 3_000;
const askAgainMaxMs = 30_000;
const resendGapMs = 2_000;
const reconnectGraceMs = 10_000;
// A caller that stops viewing a picture keeps getting it this long: each start or stop renegotiates the connection,
// and a member flipping between channels would do that every time.
const lingerMs = 10_000;
// Trystero's peer id survives a workspace reopening in the same page. Keep revisions across VoiceLink instances too.
let presenceRevision = 0;
// A connection that negotiates this long without settling is noted in the call's events.
const stuckNegotiationMs = 10_000;

// `refreshMs`: how often the sender sends its presence again while in a call (absent from apps that don't). `node`:
// its call goes through a node (absent from apps before that was said, which then count as on the mesh). `resend`:
// the sender doesn't get these streams from the receiver and asks for them again (older apps read only the presence).
// `seen`: how many members the sender counts in its call, itself included (a member another one sees but this one
// doesn't shows as one still loading).
// `guests`: bots this device hosts that are in a call (the media bot): each is a member of its own, with the sender's
// presence and streams (tagged with the bot's user id in their metadata). Receivers keep one virtual peer per guest.
// `watching`: the pictures the sender views, as "<userId>:screen" and "<userId>:camera" (absent from older apps, which
// get every picture).
// `replaces`: the sender's peer id before its app crashed or was killed (it never said bye): the receivers drop that
// one at once, in the call and in the mesh (`gone`), instead of waiting for its connection to time out. Only a peer of
// the same member is dropped.
type Guest = { userId: number; row: Omit<JsonRow, "id">; node?: boolean };
type Presence = {
  userId: number; row: Omit<JsonRow, "id"> | null; refreshMs?: number; node?: boolean; resend?: MediaKind[]; revision?: number;
  seen?: number; guests?: Guest[]; watching?: string[]; replaces?: string;
};
type Picture = "screen" | "camera";

const guestMark = "#";
const guestKey = (peerId: string, userId: number) => `${peerId}${guestMark}${userId}`;
const isGuestKey = (peerId: string) => peerId.includes(guestMark);
// One row of the call diagnostics (voice/Diagnostics.tsx).
type DiagnosticRow = Record<string, string | number | boolean>;

export class VoiceLink implements MediaLink {
  private readonly peerUsers = new Map<string, number>();
  private readonly peerRows = new Map<string, Omit<JsonRow, "id"> | null>();
  // Peers whose call goes through a node, as their presence says; and members whose streams arrive from the node
  // (by kind), which says the same for apps from before presence said it.
  private readonly peerOnNode = new Map<string, boolean>();
  private readonly fromNode = new Map<number, Set<MediaKind>>();
  // When each peer's presence last arrived, and how often it said it refreshes.
  private readonly heard = new Map<string, { at: number; refreshMs?: number }>();
  private readonly revisions = new Map<string, number>();
  // How many members each peer counts in its call, by the channel it is in, and our own count as last sent to everyone.
  private readonly seenBy = new Map<string, { channelId: number; count: number }>();
  private seenSent: number | undefined;
  private seenTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly unreachable = new Map<string, number>();
  private ownText = "";
  private ownRevision = 0;
  // What each peer is currently being sent, and what came from them.
  private readonly sent = new Map<string, Map<MediaKind, MediaStream>>();
  // Bots hosted here that are in a call, and what each real peer is sent of them (by "<user>:<kind>").
  private readonly guests = new Map<number, { channelId: number; streams: LocalStreams; row: Omit<JsonRow, "id"> }>();
  private readonly sentGuests = new Map<string, Map<string, MediaStream>>();
  private readonly incoming = new Map<string, Map<MediaKind, MediaStream>>();
  private readonly watchedStreams = new WeakSet<MediaStream>();
  // Members whose mic is missing here: when to ask them for it (again) and the wait after that. And when each member
  // last got our streams again on its request.
  private readonly missing = new Map<string, { next: number; wait: number }>();
  private readonly resent = new Map<string, number>();
  // The pictures this device views (presence `watching`, sent once per batch of changes); what each peer says it views
  // (none said: an older app, which gets every picture); and when a peer stopped viewing one of ours (it lingers).
  private readonly viewing = new Set<string>();
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly peerWatching = new Map<string, Set<string>>();
  private readonly lookedAway = new Map<string, Map<string, number>>();
  // Each share's sound on its own, for the callers who don't view its picture.
  private readonly soundCopies = new WeakMap<MediaStream, MediaStream | null>();
  private readonly micSamples = new Map<string, { track: MediaStreamTrack; bytes: number; packets: number; at: number; lastPacket: number }>();
  private joinPresenceAt: number[] = [];
  private channelId: number | null = null;
  private readonly mesh: Mesh | null = null;
  private readonly sfu: SfuLink | null = null;
  private lastSent = "";
  // Refreshes still to send after leaving a call.
  private leftTicks = 0;
  private local: LocalStreams = { mic: null, camera: null, screen: null };
  // The screen-share quality picked on this device, and the share's last measured pictures (for the bitrate).
  private quality: ShareQuality | null = null;
  private lastSamples = new Map<string, OutboundSample>();
  private readonly watched = new WeakSet<RTCPeerConnection>();
  // For the call's events: the peers with a direct link now (`onDirectPeers` can say a link opened twice), and the
  // member behind every peer met, so a member lost (gone from `peerUsers`) is still named.
  private readonly linked = new Set<string>();
  private readonly metUsers = new Map<string, number>();
  private readonly cleanups: (() => void)[] = [];
  private readonly sendPresence: (presence: Presence, peer?: string) => void;
  private readonly replaces: () => string | null;

  constructor(
    private readonly workspaceId: string,
    private readonly backend: MockBackend,
    private readonly sync: WorkspaceSync,
    private readonly userId: number,
    private readonly ledger: Ledger,
    // `presence: false`: a view window (core/popout.ts), another peer of this account that is never in a call. Its
    // word about calls would take the account out of the main window's call for every member it met (ADR 0009), so
    // it takes no part in calls at all, as without a mesh.
    // `replaces`: this device's peer id from before a crash or kill, while it should still be said (core/lastRun.ts).
    options: { presence?: boolean; replaces?: () => string | null } = {},
  ) {
    this.replaces = options.replaces ?? (() => null);
    const mesh = sync.mesh;
    if (!mesh || options.presence === false) {
      this.sendPresence = () => {};
      return;
    }
    const send = mesh.channel<Presence>("voice", (presence, peerId) => this.receive(peerId, presence));
    // Every presence carries how many members we count in our call (not part of `own`: it changes with others' rows).
    this.sendPresence = (presence, peer) => {
      const seen = this.seenHere();
      if (!peer) this.seenSent = seen;
      send(seen === undefined ? presence : { ...presence, seen }, peer);
    };
    this.cleanups.push(mesh.onStream((stream, peerId, meta) => this.receiveStream(peerId, stream, meta)));
    this.cleanups.push(mesh.onPlaced((stream, target) => {
      noteActivity("streams sent");
      // Once per link when the call starts, and again when the mesh moves it (another room's connection).
      if (stream === this.local.mic) this.note("our mic goes over the link to {peer}", target);
      const share = this.local.screen;
      if (share && (stream === share || stream === this.soundCopies.get(share))) {
        this.watchNegotiation(target);
        this.tuneMesh();
      } else if (stream === this.local.mic || stream === this.local.camera) {
        this.watchNegotiation(target);
        this.tunePriorities();
      } else if (this.isGuestShare(stream)) this.tuneGuests();
    }));
    this.cleanups.push(sync.onPeers((peerId) => {
      this.unreachable.delete(peerId);
      this.sendPresence(this.own(), peerId);
      this.route();
    }, (peerId) => {
      // Its app said bye (quit, reload): `onQuit` takes it out, nothing to wait for.
      if (mesh.hasQuit(peerId)) return;
      // A room/route handoff is not a hang-up. Keep membership briefly, but replace lost outgoing placements on return.
      this.unreachable.set(peerId, Date.now());
      const had = this.sent.get(peerId);
      this.sent.delete(peerId);
      this.sentGuests.delete(peerId);
      this.retuneWithout(had);
      if (this.together(peerId)) this.note("{peer} temporarily unreachable: waiting for reconnection", peerId, true);
    }));
    // A peer whose app said bye leaves the call at once: also one never reachable here, or whose link was lost first.
    this.cleanups.push(mesh.onQuit((peerId) => this.quitPeer(peerId)));
    // A member reached through a relay first and directly later (the call's room connects a call's members) counts as
    // reachable all along, so `onPeers` never fires again: the presence sent through the relay was all they had, and
    // when it was lost they never knew whose streams arrived (mesh-test s10). The direct link gets it again.
    this.cleanups.push(mesh.onDirectPeers((peerId) => {
      this.sendPresence(this.own(), peerId);
      if (this.linked.has(peerId)) return;
      this.linked.add(peerId);
      if (this.together(peerId)) this.note("direct link to {peer} opened", peerId);
    }, (peerId) => {
      this.linked.delete(peerId);
      // Media goes only over the direct link (ADR 0019): it waits for the call's room to link them again.
      if (this.together(peerId)) this.note("direct link to {peer} closed: connecting directly again", peerId, true);
    }));
    // While in a call, and a few times after leaving one, the presence goes out again now and then, so one lost message
    // doesn't leave a member out of the call or a ghost in it. Receivers ignore a presence that changed nothing.
    let lastTick = Date.now();
    const refresh = setInterval(() => {
      // A tick far later than due (the device slept, or the page was throttled or stalled): the time missed is added
      // to every peer's last presence, so nobody counts as silent for refreshes that couldn't arrive meanwhile.
      const now = Date.now();
      const missed = now - lastTick - presenceRefreshMs;
      lastTick = now;
      if (missed > presenceRefreshMs) for (const heard of this.heard.values()) heard.at += missed;
      this.expireSilent();
      this.publishSeen();
      if (this.channelId === null) {
        if (this.leftTicks === 0) return;
        this.leftTicks--;
        return this.sendPresence(this.own());
      }
      // To everyone in the workspace, not only the members known to be in the call: a member whose presence never
      // arrived here counts as not in the call, and it may count us the same way, so only a refresh sent to it heals
      // that. Narrowed to the known members, two such members never heard each other (mesh-test s10).
      this.sendPresence(this.own());
    }, presenceRefreshMs);
    this.cleanups.push(() => clearInterval(refresh));
    const heal = setInterval(() => this.heal(), healEveryMs);
    this.cleanups.push(() => clearInterval(heal));
    // Only our own row going out; rows written for other members change the table too.
    this.cleanups.push(backend.subscribe((event) => {
      if (event.plugin !== "voice") return;
      const own = this.own();
      const text = JSON.stringify(own);
      if (text !== this.lastSent) {
        this.lastSent = text;
        return this.sendPresence(own);
      }
      // Only our count changed (another member's row): once, after this change, so receiving a presence never sends
      // one from inside it.
      if (this.seenHere() === this.seenSent || this.seenTimer) return;
      this.seenTimer = setTimeout(() => {
        this.seenTimer = undefined;
        if (this.seenHere() !== this.seenSent) this.sendOwn();
      }, 0);
    }));
    this.cleanups.push(() => clearTimeout(this.seenTimer), () => clearTimeout(this.watchTimer), registerMediaLink(workspaceId, this));
    this.mesh = mesh;
    // Calls through the node (ADR 0005): the node is the arbiter of a call's mode, the member asks it to serve and
    // behaves like the answer. The mesh call keeps running under it, so a call moving between modes never has a gap.
    this.sfu = new SfuLink(
      workspaceId, sync, this.ledger, userId,
      (call) => this.backend.data("voice").select(table, { channel_id: call }).length,
      (mode) => this.callsNodeChanged(mode),
      (user, kind, stream) => {
        const kinds = this.fromNode.get(user) ?? new Set<MediaKind>();
        if (stream) kinds.add(kind);
        else kinds.delete(kind);
        if (kinds.size > 0) this.fromNode.set(user, kinds);
        else this.fromNode.delete(user);
        setRemoteStream(this.workspaceId, user, kind, stream);
        // A member found on the node: its mesh copy is taken back (the node carries ours to it).
        this.route();
      },
    );
  }

  setLocal(channelId: number | null, streams: LocalStreams): void {
    // The call's own room: its members connect to each other directly (members otherwise reach only nodes).
    this.sync.joinCall(channelId ?? this.guestChannel());
    if (channelId === null && this.channelId !== null) this.leftTicks = leftResends;
    if (channelId !== this.channelId) {
      if (this.channelId !== null) this.note("we left the call");
      if (channelId !== null) this.note("we joined the call");
      this.joinPresenceAt = channelId === null ? [] : [1_000, 3_000, 7_000].map((wait) => Date.now() + wait);
      this.micSamples.clear();
      this.missing.clear();
      this.resent.clear();
      // A stage gone without saying so must not keep pictures coming.
      if (this.viewing.size > 0) {
        this.viewing.clear();
        this.sendOwn();
      }
    }
    this.channelId = channelId;
    this.local = streams;
    this.intendSfu();
    this.route();
    for (const peerId of this.peerUsers.keys()) this.show(peerId);
  }

  // A bot hosted here joins a call (or, with null, leaves it): it shows as a member of that call and its streams go to
  // the members in the channel. The call's room is joined when this member is in no call of its own.
  setGuest(userId: number, call: { channelId: number; streams: LocalStreams; row: Omit<JsonRow, "id"> } | null): void {
    const data = this.backend.data("voice");
    if (call) this.guests.set(userId, call);
    else this.guests.delete(userId);
    this.sync.joinCall(this.channelId ?? this.guestChannel());
    data.delete(table, { user_id: userId });
    if (call) data.insert(table, { ...call.row, user_id: userId });
    // This device plays its own bot like any other member's media.
    clearRemote(this.workspaceId, userId);
    if (call) for (const kind of kinds) if (call.streams[kind]) setRemoteStream(this.workspaceId, userId, kind, call.streams[kind]);
    remoteTracksChanged(this.workspaceId);
    this.intendSfu();
    this.sendOwn();
    this.route();
  }

  // What the node link should do now: the call this member is in, or the one of a bot it hosts when it is in none (then
  // it only sends for the bot and listens to nothing).
  private intendSfu(): void {
    const streams = new Map([...this.guests].map(([userId, guest]) => [userId, guest.streams]));
    this.sfu?.setIntent(this.channelId ?? this.guestChannel(), this.local, streams, this.channelId !== null);
  }

  // Whether the hosted bots' media goes through the node (their call is an SFU call and this device's media connected).
  private guestsOnNode(): boolean {
    const channel = this.guestChannel();
    return channel !== null && this.sfu?.modeOf(channel) === "sfu";
  }

  // Whether a peer gets the bots' media over the mesh: unless the call goes through a node for both sides.
  private guestsOverMesh(peerId: string): boolean {
    if (!this.guestsOnNode()) return true;
    const userId = this.peerUsers.get(peerId);
    return !this.peerOnNode.get(peerId) && !(userId !== undefined && this.fromNode.has(userId));
  }

  private guestChannel(): number | null {
    return this.guests.values().next().value?.channelId ?? null;
  }

  close(): void {
    for (const userId of [...this.guests.keys()]) this.setGuest(userId, null);
    this.setLocal(null, { mic: null, camera: null, screen: null });
    void this.sfu?.close();
    this.cleanups.forEach((cleanup) => cleanup());
  }

  // The call changed mode. The others hear it from our presence; the mesh takes its copies back from members on a
  // node too (or sends them again once we are off it), and members on a node get their streams from it.
  private callsNodeChanged(mode: SfuMode): void {
    noteActivity("call mode changes");
    this.note(mode === "sfu" ? "the call goes through a node now" : "the call is back on the mesh");
    if (mode === "sfu") {
      for (const [peerId, userId] of this.peerUsers) if (this.together(peerId) && !this.overMesh(peerId)) clearRemote(this.workspaceId, userId);
    }
    this.sendOwn();
    this.route();
    for (const peerId of this.peerUsers.keys()) this.show(peerId);
  }

  // While a call runs through a node, its streams come from the SFU (via setRemoteStream).
  private sfuMode(): boolean {
    return this.sfu?.modeOf(this.channelId) === "sfu";
  }

  // Whether media with this peer goes over the mesh: unless both sides' calls go through a node. A member still on
  // the mesh (every node busy, its transport failed, an older app) is sent to and heard over it, and keeps hearing us.
  private overMesh(peerId: string): boolean {
    if (!this.sfuMode()) return true;
    const userId = this.peerUsers.get(peerId);
    return !this.peerOnNode.get(peerId) && !(userId !== undefined && this.fromNode.has(userId));
  }

  private sendOwn(): void {
    const own = this.own();
    this.lastSent = JSON.stringify(own);
    this.sendPresence(own);
  }

  private own(): Presence {
    const [row] = this.backend.data("voice").select(table, { user_id: this.userId });
    const node = this.sfuMode();
    const { id: _id, ...rest } = row ?? {};
    const own: Presence = { userId: this.userId, row: row ? rest : null, refreshMs: presenceRefreshMs, node, watching: [...this.viewing] };
    const replaces = this.replaces();
    if (replaces) own.replaces = replaces;
    if (this.guests.size) {
      const node = this.guestsOnNode();
      own.guests = [...this.guests].map(([userId, guest]) => ({ userId, row: guest.row, node }));
    }
    const text = JSON.stringify(own);
    if (text !== this.ownText) {
      this.ownText = text;
      this.ownRevision = ++presenceRevision;
    }
    return { ...own, revision: this.ownRevision };
  }

  // Takes out of the call a member that said it refreshes and has missed several refreshes in a row.
  private expireSilent(): void {
    const now = Date.now();
    for (const [peerId, row] of this.peerRows) {
      const heard = this.heard.get(peerId);
      const userId = this.peerUsers.get(peerId);
      if (!row || userId === undefined || !heard?.refreshMs || now - heard.at <= heard.refreshMs * missedRefreshes) continue;
      if (this.sfuMode() && this.fromNode.has(userId)) continue;
      // Another device of the account still in a call keeps the account's row and streams: only this one's entry goes.
      if (this.rowElsewhere(peerId, userId)) {
        this.peerRows.set(peerId, null);
        this.heard.delete(peerId);
        // Its call size goes too: nothing would expire it again, and it kept the channel's count up for good.
        if (this.seenBy.delete(peerId)) this.publishSeen();
        continue;
      }
      if (this.together(peerId)) this.note(`{peer} taken out of the call: no presence for ${Math.round((now - heard.at) / 1000)} s`, peerId, true);
      this.receive(peerId, { userId, row: null });
    }
  }

  // The other devices of a peer's account (another computer, a view window: each its own peer), and the call row of
  // one of them that is in a call.
  private otherDevices(peerId: string, userId: number): string[] {
    return [...this.peerUsers].filter(([other, user]) => other !== peerId && user === userId).map(([other]) => other);
  }

  private rowElsewhere(peerId: string, userId: number): Omit<JsonRow, "id"> | null {
    for (const other of this.otherDevices(peerId, userId)) {
      const row = this.peerRows.get(other);
      if (row) return row;
    }
    return null;
  }

  private receive(peerId: string, presence: Presence) {
    if (!presence) return;
    // Its sender said bye: whatever it said last (its "left" comes just before), it is gone. Also what `expireSilent`
    // says for it.
    if (this.mesh?.hasQuit(peerId)) return this.quitPeer(peerId);
    if (presence.revision !== undefined) {
      if (!Number.isSafeInteger(presence.revision) || presence.revision < 0 ||
          presence.revision < (this.revisions.get(peerId) ?? -1)) return;
      this.revisions.set(peerId, presence.revision);
    }
    this.takeGuests(peerId, presence);
    if (presence.userId === this.userId) return;
    const returning = this.unreachable.delete(peerId);
    const watching = this.takeWatching(peerId, presence.watching);
    // The sender's app is back after a crash: its old connection goes now. Before its presence when it isn't in a call
    // (the old one's row would keep the member in it), after when it is (the member stays, no leave and join sounds).
    const replaced = this.replacedBy(peerId, presence);
    if (replaced && !presence.row) this.dropReplaced(replaced, peerId);
    const routed = this.takePresence(peerId, presence);
    if (replaced && presence.row) this.dropReplaced(replaced, peerId);
    if ((returning || watching) && !routed) this.route();
    if (Array.isArray(presence.resend)) this.resendTo(peerId, presence.resend);
  }

  // The old peer a presence says it replaces: a peer of the same member, never the sender itself or a hosted bot.
  private replacedBy(peerId: string, presence: Presence): string | null {
    const old = presence.replaces;
    if (typeof old !== "string" || old === peerId || isGuestKey(old) || isGuestKey(peerId)) return null;
    return this.peerUsers.get(old) === presence.userId ? old : null;
  }

  // Here first, quietly when the member stays in the call; then in the mesh, so every feature drops it (its quit comes
  // back here and finds nothing left).
  private dropReplaced(old: string, by: string): void {
    if (this.together(old)) this.note("{peer}'s app restarted: dropped its old connection", by);
    this.forget(old, true);
    this.mesh?.gone(old);
  }

  // A peer whose app said bye (it closed or reloaded; a reload joins again under a new id) leaves the call at once.
  private quitPeer(peerId: string): void {
    if (!this.peerUsers.has(peerId) && !this.unreachable.has(peerId) && !this.hostsGuests(peerId)) return;
    if (this.together(peerId)) this.note("{peer}'s app closed or reloaded: left the call", peerId);
    this.forget(peerId, true);
  }

  private hostsGuests(peerId: string): boolean {
    return [...this.peerUsers.keys()].some((key) => key.startsWith(`${peerId}${guestMark}`));
  }

  // This device views (or stops viewing) a member's shared picture or camera: the member's device sends it here only
  // while it does (ADR 0019). The stage turns its feeds on and off together: one presence goes out for the batch.
  watch(userId: number, picture: Picture, on: boolean): void {
    const key = `${userId}:${picture}`;
    if (on === this.viewing.has(key)) return;
    if (on) this.viewing.add(key);
    else this.viewing.delete(key);
    this.watchTimer ??= setTimeout(() => {
      this.watchTimer = undefined;
      this.sendOwn();
    }, 0);
  }

  // Whether a watched key ("<userId>:<picture>") names a picture this device sends: its own, or a hosted bot's.
  private ours(key: string): boolean {
    const user = Number(key.slice(0, key.indexOf(":")));
    return user === this.userId || this.guests.has(user);
  }

  // What a peer says it views. One of ours it stops viewing keeps going for `lingerMs`; an older app (which says
  // nothing) gets everything. Whether anything about our pictures changed (others' don't move anything here).
  private takeWatching(peerId: string, watching: unknown): boolean {
    const before = this.peerWatching.get(peerId);
    const now = Array.isArray(watching) ? new Set(watching.filter((key): key is string => typeof key === "string")) : undefined;
    if (now) this.peerWatching.set(peerId, now);
    else this.peerWatching.delete(peerId);
    const was = before && new Set([...before].filter((key) => this.ours(key)));
    const is = now && new Set([...now].filter((key) => this.ours(key)));
    if (!was && !is) return false;
    if (was && is && was.size === is.size && [...is].every((key) => was.has(key))) return false;
    const away = this.lookedAway.get(peerId) ?? new Map<string, number>();
    for (const key of was ?? []) if (!is?.has(key)) away.set(key, Date.now());
    for (const key of [...away.keys()]) if (!is || is.has(key)) away.delete(key);
    if (away.size > 0) this.lookedAway.set(peerId, away);
    else this.lookedAway.delete(peerId);
    return true;
  }

  // Whether a peer gets our picture: while it views it, a short while after, or always when its app doesn't say what it
  // views.
  private getsPicture(peerId: string, userId: number, picture: Picture): boolean {
    const watching = this.peerWatching.get(peerId);
    const key = `${userId}:${picture}`;
    if (!watching || watching.has(key)) return true;
    const since = this.lookedAway.get(peerId)?.get(key);
    return since !== undefined && Date.now() - since < lingerMs;
  }

  // Pictures whose viewer looked away long enough ago stop going to it.
  private expireLookedAway(): void {
    const now = Date.now();
    let expired = false;
    for (const [peerId, away] of this.lookedAway) {
      for (const [key, since] of away) {
        if (now - since < lingerMs) continue;
        away.delete(key);
        expired = true;
      }
      if (away.size === 0) this.lookedAway.delete(peerId);
    }
    if (expired) this.route();
  }

  // What a peer in the call gets of a stream of ours or of a hosted bot's: the mic, and a share of sound alone, as it
  // is; a picture while the peer views it, else nothing of a camera and a share's sound alone (heard whatever is
  // shown, at a fraction of the picture's upload).
  private copyFor(peerId: string, userId: number, kind: MediaKind, stream: MediaStream | null): MediaStream | null {
    if (!stream || !isPicture(kind, stream) || this.getsPicture(peerId, userId, kind as Picture)) return stream;
    return kind === "screen" ? this.soundOf(stream) : null;
  }

  // A share's sound tracks as a stream of their own, made once per share (null: the share has no sound).
  private soundOf(share: MediaStream): MediaStream | null {
    let copy = this.soundCopies.get(share);
    if (copy === undefined) {
      const tracks = share.getAudioTracks();
      copy = tracks.length > 0 ? new MediaStream(tracks) : null;
      this.soundCopies.set(share, copy);
    }
    return copy;
  }

  // The bots a peer hosts that are in a call: each one is a virtual peer of its own. Only a bot of the sender counts,
  // and one the sender no longer lists has left.
  private takeGuests(peerId: string, presence: Presence): void {
    if (isGuestKey(peerId)) return;
    const listed = new Set<number>();
    for (const guest of Array.isArray(presence.guests) ? presence.guests : []) {
      if (!guest || !Number.isSafeInteger(guest.userId) || !guest.row || !this.hostsBot(presence.userId, guest.userId)) continue;
      listed.add(guest.userId);
      this.takePresence(guestKey(peerId, guest.userId), {
        userId: guest.userId, row: guest.row, refreshMs: presence.refreshMs, node: guest.node === true,
      });
    }
    for (const [key, userId] of [...this.peerUsers])
      if (key.startsWith(`${peerId}${guestMark}`) && !listed.has(userId)) this.forget(key, true);
  }

  private hostsBot(hostUser: number, botUser: number): boolean {
    const [bot] = this.ledger.select("bots", "bots_bots", { user_id: botUser });
    return !!bot && Number(bot.host) === hostUser;
  }

  // Whether it routed the call's streams again (the presence changed something).
  private takePresence(peerId: string, presence: Presence): boolean {
    const previous = this.peerUsers.get(peerId);
    this.heard.set(peerId, { at: Date.now(), refreshMs: presence.refreshMs });
    this.metUsers.set(peerId, presence.userId);
    const data = this.backend.data("voice");
    const onNode = presence.node === true;
    this.noteSeen(peerId, presence);
    // The same presence again (the refresh while in a call, a direct link opening): nothing changed. Writing it anyway
    // gave the row a new id, so every participant list remounted it, and asked the call's node again. Unless the row
    // went meanwhile (another device of the same account said it isn't in a call): then the refresh puts it back.
    const sameRow = previous === presence.userId && this.peerRows.has(peerId) &&
      JSON.stringify(this.peerRows.get(peerId)) === JSON.stringify(presence.row) &&
      (!presence.row || data.select(table, { user_id: presence.userId }).length > 0);
    if (sameRow && (this.peerOnNode.get(peerId) ?? false) === onNode) return false;
    // A member we had lost is back: they may have lost us too, and a presence sent through a go-between can be lost.
    if (previous !== undefined && previous !== presence.userId) clearRemote(this.workspaceId, previous);
    noteActivity("call members changed");
    const wasTogether = this.together(peerId);
    this.peerUsers.set(peerId, presence.userId);
    this.peerOnNode.set(peerId, onNode);
    if (!sameRow) {
      // A device not in a call speaks only for itself: the account stays in the call another of its devices is in
      // (a view window met a member, and the member dropped the main window's call).
      const row = presence.row ?? this.rowElsewhere(peerId, presence.userId);
      const [current] = data.select(table, { user_id: presence.userId });
      if (!row || !current || Object.entries(row).some(([key, value]) => current[key] !== value)) {
        data.delete(table, { user_id: presence.userId });
        if (row) data.insert(table, { ...row, user_id: presence.userId });
      }
    }
    this.peerRows.set(peerId, presence.row);
    // Said by the member itself (the presence a silent member is taken out with has no refreshMs): a link that closes
    // after this is a member leaving, not a drop.
    if (wasTogether !== this.together(peerId) && presence.refreshMs !== undefined)
      this.note(wasTogether ? "{peer} left the call" : "{peer} joined the call", peerId);
    // Record the sender before answering: synchronous delivery must not recurse through two unknown peers.
    if (previous === undefined && !isGuestKey(peerId)) this.sendPresence(this.own(), peerId);
    this.show(peerId);
    this.route();
    // The call's size changed; if it crossed the server's SFU threshold the node's word about the mode changes too.
    this.intendSfu();
    return true;
  }

  private seenHere(): number | undefined {
    const [row] = this.backend.data("voice").select(table, { user_id: this.userId });
    return row ? this.backend.data("voice").select(table, { channel_id: row.channel_id }).length : undefined;
  }

  private noteSeen(peerId: string, presence: Presence): void {
    const channelId = presence.row ? Number(presence.row.channel_id) : null;
    const count = typeof presence.seen === "number" && Number.isSafeInteger(presence.seen) ? presence.seen : null;
    const before = this.seenBy.get(peerId);
    if (channelId !== null && count !== null) {
      if (before?.channelId === channelId && before.count === count) return;
      this.seenBy.set(peerId, { channelId, count });
    } else if (!this.seenBy.delete(peerId)) return;
    this.publishSeen();
  }

  // The largest count any member reports for each channel, only while that member said it lately: within the refreshes
  // `expireSilent` allows (an older app that never refreshes stays listed, but what it said once stops counting). A
  // silent device's last count stayed in the max for good and kept a channel at 3 on every screen, the leaver's too.
  // The refresh tick publishes again, so a count goes at most one refresh after its window.
  private publishSeen(): void {
    const now = Date.now();
    const sizes: Record<number, number> = {};
    for (const [peerId, { channelId, count }] of this.seenBy) {
      const heard = this.heard.get(peerId);
      if (!heard || now - heard.at > (heard.refreshMs ?? presenceRefreshMs) * missedRefreshes) continue;
      sizes[channelId] = Math.max(sizes[channelId] ?? 0, count);
    }
    setReportedSizes(this.workspaceId, sizes);
  }

  private together(peerId: string): boolean {
    const row = this.peerRows.get(peerId);
    return this.channelId !== null && !!row && Number(row.channel_id) === this.channelId;
  }

  // Puts a member's streams in the call while we are in their channel and they are sending them over the mesh (a
  // member on the node as well gets its streams from there, set by the SFU link).
  private show(peerId: string) {
    if (!this.overMesh(peerId)) return;
    const userId = this.peerUsers.get(peerId);
    if (userId === undefined) return;
    const row = this.peerRows.get(peerId);
    const together = this.together(peerId);
    // A member's streams are kept by account: a device of theirs outside the call leaves those of one in it alone.
    if (!together && this.otherDevices(peerId, userId).some((other) => this.together(other))) return;
    const on: Record<MediaKind, boolean> = { mic: true, camera: !!row?.camera, screen: !!row?.sharing };
    for (const kind of kinds) {
      const incoming = this.incoming.get(peerId)?.get(kind);
      const stream = together && on[kind] && incoming && hasLive(incoming, kind) ? incoming : null;
      if (stream !== (remoteStream(this.workspaceId, userId, kind) ?? null)) setRemoteStream(this.workspaceId, userId, kind, stream);
    }
  }

  // Whether this member waits for the peer's mic: both in this call over the mesh, the peer unmuted (a muted member may
  // have no mic at all), and no live mic track of theirs here, from the mesh or the node. Only whether a track is
  // there: a silent member sends next to nothing (noise gate, Opus DTX), and the connection then flags its track muted.
  private waitsForMic(peerId: string): boolean {
    if (this.channelId === null || this.unreachable.has(peerId) || !this.together(peerId) || !this.overMesh(peerId)) return false;
    const userId = this.peerUsers.get(peerId);
    if (userId === undefined || this.fromNode.get(userId)?.has("mic")) return false;
    if (this.peerRows.get(peerId)?.muted) return false;
    const mic = this.incoming.get(peerId)?.get("mic");
    return !(mic && micTrack(mic));
  }

  private heal(): void {
    const now = Date.now();
    for (const [peer, since] of this.unreachable) {
      const user = this.peerUsers.get(peer);
      // An independent SFU consumer is still evidence of membership when only the mesh route disappeared.
      if (this.sfuMode() && user !== undefined && this.fromNode.has(user)) continue;
      if (now - since >= reconnectGraceMs) this.forget(peer);
    }
    this.expireLookedAway();
    // Only while our own row says we are in the call: the others send to us only then.
    if (this.channelId === null || Number(this.own().row?.channel_id) !== this.channelId) return this.missing.clear();
    // The first presence can be lost while rooms/authentication settle. Refresh everyone briefly on joining, including
    // peers we don't yet know are in the call; otherwise neither side asks for media until the 20 s refresh.
    const upcoming = this.joinPresenceAt.filter((at) => at > now);
    if (upcoming.length < this.joinPresenceAt.length) this.sendPresence(this.own());
    this.joinPresenceAt = upcoming;
    // A mic comes only over a direct link (ADR 0019): asking a member without one is no use until it comes.
    const direct = new Set(this.mesh?.directPeers() ?? []);
    for (const peerId of this.peerUsers.keys()) {
      if (isGuestKey(peerId) || !direct.has(peerId) || !this.waitsForMic(peerId)) {
        this.missing.delete(peerId);
        continue;
      }
      const gap = this.missing.get(peerId);
      if (!gap) {
        this.missing.set(peerId, { next: now + askAfterMs, wait: askAfterMs });
        continue;
      }
      if (now < gap.next) continue;
      gap.wait = Math.min(gap.wait * 2, askAgainMaxMs);
      gap.next = now + gap.wait;
      // Only asked: the connection itself is Trystero's, and it carries the workspace's sync and every other stream.
      this.note("{peer}'s mic doesn't arrive: asked them to send it again", peerId, true);
      this.sendPresence({ ...this.own(), resend: ["mic"] }, peerId);
    }
  }

  // A member doesn't get some of our streams: they go to it again. Its presence came with the request, so a member
  // that counts us in its call while we didn't know it was in ours is sent to as well.
  private resendTo(peerId: string, wanted: unknown[]): void {
    if (!this.mesh || !this.together(peerId) || !this.overMesh(peerId)) return;
    const now = Date.now();
    if (now - (this.resent.get(peerId) ?? 0) < resendGapMs) return;
    this.resent.set(peerId, now);
    for (const kind of kinds) {
      const stream = wanted.includes(kind) ? this.sent.get(peerId)?.get(kind) : undefined;
      if (!stream) continue;
      this.note(`{peer} doesn't get our ${kind}: queued it for resend`, peerId, true);
      this.mesh.resend(stream, peerId);
    }
  }

  // The share's quality (ADR 0006): the node path tunes its own producer, the mesh every connection carrying it.
  setQuality(quality: ShareQuality): void {
    this.quality = quality;
    this.sfu?.setQuality(quality);
    this.tuneMesh();
  }

  // The senders of a stream of ours on every connection (one per receiver: nobody passes it on).
  private sendersOf(stream: MediaStream | null): RTCRtpSender[] {
    const tracks = stream?.getTracks() ?? [];
    if (tracks.length === 0) return [];
    return Object.values(this.sync.room?.getPeers() ?? {}).flatMap((pc) =>
      pc.connectionState === "closed" ? [] : pc.getSenders().filter((sender) => !!sender.track && tracks.includes(sender.track)));
  }

  // Our share's senders, picture and sound apart.
  private screenSenders(): ScreenSenders<RTCRtpSender> {
    const senders = this.sendersOf(this.local.screen);
    return { video: senders.filter((s) => s.track!.kind === "video"), audio: senders.filter((s) => s.track!.kind === "audio") };
  }

  // Voice ahead of pictures on every connection, the camera's copies within the camera budget (shareQuality.ts).
  private tunePriorities(): void {
    const camera = this.sendersOf(this.local.camera);
    void applyCallPriorities({ mic: this.sendersOf(this.local.mic), camera }, camera.length);
  }

  // Each copy is one upload, so the upload budget counts the picture's senders.
  private tuneMesh(): void {
    if (!this.quality) return;
    const senders = this.screenSenders();
    if (senders.video.length + senders.audio.length > 0) void applyShareQuality(senders, this.quality, senders.video.length);
  }

  // Some browsers give a sender no encodings until its connection is negotiated: those are tuned once it is (tuning
  // again is cheap, senders that already have the settings are left alone).
  private watchNegotiation(target: string): void {
    const pc = this.sync.room?.getPeers()[target];
    if (!pc || this.watched.has(pc)) return;
    this.watched.add(pc);
    // Every link carrying our media. A local close() fires no event: a closed link shows as
    // "direct link closed" (onDirectPeers) or as the mic placed again (onPlaced).
    let troubled = false;
    pc.addEventListener("connectionstatechange", () => {
      const state = pc.connectionState;
      if (state === "disconnected" || state === "failed") {
        troubled = true;
        this.note(`connection to {peer} ${state}`, target, true);
      } else if (state === "connected" && troubled) {
        troubled = false;
        this.note("connection to {peer} back", target);
      }
    });
    let stuck: ReturnType<typeof setTimeout> | undefined;
    pc.addEventListener("signalingstatechange", () => {
      clearTimeout(stuck);
      if (pc.signalingState === "closed") return;
      if (pc.signalingState !== "stable") {
        stuck = setTimeout(() => this.note(`connection to {peer} still negotiating after ${stuckNegotiationMs / 1000} s`, target, true), stuckNegotiationMs);
        return;
      }
      noteActivity("renegotiations");
      this.tuneMesh();
      this.tunePriorities();
    });
  }

  async shareStats(): Promise<ShareStats | null> {
    const track = this.local.screen?.getVideoTracks()[0];
    if (!this.quality || !track) return null;
    const viaNode = this.sfuMode();
    const senders = viaNode ? [] : this.screenSenders().video;
    const reports = viaNode ? [await this.sfu?.screenStats()] : await Promise.all(senders.map((sender) => sender.getStats()));
    const samples = reports.flatMap((report) => {
      const sample = report ? readOutbound(report) : null;
      return sample ? [sample] : [];
    });
    const numbers = summarizeShare(samples, this.lastSamples);
    this.lastSamples = new Map(samples.map((sample) => [sample.id, sample]));
    // Nobody receiving it yet: what the capture gives.
    if (samples.length === 0) {
      const settings = track.getSettings();
      if (settings.width !== undefined) Object.assign(numbers, { width: settings.width, height: settings.height });
      if (settings.frameRate !== undefined) numbers.fps = settings.frameRate;
    }
    const copies = viaNode ? 1 : senders.length;
    return {
      ...numbers, copies, viaNode, cap: effectiveBitrate(this.quality, copies), soundRefused: viaNode && !!this.sfu?.screenSoundRefused(),
    };
  }

  // This device's connections, for call diagnostics.
  deviceInfo(): Record<string, string | number> {
    const states = Object.values(this.sync.room?.getPeers() ?? {}).map((pc) => pc.connectionState);
    const count = (state: string) => states.filter((s) => s === state).length;
    const negotiating = Object.values(this.sync.room?.getPeers() ?? {}).filter((pc) => pc.signalingState !== "stable" && pc.signalingState !== "closed").length;
    return {
      "Peer connections": `${states.length} (${count("connected")} connected, ${count("connecting") + count("new")} connecting, ${count("failed")} failed)`,
      "Connections negotiating now": negotiating,
      "Media call channel": this.channelId ?? "none",
      "Published call channel": String(this.own().row?.channel_id ?? "none"),
      "Backend participants": JSON.stringify(this.backend.data("voice").select(table).map((row) => ({ user: row.user_id, channel: row.channel_id }))),
      "Peer presence": JSON.stringify([...this.peerUsers].map(([peer, user]) => ({
        peer, user, channel: this.peerRows.get(peer)?.channel_id ?? null,
        ageMs: Date.now() - (this.heard.get(peer)?.at ?? Date.now()),
        reconnecting: this.unreachable.has(peer), revision: this.revisions.get(peer) ?? null,
      }))),
      "Peers awaiting authentication": this.sync.room?.unauthenticatedPeers?.().length ?? 0,
    };
  }

  // WebRTC's own numbers for each connection to the member: route, the audio both ways, and every stream we send them.
  async diagnose(userId: number): Promise<DiagnosticRow[]> {
    const connections = this.sync.room?.getPeers() ?? {};
    const result: DiagnosticRow[] = [];
    for (const [peerId, user] of this.peerUsers) {
      if (user !== userId) continue;
      const info: DiagnosticRow = {
        "In the same channel": this.together(peerId),
        "Sending them": [...(this.sent.get(peerId)?.keys() ?? [])].join(", ") || "nothing",
      };
      // Over the mesh media goes only over the direct link (ADR 0019): without one there is nothing to measure yet. A
      // member whose call goes through the node is shown by the way it is reached (a node, for its messages).
      const viaNode = !this.overMesh(peerId);
      const relay = viaNode ? this.mesh?.relayOf(peerId) : undefined;
      const pc = connections[relay ?? peerId];
      if (!pc) {
        // Only a caller of our call is being linked (through its room).
        if (viaNode || isGuestKey(peerId) || !this.together(peerId)) continue;
        info["Connection"] = "connecting directly";
        result.push(info);
        continue;
      }
      const stats = await pc.getStats();
      const byId = new Map<string, Record<string, unknown>>();
      stats.forEach((s: Record<string, unknown>) => byId.set(String(s.id), s));
      info["Connection"] = relay ? `through ${this.nameOf(relay)} (${pc.connectionState})` : pc.connectionState;
      info["Signaling"] = pc.signalingState;
      info["Audio tracks received"] = pc.getReceivers().filter((r) => r.track?.kind === "audio").length;
      for (const s of byId.values()) {
        if (s.type === "candidate-pair" && (s.nominated || s.selected) && s.state === "succeeded") {
          const local = byId.get(String(s.localCandidateId));
          const remote = byId.get(String(s.remoteCandidateId));
          info["Route"] = `${local?.candidateType ?? "?"} -> ${remote?.candidateType ?? "?"} (${local?.protocol ?? "?"})`;
          if (typeof s.currentRoundTripTime === "number") info["Round trip (ms)"] = Math.round(s.currentRoundTripTime * 1000);
          if (typeof s.availableOutgoingBitrate === "number") info["Available upload (kbit/s)"] = Math.round(s.availableOutgoingBitrate / 1000);
        }
      }
      const incoming = remoteStream(this.workspaceId, userId, "mic");
      const track = incoming && micTrack(incoming);
      const receiver = track && pc.getReceivers().find((receiver) => receiver.track === track);
      if (track) {
        info["Mic track"] = track.id;
        info["Mic track muted by connection"] = track.muted;
        if (!receiver) info["Audio in: stats"] = "playing mic is on another connection (node or handoff)";
      }
      if (receiver) {
        try {
          const sample = readMicStats(await receiver.getStats());
          const now = Date.now();
          const before = this.micSamples.get(peerId);
          const same = before?.track === track && sample.bytes >= before.bytes && sample.packets >= before.packets;
          const advanced = same && sample.packets > before.packets;
          const lastPacket = !same || advanced ? now : before.lastPacket;
          this.micSamples.set(peerId, { ...sample, track: track!, at: now, lastPacket });
          info["Audio in: bytes"] = sample.bytes;
          info["Audio in: packets"] = sample.packets;
          info["Audio in: packets lost"] = sample.lost;
          if (sample.level !== undefined) info["Audio in: level (0-1)"] = Math.round(sample.level * 1000) / 1000;
          if (same && now > before.at) {
            info["Audio in: kbit/s since last sample"] = Math.round((sample.bytes - before.bytes) * 8 / (now - before.at));
            info["Audio in: ms without packet progress"] = now - lastPacket;
          }
        } catch {
          info["Audio in: stats"] = "receiver unavailable during handoff";
        }
      }
      // Each stream we send them on its own: what the encoder makes of it and what holds it back.
      for (const sender of pc.getSenders()) {
        const label = sender.track ? this.sentLabel(peerId, sender.track) : null;
        const sample = label ? readOutbound(await sender.getStats()) : null;
        if (!label || !sample) continue;
        info[`${label} out: bytes`] = sample.bytes;
        if (sample.width !== undefined) info[`${label} out: resolution`] = `${sample.width}x${sample.height}`;
        if (sample.fps !== undefined) info[`${label} out: fps`] = Math.round(sample.fps);
        if (sample.target !== undefined) info[`${label} out: target (kbit/s)`] = Math.round(sample.target / 1000);
        if (sample.limitation !== undefined) info[`${label} out: limited by`] = sample.limitation;
      }
      result.push(info);
    }
    return result;
  }

  // What happened to the call's links lately (voice/activity.ts), newest first, with members' names: each looked up
  // once (the panel asks every second, and a lookup reads the member table).
  callEvents(): string[] {
    const names = new Map<string, string>();
    return recentCallEvents(this.workspaceId, (peerId) => {
      let name = names.get(peerId);
      if (name === undefined) names.set(peerId, (name = this.nameOf(peerId)));
      return name;
    });
  }

  private note(text: string, peer?: string, warn = false): void {
    noteCallEvent(this.workspaceId, text, peer, warn);
  }

  // A peer's name as the member list shows it; "another member" for one that sent no presence (a node).
  private nameOf(peerId: string): string {
    const user = this.peerUsers.get(peerId) ?? this.metUsers.get(peerId);
    const profile = user === undefined ? null : this.backend.data("members").select("members_profiles", { user_id: user })[0];
    return String(profile?.display_name ?? profile?.username ?? "another member");
  }

  // Which of our streams a sender to this peer carries, as call diagnostics name it.
  private sentLabel(peerId: string, track: MediaStreamTrack): string | null {
    for (const [kind, stream] of this.sent.get(peerId) ?? []) {
      if (!stream.getTracks().includes(track)) continue;
      if (kind === "screen") return track.kind === "audio" ? "Screen sound" : "Screen";
      return kind === "mic" ? "Mic" : "Camera";
    }
    return null;
  }

  private forget(peerId: string, quiet = false) {
    for (const key of [...this.peerUsers.keys()]) if (key.startsWith(`${peerId}${guestMark}`)) this.forget(key, true);
    this.sentGuests.delete(peerId);
    this.unreachable.delete(peerId);
    if (this.seenBy.delete(peerId)) this.publishSeen();
    const userId = this.peerUsers.get(peerId);
    if (userId !== undefined) noteActivity("peers lost");
    if (this.together(peerId) && !quiet) this.note("lost {peer}: no way to reach them", peerId, true);
    const had = this.sent.get(peerId);
    this.peerUsers.delete(peerId);
    this.peerRows.delete(peerId);
    this.peerOnNode.delete(peerId);
    this.heard.delete(peerId);
    this.sent.delete(peerId);
    this.incoming.delete(peerId);
    this.missing.delete(peerId);
    this.resent.delete(peerId);
    this.micSamples.delete(peerId);
    this.peerWatching.delete(peerId);
    this.lookedAway.delete(peerId);
    this.intendSfu();
    this.retuneWithout(had);
    if (userId === undefined) return;
    // Another connection of the same account may still be there.
    if ([...this.peerUsers.values()].includes(userId)) return;
    this.backend.data("voice").delete(table, { user_id: userId });
    clearRemote(this.workspaceId, userId);
  }

  private receiveStream(from: string, stream: MediaStream, meta: StreamMeta) {
    const kind = meta.kind as MediaKind;
    if (!kinds.has(kind)) return;
    const peerId = typeof meta.guest === "number" && Number.isSafeInteger(meta.guest) ? guestKey(from, meta.guest) : from;
    noteActivity("streams received");
    const streams = this.incoming.get(peerId) ?? new Map<MediaKind, MediaStream>();
    this.incoming.set(peerId, streams);
    const before = streams.get(kind);
    if (kind === "mic" && before && before !== stream && this.together(peerId)) this.note("{peer}'s mic arrived again on a new stream", peerId);
    streams.set(kind, stream);
    this.watchTracks(peerId, kind, stream);
    this.show(peerId);
    remoteTracksChanged(this.workspaceId);
  }

  // Trystero hands the same stream object again when its sender places it again, sometimes before the new track came:
  // the old track is removed, the new one added later. So a stream stays a member's until another one comes, and each
  // change of its tracks shows the member again (dropped at the first removal, the new track went unnoticed and the
  // member stayed silent).
  private watchTracks(peerId: string, kind: MediaKind, stream: MediaStream) {
    if (this.watchedStreams.has(stream)) return;
    this.watchedStreams.add(stream);
    let live = hasLive(stream, kind);
    const changed = () => {
      if (this.incoming.get(peerId)?.get(kind) !== stream) return;
      const now = hasLive(stream, kind);
      if (kind === "mic" && now !== live && this.together(peerId)) this.note(now ? "{peer}'s mic is back" : "{peer}'s mic stream ended", peerId, !now);
      live = now;
      this.show(peerId);
      remoteTracksChanged(this.workspaceId);
    };
    const watchTrack = (track: MediaStreamTrack) => {
      track.addEventListener?.("ended", changed);
      track.addEventListener?.("unmute", changed);
      track.addEventListener?.("mute", changed);
    };
    stream.getTracks().forEach(watchTrack);
    stream.addEventListener?.("addtrack", (event) => {
      watchTrack((event as MediaStreamTrackEvent).track);
      changed();
    });
    stream.addEventListener?.("removetrack", changed);
  }

  // Sends each local stream to the peers in our channel and takes back what they should no longer get: the mic and a
  // share's sound to every one, a picture or the camera only to those that view it (`copyFor`).
  private route() {
    const mesh = this.mesh;
    if (!mesh) return;
    this.routeGuests(mesh);
    const copies = this.copies();
    for (const peerId of this.peerUsers.keys()) {
      if (isGuestKey(peerId)) continue;
      // The node forwards our streams to members on it too: no mesh copy for them (it is taken back).
      const together = !this.unreachable.has(peerId) && this.together(peerId) && this.overMesh(peerId);
      const sent = this.sent.get(peerId) ?? new Map<MediaKind, MediaStream>();
      this.sent.set(peerId, sent);
      for (const kind of kinds) {
        const want = together ? this.copyFor(peerId, this.userId, kind, this.local[kind]) : null;
        const have = sent.get(kind) ?? null;
        if (want === have) continue;
        if (have) {
          mesh.removeStream(have, peerId);
          sent.delete(kind);
        }
        if (want) {
          mesh.addStream(want, peerId, { kind });
          sent.set(kind, want);
        }
      }
    }
    // Copies taken back change each copy's share of the budget now; new ones are tuned once their senders exist
    // (onPlaced). Nothing to tune when no copy came or went: walking every connection's senders on each presence
    // change cost a lot in a big call.
    const after = this.copies();
    if (after.screen !== copies.screen) this.tuneMesh();
    if (after.camera !== copies.camera) this.tunePriorities();
  }

  // A peer that got a copy of our screen or camera is gone: each copy left gets a bigger share of the budget.
  private retuneWithout(had: Map<MediaKind, MediaStream> | undefined): void {
    if (had?.has("screen")) this.tuneMesh();
    if (had?.has("camera")) this.tunePriorities();
  }

  // Sends each hosted bot's streams to the members in its channel and takes them back from the others, like a member's
  // own (`copyFor`): the media bot's sound rides in its share's stream, so a member not viewing it gets the sound alone.
  private routeGuests(mesh: Mesh): void {
    let moved = false;
    for (const peerId of this.peerUsers.keys()) {
      if (isGuestKey(peerId)) continue;
      const row = this.peerRows.get(peerId);
      const sent = this.sentGuests.get(peerId) ?? new Map<string, MediaStream>();
      this.sentGuests.set(peerId, sent);
      const wanted = new Map<string, { stream: MediaStream; userId: number; kind: MediaKind }>();
      if (row && !this.unreachable.has(peerId) && this.guestsOverMesh(peerId))
        for (const [userId, guest] of this.guests) {
          if (Number(row.channel_id) !== guest.channelId) continue;
          for (const kind of kinds) {
            const stream = this.copyFor(peerId, userId, kind, guest.streams[kind]);
            if (stream) wanted.set(`${userId}:${kind}`, { stream, userId, kind });
          }
        }
      for (const [key, stream] of [...sent]) {
        if (wanted.get(key)?.stream === stream) continue;
        moved = true;
        mesh.removeStream(stream, peerId);
        sent.delete(key);
      }
      for (const [key, { stream, userId, kind }] of wanted) {
        if (sent.has(key)) continue;
        mesh.addStream(stream, peerId, { kind, guest: userId });
        sent.set(key, stream);
      }
    }
    // A copy taken back changes each copy's share of the budget now; new ones are tuned once placed (onPlaced).
    if (moved) this.tuneGuests();
  }

  // A hosted bot's share is a picture like a member's: its copies share the upload budget (at the default quality,
  // a bot picks none), its sound gets its own small bitrate, both below the call's voices.
  private tuneGuests(): void {
    for (const guest of this.guests.values()) {
      const senders = this.sendersOf(guest.streams.screen);
      const split = { video: senders.filter((s) => s.track!.kind === "video"), audio: senders.filter((s) => s.track!.kind === "audio") };
      if (senders.length > 0) void applyShareQuality(split, defaultShareQuality, split.video.length);
    }
  }

  // Whether a stream placed on a connection is (a copy of) a hosted bot's share.
  private isGuestShare(stream: MediaStream): boolean {
    for (const guest of this.guests.values()) {
      const share = guest.streams.screen;
      if (share && (stream === share || stream === this.soundCopies.get(share))) return true;
    }
    return false;
  }

  // How many members our screen and our camera go to over the mesh (each copy is one upload).
  private copies(): Record<Picture, number> {
    const copies = { screen: 0, camera: 0 };
    for (const sent of this.sent.values()) {
      if (sent.has("screen")) copies.screen++;
      if (sent.has("camera")) copies.camera++;
    }
    return copies;
  }
}

// Whether a stream only goes to the callers who view it: a camera, or a share with a picture (a share of sound only
// goes to every caller, there is nothing to view).
function isPicture(kind: MediaKind, stream: MediaStream): boolean {
  return kind === "camera" || (kind === "screen" && stream.getVideoTracks().length > 0);
}

// Whether a member's stream carries anything now: for the mic a live sound track, else any live track.
function hasLive(stream: MediaStream, kind: MediaKind): boolean {
  const tracks = kind === "mic" ? stream.getAudioTracks() : stream.getTracks();
  return tracks.some((track) => track.readyState !== "ended");
}
