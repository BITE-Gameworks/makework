// A member's side of a call through a node (ADR 0005), owned by VoiceLink. The node is the arbiter of a call's
// mode: the member asks the call's node (the first authorized node in the rendezvous order that answers) whether it
// serves, and behaves like the answer: an SFU call for its media, a mesh call otherwise (VoiceLink still sends its
// streams itself). Everything here is additive to the mesh: a workspace without calls-through-nodes, or an app before
// them, just never answers "serve".
//
// mediasoup-client is loaded lazily (dynamic import), so this module compiles and runs in node too (tests), where
// RTCPeerConnection isn't available until a Device is actually made.
import { account, accountKey } from "../core/account";
import { sign } from "../core/identity";
import { compareText } from "../core/text";
import { authorizedNodes, nodeLinkOf } from "./nodes";
import { requestAction } from "./requests";
import {
  callNodeOrder, mediaKind, sfuDriven, sfuJoinText, sfuNotifyChannel, sfuRequestChannel, sfuSettings,
  type SfuJoin, type SfuKind, type SfuNotify, type SfuProducerInfo, type SfuReply, type SfuRequest,
} from "./sfuProtocol";
import type { Ledger } from "./ledger";
import type { WorkspaceSync } from "./sync";
import type { LocalStreams, MediaKind } from "../voice/media";
import { applyShareQuality, picturePriority, screenSenderSettings, voicePriority, type ScreenSenders, type ShareQuality } from "../voice/shareQuality";

export type SfuMode = "mesh" | "sfu";

// How long a join ask waits on one node before the next one is asked, and a request's lifetime.
const askMs = 8_000;
// How long a node that failed this member is left out of the join order (reachable on the mesh, unreachable for
// media: its RTC ports blocked, or no direct connection for the call's requests), after which it is asked again.
// Each failure in a row doubles it up to maxAvoidMs: a node whose media port nobody forwarded was joined and left
// every 75 s, renegotiating every mesh connection each time.
const avoidMs = 60_000;
const maxAvoidMs = 15 * 60_000;
// How long after no node took the call (all busy, none answering) the nodes are asked again.
const joinRetryMs = 15_000;
// How long a kind the node refused (a voice-muted mic) waits before it is asked again, unless its track changes.
const refusedRetryMs = 30_000;
// How soon a producer this member couldn't receive is tried again (not yet in the node's router, a consume that
// failed on the way), and how many times.
const consumeRetryMs = 1_500;
const consumeTries = 10;
// What the link answers itself when it has no node to ask, and when the node gave no producer id.
const notInCall = "not in a call";
const unanswered = "produce failed";
// In a call now, or falling back? An SFU call needs a moment to bring its transports up.
let deviceModule: typeof import("mediasoup-client") | null = null;

type SendTransport = {
  on(event: "connect", handler: (data: { dtlsParameters: unknown }, callback: () => void, errback: (e: Error) => void) => void): void;
  on(event: "produce", handler: (data: { kind: "audio" | "video"; rtpParameters: unknown; appData: { kind: SfuKind; as?: number } }, callback: (result: { id: string }) => void, errback: (e: Error) => void) => void): void;
  on(event: "connectionstatechange", handler: (state: string) => void): void;
  produce(data: { track: MediaStreamTrack; appData: { kind: SfuKind; as?: number }; encodings?: RTCRtpEncodingParameters[]; codecOptions?: { opusDtx?: boolean }; stopTracks?: boolean }): Promise<Producer>;
  close(): void;
};
type RecvTransport = {
  on(event: "connect", handler: (data: { dtlsParameters: unknown }, callback: () => void, errback: (e: Error) => void) => void): void;
  on(event: "connectionstatechange", handler: (state: string) => void): void;
  // The node named this transport's consumer with the media kind, which mediasoup-client requires.
  consume(data: { id: string; producerId: string; kind: "audio" | "video"; rtpParameters: unknown }): Promise<Consumer>;
  close(): void;
};
// rtpSender: the producer's own RTCRtpSender (mediasoup-client 3.x), where the share's quality is set.
type Producer = {
  id: string;
  track: MediaStreamTrack | null;
  rtpSender?: RTCRtpSender;
  replaceTrack(options: { track: MediaStreamTrack | null }): Promise<void>;
  close(): void;
};
type Consumer = { id: string; track: MediaStreamTrack; paused: boolean; resume(): Promise<void>; close(): void };
type SfuDevice = {
  rtpCapabilities: unknown;
  // mediasoup-client's Device.load takes the router's capabilities by name, not bare.
  load(options: { routerRtpCapabilities: unknown }): Promise<void>;
  createSendTransport(params: Record<string, unknown>): Promise<SendTransport>;
  createRecvTransport(params: Record<string, unknown>): Promise<RecvTransport>;
};

