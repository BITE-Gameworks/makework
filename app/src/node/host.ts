// One server hosted by this node: a member with "Manage nodes" added it (p2p/pair.ts), so it joins the server's room
// as part of the workspace, with no invite (its own key, profile "node#N"), keeps the signed log, and keeps its share
// of the files the server's data points at and serves them to members, many at once. It says which peer it is with a signed hello and answers pings (members ask the closest node
// first; p2p/nodes.ts).
//
// Nodes split the files (RAID 1 style): each file is kept by `copies` nodes, chosen by rendezvous hashing
// (p2p/placement.ts), so every node and member works out the same holders from the server's data. Nodes tell each
// other which files they have (`node-have`: the full list when they meet, then additions and removals), and a node
// asked for a file it doesn't keep fetches it from one that does (on demand, into its cache). A node not reached for
// `healAfterMs` counts as gone: the next node in each of its files' ranking copies them from a surviving copy, and
// when it comes back the extra copies become cache (main.ts prunes the cache by age past its budget).
//
// Big files (20 GB and more, over the server's `stripe_mb`) are kept in 4 MiB pieces instead, each placed the same way
// (or with parity, p2p/pieces.ts), and no node ever holds one whole. A node takes its pieces from other nodes
// (`piece-get`), as byte ranges from a member who has the file, or rebuilds them from parity, and checks each against
// the file's piece list (`nodes_pieces`). A member asking a node for such a file gets it piece by piece, each fetched
// as it goes (a few ahead), and checks the whole file's SHA-256 as always (members never see pieces). Which pieces a
// node has goes to the other nodes as one bitmap per file.
import { RTCPeerConnection } from "werift";
import { selfId } from "trystero";
import { ApiClient } from "../api/client";
import type { ServerEvent } from "../api/types";
import { accountId, sign } from "../core/identity";
import { snapshotLoader } from "../core/workspaceSnapshots";
import { pairKeys, isSealed, unseal } from "../dm/crypto";
import { MockTransport } from "../mock/transport";
import { plugins, localPlugins } from "../p2p/plugins";
import { Ledger, createLedgerBackend } from "../p2p/ledger";
import { userNumberOf } from "../p2p/log";
import { appVersion } from "../core/version";
import { NodeLink, authorizedNodes, fresh, groupsFor, helloText, jwk, nodeRows, storageOf, verifySigned, type HoldsReply, type Place } from "../p2p/nodes";
import { inviteCode, inviteOpen } from "../p2p/invite";
import { kickedBy, roleTablesFrom, standing } from "../p2p/permissions";
import {
  bitsFromBase64, bitsToBase64, dataHolders, digestBytes, duties as pieceDuties, groupIndexes, groupOf, hasBit, matchesList, parityHolder,
  parityKey, pieceCount, pieceKey, pieceLength, pieceSize, setBit, slotOf, striped, xorPieces, type PieceDuty, type Storage,
} from "../p2p/pieces";
import { holders, type PlacedNode } from "../p2p/placement";
import { workspacePolicy } from "../p2p/policy";
import { ContentStreams, type StreamStore } from "../p2p/stream";
import {
  mediaKind, sfuDriven, sfuJoinText, sfuKinds, sfuMutedError, sfuNotifyChannel, sfuRequestChannel, sfuSettings,
  type SfuJoin, type SfuNotify, type SfuReply, type SfuRequest,
} from "../p2p/sfuProtocol";
import { requestAction } from "../p2p/requests";
import { WorkspaceSync } from "../p2p/sync";
import { SyncScheduler, type CatchUp } from "../p2p/syncQueue";
import { loadDeclared } from "../system/declared";
import { canSee } from "../p2p/visibility";
import { SfuCalls, type SfuPeer, type SfuWorkerLike } from "./sfu";
import { SfuBridges, sfuBridgeChannel, type BridgeReply, type BridgeRequest } from "./sfuBridge";
import type { MockBackend } from "../system/backend";
import { defaultConfig, type HostedEntry } from "./config";
import type { NodeContent } from "./storage";
import type { CommitStore } from "../p2p/ledger";

const helloEveryMs = 60_000;
// How long a request to another node about a shared call waits, and how often calls not yet linked are asked about
// again (a lost message between nodes must not leave a call split for good).
const bridgeAskMs = 8_000;
const bridgeCheckMs = 30_000;
const keepEveryMs = 60_000;
// A keep pass waits for changes to stop coming for `keepQuietMs`, but no longer than `keepMaxWaitMs` after the first:
// put off by every commit, a node fetched nothing while a batch was still being posted (the first file came 11 s after
// its post with ten posts 1 s apart). A running pass starts over for new changes at most that often too,
// not after every file: each start goes over every duty again.
const keepQuietMs = 2_000;
const keepMaxWaitMs = 3_000;
// Under the 10 s a member waits for an answer (p2p/stream.ts); the fetch goes on and serves the next request.
const onDemandMs = 8_000;
// A fetch whose holders were all busy asks them again this much later, this many rounds in all.
const busyWaitMs = 3_000;
const busyRounds = 4;
const pieceNewsMs = 2_000;
// A file whose piece couldn't be made is tried again this much later (one try per file and pass, not per piece: a
// file of 300 GB has 75k pieces).
const retryStuckMs = 15_000;
// Pieces kept in memory for members being served (4 MiB each).
const servedPieces = 8;
const listsKept = 8;

// The queue of the uploaders a node takes new files from, `receivers` of them at once (`HostedServer.lanes`). The
// limit stays where it is set: a slow download mostly means a slow uploader, which says nothing about this node's
// load, so adapting to it (as the catch-up queue does) would hold everyone back for one slow member.
export function fetchScheduler(receivers: number): SyncScheduler {
  return new SyncScheduler({ start: receivers, min: receivers, max: receivers });
}

// The column naming who wrote a table's rows: the one its plugin declared (`authored`), else `author_id`.
function authorColumn(table: { columns: Record<string, unknown>; authored?: string }): string | null {
  return table.authored ?? ("author_id" in table.columns ? "author_id" : null);
}

function nodeIsMember(ledger: Ledger): boolean {
  if (ledger.select("roles", "roles_bans", { user_id: ledger.me }).length > 0) return false;
  if (ledger.owner === ledger.me) return true;
  if (ledger.select("members", "members_profiles", { user_id: ledger.me }).length > 0) return true;
  return ledger.select("nodes", "nodes_nodes", { user_id: ledger.me })
    .some((row) => row.status === "authorized");
}

// Pointers: whole files by hash; pieces as a bitmap per file (`pieces`: base64, p2p/pieces.ts `slotOf`), or by key
// ("<hash>:<n>", "<hash>:p<g>") from nodes built before the bitmaps. `all`: everything the sender has, replacing what
// it said before.
type Have = { all?: string[]; add?: string[]; remove?: string[]; pieces?: Record<string, string> };
// What this node keeps of one file: all of it, or some of its pieces.
type Duty = { hash: string; size: number | null; whole: boolean; pieces: PieceDuty[] };
type PieceGet = { key: string };

export interface NodeIdentity {
  id: string;
  key: { x: string; y: string };
  privateKey: CryptoKey;
  agreementKey?: CryptoKey;
}

// What the node tells the server about itself (its row in nodes_nodes).
export interface NodeDescription {
  address: string;
  url: string;
  place: Place | null;
}

export interface HostContext {
  identity: NodeIdentity;
  commits: CommitStore;
  content: NodeContent;
  // Members served at once.
  senders: number;
  // The queue of the uploaders this node takes new files from (`fetchQueue`): main.ts hands one to every hosted
  // workspace (they share the downlink), limited by `--receivers`. Without it each workspace has its own.
  fetches?: SyncScheduler;
  // Whether another workspace hosted by this node points at the content (main.ts: they share one content folder), so
  // a file deleted for good in one stays for the other.
  wantedElsewhere?: (hash: string, here: HostedServer) => boolean;
  // How long a node may be unreachable before its files are copied elsewhere.
  healAfterMs: number;
  // The node's call worker (main.ts: one `sharedWorker` for every hosted server, on `--rtc-ports`); tests hand a fake
  // one (SfuWorkerLike) so the arbiter's decisions run without the native addon. Without it no call is served.
  openSfu?: () => Promise<SfuWorkerLike>;
  // The node's LAN address when it is behind a router (main.ts): nodes behind the same router link calls there.
  lanAddress?: string | null;
  // Tests: rooms on a fake network and this node's peer id there.
  joinRoom?: (roomId: string, passive: boolean) => import("trystero").Room;
  self?: string;
  // Tests: how long a transfer may stall before it stops (p2p/stream.ts `idleMs`, 30 s by default).
  streamIdleMs?: number;
  updateEntry?: (entry: HostedEntry) => Promise<void>;
}

// Where a hosted server's files are, for status.json and `list`.
export type FileCounts = { kept: number; cached: number; missing: number; below: number; pieces: number; wholeStriped: number };

export class HostedServer {
  readonly ledger: Ledger;
  readonly backend: MockBackend;
  readonly api: ApiClient;
  readonly sync: WorkspaceSync;
  private readonly streams: ContentStreams | null = null;
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private readonly cleanups: (() => void)[] = [];
  private readonly nodes: NodeLink;
  private readonly sendHave:((data: Have, peer?: string) => void) | null = null;
  private readonly pieceGet:{ request(data: PieceGet, options: { target: string; timeoutMs: number }): Promise<Uint8Array | null> } | null = null;
  // Calls through this node (sfu.ts), started with the first served one; nothing for servers nobody calls into.
  private sfuWorker: Promise<SfuWorkerLike> | null = null;
  private sfuReady: Promise<SfuCalls> | null = null;
  private sfu: SfuCalls | null = null;
  // Who in a served call each device (peer) is, for the requests that follow a `join`.
  private readonly callMembers = new Map<string, { callId: number; member: SfuPeer; user: number }>();
  private readonly notifySfu:((notice: SfuNotify, peer: string) => void) | null = null;
  // A call split across nodes stays one call: the nodes serving it pipe their members' media to each other (ADR 0007).
  private readonly bridges: SfuBridges;
  private readonly askBridge:((peer: string, request: BridgeRequest) => Promise<BridgeReply | null>) | null = null;
  private warnedAddress = false;
  private stopWatchingWorker: () => void = () => {};
  // Pointers: the files (and old-style piece keys) each node peer said it has, and its pieces as a bitmap per file.
  private readonly holdings = new Map<string, Set<string>>();
  private readonly pieceHoldings = new Map<string, Map<string, Uint8Array>>();
  // Files whose pieces here changed, told to the other nodes together every `pieceNewsMs`.
  private readonly changedPieces = new Set<string>();
  private pieceNewsTimer: ReturnType<typeof setTimeout> | undefined;
  // Bumped on every change of the server's data: what is worked out from the rows is kept until it changes.
  private version = 0;
  private rowCache: {
    version: number; wanted: Set<string>; sizes: Map<string, number>; lists: Map<string, string>; uploaders: Map<string, number>;
    rowRefs: Map<string, string[]>;
  } | null = null;
  // Content whose rows were removed for good since the last keep pass (`notePurged`).
  private readonly purging = new Set<string>();
  private dutyCache: { key: string; duties: Duty[] } | null = null;
  // Piece lists by file hash (a few, they are up to a few MB), pieces served to members lately (with the next one
  // fetched ahead), and where byte ranges of a file came from last.
  private readonly lists = new Map<string, Promise<Uint8Array | null>>();
  private readonly served = new Map<string, Promise<Uint8Array<ArrayBuffer> | null>>();
  private readonly rangeSource = new Map<string, string>();
  private readonly uncheckedNoted = new Set<string>();
  // When each node was last reached (this one counts as always there); nodes start as just seen.
  private readonly seen = new Map<number, number>();
  private readonly started = Date.now();
  private readonly fetching = new Map<string, Promise<boolean | "busy">>();
  // The whole files this node keeps and lacks, by uploader (null: not known), in the order of the data: what the last
  // keep pass found. Each uploader is one lane, fetched one file at a time; the lanes run beside each other through
  // `fetchQueue` (first in, first out, one file a turn, then to the back of the line), so one member's big file or
  // folder never holds up another member's upload (taken one file at a time for all members together, a
  // second member's big file wasn't asked for until the first one's was complete).
  private lanes = new Map<number | null, string[]>();
  private readonly fetchQueue: SyncScheduler;
  // Files a holder answered "busy" for while they are fetched (it has them and serves others): on their way, so a member
  // asking meanwhile hears "busy" (fetchOnDemand). From that answer on, not only while waiting to ask again: a member
  // asking while this node asked the other sources heard "missing".
  private readonly heldBusy = new Set<string>();
  // Whole-file writes of one hash take turns (a download and putting it together share parts/<hash>.part).
  private readonly writing = new Map<string, Promise<unknown>>();
  private registered = false;
  private profiling = false;
  private keeping = false;
  private keepAgain = false;
  private keepTimer: ReturnType<typeof setTimeout> | undefined;
  // When the keep pass now waiting was first asked for.
  private keepAskedAt: number | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  // Content this server's data points at that no member had when asked, until the next pass.
  private readonly unavailable = new Set<string>();
  private updatingSecret: Promise<void> = Promise.resolve();

  static async open(entry: HostedEntry, context: HostContext, describe: () => NodeDescription): Promise<HostedServer> {
    const signer = { author: context.identity.id, key: context.identity.key, privateKey: context.identity.privateKey, replica: entry.replica };
    // Snapshot states are read from the node's own store (the app's store would be IndexedDB).
    const text = async (hash: string) => {
      const size = await context.content.size(hash);
      const bytes = size === null ? null : await context.content.readRange(hash, 0, size);
      return bytes ? new TextDecoder().decode(bytes) : null;
    };
    let ledger!: Ledger;
    ledger = new Ledger(entry.id, signer, workspacePolicy, context.commits, snapshotLoader(() => ledger, text));
    const backend = createLedgerBackend(ledger, localPlugins);
    for (const plugin of plugins) backend.load(plugin);
    await ledger.load();
    const stopDeclared = loadDeclared(ledger, backend);
    const hosted = new HostedServer(entry, context, ledger, backend, describe, stopDeclared);
    void hosted.arrive();
    return hosted;
  }