// How this member signs its join asks and names its public key; real code takes them from the account (core/account).
export interface SfuCredentials {
  key: { x: string; y: string };
  sign(text: string): Promise<string>;
}

// What a member can prove they are, and what it signs with, are the only parts of a join the (test) caller controls;
// everything else this class works out from the ledger and the network like the node does.
function accountCredentials(): SfuCredentials | null {
  try {
    const keys = accountKey();
    const me = account();
    if (!keys || !me?.publicKey?.x) return null;
    return { key: { x: me.publicKey.x, y: me.publicKey.y }, sign: (text) => sign(keys, text) };
  } catch {
    return null;
  }
}

// One line per decision, `[sfu] call <id>: ...`, in the console (the packaged app's log, mesh-test's client logs).
function log(call: number | null, what: string): void {
  console.info(`[sfu] call ${call ?? "-"}: ${what}`);
}

const producerKey = (kind: SfuKind, bot: number | null) => (bot === null ? kind : `${bot}:${kind}`);

export class SfuLink {
  // Where this member is: the call it is in, and its mode there (a mesh call keeps this at "mesh").
  private call: number | null = null;
  private mode: SfuMode = "mesh";
  // Whether every direction currently needed through the node is connected. Until then the call stays on the
  // mesh for everyone (modeOf says "mesh", the node's streams are held back): a node answering the join whose media
  // port nobody reaches took the call off the mesh, and nothing came through at all.
  private carrying = false;
  private readonly connectedTransports = new WeakSet<SendTransport | RecvTransport>();
  private readonly heldBack = new Map<string, { user: number; kind: MediaKind; stream: MediaStream }>();
  // The node answering "serve" (its peer id), and the router and known producers it described.
  private joined: string | null = null;
  // The node being asked to serve right now (its notices count before its answer arrives).
  private joining: string | null = null;
  private rtpCapabilities: unknown = null;
  private readonly known = new Map<string, SfuProducerInfo>();
  private device: SfuDevice | null = null;
  private send: SendTransport | null = null;
  private recv: RecvTransport | null = null;
  // Producers by kind; a hosted bot's by "<bot>:<kind>" (`producerKey`).
  private readonly producers = new Map<string, Producer>();
  // What this member receives, by producer id: the consumer and whose stream of which kind it is.
  private readonly consumed = new Map<string, { consumer: Consumer; info: SfuProducerInfo }>();
  // Which producer each member's kind shows now ("user:kind" -> producer id): a member that moved node has a new
  // producer of a kind before its old one's end is announced, and that end must not clear the new one.
  private readonly shown = new Map<string, string>();
  // Closing: no new work is taken; closed: the last run (the hang-up) is done.
  private closing = false;
  private closed = false;
  private run = Promise.resolve();
  // What the device last wanted, so a lost node can be left without waiting for the next change; and why the joined
  // node can't be used any more, if it can't (a transport's ICE gave up, or the direct connection for requests broke).
  private streams: LocalStreams = { mic: null, camera: null, screen: null };
  // Bots this device hosts in the call, with what each sends (they are produced as the bot, over this member's
  // transports), and whether this member listens: a host in no call of its own only sends for its bots.
  private guests = new Map<number, LocalStreams>();
  private listening = true;
  private failed: string | null = null;
  // Nodes (peer ids) left out of the join order until a time, and the timer that asks again when that time is up;
  // how many times in a row each failed this member (reset once its media connects).
  private readonly avoid = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private retry: ReturnType<typeof setTimeout> | undefined;
  // The call the device wants now, whether a run for it is queued, and when the nodes may be asked to serve it again.
  private intent: number | null = null;
  private queued = false;
  private joinAgainAt = 0;
  // The online nodes that last didn't take the call: a node coming (or going) is asked at once.
  private refusedBy = "";
  private joinTimer: ReturnType<typeof setTimeout> | undefined;
  // Set by a retry timer: its run asks again whatever the clock says (a timer can fire a moment before it is due by
  // Date.now(), and the run then skipped and set no new timer, so the call stayed a mesh call for good).
  private joinDue = false;
  // Kinds the node refused, with the track refused and when it may be asked again; and the timer that asks.
  private readonly refused = new Map<string, { track: MediaStreamTrack; until: number }>();
  private refusedDue = false;
  private refusedTimer: ReturnType<typeof setTimeout> | undefined;
  // Producers not received yet, how many times tried, and the timer that tries them again.
  private readonly tries = new Map<string, number>();
  private consumeTimer: ReturnType<typeof setTimeout> | undefined;
  // The share's quality, and whether the node refused the computer's sound (a node older than screen sound).
  private quality: ShareQuality | null = null;
  private soundRefused = false;
  // Each member's screen arrives as two producers, its picture and its sound; the call shows and plays them as one
  // stream, the way the mesh delivers it.
  private readonly screens = new Map<number, { picture?: MediaStreamTrack; sound?: MediaStreamTrack }>();
  private readonly request: { request(data: SfuRequest, options: { target: string; timeoutMs: number }): Promise<SfuReply | null> } | null = null;
  private readonly stopWatching: (() => void) | null = null;
  private readonly stopSettings: (() => void) | null = null;

  constructor(
    private readonly workspaceId: string,
    sync: WorkspaceSync,
    private readonly ledger: Ledger,
    private readonly userId: number,
    private readonly countMembers: (call: number) => number,
    private readonly onMode: (mode: SfuMode, call: number | null) => void,
    private readonly onRemote: (user: number, kind: MediaKind, stream: MediaStream | null) => void,
    private readonly credentials: () => SfuCredentials | null = accountCredentials,
    // Shorter waits, for tests.
    private readonly timing: { joinRetryMs?: number; refusedRetryMs?: number; avoidMs?: number } = {},
  ) {
    const room = sync.room;
    if (!room) return;
    // A request action, as on the node (node/host.ts): a message action has no `request`, so a join was never sent
    // (found by mesh-test s10).
    const wire = requestAction<SfuRequest, SfuReply>(room, sfuRequestChannel);
    // No direct connection to the joined node (Trystero's and RoomGroup's "disconnected") means it can't be used: a node
    // stays online while its pings come through the mesh, and the call's requests don't (mesh-test s11: a member stayed
    // on a node it couldn't ask anything for 16 minutes, unheard). A timeout is only a slow node.
    this.request = {
      request: (data, options) => wire.request(data, options).catch((e) => {
        if ((e as { kind?: string })?.kind === "disconnected" && options.target === this.joined) this.nodeFailed("it can't be reached directly");
        return null;
      }),
    };
    // The node drops this member from its call when their direct connection closes (node/host.ts), so the call through
    // it is over then: left at once, not 15 s later when ICE gives up (mesh-test s11: a silent call meanwhile). Not
    // avoided: the connection often comes back within seconds, and the node takes the member again.
    this.stopWatching = sync.mesh?.onDirectPeers(() => {}, (peer) => {
      if (peer === this.joined) this.nodeFailed("its direct connection closed", false);
    }) ?? null;
    // The server's call settings decide too: a call checked them only when its members changed, so switching calls
    // through nodes on left a running call on the mesh (mesh-test s14), and switching them off left it on its node.
    this.stopSettings = ledger.subscribe((event) => {
      if (event.plugin === "nodes" && event.table === "nodes_settings") this.setIntent(this.intent, this.streams);
    });
    const notifyAction = room.makeAction(sfuNotifyChannel);
    // Only the node this member joined speaks for the call: any other peer could otherwise close a member's media.
    (notifyAction as unknown as { onMessage: (data: SfuNotify, context: { peerId: string }) => void }).onMessage = (notice, context) => {
      // Or the node being asked to serve: it may announce a producer between taking the join and its answer arriving.
      if (context?.peerId === this.joined || (this.joined === null && context?.peerId === this.joining)) this.notice(notice);
    };
  }

  // How the member is reaching a call's media (mesh while not in one, while its SFU join is unanswered, and while
  // the node's media hasn't connected).
  modeOf(call: number | null): SfuMode {
    return call === this.call && this.mode === "sfu" && this.carrying ? "sfu" : "mesh";
  }

  // The device wants this call and these streams now (VoiceLink keeps sending to the mesh until the node serves the
  // call and its media connected, so a call moving between modes never has a gap).
  // Only the latest intent matters: one run is queued at a time and does what the device wants when it starts. Every
  // presence change in the server used to queue a full run (a signed ask to every node), faster than they drained.
  setIntent(call: number | null, streams: LocalStreams, guests: Map<number, LocalStreams> = this.guests, listening = this.listening): void {
    if (this.closing) return;
    this.streams = streams;
    this.guests = guests;
    this.listening = listening;
    this.intent = call;
    if (this.queued) return;
    this.queued = true;
    void this.enqueue(() => {
      this.queued = false;
      return this.work(this.intent);
    }, "Calls through nodes");
  }

  // Everything the link does runs one step at a time, in order. A step that throws is logged and the next one runs:
  // one uncaught step left the queue rejected, and every later step (the hang-up included) was skipped.
  private enqueue(step: () => Promise<void> | void, label: string): Promise<void> {
    return (this.run = this.run.then(step).catch((e) => console.warn(`${label}: ${(e as Error).message}`)));
  }

  // Hangs up (the node is told, producers and transports close) and takes no more work. Marking the link closed
  // before that last run made it return at once, so a closed link never left its node.
  async close(): Promise<void> {
    if (this.closing) return this.run;
    clearTimeout(this.retry);
    clearTimeout(this.joinTimer);
    clearTimeout(this.refusedTimer);
    clearTimeout(this.consumeTimer);
    this.stopWatching?.();
    this.stopSettings?.();
    this.closing = true;
    this.streams = { mic: null, camera: null, screen: null };
    this.guests = new Map();
    await this.enqueue(() => this.work(null), "Calls through nodes");
    this.closed = true;
  }