  private constructor(
    readonly entry: HostedEntry, private readonly context: HostContext, ledger: Ledger, backend: MockBackend,
    private readonly describe: () => NodeDescription, stopDeclared: () => void,
  ) {
    this.ledger = ledger;
    this.backend = backend;
    this.fetchQueue = context.fetches ?? fetchScheduler(defaultConfig.receivers);
    this.cleanups.push(stopDeclared);
    this.api = new ApiClient(new MockTransport(backend));
    // Active in the hub room: members connect to it (sync.ts).
    this.sync = new WorkspaceSync(ledger, entry.id, entry.secret, {
      tabs: false, role: "node", rtcPolyfill: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection,
      joinRoom: context.joinRoom, self: context.self,
      recoverySecrets: entry.recoverySecrets,
      // A snapshot's state, into the node's store from the nodes and members that have it.
      ensureContent: async (hash) => (await this.fetchFor(hash)) === true,
      // No invite: a member with "Manage nodes" added this node's row (p2p/pair.ts), which makes it part of the
      // workspace for every member from its first connection.
      ...(entry.v === 3 ? {
        peerAuth: { localAccess: nodeIsMember(ledger) ? "member" as const : "invite" as const },
      } : {}),
    });
    this.nodes = new NodeLink(entry.id, ledger, this.sync, { answerPings: true, answerHoldings: (hashes) => this.holdsHere(hashes) });
    this.bridges = new SfuBridges({
      calls: () => this.sfu,
      address: () => this.describe().address,
      lanAddress: () => context.lanAddress ?? null,
      self: () => userNumberOf(context.identity.id),
      nodeUser: (peer) => this.nodes.nodeUser(peer),
      onlineNodes: () => this.nodes.onlineNodes(),
      ask: (peer, request) => this.askBridge?.(peer, request) ?? Promise.resolve(null),
      notify: (callId, notice) => {
        for (const target of this.sfu?.get(callId)?.peers() ?? []) this.notifySfu?.(notice, target);
      },
    });
    // In its group's room and the nodes' room when there are more than 3 nodes (sync.ts).
    this.sync.setGroups(() => groupsFor(ledger, null, true));
    const mesh = this.sync.mesh;
    const room = this.sync.room;
    if (mesh && room) {
      // Whole files from the store; a big file kept in pieces is served piece by piece without a whole copy.
      const store: StreamStore = {
        size: async (hash) => (await context.content.size(hash)) ?? this.stripedSize(hash),
        readRange: async (hash, start, end) =>
          (await context.content.has(hash)) ? context.content.readRange(hash, start, end) : this.readStriped(hash, start, end),
        openWriter: (hash) => context.content.openWriter(hash),
      };
      this.streams = new ContentStreams(room, store, {
        senders: context.senders,
        idleMs: context.streamIdleMs,
        // A member asked this node for a file it doesn't have yet (another node keeps it, or it is a new upload this
        // node is still fetching): load it first.
        onMissing: (hash) => (this.wanted().has(hash) ? this.fetchOnDemand(hash) : Promise.resolve(false)),
        // A joiner (not a member yet) may fetch the workspace's snapshot state from here, nothing else.
        invitees: {
          may: (hash) => ledger.select("members", "members_snapshots", {}).some((row) => row.content === `mwc:${hash}`),
          isMember: (peer) => room.isMember?.(peer) ?? true,
        },
      });
      // Through NodeLink's `node-have` channel: a second listener here never heard anything (Trystero keeps the first
      // action of a name), so this node knew nothing of what the others keep (mesh-test s8/s9: every file "below").
      this.sendHave = (data, peer) => this.nodes.sendHave(data, peer);
      this.cleanups.push(this.nodes.onHave((peer, have) => this.receiveHave(peer, have)));
      this.pieceGet = room.makeAction<PieceGet, Uint8Array | null>("piece-get", {
        kind: "request",
        onRequest: ({ key }) => this.servePiece(String(key)),
      }) as unknown as typeof this.pieceGet;
      // Calls through this node: members ask it (and the other nodes) whether it serves their call; once one says
      // yes, everyone is to that node, so its word is the mode of the call (ADR 0005).
      requestAction<SfuRequest, SfuReply>(room, sfuRequestChannel, (request, { peerId }) => this.handleSfu(request, peerId));
      // The other nodes serving a call (only authorized nodes are answered; sfuBridge.ts).
      const bridge = requestAction<BridgeRequest, BridgeReply>(room, sfuBridgeChannel, (request, { peerId }) => this.bridges.handle(peerId, request));
      this.askBridge = (peer, request) => bridge.request(request, { target: peer, timeoutMs: bridgeAskMs }).catch(() => null);
      const notify = (room.makeAction as (name: string) => { send(data: SfuNotify, options: { target: string }): Promise<void> })(sfuNotifyChannel);
      this.notifySfu = (notice, peer) => void notify.send(notice, { target: peer });
      this.cleanups.push(mesh.onPeers((peer) => {
        void this.hello(peer);
        this.scheduleKeep(true);
      }, (peer) => {
        this.holdings.delete(peer);
        this.pieceHoldings.delete(peer);
        this.bridges.nodeLeft(peer);
        const here = this.callMembers.get(peer);
        if (here) {
          this.callMembers.delete(peer);
          this.dropCall(here.callId, peer);
        }

      }));
      this.cleanups.push(this.nodes.onNodes((peer, user) => {
        // No longer an authorized node of this server: its bridges go (media from a node the server stopped
        // trusting must not keep reaching its members).
        if (user === null) return this.bridges.nodeLeft(peer);
        this.seen.set(user, Date.now());
        void this.sendHoldings(peer);
        void this.bridges.nodeOnline(peer);
        this.scheduleKeep(true);
      }));
    }
    this.cleanups.push(ledger.subscribe((event) => {
      if (event.change === "delete") this.notePurged(event);
      this.version++;
      this.scheduleKeep();
      void this.applySecretRows().catch((e) => console.warn(`Workspace ${entry.id} secret update wasn't applied:`, e));
      // Authorized after it registered (a node hosted the old way): its name now.
      if (this.registered) {
        const mine = nodeRows(ledger).find((n) => n.user_id === ledger.me);
        if (mine) void this.ensureProfile(mine.name).catch((e) => console.warn(`[${this.label()}] profile not set:`, (e as Error).message));
      }
    }));
    this.timers.push(
      setInterval(() => void this.hello(), helloEveryMs),
      setInterval(() => void this.bridges.recheck(), bridgeCheckMs),
      setInterval(() => this.scheduleKeep(true), keepEveryMs),
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopWatchingWorker();
    // Its bridges' retries stop, and the other nodes drop what came from here.
    this.bridges.reset();
    clearTimeout(this.keepTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.pieceNewsTimer);
    this.fetchQueue.dropPrefix(`${this.entry.id}:`);
    this.timers.forEach(clearInterval);
    this.cleanups.forEach((cleanup) => cleanup());
    this.streams?.close();
    this.nodes.close();
    this.sfu?.close();
    this.sync.close();
    this.api.close();
    await this.ledger.flush();
  }

  // ---- Calls through this node (ADR 0005): the node is the arbiter of a call's mode. ----

  // The SFU (one mediasoup worker for every server this node hosts), started with the first call it serves. A node
  // with nothing to host never takes the worker's resources.
  private ensureSfu(): Promise<SfuCalls> {
    if (!this.sfuWorker) {
      // The node's one worker (main.ts hands every hosted server `sharedWorker`); tests hand a fake one. Without one
      // no call is served here: a worker of its own would be one nothing closes.
      const worker = this.context.openSfu?.() ?? Promise.reject(new Error("no call worker"));
      this.sfuWorker = worker.catch((e) => {
        this.sfuWorker = null;
        throw e;
      });
    }
    if (!this.sfuReady) {
      this.sfuReady = this.sfuWorker.then(async (worker) => {
        // Closed while the worker was starting: no calls for a server that is gone.
        if (this.closed) throw new Error("the server is closing");
        const calls = new SfuCalls(worker, (channelId, peer, notice) => {
          for (const target of this.sfu?.get(channelId)?.peers() ?? []) {
            if (target === peer) continue;
            this.notifySfu?.(notice, target);
          }
          // A member's producer ended here: the other nodes serving the call drop it too.
          if ("producerClosed" in notice) this.bridges.ended(channelId, [notice.producerClosed.id]);
        });
        this.sfu = calls;
        // The worker died (its calls closed with it): the next join starts a new one; until then nobody is in a call
        // here. Keeping the dead calls answered every later join with an error until the node restarted.
        this.stopWatchingWorker = worker.onDied(() => {
          this.stopWatchingWorker();
          if (this.sfu !== calls) return;
          console.warn("Calls through this node are off until the next one: its mediasoup worker died.");
          this.sfu = null;
          this.sfuReady = null;
          this.sfuWorker = null;
          this.callMembers.clear();
          // Its bridges went with the calls: forgotten here and dropped on the other nodes, or the call stayed split.
          this.bridges.reset();
        });
        return calls;
      }).catch((e) => {
        if (!this.closed) console.warn(`Calls through this node are off: ${(e as Error).message}`);
        this.sfu = null;
        this.sfuWorker = null;
        this.sfuReady = null;
        throw e;
      });
    }
    return this.sfuReady;
  }

  // The calls served here now, for status.json (mesh-test reads it): members, their producers and those piped in, and
  // each bridge to another node serving the call.
  callsStatus(): Record<string, { members: number; own: number; remote: number; bridges: ReturnType<SfuBridges["describe"]> }> {
    const out: Record<string, { members: number; own: number; remote: number; bridges: ReturnType<SfuBridges["describe"]> }> = {};
    for (const callId of this.sfu?.channels() ?? []) {
      const call = this.sfu!.get(callId)!;
      out[callId] = { members: call.size, own: call.local().length, remote: call.remoteCount, bridges: this.bridges.describe(callId) };
    }
    return out;
  }

  // A call request as the room's action routes it to this node: the arbiter's whole decision path (auth, the count
  // the member reported, the settings, the cap) behind the real closures. Tests drive it through here.
  sfuRequest(peer: string, request: SfuRequest): Promise<SfuReply> {
    return this.handleSfu(request, peer);
  }

  private async handleSfu(request: SfuRequest, peer: string): Promise<SfuReply> {
    try {
      if ("join" in request) return await this.sfuJoin(peer, request.join);
      const here = this.callMembers.get(peer);
      if (!here) return { ok: false, error: "Join the call first." };
      const { callId, member, user } = here;
      if ("leave" in request) {
        this.callMembers.delete(peer);
        this.dropCall(callId, peer);
        return { ok: true };
      }
      if ("create" in request) return { ok: true, data: await member.create(request.create.kind) };
      if ("connect" in request) {
        await member.connect(request.connect.id, request.connect.dtlsParameters);
        return { ok: true };
      }
      if ("produce" in request) {
        // The server's own voice queue (roles_mutes, signed) is enforced here, not on the sender's side. It covers all
        // sound (the shared computer sound too), like the members' apps that don't play a voice-muted member's share.
        // A bot the member hosts may send as itself (a media bot); its own voice mute counts too.
        const bot = request.produce.as === undefined ? undefined : Number(request.produce.as);
        if (bot !== undefined && !this.hostsBot(user, bot)) return { ok: false, error: "That is not your bot." };
        if (mediaKind(request.produce.kind) === "audio" && standing(this.roleTables(), bot ?? user, this.ledger.owner).muted.voice) {
          return { ok: false, error: sfuMutedError };
        }
        const info = await member.produce(request.produce.kind, request.produce.rtpParameters, bot);
        for (const target of this.sfu?.get(callId)?.peers() ?? []) {
          if (target !== peer) this.notifySfu?.({ newProducer: info }, target);
        }
        this.bridges.produced(callId, info);
        return { ok: true, data: { id: info.id } };
      }
      if ("consume" in request) {
        return { ok: true, data: await member.consume(request.consume.producerId, request.consume.rtpCapabilities) };
      }
      if ("resume" in request) {
        await member.resume(request.resume.id);
        return { ok: true };
      }
      if ("close" in request) {
        await member.close(request.close.id);
        return { ok: true };
      }
      return { ok: false, error: "Unknown request." };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // Whether the bot (a user number) is one the member hosts, as the synced bots table says.
  private hostsBot(host: number, bot: number): boolean {
    const [row] = this.ledger.select("bots", "bots_bots", { user_id: bot });
    return !!row && Number(row.host) === host;
  }

  private async sfuJoin(peer: string, join: SfuJoin): Promise<SfuReply> {
    // The member signs over `time`, `call` and its user number with its account key; the node works the account id
    // back from the key the same way commits do, and checks the claimed number, membership and channel.
    if (!fresh(join?.time) || !join?.key) return { serve: false, reason: "none" };
    const callId = Number(join.call);
    const text = sfuJoinText(this.entry.id, callId, Number(join.user), join.time);
    if (!(await verifySigned(join.key, text, join.sig))) return { serve: false, reason: "none" };
    // The account id comes from the whole JWK (the `crv` is part of the hash): the join carries only the coordinates,
    // so build the key back up the way commits do, or this member never matches its own claim.
    const user = userNumberOf(await accountId(jwk(join.key)));
    if (user !== Number(join.user) || this.canJoin(user, callId)) return { serve: false, reason: "none" };
    const settings = sfuSettings(this.ledger);
    // The node counts the call from the member's own count: voice presence is peer to peer and local (the `voice`
    // plugin is not synced), so the node's own table stays empty. It is still the node that decides.
    if (!sfuDriven(settings, Number(join.members))) return { serve: false, reason: "none" };
    // Without a public address the transports would announce one nobody can reach (0.0.0.0): no call is served here.
    if (!this.describe().address) {
      if (!this.warnedAddress) console.warn("Calls through this node are off: it has no public address (--address).");
      this.warnedAddress = true;
      return { serve: false, reason: "none" };
    }
    const calls = await this.ensureSfu().catch(() => null);
    if (!calls) return { serve: false, reason: "busy" };
    // A device joining another call without having left its last one (its `leave` lost on the way) leaves that one
    // now, or it stayed in it: a place taken, its dead producers still offered, the call never emptying.
    const before = this.callMembers.get(peer);
    if (before && before.callId !== callId) {
      this.callMembers.delete(peer);
      this.dropCall(before.callId, peer);
    }
    const call = await calls.open(callId);
    const first = call.isEmpty;
    // Past the capacity only for a member with no other node to go to (`last`): the call stays whole over the bridges.
    const member = call.tryJoin(peer, user, join.last === true ? Infinity : settings.max);
    if (!member) return { serve: false, reason: "busy" };
    this.callMembers.set(peer, { callId, member, user });
    // The call's first member here: the other nodes serving it (members past their capacity) get linked.
    if (first) void this.bridges.opened(callId);
    return { serve: true, rtpCapabilities: call.router.rtpCapabilities, producers: call.producers(user), kinds: sfuKinds };
  }

  // What keeps a member out of a call: banned now, or kicked (a kick row and no profile, which is "invite them
  // again"), or not a channel it can see like the ledger's own policy says.
  private canJoin(user: number, callId: number): string | null {
    const tables = this.roleTables();
    if (standing(tables, user, this.ledger.owner).banned) return "banned";
    if (kickedBy((plugin, table, where) => this.ledger.select(plugin, table, where ?? {}), user)) return "not a member";
    const [channel] = this.ledger.select("channels", "channels_channels", { id: callId });
    if (!channel) return "no such channel";
    const target = { channelId: callId, categoryId: channel.category_id ? Number(channel.category_id) : null };
    if (!canSee(this.ledger.select("channels", "channels_visibility", {}), tables, this.ledger.owner, user, target)) {
      return "you can't see that channel";
    }
    return null;
  }

  private roleTables() {
    return roleTablesFrom((plugin, table) => this.ledger.select(plugin, table, {}));
  }

  private dropCall(callId: number, peer: string): void {
    const call = this.sfu?.get(callId);
    if (!call) return;
    call.leave(peer);
    if (call.isEmpty) {
      this.bridges.emptied(callId);
      call.close();
      this.sfu?.drop(callId);
    }
  }

  name(): string {
    return String(this.ledger.select("channels", "channels_workspace", {})[0]?.name ?? "");
  }

  icon(): string {
    return String(this.ledger.select("channels", "channels_workspace", {})[0]?.icon ?? "");
  }

  color(): string {
    return String(this.ledger.select("channels", "channels_workspace", {})[0]?.color ?? "");
  }

  // People in the server, nodes left out.
  memberCount(): number {
    const nodeIds = new Set(nodeRows(this.ledger).map((n) => n.user_id));
    return this.ledger.select("members", "members_profiles", {}).filter((p) => !nodeIds.has(Number(p.user_id))).length;
  }

  status(): "joining" | "pending" | "authorized" | "ignored" {
    const mine = nodeRows(this.ledger).find((n) => n.user_id === this.ledger.me);
    return mine ? (mine.status as "pending" | "authorized" | "ignored") : "joining";
  }

  // Every file this server's data points at, from rows that aren't deleted, and the piece lists of those.
  wanted(): Set<string> {
    return this.rows().wanted;
  }

  // What is worked out from the rows, once per change of the server's data.
  private rows(): NonNullable<HostedServer["rowCache"]> {
    if (this.rowCache?.version === this.version) return this.rowCache;
    const wanted = new Set<string>();
    const sizes = new Map<string, number>();
    // File hash -> its piece list's hash. A list alone doesn't make its file wanted (a cancelled upload's).
    const lists = new Map<string, string>();
    // File hash -> the member who uploaded it: the author of the first row pointing at it, where that can be told (the
    // row's author column, else the author of its parent row: a chat attachment's message). Asked first for the file,
    // and the lane it is fetched in (`sources`, `keep`).
    const uploaders = new Map<string, number>();
    // Row ("plugin/table/id") -> the content it points at, deleted rows too: what a row removed for good pointed at
    // (`notePurged`).
    const rowRefs = new Map<string, string[]>();
    const refs = (value: unknown) => (typeof value === "string" && value.includes("mwc:") ? [...value.matchAll(/mwc:([a-f0-9]{64})/g)].map((m) => m[1]) : []);
    const userOf = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined);
    for (const manifest of this.ledger.allManifests()) {
      if (localPlugins.includes(manifest.name)) continue;
      // The authors of a parent table's rows by row id, worked out the first time a child row needs them.
      const parents = new Map<string, Map<number, number>>();
      const authorsOf = (name: string): Map<number, number> => {
        let authors = parents.get(name);
        if (authors) return authors;
        parents.set(name, (authors = new Map()));
        const parent = manifest.tables.find((t) => t.name === name);
        const column = parent && authorColumn(parent);
        if (column) {
          for (const row of this.ledger.select(manifest.name, name, {})) {
            const author = userOf(row[column]);
            if (author !== undefined) authors.set(row.id, author);
          }
        }
        return authors;
      };
      for (const table of manifest.tables) {
        const isLists = manifest.name === "nodes" && table.name === "nodes_pieces";
        const column = authorColumn(table);
        const idColumns = column || !table.parent ? [] : Object.keys(table.columns).filter((name) => name.endsWith("_id"));
        const uploaderOf = (row: Record<string, unknown>): number | undefined => {
          if (column) return userOf(row[column]);
          if (!table.parent) return undefined;
          const authors = authorsOf(table.parent);
          for (const name of idColumns) {
            const author = typeof row[name] === "number" ? authors.get(row[name]) : undefined;
            if (author !== undefined) return author;
          }
          return undefined;
        };
        const tableRows = this.ledger.select(manifest.name, table.name, {});
        // A table that is a tree (`tree`, system/data.ts: a files channel's folders): a row under a deleted row is
        // deleted too, and so is one whose parent row is gone. Looked at by itself, every file in a deleted folder
        // stayed pointed at and was kept for good.
        const tree = table.tree && "deleted" in table.columns ? table.tree : null;
        const byId = tree ? new Map(tableRows.map((row) => [row.id, row])) : null;
        const known = new Map<number, boolean>();
        const deleted = (row: (typeof tableRows)[number]): boolean => {
          if (!tree || !byId) return row.deleted === true;
          const path: number[] = [];
          let at: (typeof tableRows)[number] | undefined = row;
          let result = false;
          while (at) {
            const before = known.get(at.id);
            if (before !== undefined) {
              result = before;
              break;
            }
            // Longer than the table: a loop, which nothing reaches from the root.
            if (at.deleted === true || path.length > byId.size) {
              result = true;
              break;
            }
            path.push(at.id);
            const parentId: unknown = at[tree];
            if (parentId === null || parentId === undefined) break;
            at = typeof parentId === "number" ? byId.get(parentId) : undefined;
            if (!at) result = true;
          }
          for (const id of path) known.set(id, result);
          return result;
        };
        for (const row of tableRows) {
          if (isLists) {
            const [file] = refs(row.content);
            const [list] = refs(row.manifest);
            if (file && list && !lists.has(file)) {
              lists.set(file, list);
              const uploader = uploaderOf(row);
              if (uploader !== undefined && !uploaders.has(list)) uploaders.set(list, uploader);
            }
            continue;
          }
          const found = Object.values(row).flatMap(refs);
          if (!found.length) continue;
          rowRefs.set(`${manifest.name}/${table.name}/${row.id}`, found);
          if (deleted(row)) continue;
          for (const hash of found) wanted.add(hash);
          // Sizes from the rows that give one (chat attachments, files), so big ones can be kept in pieces.
          const size = "size" in table.columns ? Number(row.size) : Number.NaN;
          if (Number.isSafeInteger(size) && size > 0) for (const hash of found) sizes.set(hash, size);
          if (found.some((hash) => !uploaders.has(hash))) {
            const uploader = uploaderOf(row);
            if (uploader !== undefined) for (const hash of found) if (!uploaders.has(hash)) uploaders.set(hash, uploader);
          }
        }
      }
    }
    for (const [file, list] of lists) if (wanted.has(file)) wanted.add(list);
    this.rowCache = { version: this.version, wanted, sizes, lists, uploaders, rowRefs };
    return this.rowCache;
  }

  // Rows were removed from the data (not hidden: a files channel's "Delete from network", system/files.ts `purge`).
  // What they pointed at, from the rows as they were before, is let go at the next keep pass (`purge`) instead of at
  // main.ts's hourly cleanup. A row added and removed again between two passes isn't in the cache: the cleanup has it.
  private notePurged(event: ServerEvent) {
    const cache = this.rowCache;
    if (!cache) return;
    for (const id of event.ids) {
      for (const hash of cache.rowRefs.get(`${event.plugin}/${event.table}/${id}`) ?? []) {
        this.purging.add(hash);
        const list = cache.lists.get(hash);
        if (list) this.purging.add(list);
      }
    }
  }

  // Lets go of the content of rows removed for good, now: the whole file, its part and its pieces, unless a row here
  // or in another workspace this node hosts still points at the same bytes. The other nodes hear it is gone.
  private async purge(here: Set<string>, local: Map<string, Set<string>>) {
    if (!this.purging.size) return;
    const wanted = this.wanted();
    const removed: string[] = [];
    for (const hash of [...this.purging]) {
      this.purging.delete(hash);
      if (wanted.has(hash) || this.context.wantedElsewhere?.(hash, this)) continue;
      // A fetch of it still running ends there (`download`).
      this.streams?.cancel(hash);
      await this.context.content.remove(hash);
      for (const key of local.get(hash) ?? []) await this.context.content.removePiece(key);
      if (local.delete(hash)) this.piecesChanged(hash);
      if (here.delete(hash)) removed.push(hash);
    }
    if (removed.length) {
      console.info(`[${this.label()}] ${removed.length} file${removed.length === 1 ? "" : "s"} deleted for good`);
      this.announce({ remove: removed });
    }
  }

  // The authorized nodes for placement: one not reached for `healAfterMs` is gone (its files move to the next node).
  private placed(): PlacedNode[] {
    const now = Date.now();
    const online = this.nodes.onlineNodes();
    return authorizedNodes(this.ledger).map((user) => {
      if (user === this.ledger.me || online.has(user)) this.seen.set(user, now);
      return { user, gone: now - (this.seen.get(user) ?? this.started) > this.context.healAfterMs };
    });
  }

  // Sizes of the files rows give one for (chat attachments, files), so big ones can be kept in pieces.
  private sizes(): Map<string, number> {
    return this.rows().sizes;
  }

  // What this node keeps of each file: whole files (its share by placement), or pieces of big ones. Worked out again
  // only when the nodes, the settings or the data changed: a file of 300 GB has 75k pieces.
  private duties(placed = this.placed()): Duty[] {
    const storage = storageOf(this.ledger);
    const key = JSON.stringify([placed, storage, this.version]);
    if (this.dutyCache?.key === key) return this.dutyCache.duties;
    const sizes = this.sizes();
    const me = this.ledger.me;
    const out: Duty[] = [];
    for (const hash of this.wanted()) {
      const size = sizes.get(hash) ?? null;
      if (striped(size, storage)) {
        const pieces = pieceDuties(hash, size!, me, placed, storage);
        if (pieces.length) out.push({ hash, size, whole: false, pieces });
      } else if (holders(hash, placed, storage.copies).includes(me)) out.push({ hash, size, whole: true, pieces: [] });
    }
    this.dutyCache = { key, duties: out };
    return out;
  }

  // A big file this node serves piece by piece (any node can: it fetches pieces it doesn't keep), else null.
  private stripedSize(hash: string): number | null {
    const size = this.sizes().get(hash) ?? null;
    return this.wanted().has(hash) && striped(size, storageOf(this.ledger)) ? size : null;
  }

  // The whole files this node keeps, and the state of the snapshot its log starts from: a node that joined after one
  // has no commits before its cutoff and reads the state again at every start, so it is never pruned as cache.
  held(): Set<string> {
    const held = new Set(this.duties().filter((d) => d.whole).map((d) => d.hash));
    const snapshot = this.ledger.snapshotForBootstrap()?.ref.content;
    if (snapshot) held.add(snapshot.slice(4));
    return held;
  }

  // The pieces this node keeps.
  keptPieces(): Set<string> {
    return new Set(this.duties().flatMap((d) => d.pieces.map((p) => p.key)));
  }

  // Pieces kept here that this node no longer has to keep and that the nodes keeping them have (pointers): main.ts
  // removes them.
  extraPieces(local: Map<string, string[]>): string[] {
    const wanted = this.wanted();
    const placed = this.placed();
    const keep = new Set(this.duties(placed).flatMap((d) => d.pieces.map((p) => p.key)));
    const storage = storageOf(this.ledger);
    const sizes = this.sizes();
    const online = this.nodes.onlineNodes();
    const out: string[] = [];
    for (const [hash, keys] of local) {
      const size = sizes.get(hash);
      for (const key of keys) {
        if (keep.has(key)) continue;
        if (!wanted.has(hash) || size === undefined) {
          out.push(key);
          continue;
        }
        const suffix = key.slice(hash.length + 1);
        const keepers = suffix.startsWith("p")
          ? [parityHolder(hash, Number(suffix.slice(1)), size, placed, storage)]
          : dataHolders(hash, Number(suffix), placed, storage);
        const safe = keepers.every((user) => user !== null && user !== this.ledger.me && this.nodeHas(online.get(user) ?? "", key));
        if (safe) out.push(key);
      }
    }
    return out;
  }

  // kept: files whose share (whole or pieces) is all here; cached: whole files here this node doesn't keep; missing:
  // files with some of its share still to fetch; below: files with a piece or copy short, as far as pointers tell;
  // pieces: pieces of files here (data and parity); wholeStriped: files kept in pieces that are here whole all the same
  // (none should be).
  async counts(): Promise<FileCounts> {
    const placed = this.placed();
    const storage = storageOf(this.ledger);
    const alive = placed.filter((n) => !n.gone).length || 1;
    const copies = Math.min(storage.parity > 0 ? 1 : storage.copies, alive);
    const nodePeers = [...this.nodes.onlineNodes().values()];
    const local = await this.context.content.pieces();
    const seen = (key: string, hereToo: boolean) => (hereToo ? 1 : 0) + nodePeers.filter((peer) => this.nodeHas(peer, key)).length;
    const duties = new Map(this.duties(placed).map((d) => [d.hash, d]));
    const sizes = this.sizes();
    const counts: FileCounts = { kept: 0, cached: 0, missing: 0, below: 0, pieces: 0, wholeStriped: 0 };
    for (const hash of this.wanted()) {
      const duty = duties.get(hash);
      const has = await this.context.content.has(hash);
      const mine = new Set(local.get(hash) ?? []);
      counts.pieces += mine.size;
      if (duty?.whole) has ? counts.kept++ : counts.missing++;
      else if (duty) duty.pieces.every((p) => mine.has(p.key)) ? counts.kept++ : counts.missing++;
      else if (has) counts.cached++;
      const size = sizes.get(hash) ?? null;
      if (striped(size, storage)) {
        if (has) counts.wholeStriped++;
        let short = false;
        for (let i = 0; i < pieceCount(size!) && !short; i++) short = seen(pieceKey(hash, i), mine.has(pieceKey(hash, i))) < copies;
        if (storage.parity > 0)
          for (let g = 0; g * storage.parity < pieceCount(size!) && !short; g++) short = seen(parityKey(hash, g), mine.has(parityKey(hash, g))) < 1;
        if (short) counts.below++;
      } else if (seen(hash, has) < Math.min(storage.copies, alive)) counts.below++;
    }
    return counts;
  }

  // Files and pieces main.ts deleted: the other nodes stop pointing here for them.
  dropped(removed: string[]): void {
    const whole = removed.filter((key) => key.length === 64);
    if (whole.length) this.announce({ remove: whole });
    for (const key of removed) if (key.length > 64) this.piecesChanged(key.slice(0, 64));
  }

  // Its invite page's path, set by a member with "Manage nodes" on its row; "" for none.
  page(): string {
    return nodeRows(this.ledger).find((n) => n.user_id === this.ledger.me)?.page ?? "";
  }

  // The code its invite page shows: the newest invite still open that a member chose to show on the nodes' pages
  // (`public_token`), or null. Nodes never make invites.
  pageInvite(): string | null {
    const joins = new Map<number, number>();
    for (const row of this.ledger.select("members", "members_invite_joins", {}))
      joins.set(Number(row.invite_id), (joins.get(Number(row.invite_id)) ?? 0) + 1);
    const open = this.ledger.select("members", "members_invites", {})
      .filter((row) => typeof row.public_token === "string" && row.public_token !== "" && inviteOpen(row, joins.get(Number(row.id)) ?? 0))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return open[0] ? inviteCode(this.entry.id, String(open[0].public_token)) : null;
  }

  // Once the server's data is here and has stopped arriving: the profile and the row, then keep the files.
  private async arrive() {
    await this.ledger.ready();
    if (this.closed) return;
    await quiet(this.ledger);
    if (this.closed) return;
    try {
      const secret = this.sync.activeSecret();
      if (this.entry.v === 3 && secret !== this.entry.secret) {
        this.entry.recoverySecrets = [...new Set([...(this.entry.recoverySecrets ?? []), this.entry.secret])]
          .filter((value) => value !== secret);
        this.entry.secret = secret;
      }
      await this.applySecretRows();
      if (this.entry.v === 3) {
        this.entry.generation = this.ledger.select("members", "members_rotations", {})
          .reduce((max, row) => Math.max(max, Number(row.generation)), this.entry.generation ?? 0);
        await this.context.updateEntry?.(this.entry);
      }
      await this.register();
      this.registered = true;
      void this.hello();
      this.scheduleKeep(true);
    } catch (e) {
      console.warn(`[${this.label()}] not registered as a node:`, (e as Error).message);
    }
  }

  // The node's profile (its name in the member list), added without an invite once its row is authorized: right
  // away for a node a member added, at authorization for one hosted the old way. Before, the node asked with no
  // invite while the workspace had invites, was refused, and never got its name.
  private async ensureProfile(name: string) {
    const mine = nodeRows(this.ledger).find((n) => n.user_id === this.ledger.me);
    if (mine?.status !== "authorized" || this.profiling) return;
    const profile = this.ledger.select("members", "members_profiles", { user_id: this.ledger.me })[0];
    if (profile?.display_name === name) return;
    this.profiling = true;
    try {
      await this.api.plugin("members").call("set-profile", { username: "node", display_name: name, color: "", avatar: `gen:${this.context.identity.id}`, node: true });
    } finally {
      this.profiling = false;
    }
  }

  private applySecretRows(): Promise<void> {
    const apply = async () => {
      if (this.entry.v !== 3) return;
      const ownId = userNumberOf(this.context.identity.id);
      const ownGeneration = this.entry.generation ?? 0;
      const rows = this.ledger.select("members", "members_secrets", { user_id: ownId })
        .filter((row) => Number(row.generation) > ownGeneration)
        .sort((a, b) => Number(a.generation) - Number(b.generation));
      if (!rows.length) return;
      const agreementKey = this.context.identity.agreementKey;
      if (!agreementKey) throw new Error("This node can't decrypt workspace secrets because its account key has no ECDH key.");
      for (const row of rows) {
        const value: unknown = JSON.parse(String(row.sealed));
        if (!isSealed(value) || value.to !== this.context.identity.id)
          throw new Error("A workspace secret envelope is malformed.");
        const sender = this.ledger.log().find(({ commit }) => commit.author === value.from)?.commit;
        if (!sender) throw new Error("The sender of a workspace secret isn't in the signed history.");
        const keys = await pairKeys(agreementKey, this.context.identity.id, {
          id: value.from, publicKey: sender.key,
        });
        const payload = await unseal(keys, value);
        if (!payload?.text) throw new Error("A workspace secret could not be opened with the node key.");
        const previous = this.entry.secret;
        await this.sync.rotateSecret(payload.text);
        this.entry.secret = payload.text;
        this.entry.generation = Number(row.generation);
        this.entry.recoverySecrets = [...new Set([...(this.entry.recoverySecrets ?? []), previous])]
          .filter((secret) => secret !== payload.text);
        await this.context.updateEntry?.(this.entry);
      }
    };
    this.updatingSecret = this.updatingSecret.then(apply, apply);
    return this.updatingSecret;
  }

  private async register() {
    const description = this.describe();
    const row = nodeRows(this.ledger).find((n) => n.user_id === this.ledger.me);
    // Its page path is a member's choice (Workspace settings > Nodes), not the node's.
    const values = {
      key_x: this.context.identity.key.x, key_y: this.context.identity.key.y, address: description.address, url: description.url,
      country: description.place?.country ?? "", city: description.place?.city ?? "",
      lat: description.place?.lat ?? null, lon: description.place?.lon ?? null,
    };
    const same = row && Object.entries(values).every(([k, v]) => String((row as Record<string, unknown>)[k] ?? "") === String(v ?? ""));
    let name = row?.name ?? "node";
    if (!same) name = (await this.api.plugin("nodes").call<{ name: string }>("register", values)).name;
    await this.ensureProfile(name);
    await this.ledger.flush();
  }

  private async hello(peer?: string) {
    if (!this.sync.mesh) return;
    const time = Date.now();
    // Signed for the receiving peer's view of us: our own peer id.
    const sig = await sign(this.context.identity.privateKey, helloText(this.entry.id, this.context.self ?? selfId, time));
    this.nodes.sendHello({ user: this.ledger.me, time, sig, app: appVersion }, peer);
  }

  // Everything of this server's files and pieces this node has, to a node it just met.
  // What this node holds of `hashes`, for a member asking (`node-holds`, p2p/nodes.ts): whole files, and bitmaps of the
  // pieces it keeps of big ones.
  private async holdsHere(hashes: string[]): Promise<HoldsReply> {
    const sizes = this.sizes();
    const have: string[] = [];
    const pieces: Record<string, string> = {};
    for (const hash of hashes) {
      if (await this.context.content.has(hash)) {
        have.push(hash);
        continue;
      }
      const size = sizes.get(hash);
      const keys = size === undefined ? [] : await this.context.content.piecesOf(hash);
      if (size !== undefined && keys.length) pieces[hash] = bitsToBase64(this.bitsOf(hash, size, keys));
    }
    return { asked: hashes, have, pieces };
  }

  private async sendHoldings(peer: string) {
    const all: string[] = [];
    const pieces: Record<string, string> = {};
    const wanted = this.wanted();
    const sizes = this.sizes();
    for (const hash of wanted) if (await this.context.content.has(hash)) all.push(hash);
    for (const [hash, keys] of await this.context.content.pieces()) {
      const size = sizes.get(hash);
      if (wanted.has(hash) && size !== undefined) pieces[hash] = bitsToBase64(this.bitsOf(hash, size, keys));
    }
    this.sendHave?.({ all, pieces }, peer);
  }

  private bitsOf(hash: string, size: number, keys: string[]): Uint8Array {
    let bits: Uint8Array = new Uint8Array(0);
    for (const key of keys) {
      const slot = slotOf(key, hash, size);
      if (slot !== null) bits = setBit(bits, slot, true);
    }
    return bits;
  }

  private announce(change: Have) {
    for (const peer of this.nodes.onlineNodes().values()) this.sendHave?.(change, peer);
  }

  // A file's pieces here changed: the other nodes get its bitmap with the next batch.
  private piecesChanged(hash: string) {
    this.changedPieces.add(hash);
    this.pieceNewsTimer ??= setTimeout(() => {
      this.pieceNewsTimer = undefined;
      void this.tellPieces();
    }, pieceNewsMs);
  }

  private async tellPieces() {
    const sizes = this.sizes();
    const pieces: Record<string, string> = {};
    for (const hash of [...this.changedPieces]) {
      this.changedPieces.delete(hash);
      const size = sizes.get(hash);
      if (size !== undefined) pieces[hash] = bitsToBase64(this.bitsOf(hash, size, await this.context.content.piecesOf(hash)));
    }
    if (Object.keys(pieces).length && !this.closed) this.announce({ pieces });
  }

  // Taken from anyone, used only for peers that are authorized nodes (see `sources`).
  private receiveHave(peer: string, have: Have) {
    if (!have || typeof have !== "object") return;
    const valid = (list: unknown) => (Array.isArray(list) ? list.filter((h): h is string => typeof h === "string" && /^[0-9a-f]{64}(:p?\d+)?$/.test(h)) : []);
    const full = Array.isArray(have.all);
    const set = full ? new Set<string>() : this.holdings.get(peer) ?? new Set<string>();
    for (const key of [...valid(have.all), ...valid(have.add)]) set.add(key);
    for (const key of valid(have.remove)) set.delete(key);
    this.holdings.set(peer, set);
    const bitmaps = full ? new Map<string, Uint8Array>() : this.pieceHoldings.get(peer) ?? new Map<string, Uint8Array>();
    if (have.pieces && typeof have.pieces === "object")
      for (const [hash, text] of Object.entries(have.pieces)) {
        const bits = /^[0-9a-f]{64}$/.test(hash) && typeof text === "string" ? bitsFromBase64(text) : null;
        if (bits) bitmaps.set(hash, bits);
      }
    this.pieceHoldings.set(peer, bitmaps);
  }

  // Whether a node peer said it has a file (whole) or a piece (in its bitmap, or by key from older nodes).
  private nodeHas(peer: string, key: string): boolean {
    const keys = this.holdings.get(peer);
    if (keys?.has(key)) return true;
    const hash = key.slice(0, 64);
    if (key.length === 64 || keys?.has(hash)) return keys?.has(hash) ?? false;
    const size = this.sizes().get(hash);
    const slot = size === undefined ? null : slotOf(key, hash, size);
    return slot !== null && hasBit(this.pieceHoldings.get(peer)?.get(hash), slot);
  }

  // Where to fetch a file or piece from: nodes that say they have it, then the members, then the other nodes (which
  // would fetch it on demand: for a new file none has, every node asked the others first, each waiting on the next).
  // Of the members its uploader's devices first (`rows().uploaders`; asked in the order they joined, a new file cost a
  // request to every member before its uploader), and last those something is coming from already: a request to one
  // of them waits behind that transfer and makes it give way, for a file it most likely doesn't have.
  // `nodesOnly`: the nodes, those that say they have it first (pieces).
  private sources(key: string, nodesOnly = false): string[] {
    const peers = Object.keys(this.sync.room!.getPeers());
    const nodePeers = new Set(this.nodes.onlineNodes().values());
    const has = (p: string) => nodePeers.has(p) && this.nodeHas(p, key);
    const holding = peers.filter(has);
    const otherNodes = peers.filter((p) => !has(p) && nodePeers.has(p));
    if (nodesOnly) return [...holding, ...otherNodes];
    const uploader = this.rows().uploaders.get(key);
    const theirs = new Set(uploader === undefined ? [] : this.sync.peersOf(uploader));
    const rank = (p: string) => (theirs.has(p) ? 0 : this.streams?.receivingFrom(p) ? 2 : 1);
    const members = peers.filter((p) => !nodePeers.has(p)).map((p) => ({ p, rank: rank(p) }));
    return [...holding, ...members.toSorted((a, b) => a.rank - b.rank).map((m) => m.p), ...otherNodes];
  }

  private scheduleKeep(retry = false) {
    if (retry) this.unavailable.clear();
    const now = performance.now();
    this.keepAskedAt ??= now;
    clearTimeout(this.keepTimer);
    this.keepTimer = setTimeout(() => {
      this.keepAskedAt = undefined;
      void this.keep();
    }, Math.max(0, Math.min(keepQuietMs, this.keepAskedAt + keepMaxWaitMs - now)));
  }

  // Fetches what this node keeps and lacks: whole files in a lane per uploader (`lanes`), the lanes beside each other;
  // the pieces of big files one at a time.
  private async keep() {
    if (this.status() !== "authorized" || !this.streams || !this.sync.room) return;
    if (this.keeping) {
      this.keepAgain = true;
      return;
    }
    this.keeping = true;
    try {
      let stuck = false;
      do {
        this.keepAgain = false;
        stuck = false;
        const started = performance.now();
        // New changes start the pass over, but not before it ran `keepMaxWaitMs` (see there).
        const startOver = () => this.keepAgain && performance.now() - started >= keepMaxWaitMs;
        const local = new Map([...(await this.context.content.pieces())].map(([hash, keys]) => [hash, new Set(keys)]));
        const here = await this.context.content.hashes();
        await this.purge(here, local);
        const duties = this.duties();
        // The whole files first, and the pass doesn't wait for them: their lanes go on by themselves. Not the ones
        // being fetched already (by a lane, or for a member who asked).
        const uploaders = this.rows().uploaders;
        const lanes = new Map<number | null, string[]>();
        for (const duty of duties) {
          if (!duty.whole || this.unavailable.has(duty.hash) || here.has(duty.hash) || this.fetching.has(duty.hash)) continue;
          const lane = uploaders.get(duty.hash) ?? null;
          const files = lanes.get(lane);
          if (files) files.push(duty.hash);
          else lanes.set(lane, [duty.hash]);
        }
        this.lanes = lanes;
        // A lane already in the queue or running goes on with the new list.
        for (const lane of lanes.keys()) this.fetchQueue.enqueue(this.laneKey(lane), this.laneStep(lane));
        for (const duty of duties) {
          if (this.closed || startOver()) break;
          if (duty.whole) continue;
          for (const piece of duty.pieces) {
            if (this.closed || startOver()) break;
            if (this.unavailable.has(piece.key) || local.get(duty.hash)?.has(piece.key)) continue;
            const bytes = await this.makePiece(duty.hash, duty.size!, piece);
            if (!bytes) {
              // Nobody has it now: the rest of this file waits for the retry.
              this.unavailable.add(piece.key);
              stuck = true;
              break;
            }
            await this.context.content.writePiece(piece.key, bytes);
            this.piecesChanged(duty.hash);
          }
        }
      } while (this.keepAgain && !this.closed);
      if (stuck) this.retryStuck();
    } finally {
      this.keeping = false;
    }
  }

  // Another pass for what couldn't be had now (a busy holder, a piece nobody had), `retryStuckMs` after the first of them.
  private retryStuck() {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.scheduleKeep(true);
    }, retryStuckMs);
  }