  private async work(call: number | null): Promise<void> {
    if (this.closed) return;
    if (call !== this.call) {
      await this.hangUp();
      this.call = call;
      this.joinAgainAt = 0;
    }
    if (call === null) return;
    // The call's node went away (it left the mesh, or a transport to it failed): back to the mesh, which never stopped
    // under the call, then the next node in the order is asked like on a join. Without this a call whose node died
    // stayed "through the node" with nobody hearing anybody (found by mesh-test s10).
    if (this.mode === "sfu" && this.nodeLost()) {
      log(call, `leaving node ${this.joined?.slice(0, 6) ?? "-"}: ${this.failed ?? "it went offline"}`);
      await this.hangUp();
      this.onMode("mesh", call);
    }
    const driven = this.syncDriven(call);
    if (driven && this.mode === "mesh") {
      if (this.joinDue || Date.now() >= this.joinAgainAt || this.onlineKey() !== this.refusedBy) {
        this.joinDue = false;
        // Joined: the link sends and receives through the node from now on, but the call leaves the mesh (onMode) only
        // once every required direction connected (`carry`).
        if (await this.join(call)) {
          this.mode = "sfu";
        } else {
          // No node took it: asked again after a while (or for a new call), not on every presence change.
          const wait = this.timing.joinRetryMs ?? joinRetryMs;
          this.joinAgainAt = Date.now() + wait;
          this.refusedBy = this.onlineKey();
          clearTimeout(this.joinTimer);
          this.joinTimer = setTimeout(() => {
            this.joinDue = true;
            this.setIntent(this.intent, this.streams);
          }, wait);
        }
      }
    } else if (!driven && this.mode === "sfu") {
      await this.hangUp();
      this.onMode("mesh", call);
    }
    if (this.mode !== "sfu") return;
    this.carry();
    // Making sure the member sends what it has (mic, camera, the screen's picture and sound) and receives everyone
    // who is sending. The newest streams, not the ones this run was queued with: a mic restarted meanwhile ended
    // those tracks ("track ended" in mesh-test s10).
    await this.syncStreams(this.streams, null);
    for (const [bot, streams] of this.guests) await this.syncStreams(streams, bot);
    // Bots no longer in the call stop sending.
    for (const key of [...this.producers.keys()]) {
      const bot = Number(key.split(":")[0]);
      if (key.includes(":") && !this.guests.has(bot)) this.closeProducer(key);
    }
    for (const info of [...this.known.values()]) await this.receive(info);
    this.carry();
  }

  private onlineKey(): string {
    return [...(nodeLinkOf(this.workspaceId)?.onlineNodes().values() ?? [])].sort(compareText).join(",");
  }

  private nodeLost(): boolean {
    if (this.failed !== null || this.joined === null) return true;
    const online = nodeLinkOf(this.workspaceId)?.onlineNodes() ?? new Map<number, string>();
    return ![...online.values()].includes(this.joined);
  }

  // A transport to the node connected: its media works, so the call can leave the mesh. One that failed: leave the
  // node now rather than on the next presence change.
  private watchTransport(transport: SendTransport | RecvTransport): void {
    transport.on("connectionstatechange", (state) => {
      log(this.call, `${transport === this.send ? "send" : transport === this.recv ? "recv" : "old"} transport ${state}`);
      if (transport !== this.send && transport !== this.recv) return;
      if (state === "connected") this.connectedTransports.add(transport);
      else this.connectedTransports.delete(transport);
      void this.enqueue(() => this.carry(), "Calls through nodes");
      // Never connected: the node answers over the mesh, but its media port doesn't reach this member (not
      // forwarded, a firewall, or the node's own network dialing its public address).
      if (state === "failed") this.nodeFailed(this.carrying ? "a transport failed" : "its media never connected (UDP/TCP to the node blocked?)");
    });
  }

  // The node's media works: the call leaves the mesh (VoiceLink takes its copies back, the presence says `node`), then
  // the streams received meanwhile are shown.
  private carry(): void {
    if (this.mode !== "sfu" || this.failed !== null) return;
    const sending = [this.streams, ...this.guests.values()].some((streams) =>
      Object.values(streams).some((stream) => stream?.getTracks().some((track) => track.readyState !== "ended")));
    const receiving = this.listening && [...this.known.values()].some((info) => info.user !== this.userId);
    const ready = (sending || receiving) &&
      (!sending || !!this.send && this.connectedTransports.has(this.send)) &&
      (!receiving || !!this.recv && this.connectedTransports.has(this.recv));
    if (!ready) {
      if (this.carrying) {
        this.carrying = false;
        this.onMode("mesh", this.call);
      }
      return;
    }
    if (this.carrying) return;
    this.carrying = true;
    if (this.joined) this.failures.delete(this.joined);
    log(this.call, `media through node ${this.joined?.slice(0, 6) ?? "-"} connected`);
    this.onMode("sfu", this.call);
    const held = [...this.heldBack.values()];
    this.heldBack.clear();
    // One view that throws doesn't keep the others from their streams.
    for (const { user, kind, stream } of held) {
      try {
        this.onRemote(user, kind, stream);
      } catch (e) {
        console.warn(`Calls through nodes: ${(e as Error).message}`);
      }
    }
  }

  private nodeFailed(why: string, avoid = true): void {
    if (this.failed !== null) return;
    this.failed = why;
    // Joining it again would fail the same way: the next node is asked, or the call stays a mesh call for now. Longer
    // each time in a row it fails.
    let wait = this.timing.avoidMs ?? avoidMs;
    const node = avoid ? this.joined : null;
    if (node) {
      const times = (this.failures.get(node) ?? 0) + 1;
      this.failures.set(node, times);
      wait = Math.min(wait * 2 ** (times - 1), maxAvoidMs);
      this.avoid.set(node, Date.now() + wait);
    }
    clearTimeout(this.retry);
    // The timer says the wait is over, not the clock (a timer can fire a moment early by Date.now()), and its run
    // asks whatever the join retry's clock says: the node was otherwise asked again only on that retry's next tick.
    this.retry = setTimeout(() => {
      if (node) this.avoid.delete(node);
      this.joinDue = true;
      this.setIntent(this.intent, this.streams);
    }, wait);
    this.setIntent(this.intent, this.streams);
  }

  private syncDriven(call: number): boolean {
    return sfuDriven(sfuSettings(this.ledger), this.countMembers(call));
  }

  // Asks the call's nodes (rendezvous order, p2p/sfuProtocol) whether one serves; the first one to answer does.
  private async join(call: number): Promise<boolean> {
    const credentials = this.credentials();
    if (!credentials) return false;
    const reachable = nodeLinkOf(this.workspaceId)?.onlineNodes() ?? new Map<number, string>();
    if (reachable.size === 0) return false;
    const now = Date.now();
    const ordered = callNodeOrder(call, authorizedNodes(this.ledger))
      .filter((user) => reachable.has(user) && (this.avoid.get(reachable.get(user)!) ?? 0) <= now);
    const time = Date.now();
    const sig = await credentials.sign(sfuJoinText(this.workspaceId, call, this.userId, time)).catch(() => null);
    if (!sig) return false;
    const join: SfuJoin = { user: this.userId, key: credentials.key, time, sig, call, members: this.countMembers(call) };
    // The nodes in the call's order; then, when every one of them was at capacity, those again as this member's last
    // resort: the first takes it past its capacity and the nodes' bridges keep the call whole (ADR 0007). A member
    // reaches only its node group's nodes, so falling to the mesh used to split the call between nodes and mesh.
    const busy: number[] = [];
    for (const [users, last] of [[ordered, false], [busy, true]] as const) {
      for (const user of users) {
        this.joining = reachable.get(user)!;
        this.known.clear();
        const reply = await this.request?.request({ join: last ? { ...join, last } : join }, { target: this.joining, timeoutMs: askMs });
        log(call, `asked node ${user}${last ? " (last resort)" : ""}: ${!reply ? "no answer" : "serve" in reply ? (reply.serve ? "serves" : reply.reason) : "error" in reply ? reply.error : "?"}`);
        if (reply && "serve" in reply && !reply.serve && reply.reason === "busy" && !last) busy.push(user);
        if (!reply || !("serve" in reply) || !reply.serve) continue;
        this.joined = this.joining;
        this.joining = null;
        this.rtpCapabilities = reply.rtpCapabilities;
        // Whether this node carries the computer's sound is its own word, not guessed from an error.
        this.soundRefused = !(reply.kinds ?? []).includes("screen-sound");
        // Added to what it announced while the answer was on the way (cleared, a camera started meanwhile was lost).
        for (const producer of reply.producers) this.known.set(producer.id, producer);
        return true;
      }
    }
    this.joining = null;
    this.known.clear();
    return false;
  }

  private async hangUp(): Promise<void> {
    if (this.joined) {
      void this.request?.request({ leave: true }, { target: this.joined, timeoutMs: askMs }).catch(() => {});
      this.joined = null;
    }
    this.tearDown();
    this.mode = "mesh";
  }

  private tearDown(): void {
    for (const [kind, producer] of this.producers) {
      producer.close();
      this.producers.delete(kind);
    }
    for (const id of [...this.consumed.keys()]) this.dropConsumer(id);
    this.carrying = false;
    this.heldBack.clear();
    this.screens.clear();
    this.shown.clear();
    this.tries.clear();
    this.soundRefused = false;
    this.refused.clear();
    this.failed = null;
    this.send?.close();
    this.recv?.close();
    this.send = null;
    this.recv = null;
    this.known.clear();
    this.device = null;
    this.rtpCapabilities = null;
  }