  private laneKey(lane: number | null): string {
    return `${this.entry.id}:${lane ?? "any"}`;
  }

  // One turn of an uploader's lane: its next file. With more after it the lane goes to the back of the line, so the
  // lanes take turns file by file and no uploader has two files on their way (a member sends a receiver one thing at
  // a time, p2p/stream.ts). One try per file: waiting out a busy holder (a member serving someone else) held up every
  // file after it, so a busy one is tried again with the stuck ones.
  private laneStep(lane: number | null): CatchUp {
    return async (run) => {
      const files = this.lanes.get(lane);
      let hash = files?.shift();
      while (hash !== undefined && (this.unavailable.has(hash) || this.fetching.has(hash))) hash = files?.shift();
      if (hash === undefined || this.closed || run.dropped()) return;
      const got = await this.fetchFor(hash, 1).catch(() => false as const);
      if (got === "busy") this.retryStuck();
      else if (got !== true) this.unavailable.add(hash);
      // The list as it is now: a pass since may have made a new one.
      return this.lanes.get(lane)?.length && !this.closed ? this.laneStep(lane) : undefined;
    };
  }

  // Fetches a whole file (one fetch per file at a time; a keep pass and a member's request share it). Never a file kept
  // in pieces.
  // `rounds`: how many times to ask holders that answered "busy"; "busy" when they still were at the end.
  private fetchFor(hash: string, rounds = busyRounds): Promise<boolean | "busy"> {
    if (this.stripedSize(hash) !== null) return Promise.resolve(false);
    let running = this.fetching.get(hash);
    if (!running) {
      running = this.fetch(hash, rounds).finally(() => this.fetching.delete(hash));
      this.fetching.set(hash, running);
    }
    return running;
  }