  private async deviceOrMake(): Promise<SfuDevice> {
    if (this.device) return this.device;
    deviceModule ??= await import("mediasoup-client");
    const device = new deviceModule.Device() as unknown as SfuDevice;
    await device.load({ routerRtpCapabilities: this.rtpCapabilities });
    this.device = device;
    return device;
  }

  private async sendTransport(): Promise<SendTransport> {
    if (this.send) return this.send;
    const device = await this.deviceOrMake();
    const made = await this.ask({ create: { kind: "send" } });
    if (!made || !("ok" in made) || !made.ok || !made.data?.id) throw new Error((made as { error?: string })?.error ?? "no send transport");
    const id = String(made.data.id);
    const ice = made.data as { iceParameters?: unknown; iceCandidates?: unknown; dtlsParameters?: unknown };
    const transport = await device.createSendTransport({ id, iceParameters: ice.iceParameters, iceCandidates: ice.iceCandidates, dtlsParameters: ice.dtlsParameters, sctpParameters: null });
    transport.on("connect", (data, callback, errback) => {
      this.ask({ connect: { id, dtlsParameters: data.dtlsParameters } }).then((reply) => {
        const done = reply && "ok" in reply && reply.ok;
        if (done) callback();
        else errback(new Error((reply as { error?: string })?.error ?? "connect failed"));
      }, errback);
    });
    transport.on("produce", (data, callback, errback) => {
      // The call kind travels in appData: audio could be the mic or the screen's sound, video the camera or the screen.
      this.ask({ produce: { kind: data.appData.kind, rtpParameters: data.rtpParameters, ...(data.appData.as ? { as: data.appData.as } : {}) } }).then(
        (reply) => {
          const id = reply && "ok" in reply && reply.ok ? (reply.data as { id?: string } | null)?.id : null;
          if (id) callback({ id });
          else errback(new Error((reply as { error?: string })?.error ?? unanswered));
        }, errback);
    });
    this.watchTransport(transport);
    this.send = transport;
    return transport;
  }

  private async recvTransport(): Promise<RecvTransport> {
    if (this.recv) return this.recv;
    const device = await this.deviceOrMake();
    const made = await this.ask({ create: { kind: "recv" } });
    if (!made || !("ok" in made) || !made.ok || !made.data?.id) throw new Error((made as { error?: string })?.error ?? "no recv transport");
    const id = String(made.data.id);
    const ice = made.data as { iceParameters?: unknown; iceCandidates?: unknown; dtlsParameters?: unknown };
    const transport = await device.createRecvTransport({ id, iceParameters: ice.iceParameters, iceCandidates: ice.iceCandidates, dtlsParameters: ice.dtlsParameters, sctpParameters: null });
    transport.on("connect", (data, callback, errback) => {
      this.ask({ connect: { id, dtlsParameters: data.dtlsParameters } }).then((reply) => {
        const done = reply && "ok" in reply && reply.ok;
        if (done) callback();
        else errback(new Error((reply as { error?: string })?.error ?? "connect failed"));
      }, errback);
    });
    this.watchTransport(transport);
    this.recv = transport;
    return transport;
  }

  private async ask(request: SfuRequest): Promise<SfuReply | null> {
    if (!this.request || !this.joined) return { ok: false, error: notInCall };
    return this.request.request(request, { target: this.joined, timeoutMs: askMs });
  }