  // A member's request for a file this node doesn't have: answered within `onDemandMs`. Still fetching then, it is
  // "busy" when the file is really coming (a holder is sending it, it waits its turn behind a transfer that is, or a
  // holder that has it was busy and is asked again): answered "missing", the member showed "Nobody online has it" and
  // waited 30 s while this node was loading it from its uploader. Otherwise "missing": nodes asking each other for a
  // file none has would each wait on the other until then, and the member would hear "busy" for good.
  private fetchOnDemand(hash: string): Promise<boolean | "busy"> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.streams?.coming(hash) || this.heldBusy.has(hash) ? "busy" : false), onDemandMs);
      this.fetchFor(hash).then((found) => {
        clearTimeout(timer);
        resolve(found);
      }, () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  private exclusive<T>(hash: string, run: () => Promise<T>): Promise<T> {
    const turn = (this.writing.get(hash) ?? Promise.resolve()).catch(() => {}).then(run);
    this.writing.set(hash, turn);
    void turn.finally(() => {
      if (this.writing.get(hash) === turn) this.writing.delete(hash);
    }).catch(() => {});
    return turn;
  }

  private fetch(hash: string, rounds: number): Promise<boolean | "busy"> {
    return this.exclusive(hash, () => this.download(hash, rounds));
  }

  // Asks each source in turn. A holder answers "busy" only for a file it has (p2p/stream.ts), so when one did, all are
  // asked again `busyWaitMs` later, up to `rounds` times: a member serving another node, or a node at its limit.
  private async download(hash: string, rounds: number): Promise<boolean | "busy"> {
    if (await this.context.content.has(hash)) return true;
    if (!this.streams || !this.sync.room) return false;
    try {
      for (let round = 1; ; round++) {
        let busy = false;
        for (const peer of this.sources(hash)) {
          const result = await this.streams.download(hash, peer);
          if (result === "done") {
            this.announce({ add: [hash] });
            return true;
          }
          if (result === "busy") {
            busy = true;
            this.heldBusy.add(hash);
          }
          // Cancelled: its rows were removed for good meanwhile (`purge`), so nobody else is asked for it.
          if (this.closed || result === "cancelled") return false;
        }
        if (!busy) return false;
        if (round >= rounds) return "busy";
        await new Promise((resolve) => setTimeout(resolve, busyWaitMs));
        if (this.closed) return false;
      }
    } finally {
      this.heldBusy.delete(hash);
    }
  }

  // A piece this node keeps, made from what is reachable.
  private async makePiece(hash: string, size: number, piece: PieceDuty): Promise<Uint8Array<ArrayBuffer> | null> {
    if (piece.kind === "data") return this.dataPiece(hash, size, piece.index, true);
    const storage = storageOf(this.ledger);
    const group: Uint8Array[] = [];
    for (const i of groupIndexes(piece.index, size, storage)) {
      const bytes = await this.dataPiece(hash, size, i, false);
      if (!bytes) return null;
      group.push(bytes);
    }
    return xorPieces(group);
  }

  // Data piece `i`: kept here (checked when it was stored), cut from a whole copy here, from a node (pointers first),
  // as a byte range from a member who has the file, or rebuilt from its parity group (`rebuild`). What comes from
  // elsewhere is checked against the file's piece list.
  private async dataPiece(hash: string, size: number, i: number, rebuild: boolean): Promise<Uint8Array<ArrayBuffer> | null> {
    const key = pieceKey(hash, i);
    const length = pieceLength(i, size);
    const kept = await this.context.content.readPiece(key);
    if (kept?.byteLength === length) return kept;
    const cut = await this.context.content.readRange(hash, i * pieceSize, i * pieceSize + length);
    if (cut?.byteLength === length) return cut;
    const fromNode = await this.requestPiece(key, (bytes) => bytes.byteLength === length && this.checkPiece(hash, i, bytes));
    if (fromNode) return fromNode;
    const fromMember = await this.rangeFromMembers(hash, size, i);
    if (fromMember) return fromMember;
    const storage = storageOf(this.ledger);
    if (!rebuild || storage.parity === 0) return null;
    const rebuilt = await this.rebuild(hash, size, i, storage);
    return rebuilt && (await this.checkPiece(hash, i, rebuilt)) ? rebuilt : null;
  }

  // Data piece `i` from the rest of its parity group and the parity piece (a bad parity piece shows when the rebuilt
  // piece is checked).
  private async rebuild(hash: string, size: number, i: number, storage: Storage): Promise<Uint8Array<ArrayBuffer> | null> {
    const g = groupOf(i, storage);
    const others: Uint8Array[] = [];
    for (const j of groupIndexes(g, size, storage)) {
      if (j === i) continue;
      const bytes = await this.dataPiece(hash, size, j, false);
      if (!bytes) return null;
      others.push(bytes);
    }
    const parity = (await this.context.content.readPiece(parityKey(hash, g))) ?? (await this.requestPiece(parityKey(hash, g)));
    return parity ? xorPieces([...others, parity]).slice(0, pieceLength(i, size)) : null;
  }

  // Piece `i` as a byte range from a member who has the whole file (its uploader, mostly): the member that gave the
  // last range of this file first, then the others. One range of a file at a time (the transfer is keyed by file).
  private rangeFromMembers(hash: string, size: number, i: number): Promise<Uint8Array<ArrayBuffer> | null> {
    return this.exclusive(`${hash}:range`, async () => {
      if (!this.streams || !this.sync.room) return null;
      const nodePeers = new Set(this.nodes.onlineNodes().values());
      const members = Object.keys(this.sync.room.getPeers()).filter((p) => !nodePeers.has(p));
      const last = this.rangeSource.get(hash);
      const order = last && members.includes(last) ? [last, ...members.filter((p) => p !== last)] : members;
      const start = i * pieceSize;
      for (const peer of order) {
        // A member sends to one receiver at a time, and the other nodes ask it too: "busy" means it has the file, so
        // it is worth waiting for (members without it answer at once that they don't have it).
        for (let attempt = 0; attempt < 8; attempt++) {
          if (this.closed) return null;
          const result = await this.streams.fetchRange(hash, start, start + pieceLength(i, size), peer);
          if (result instanceof Uint8Array) {
            if (await this.checkPiece(hash, i, result)) {
              this.rangeSource.set(hash, peer);
              return result;
            }
            console.warn(`[${this.label()}] ${hash.slice(0, 8)} piece ${i} from a member didn't match its piece list`);
            break;
          }
          if (result !== "busy") break;
          await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, 250 * 2 ** attempt) * (0.5 + Math.random())));
        }
      }
      return null;
    });
  }

  // A piece from the nodes that say they have it (or its whole file), then the others; `check` refuses a bad one.
  private async requestPiece(key: string, check?: (bytes: Uint8Array<ArrayBuffer>) => boolean | Promise<boolean>): Promise<Uint8Array<ArrayBuffer> | null> {
    if (!this.pieceGet || !this.sync.room) return null;
    for (const peer of this.sources(key, true)) {
      const bytes = await this.pieceGet.request({ key }, { target: peer, timeoutMs: 30_000 }).catch(() => null);
      if (bytes && bytes.byteLength > 0) {
        const piece = new Uint8Array(bytes) as Uint8Array<ArrayBuffer>;
        if (!check || (await check(piece))) return piece;
        console.warn(`[${this.label()}] piece ${key.slice(0, 8)}…${key.slice(64)} from a node didn't match its piece list`);
      }
      if (this.closed) return null;
    }
    return null;
  }

  // Whether piece `i` matches the file's piece list. Without a list (a file added another way) pieces are taken
  // unchecked, and members still check the whole file; a list that can't be had right now refuses the piece for now.
  private async checkPiece(hash: string, i: number, bytes: Uint8Array<ArrayBuffer>): Promise<boolean> {
    if (!this.rows().lists.has(hash)) {
      if (!this.uncheckedNoted.has(hash)) {
        this.uncheckedNoted.add(hash);
        console.log(`[${this.label()}] ${hash.slice(0, 8)} has no piece list: its pieces aren't checked one by one`);
      }
      return true;
    }
    const list = await this.pieceList(hash);
    if (!list) console.warn(`[${this.label()}] ${hash.slice(0, 8)}: its piece list isn't here yet, piece ${i} waits`);
    return list ? matchesList(list, i, bytes) : false;
  }

  // The file's piece list (the SHA-256 of each piece), loaded once and kept for a few files; null while it can't be
  // had.
  private pieceList(hash: string): Promise<Uint8Array | null> {
    const listHash = this.rows().lists.get(hash);
    if (!listHash) return Promise.resolve(null);
    let loading = this.lists.get(listHash);
    if (!loading) {
      loading = (async () => {
        if (!(await this.context.content.has(listHash)) && (await this.fetch(listHash, busyRounds)) !== true) return null;
        const length = await this.context.content.size(listHash);
        const size = this.sizes().get(hash);
        if (length === null || (size !== undefined && length !== pieceCount(size) * digestBytes)) return null;
        return this.context.content.readRange(listHash, 0, length);
      })();
      // A list that couldn't be loaded is asked for again next time.
      void loading.then((list) => {
        if (!list) this.lists.delete(listHash);
      });
      this.lists.set(listHash, loading);
      while (this.lists.size > listsKept) this.lists.delete(this.lists.keys().next().value!);
    }
    return loading;
  }

  // Bytes of a file kept in pieces, for a member: each piece fetched as it is reached, the next one fetched ahead.
  private async readStriped(hash: string, start: number, end: number): Promise<Uint8Array<ArrayBuffer> | null> {
    const size = this.stripedSize(hash);
    if (size === null || start >= end || end > size) return null;
    const out = new Uint8Array(new ArrayBuffer(end - start));
    for (let at = start; at < end;) {
      const i = Math.floor(at / pieceSize);
      const piece = await this.servedPiece(hash, size, i);
      if (!piece) return null;
      const from = at - i * pieceSize;
      const take = Math.min(end - at, piece.byteLength - from);
      out.set(piece.subarray(from, from + take), at - start);
      at += take;
    }
    const next = Math.floor((end - 1) / pieceSize) + 1;
    if (next < pieceCount(size)) void this.servedPiece(hash, size, next);
    return out;
  }

  private servedPiece(hash: string, size: number, i: number): Promise<Uint8Array<ArrayBuffer> | null> {
    const key = pieceKey(hash, i);
    let piece = this.served.get(key);
    if (!piece) {
      piece = this.dataPiece(hash, size, i, true);
      void piece.then((bytes) => {
        if (!bytes) this.served.delete(key);
      });
      this.served.set(key, piece);
      while (this.served.size > servedPieces) this.served.delete(this.served.keys().next().value!);
    }
    return piece;
  }

  // Another node asks for a piece: kept here, cut from a whole copy here (parity worked out from it), or a data piece
  // fetched for it as a byte range from a member this node reaches (checked, passed on, not kept): members connect
  // only to their group's nodes, so the other groups' nodes reach the uploader only through one of these.
  private async servePiece(key: string): Promise<Uint8Array | null> {
    const match = /^([0-9a-f]{64}):(p?)(\d+)$/.exec(key);
    if (!match) return null;
    const kept = await this.context.content.readPiece(key);
    if (kept) return kept;
    const [, hash, parity, n] = match;
    const size = this.sizes().get(hash);
    if (!size) return null;
    if (!(await this.context.content.has(hash)))
      return !parity && this.stripedSize(hash) !== null && Number(n) < pieceCount(size) ? this.rangeFromMembers(hash, size, Number(n)) : null;
    const read = (i: number) => this.context.content.readRange(hash, i * pieceSize, i * pieceSize + pieceLength(i, size));
    if (!parity) return read(Number(n));
    const group: Uint8Array[] = [];
    for (const i of groupIndexes(Number(n), size, storageOf(this.ledger))) {
      const bytes = await read(i);
      if (!bytes) return null;
      group.push(bytes);
    }
    return xorPieces(group);
  }

  private label() {
    return this.name() || this.entry.id.slice(0, 8);
  }
}

// Resolves once no commit arrived for a while (the first batches of a join), at most after a minute.
function quiet(ledger: Ledger, quietMs = 3000, maxMs = 60_000): Promise<void> {
  return new Promise((resolve) => {
    let timer = setTimeout(done, quietMs);
    const cap = setTimeout(done, maxMs);
    const stop = ledger.subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(done, quietMs);
    });
    function done() {
      clearTimeout(timer);
      clearTimeout(cap);
      stop();
      resolve();
    }
  });
}