  // Sends what the streams say: a producer for each kind that is on, closed (or replaced) for one turned off. The
  // screen stream carries two kinds, its picture ("screen") and the computer's sound ("screen-sound").
  private async syncStreams(streams: LocalStreams, bot: number | null): Promise<void> {
    const kinds: { kind: SfuKind; stream: MediaStream | null }[] = [
      { kind: "mic", stream: streams.mic }, { kind: "camera", stream: streams.camera },
      { kind: "screen", stream: streams.screen }, { kind: "screen-sound", stream: streams.screen },
    ];
    // A run started by the refusal timer asks the refused kinds again whatever the clock says.
    const due = this.refusedDue;
    this.refusedDue = false;
    for (const { kind, stream } of kinds) {
      const found = (mediaKind(kind) === "audio" ? stream?.getAudioTracks()[0] : stream?.getVideoTracks()[0]) ?? null;
      const track = found?.readyState === "ended" ? null : found;
      const key = producerKey(kind, bot);
      const producer = this.producers.get(key);
      if (track) {
        // The same kind from a new track (the mic chain restarted, another camera): the producer takes the new track,
        // so the node and the members receiving it never see it change.
        if (producer && producer.track !== track) {
          await producer.replaceTrack({ track }).catch((e) => console.warn(`Calls through nodes: ${kind} not switched: ${(e as Error).message}`));
        }
        // Already sending this kind, or a node that said it doesn't carry screen sound.
        if (producer || (kind === "screen-sound" && this.soundRefused)) continue;
        // Refused a moment ago (a moderator's voice mute): asked again when the wait is over or the track changed, not
        // on every change in the server (each ask is a renegotiation and a request to the node).
        const refusal = this.refused.get(key);
        if (refusal?.track === track && !due && Date.now() < refusal.until) continue;
        // One kind refused never stops the others.
        try {
          await this.produce(kind, track, bot);
          this.refused.delete(key);
        } catch (e) {
          console.warn(`Calls through nodes: not sending ${kind}: ${(e as Error).message}`);
          const wait = this.timing.refusedRetryMs ?? refusedRetryMs;
          this.refused.set(key, { track, until: Date.now() + wait });
          clearTimeout(this.refusedTimer);
          this.refusedTimer = setTimeout(() => {
            this.refusedDue = true;
            this.setIntent(this.intent, this.streams);
          }, wait);
        }
      } else if (producer) {
        // The node closes its side too and tells the call; it refuses a second producer of a kind it still has, so a
        // camera turned off and on again would otherwise never come back. Not awaited: a node slow to answer would
        // hold up everything queued behind it (falling back to the mesh included).
        this.closeProducer(key);
      }
    }
    if (bot === null) await this.tuneScreen();
  }

  private closeProducer(key: string): void {
    const producer = this.producers.get(key);
    if (!producer) return;
    producer.close();
    this.producers.delete(key);
    void this.ask({ close: { id: producer.id } });
  }

  private async produce(kind: SfuKind, track: MediaStreamTrack, bot: number | null): Promise<void> {
    const transport = await this.sendTransport();
    // The picture starts at the chosen quality; one copy goes up whatever the call's size.
    // Voice goes ahead of pictures when the upload runs short (shareQuality.ts); the share's sound is tuned after.
    const encodings = kind === "screen" && this.quality ? [screenSenderSettings(this.quality, 1).video.encoding]
      : kind === "mic" ? [{ ...voicePriority }] : kind === "camera" ? [{ ...picturePriority }] : undefined;
    // The tracks are the app's (the mic chain, the camera, the share), which the mesh sends too: mediasoup-client stops
    // a producer's track when it closes unless told not to, and leaving a node that died silenced the member's mic
    // everywhere (mesh-test s10). Sound goes with silence suppression, as in a mesh (dtx.ts).
    const codecOptions = mediaKind(kind) === "audio" ? { opusDtx: true } : undefined;
    const made = await transport.produce({ track, appData: bot === null ? { kind } : { kind, as: bot }, encodings, codecOptions, stopTracks: false });
    this.producers.set(producerKey(kind, bot), made);
  }

  // The share's quality (ADR 0006). Through a node the member uploads one copy, so the upload budget never holds it.
  setQuality(quality: ShareQuality): void {
    this.quality = quality;
    void this.tuneScreen();
  }

  private async tuneScreen(): Promise<void> {
    if (!this.quality) return;
    const sender = (kind: SfuKind) => {
      const own = this.producers.get(kind)?.rtpSender;
      return own ? [own] : [];
    };
    const senders: ScreenSenders = { video: sender("screen"), audio: sender("screen-sound") };
    await applyShareQuality(senders, this.quality, 1);
  }

  // The share's picture as it goes to the node, for the quality control's live line.
  async screenStats(): Promise<RTCStatsReport | null> {
    return (await this.producers.get("screen")?.rtpSender?.getStats()) ?? null;
  }

  screenSoundRefused(): boolean {
    return this.soundRefused;
  }

  // What a member sends, as the call shows it: their screen's picture and sound as one "screen" stream.
  private showRemote(user: number, kind: SfuKind, track: MediaStreamTrack | null): void {
    if (kind !== "screen" && kind !== "screen-sound") return this.emitRemote(user, kind, track && new MediaStream([track]));
    const parts = { ...this.screens.get(user), [kind === "screen" ? "picture" : "sound"]: track ?? undefined };
    const tracks = [parts.picture, parts.sound].filter((t): t is MediaStreamTrack => !!t);
    if (tracks.length > 0) this.screens.set(user, parts);
    else this.screens.delete(user);
    this.emitRemote(user, "screen", tracks.length > 0 ? new MediaStream(tracks) : null);
  }

  // The node's streams reach the call only once its media connected: a track from a node nobody reaches would replace
  // the member's working mesh stream with silence (and take the mesh copy back). Until then the latest is kept.
  private emitRemote(user: number, kind: MediaKind, stream: MediaStream | null): void {
    if (this.carrying) return this.onRemote(user, kind, stream);
    const key = `${user}:${kind}`;
    if (stream) this.heldBack.set(key, { user, kind, stream });
    else this.heldBack.delete(key);
  }

  // A producer this member should receive (from the join's list or a newProducer notice): one consumer per kind.
  // The track's end (the producer closed, the node dropped it) clears the member's view.
  // Receives a producer, or tries it again a moment later: one the node hasn't got in its router yet (piped in just
  // after it was announced) or a consume that failed on the way was dropped silently and never asked again, so that
  // member stayed unheard (mesh-test s11).
  private async receive(info: SfuProducerInfo): Promise<void> {
    const done = await this.consume(info).catch((e) => {
      log(this.call, `not receiving ${info.kind} of user ${info.user}: ${(e as Error).message}`);
      return false;
    });
    if (done || !this.known.has(info.id)) {
      this.tries.delete(info.id);
      return;
    }
    const tries = (this.tries.get(info.id) ?? 0) + 1;
    this.tries.set(info.id, tries);
    if (tries >= consumeTries || this.consumeTimer) return;
    this.consumeTimer = setTimeout(() => {
      this.consumeTimer = undefined;
      this.setIntent(this.intent, this.streams);
    }, consumeRetryMs);
  }

  // Whether the producer is received now (or needs nothing: this member's own, or not in an SFU call).
  private async consume(info: SfuProducerInfo): Promise<boolean> {
    if (info.user === this.userId || this.consumed.has(info.id) || this.mode !== "sfu" || !this.listening) return true;
    const recv = await this.recvTransport();
    const asked = await this.ask({ consume: { producerId: info.id, rtpCapabilities: (await this.deviceOrMake()).rtpCapabilities } });
    if (!asked || !("ok" in asked) || !asked.ok) {
      log(this.call, `not receiving ${info.kind} of user ${info.user} yet: ${(asked as { error?: string } | null)?.error ?? "no answer"}`);
      return false;
    }
    if (!asked.data) {
      log(this.call, `not receiving ${info.kind} of user ${info.user} yet: the node can't send it now (not in its router yet, or no codec this device takes)`);
      return false;
    }
    const consumer = await recv.consume({
      id: String(asked.data.id), producerId: info.id, kind: mediaKind(info.kind), rtpParameters: asked.data.rtpParameters,
    });
    this.consumed.set(info.id, { consumer, info });
    if (asked.data.paused) {
      await this.ask({ resume: { id: String(asked.data.id) } });
      await consumer.resume();
    }
    this.shown.set(`${info.user}:${info.kind}`, info.id);
    this.showRemote(info.user, info.kind, consumer.track);
    consumer.track.addEventListener("ended", () => {
      if (this.consumed.get(info.id)?.consumer === consumer) this.dropConsumer(info.id);
    });
    return true;
  }

  // Stops receiving a producer and clears it from the member's view. mediasoup-client never ends a consumer's track
  // when the node's producer closes, so this is the only way a closed producer leaves the view.
  private dropConsumer(id: string): void {
    const entry = this.consumed.get(id);
    if (!entry) return;
    this.consumed.delete(id);
    entry.consumer.close();
    // Cleared from the view only if it is what the view shows (mesh-test s11: a member that moved node lost its new
    // mic when the old one's end arrived late from the node that noticed the dead one last).
    const key = `${entry.info.user}:${entry.info.kind}`;
    if (this.shown.get(key) !== id) return;
    // Another one of the member's of that kind still received (it moved node, and this member joined one listing both
    // its new producer and its old one piped in from the node it left): shown instead. Clearing the view lost the
    // member for good when the old one came last (mesh-test s11).
    const other = [...this.consumed].find(([, e]) => e.info.user === entry.info.user && e.info.kind === entry.info.kind);
    if (other) {
      log(this.call, `the ${entry.info.kind} of user ${entry.info.user} shown ended; showing its other one`);
      this.shown.set(key, other[0]);
      this.showRemote(entry.info.user, entry.info.kind, other[1].consumer.track);
      return;
    }
    this.shown.delete(key);
    this.showRemote(entry.info.user, entry.info.kind, null);
  }

  private notice(notice: SfuNotify): void {
    if ("newProducer" in notice) {
      this.known.set(notice.newProducer.id, notice.newProducer);
      // In line with the rest of the link's work: notices arriving together each made a recv transport, the node kept
      // only the last, and consumers on the first never got media.
      const info = notice.newProducer;
      void this.enqueue(async () => {
        this.carry();
        await this.receive(info);
        this.carry();
      }, `Receiving ${info.kind}`);
    } else {
      const id = notice.producerClosed.id;
      this.known.delete(id);
      // Queued too: a consume of this producer still waiting on the node would otherwise show it after this ran.
      void this.enqueue(() => { this.dropConsumer(id); this.carry(); }, "Calls through nodes");
    }
  }
}
