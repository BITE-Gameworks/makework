// Keeps one workspace's ledger in sync with the other members who are online. Peers on other machines meet through
// public Nostr relays (Trystero) and then talk directly over WebRTC; the server's secret encrypts the handshake,
// so only people with the invite can connect. Tabs of the same browser also sync over a BroadcastChannel.
//
// On connect each side sends which commits it has (highest seq per replica) and gets back the ones it is
// missing, once, so offline edits merge; after that every new local commit goes out as it is signed. Every commit is
// checked by the receiver (ledger.receive), so a peer can't slip in changes it wasn't allowed to make.
// A member passes new commits on to its direct peers that the sender doesn't reach itself, so members who can't
// connect to each other still get each other's changes without every member sending everything to everyone.
//
// Who connects to whom (rooms in a RoomGroup, roomGroup.ts): nodes are active in the workspace's hub room and members
// passive (Trystero: passive peers never connect to each other), so each member connects only to the nodes and reaches
// the other members through them (mesh.ts relays). While no node is reachable, members are active in the member room,
// where they connect to each other as before, and leave it `hubAfterMs` after one is: a member of a workspace without
// nodes at once, of a workspace with nodes after `fallbackAfterMs` without one. A joiner without data yet can't tell
// whether the workspace has nodes: it is passive in the member room, so it reaches members who are active there (a
// server without nodes) but not the other joiners; only after `lonelyMs` with nobody at all does it turn active. When
// joiners turned active after a few seconds (or 20), a burst of 50 met in the member room and overloaded everything
// (mesh-test s9). A call adds a room for
// its participants (`joinCall`), so call media stays direct. Apps from before all of this are active in the hub
// room, so they still connect to everyone.
//
// With more than 3 nodes, nodes form groups (p2p/nodeGroups.ts): each group has its own room (`<server>:group:<g>`,
// its nodes active, members passive), the nodes share `<server>:nodes`, and a member with the workspace's data is in the
// room of its nearest group only (the next one too while none of its nodes answers), not in the hub. The first
// group's nodes stay active in the hub, where joiners without data find them. Members of different groups reach each
// other through two nodes (mesh.ts `shareRoutes`, route lists).
//
// Without nodes, more than `gridOver` members don't all connect to each other either: each member has a cell in a
// grid (row and column from a hash of its user id, about sqrt(n/2) of each) and is active only in its row's and its
// column's room, so it connects to about 2·sqrt(2n) members (28 instead of 99 at 100), and reaches any other through
// at most two of them (a row-mate, then that one's column-mate; mesh.ts `shareRoutes`). Members of row 0 are also active
// in the plain member room, where joiners without data (passive there) find them.
//
// Getting in (`peerAuth`): every peer proves its account on connecting; members, the owner and nodes a member added
// (nodes_nodes, p2p/pair.ts) get members' access, a joiner proving an open invite gets invitee access (history, and
// the current room secret from a member). Each open invite has its own room (`inviteRoom`, from the invite's public
// key, not the room secret, so a code works after any number of secret changes): the first group's nodes wait in it
// actively, members in the plain member room passively, and a joiner joins its invite's room actively. A proof that
// matched no invite when it came is checked again when invites arrive. A member that reached nobody for `lonelyMs`
// turns active in its hub, where members sit passive in the old secret's room after a change it missed.
//
// Commits go to each member one batch after another (`outgoing`): Trystero makes every send wait while the data
// channel is full, so firing a whole catch-up at once (75 batches for a 15k-commit server) made them all wake and
// refill it together, until the member stopped taking data for 10 s and the sends were dropped (and nodes warned
// about 11+ listeners on one werift channel). Answers to hellos wait their turn in syncQueue.ts.
import { createSignal, type Accessor } from "solid-js";
import { joinRoom, selfId, type JoinRoomConfig, type Room } from "trystero";
import type { Ledger } from "./ledger";
import { logVersion, userNumberOf, wire, type Commit, type SnapshotRef } from "./log";
import { accountId, base64url, verify } from "../core/identity";
import { sha256 } from "@noble/hashes/sha2.js";
import { inviteOpen, invitePeerProofText, inviteProof, inviteRoom, inviteTokenKey, verifyInviteProof } from "./invite";
import type { JsonRow } from "../system/data";
import { Mesh } from "./mesh";
import { RoomGroup } from "./roomGroup";
import { relayUrls } from "./relays";
import { syncScheduler, type CatchUp, type CatchUpRun, type SyncScheduler } from "./syncQueue";
import { ensureContent } from "../core/content";
import { noteActivity, noteCallEvent } from "../voice/activity";

const appId = "makework";
const batch = 200;
// A batch of commits this big while in a call is a catch-up, kept with the call's events (voice/activity.ts).
const callEventBatch = 20;
// A hello is only a version vector, so checking often is cheap and repairs anything a passed-on commit missed.
const recheckMs = 20_000;
const stallCheckMs = 5_000;
const fallbackAfterMs = 10_000;
// A joiner with nobody at all for this long turns active in the member room (no member online is active there).
// Long: nodes busy with a burst of joiners connect them late, and joiners turning active then meet in the member room.
const lonelyMs = 45_000;
const hubAfterMs = 15_000;
const roomCheckMs = 2_000;
const gridOver = 12;
const onlineMemoryMs = 60_000;
// A room left to be joined again (other settings, same room) is joined after a random 0.2-2 s: peers changing rooms on
// the same event (a commit, the online count) rejoined within milliseconds of each other, which Trystero can't tell
// apart (vendor/trystero-core/README.md; mesh-test s2: 126 of 165 "incorrect password for overlapping room", 18 ms
// apart in the middle).
const rejoinDelayMs = () => 200 + Math.random() * 1_800;
let syncs = 0;

type Vector = Record<string, number>;
type RoomSpec = { id: string; passive: boolean; secret?: string };
type PeerAuth = { kind: "challenge"; nonce: string }
  | { kind: "proof"; nonce: string; author: string; key: { x: string; y: string }; signature: string; inviteProof?: string }
  | { kind: "secret"; nonce: string; author: string; key: { x: string; y: string }; signature: string; secret: string };
type PeerAccess = "member" | "invite";
type AuthOptions = { localAccess: PeerAccess; inviteToken?: string };
// `vector`: what the sender has. `ask: false`: send nothing (it gets the history elsewhere and doesn't know yet what
// that source lacks). `since`: send what is missing from this instead of `vector` (its vector merged with its
// source's: the source sends the rest). Apps before these fields send neither, which means "send what I lack".
type Hello = { protocol: number; vector: Vector; reply: boolean; ask?: boolean; since?: Vector; fullHistory?: boolean };
// `fwd`: sent to this one peer only, to pass on to everyone else (a member in the hub sends its new commits to one
// node instead of all of them, so each member gets each commit once, not once per node: NODES-REPORT.md A6).
type Message = ({ kind: "hello" } & Hello) | { kind: "commits"; commits: unknown[]; fwd?: boolean };
// How this device takes part in the member rooms (null: in none).
type MemberMode = "passive" | "active" | null;

export class WorkspaceSync {
  readonly peers: Accessor<number>;
  private readonly setPeers: (count: number) => void;
  readonly room: RoomGroup | null;
  // Members reached directly or through another member (mesh.ts); null without the network.
  readonly mesh: Mesh | null;
  // Other tabs of this browser; null with `tabs: false`.
  private readonly channel: BroadcastChannel | null;
  // Resolves to whether it went out.
  private readonly sendRoom: ((message: Message, peer: string) => Promise<boolean>) | null = null;
  // The last commits send queued for each member; the next one starts after it.
  private readonly outgoing = new Map<string, Promise<boolean>>();
  private readonly scheduler: SyncScheduler;
  // Where this member gets what it lacks: one peer at a time (the closest node first, by `order`), so a joiner doesn't
  // get the whole history from every peer it connects to (5–12.6 copies of each commit at 20–30 members, mesh-test
  // NODES-REPORT.md F2). The other peers are asked only for what the source doesn't have (`since`). A source that sends
  // nothing for `stallMs` while it has more is replaced by the next peer.
  private source: string | null = null;
  private lastProgress = 0;
  private readonly vectors = new Map<string, Vector>();
  private readonly compatiblePeers = new Set<string>();
  private readonly incompatiblePeers = new Set<string>();
  private tabsCompatible = false;
  private readonly onIncompatible?: (peer: string) => void;
  private readonly stalled = new Set<string>();
  private readonly fullHistoryPeers = new Set<string>();
  private readonly ensureContent: (hash: string) => Promise<boolean>;
  private snapshotRetry: ReturnType<typeof setTimeout> | undefined;
  private readonly snapshotRetryMs: number;
  private order: (peers: string[]) => string[] = (peers) => peers;
  private readonly stallMs: number;
  // This sync's catch-up keys in the shared scheduler.
  private readonly prefix = `${++syncs}:`;
  private closed = false;
  private readonly cleanups: (() => void)[] = [];
  private readonly role: "member" | "node";
  // Peers prove who they are (and invitees their invite) before anything else: always in the app and on nodes.
  private readonly peerAuth: boolean;
  private readonly join: ((roomId: string, passive: boolean, secret?: string) => Room) | null = null;
  private currentSecret: string;
  private readonly workspaceId: string;
  private readonly selfId: string;
  private readonly protocolVersion: number;
  private readonly peerAuthors = new Map<string, string>();
  private readonly invitePeers = new Map<string, number>();
  // Invite proofs that matched no invite here when they came (it hadn't arrived yet): checked again whenever the
  // invites change, so the joiner gets in without reconnecting.
  private readonly pendingProofs = new Map<string, { nonce: string; author: string; proof: string }>();
  private provenAgainst = -1;
  // The public key of the invite this joiner came with: its room is where members check it (p2p/invite.ts).
  private readonly inviteKey: string | null = null;
  // Joined the hub actively after reaching nobody for `lonelyMs` (a member that missed a secret change sits in a room
  // where the others are passive), until it reaches someone elsewhere.
  private lonelyHub = false;
  private readonly authNonces = new Map<string, string>();
  private readonly peerNonces = new Map<string, string>();
  private readonly peerAuthSend:((message: PeerAuth, peer: string) => Promise<void>) | null = null;
  // Which peers are this workspace's authorized nodes (NodeLink); until set, none are known.
  private nodes: { known(): boolean; isNode(peer: string): boolean } | null = null;
  private lastNodeAt: number;
  private nodeSince: number | null = null;
  private lastPeerAt: number;
  // How this member is in the member room, if at all; changes wait for the previous one (a room is left, then joined).
  private memberMode: MemberMode = null;
  private roomChange: Promise<void> = Promise.resolve();
  // The rooms joined besides the ones the group was made with (room key -> room id, passive, and the password of a
  // room that has its own instead of the room secret: an invite's), and the node groups to use: how many, and this
  // peer's in order of preference (a node: its own).
  private readonly joined = new Map<string, RoomSpec>();
  private groups: (() => { count: number; order: number[] }) | null = null;
  // In a grid of member rooms now (relays one more hop, like nodes).
  private inGrid = false;
  private settled = false;
  // The most members (nodes left out, this one included) seen online in the last `onlineMemoryMs`: reached directly,
  // through a node or through the grid. When the nodes go away, the count seen through them still sizes the grid.
  private online = { count: 1, at: 0 };
  private readonly gridOver: number;
  private call: number | null = null;
  // The call's rooms in the group: "call" under the current room secret, and the ones under earlier secrets kept since.
  private callKeys: string[] = [];
  private readonly fallbackAfterMs: number;
  private readonly hubAfterMs: number;
  private readonly lonelyMs: number;
  private readonly rejoinDelayMs: () => number;

  // Tests pass their own `room` (the hub) or `joinRoom` (every room), and `self` (its member id), and turn the tab
  // channel off. `turn`: TURN servers for each new connection and a way to ask for them (ice.ts in the app).
  // `rtcPolyfill`: the peer connection class: WebRTC outside a browser (nodes), or the app's with silence suppression
  // on calls (dtx.ts). `role`: "node" for nodes (active in the hub, no member room).
  // `ensureContent`: brings content (a snapshot's state) to this device, true once it is here; the app's content store
  // by default, nodes pass their own (they have no IndexedDB).
  constructor(
    private readonly ledger: Ledger, workspaceId: string, secret: string,
    options: {
      network?: boolean; room?: Room; self?: string; tabs?: boolean;
      turn?: { current(): RTCIceServer[]; load(): void }; rtcPolyfill?: typeof RTCPeerConnection;
      scheduler?: SyncScheduler; stallMs?: number; role?: "member" | "node"; fallbackAfterMs?: number; hubAfterMs?: number;
      lonelyMs?: number; gridOver?: number;
      joinRoom?: (roomId: string, passive: boolean) => Room;
      onIncompatible?: (peer: string) => void;
      protocolVersion?: number;
      peerAuth?: AuthOptions;
      recoverySecrets?: string[];
      ensureContent?: (hash: string) => Promise<boolean>;
      snapshotRetryMs?: number;
      rejoinDelayMs?: () => number;
    } = {},
  ) {
    this.snapshotRetryMs = options.snapshotRetryMs ?? 5_000;
    [this.peers, this.setPeers] = createSignal(0);
    this.scheduler = options.scheduler ?? syncScheduler;
    this.stallMs = options.stallMs ?? 10_000;
    this.role = options.role ?? "member";
    this.peerAuth = !!options.peerAuth;
    this.fallbackAfterMs = options.fallbackAfterMs ?? fallbackAfterMs;
    this.hubAfterMs = options.hubAfterMs ?? hubAfterMs;
    this.lonelyMs = options.lonelyMs ?? lonelyMs;
    this.rejoinDelayMs = options.rejoinDelayMs ?? rejoinDelayMs;
    this.gridOver = options.gridOver ?? gridOver;
    this.workspaceId = workspaceId;
    this.selfId = options.self ?? selfId;
    this.currentSecret = secret;
    this.protocolVersion = options.protocolVersion ?? logVersion;
    this.onIncompatible = options.onIncompatible;
    this.ensureContent = options.ensureContent ?? ((hash) => ensureContent(workspaceId, hash));
    this.lastNodeAt = this.lastPeerAt = performance.now();

    const channel = (this.channel = options.tabs === false ? null : new BroadcastChannel(`makework-ledger:${workspaceId}`));
    if (channel) channel.onmessage = (event: MessageEvent<Message>) => this.receive(event.data, (reply) => channel.postMessage(reply));

    let mesh: Mesh | null = null;
    // TURN servers (loaded before the workspace opens, see workspaces.ts) are offered with every connection: WebRTC still
    // prefers direct paths, so traffic only goes through TURN when nothing else works, but members who need it connect
    // at the first attempt instead of after a failed one. Trystero reads this for each new connection.
    const turn = options.turn;
    // The member room and call rooms use their own app ids: Trystero shares one connection per peer between rooms of
    // the same app (and tells the other side which rooms it is in over it, with no signaling), so two members who met
    // in the member room or a call would also be connected in the hub, passive or not (found by mesh-test s9).
    const configFor = (roomId: string, passive: boolean, password: string): JoinRoomConfig => ({
      appId: appIds[roomKind(roomId)],
      password, relayConfig: { urls: relayUrls }, rtcPolyfill: options.rtcPolyfill, passive,
      get turnConfig() { return turn?.current() ?? []; },
    });
    const callbacks = {
      // Trystero's 10 s for the room handshake after WebRTC connects was too short on a busy machine: a burst of
      // joiners timed out, retried and made it busier (mesh-test s9 at 50 members).
      handshakeTimeoutMs: 30_000,
      onJoinError: ({ peerId, error, roomId }: { peerId: string; error: string; roomId: string }) => {
        const hub = scopedRoomId(workspaceId, this.currentSecret, this.protocolVersion);
        console.warn(`Could not connect to member ${peerId} in ${roomName(roomId, hub)}:`, error);
        noteActivity("connections failed");
        mesh?.noteFailure(peerId);
      },
    };
    if (options.network !== false) {
      // A test's own hub room alone means no other rooms (never the real network).
      const join = (roomId: string, passive: boolean, roomSecret = this.currentSecret) => {
        const scopedId = scopedRoomId(roomId, roomSecret, this.protocolVersion);
        return options.joinRoom
          ? options.joinRoom(scopedId, passive)
          : joinRoom(configFor(scopedId, passive, roomSecret), scopedId, callbacks);
      };
      this.join = options.joinRoom ? join : options.room ? null : join;
      const group = (this.room = new RoomGroup());
      if (options.peerAuth) {
        group.requirePeerAuthentication(options.peerAuth.localAccess);
        const auth = group.makeAction<PeerAuth>("peer-auth", { mwAccess: "auth" } as never);
        this.peerAuthSend = (message, peer) => auth.send(message, { target: peer }).then(() => {});
        auth.onMessage = (message, { peerId }) => void this.receivePeerAuth(message, peerId, options.peerAuth!).catch((e) => console.warn("Peer auth message not handled:", e));
        group.onPeerConnect = (peer) => this.challengePeer(peer);
        const authRetry = setInterval(() => {
          for (const peer of group.unauthenticatedPeers()) this.challengePeer(peer);
        }, 5_000);
        this.cleanups.push(() => clearInterval(authRetry), ledger.subscribe(() => this.refreshPeerAccess()));
        this.inviteKey = options.peerAuth.inviteToken ? inviteTokenKey(options.peerAuth.inviteToken) : null;
      }
      // A joiner whose code has no room secret (mw4) has no hub until a member in the invite's room hands it over.
      if (options.room || secret) {
        group.add("hub", options.room ?? join(workspaceId, this.role === "member", secret));
        this.joined.set("hub", { id: workspaceId, passive: this.role === "member" });
      }
      for (const recoverySecret of options.recoverySecrets ?? [])
        if (recoverySecret && recoverySecret !== secret) this.addRecoveryRoom(recoverySecret);
    } else this.room = null;
    // In the hub, members reach each other through nodes at once. Media goes only over a direct link (a call's room links
    // its callers), never through a node or a member (ADR 0019).
    this.mesh = mesh = this.room ? new Mesh(this.room, options.self ?? selfId, () => turn?.load(), {
      shareRoutes: () => this.role === "node" || this.inGrid,
      relayAfter: () => (this.role === "member" && this.memberMode !== "active" ? 0 : 3_000),
    }) : null;
    // Where a slow join waits: finding a member (relays, WebRTC) or receiving the data (see workspaces.ts).
    const opened = performance.now();
    const label = `[sync] ${workspaceId.slice(0, 8)}`;
    if (this.room) console.info(`${label}: looking for members`);
    let found = false;
    if (this.room && mesh) {
      const access = options.peerAuth ? { mwAccess: "invite" } : {};
      const hello = this.room.makeAction<Hello>("hello", access as never);
      // As JSON text: commits are plain data, and the action type only takes JSON values.
      const commits = this.room.makeAction<string>("commits", access as never);
      // Open to invitees like `commits`: a joiner's profile commit goes to a node this way, and members-only, the node
      // dropped it (it still saw an invitee) until the next hello 20 s later. Every commit is checked on arrival anyway.
      const forwarded = this.room.makeAction<string>("commits-fwd", access as never);
      // Trystero gives up on a member that stops taking data for 10 s ("data channel stopped draining"); the
      // re-hello sends what it still lacks. Uncaught, that rejection stops a node.
      const send = (this.sendRoom = (message, peer) => {
        // Hellos are small and must not wait behind a catch-up.
        if (message.kind === "hello") {
          const { kind: _, ...data } = message;
          return hello.send(data, { target: peer }).then(() => true, () => false);
        }
        const text = JSON.stringify(message.commits);
        const action = message.fwd ? forwarded : commits;
        const sent = (this.outgoing.get(peer) ?? Promise.resolve(true))
          .then(() => action.send(text, { target: peer }))
          .then(() => true, () => false);
        this.outgoing.set(peer, sent);
        void sent.then(() => {
          if (this.outgoing.get(peer) === sent) this.outgoing.delete(peer);
        });
        return sent;
      });
      hello.onMessage = (data, { peerId }) => this.receive({ kind: "hello", ...data }, (reply) => void send(reply, peerId), peerId);
      commits.onMessage = (data, { peerId }) =>
        this.receive({ kind: "commits", commits: parseList(data) }, (reply) => void send(reply, peerId), peerId);
      forwarded.onMessage = (data, { peerId }) =>
        this.receive({ kind: "commits", commits: parseList(data), fwd: true }, (reply) => void send(reply, peerId), peerId);
      mesh.onDirectPeers((peerId) => {
        if (!found) console.info(`${label}: first member found after ${((performance.now() - opened) / 1000).toFixed(1)} s`);
        found = true;
        // Both sides send theirs on connect, so neither asks for a hello back: each sends what the other lacks once.
        if (this.source === null) this.setSource(this.pick());
        else void send(this.helloTo(peerId, false), peerId);
      }, (peerId) => {
        this.peerAuthors.delete(peerId);
        this.invitePeers.delete(peerId);
        this.pendingProofs.delete(peerId);
        this.authNonces.delete(peerId);
        this.peerNonces.delete(peerId);
        this.scheduler.drop(this.prefix + peerId);
        this.vectors.delete(peerId);
        this.compatiblePeers.delete(peerId);
        this.incompatiblePeers.delete(peerId);
        this.stalled.delete(peerId);
        if (peerId === this.source) this.setSource(this.pick());
      });
      const stallTimer = setInterval(() => {
        this.checkSource();
        this.refreshPeerAccess();
      }, Math.min(stallCheckMs, this.stallMs));
      this.cleanups.push(() => clearInterval(stallTimer));
      if (this.join) {
        const roomTimer = setInterval(() => this.checkRooms(), Math.min(roomCheckMs, this.fallbackAfterMs / 2, this.hubAfterMs / 2));
        this.cleanups.push(() => clearInterval(roomTimer));
        this.checkRooms();
      }
      this.cleanups.push(mesh.onPeers(() => this.countPeers(), () => this.countPeers()), () => mesh.close());
    }

    this.cleanups.push(ledger.onSigned((signed) => this.broadcast(signed)));
    this.channel?.postMessage(this.hello(true));
    // Catches anything missed, e.g. a commit that arrived while a peer was reconnecting.
    const timer = setInterval(() => {
      this.channel?.postMessage(this.hello(true));
      for (const peer of this.mesh?.directPeers() ?? []) void this.sendRoom?.(this.helloTo(peer, true), peer);
    }, recheckMs);
    this.cleanups.push(() => clearInterval(timer));
  }

  // How to rank peers as the source of what this member lacks: NodeLink.order (authorized nodes first, closest
  // first). Without it, the first peer connected.
  setSourceOrder(order: (peers: string[]) => string[]): void {
    this.order = order;
  }

  // Which peers are authorized nodes (NodeLink): decides whether members need the member room.
  // The node groups (p2p/nodeGroups.ts): how many, and which this peer joins, best first.
  setGroups(groups: () => { count: number; order: number[] }): void {
    this.groups = groups;
    this.checkRooms();
  }

  // The peers reached that proved to be this user's devices (`peerAuth`; none without it): a node asks a file's
  // uploader for it first (node/host.ts `sources`).
  peersOf(userId: number): string[] {
    const peers: string[] = [];
    for (const [peer, author] of this.peerAuthors) if (userNumberOf(author) === userId) peers.push(peer);
    return peers;
  }

  setNodes(nodes: { known(): boolean; isNode(peer: string): boolean }): void {
    this.nodes = nodes;
    this.checkRooms();
  }

  // Joins the room of a call (`channelId`), leaving the previous one's rooms; null leaves them.
  joinCall(channelId: number | null): void {
    if (!this.room || !this.join || channelId === this.call) return;
    for (const key of this.callKeys) void this.room.remove(key);
    this.callKeys = [];
    this.call = channelId;
    if (channelId !== null) this.joinCallRoom();
  }

  private joinCallRoom(): void {
    this.room!.add("call", this.join!(`${this.workspaceId}:call:${this.call}`, false, this.currentSecret));
    this.callKeys.push("call");
  }

  async rotateSecret(secret: string): Promise<void> {
    if (secret === this.currentSecret) return;
    if (!this.room || !this.join || this.protocolVersion < 5) throw new Error("This workspace can't rotate its room secret.");
    // Every room under the room secret is left and joined again with the new one (checkRooms), the old secret's hub
    // kept as a recovery room; an invite's room has its own password and stays. Members settled in a node group's
    // room, and the nodes of the other groups, aren't in the hub: requiring it, they never took a new secret and lost
    // their group. A joiner without a secret yet (mw4) gets its first one here.
    // The old hub is that recovery room (same room id and password), so it is kept under the new key: left and joined
    // again, by every member and node at the same moment, the Trystero room raced and handshakes failed ("incorrect
    // password for overlapping room", tests/vendor/trysteroCore.test.ts). A lonely member's active hub is joined
    // again passive (two lonely members rotating at the same moment can still race).
    this.roomChange = this.roomChange.then(async () => {
      // A second handoff of the same secret, queued before the first one ran.
      if (secret === this.currentSecret) return;
      for (const [key, spec] of [...this.joined]) {
        if (spec.secret) continue;
        this.joined.delete(key);
        const kept = key === "hub" && !!this.currentSecret && spec.passive === (this.role === "member")
          && this.room!.rename(key, recoveryKey(this.currentSecret));
        if (!kept) await this.room!.remove(key);
      }
      if (this.currentSecret) this.addRecoveryRoom(this.currentSecret);
      const previous = this.currentSecret;
      this.currentSecret = secret;
      // In a call, its room under the old secret stays (left and joined again by everyone in the call at once, it would
      // race like the hub), and its room under the new one is joined too: members who join the call from now on are
      // there. Before, they never connected to those already in the call (mesh-test s13).
      if (this.call !== null && !this.closed) {
        const oldKey = callKey(previous);
        if (this.room!.rename("call", oldKey)) this.callKeys = this.callKeys.map((key) => (key === "call" ? oldKey : key));
        else if (this.callKeys.includes("call")) {
          this.callKeys = this.callKeys.filter((key) => key !== "call");
          await this.room!.remove("call");
        }
        // The call may have been left or changed meanwhile (joinCall made its own room then).
        if (this.call !== null && !this.closed && !this.room!.has("call")) this.joinCallRoom();
      }
    });
    await this.roomChange;
    this.refreshPeerAccess();
    this.checkRooms();
    await this.roomChange;
  }

  // Whether this member connects to the other members now (active in the member room: no node reachable).
  inMemberRoom(): boolean {
    return this.memberMode === "active";
  }

  activeSecret(): string {
    return this.currentSecret;
  }

  // For other things sent to the members (voice, presence, content), directly or through another member.
  onPeers(joined: (peerId: string) => void, left: (peerId: string) => void): () => void {
    return this.mesh?.onPeers(joined, left) ?? (() => {});
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.snapshotRetry);
    this.scheduler.dropPrefix(this.prefix);
    this.cleanups.forEach((cleanup) => cleanup());
    this.channel?.close();
    void this.room?.leave();
  }

  // For the tab channel: every tab sends what the other lacks.
  private hello(reply: boolean): { kind: "hello" } & Hello {
    return { kind: "hello", protocol: this.protocolVersion, vector: this.ledger.vector(), reply };
  }

  // The source is asked for everything this member lacks; another peer only for what the source lacks, once the
  // source's vector is known (until then, nothing). A peer whose snapshot couldn't be used here is always asked for
  // the whole history: a request answered "busy" (its catch-up still running) is made again with the next hello.
  private helloTo(peer: string, reply: boolean, fullHistory = this.fullHistoryPeers.has(peer)): Message {
    const vector = this.ledger.vector();
    if (this.source === null || peer === this.source) return { ...this.hello(reply), vector, ask: true, ...(fullHistory ? { fullHistory: true } : {}) };
    const theirs = this.vectors.get(this.source);
    if (!theirs) return { ...this.hello(reply), vector, ask: false, ...(fullHistory ? { fullHistory: true } : {}) };
    return { ...this.hello(reply), vector, ask: true, since: merged(vector, theirs), ...(fullHistory ? { fullHistory: true } : {}) };
  }

  // Which rooms to be in now (see the top of this file).
  private checkRooms() {
    if (!this.room || !this.join || this.closed) return;
    const id = this.workspaceId;
    const groups = this.groups?.() ?? { count: 1, order: [0] };
    const grouped = groups.count > 1 && groups.order.length > 0;
    const want = new Map<string, RoomSpec>();
    if (this.role === "node") {
      if (!grouped || groups.order[0] === 0) {
        want.set("hub", { id, passive: false });
        // The first group's nodes, where joiners without data find them, also wait for joiners in every open
        // invite's room.
        this.inviteRooms(want, false);
      }
      if (grouped) {
        want.set("nodes", { id: `${id}:nodes`, passive: false });
        want.set("group", { id: `${id}:group:${groups.order[0]}`, passive: false });
      }
      this.applyRooms(want);
      return;
    }
    const now = performance.now();
    const known = this.nodes?.known() ?? false;
    const hasData = this.ledger.owner !== null;
    // Leaving the hub or the member room drops their connections, so a member leaves only once caught up (and for
    // good: a source's next hello with a new commit mustn't bring it back): a member that left after its first batch
    // started its catch-up over elsewhere (2.5 minutes, mesh-test s9). With node groups it joins its group's room at
    // once and keeps the hub until then and until one of its group's nodes is connected there: waiting in the hub,
    // all joiners had only the first group's nodes, and the others stayed idle.
    const groupReached = grouped && (this.room.peersIn("group") > 0 || this.room.peersIn("group2") > 0);
    this.settled ||= hasData && this.caughtUp() && (!grouped || groupReached);
    const settled = this.settled;
    const direct = this.mesh?.directPeers() ?? [];
    const nodeReached = known && direct.some((peer) => this.nodes?.isNode(peer));
    if (nodeReached) {
      this.lastNodeAt = now;
      this.nodeSince ??= now;
    } else this.nodeSince = null;
    if (direct.length > 0) this.lastPeerAt = now;
    const away = now - this.lastNodeAt;
    // A member that reached nobody for a while may have missed a change of the room secret: the others keep the old
    // secret's hub as a recovery room, passive, so it turns active in its hub until it reaches someone elsewhere
    // (before, with no node online it waited for good).
    if (hasData && now - this.lastPeerAt >= this.lonelyMs) this.lonelyHub = true;
    else if (this.lonelyHub && (nodeReached || ["members", "row", "col", "group", "group2"].some((key) => this.room!.peersIn(key) > 0)))
      this.lonelyHub = false;
    const hub = { id, passive: !this.lonelyHub };
    if (grouped && hasData) {
      want.set("group", { id: `${id}:group:${groups.order[0]}`, passive: true });
      // None of its nodes answers: the next group too, and only after that the member room.
      if (!nodeReached && away >= this.fallbackAfterMs && groups.order[1] !== undefined)
        want.set("group2", { id: `${id}:group:${groups.order[1]}`, passive: true });
      if (!settled || this.lonelyHub) want.set("hub", hub);
    } else want.set("hub", hub);
    let member: MemberMode;
    if (known) {
      const fallback = grouped ? 2 * this.fallbackAfterMs : this.fallbackAfterMs;
      if (nodeReached) member = this.memberMode !== null && now - this.nodeSince! < this.hubAfterMs ? this.memberMode : null;
      else member = away >= fallback ? "active" : this.memberMode;
    } else if (hasData) member = "active";
    else member = this.memberMode === "active" || now - this.lastPeerAt >= this.lonelyMs ? "active" : "passive";
    // Counted on every check, not only once in the member room: by then the nodes that relayed everyone are gone, and
    // a member saw only itself (the grid stayed off and 50 members made a full mesh, mesh-test s9).
    const online = this.onlineSeen(now);
    const grid = member === "active" && settled ? this.gridSize(online) : 0;
    this.inGrid = grid > 1;
    if (this.inGrid) {
      const { row, col } = gridCell(this.ledger.me, grid);
      want.set("row", { id: `${id}:members:r${row}`, passive: false });
      want.set("col", { id: `${id}:members:c${col}`, passive: false });
      if (row === 0) want.set("members", { id: `${id}:members`, passive: false });
    } else if (member) want.set("members", { id: `${id}:members`, passive: member === "passive" });
    // Members reachable by joiners (in the plain member room: no node reachable) also wait, passive, in every open
    // invite's room; a joiner that isn't a member yet is active in its own invite's room.
    if (hasData && this.isWorkspaceMember(this.ledger.me) && want.has("members") && !want.get("members")!.passive)
      this.inviteRooms(want, true);
    if (this.inviteKey && !(hasData && this.isWorkspaceMember(this.ledger.me))) {
      const { key, password } = inviteRoom(this.inviteKey);
      want.set(`invite:${key}`, { id: `${id}:invite:${key}`, passive: false, secret: password });
    }
    this.applyRooms(want, member);
  }

  // The rooms of the invites that still admit someone (inviteOpen), joined `passive` or not.
  private inviteRooms(want: Map<string, RoomSpec>, passive: boolean) {
    if (!this.peerAuth) return;
    const joins = new Map<number, number>();
    for (const row of this.ledger.select("members", "members_invite_joins", {}))
      joins.set(Number(row.invite_id), (joins.get(Number(row.invite_id)) ?? 0) + 1);
    const now = Date.now();
    for (const invite of this.ledger.select("members", "members_invites", {})) {
      if (typeof invite.token_key !== "string" || !inviteOpen(invite, joins.get(Number(invite.id)) ?? 0, now)) continue;
      const { key, password } = inviteRoom(invite.token_key);
      want.set(`invite:${key}`, { id: `${this.workspaceId}:invite:${key}`, passive, secret: password });
    }
  }

  // Has everything its catch-up source had when it said hello (no source: nothing to wait for).
  private caughtUp(): boolean {
    const theirs = this.source !== null ? this.vectors.get(this.source) : undefined;
    return !theirs || covers(this.ledger.vector(), theirs);
  }

  private onlineSeen(now: number): number {
    const count = (this.mesh?.peers() ?? []).filter((peer) => !this.nodes?.isNode(peer)).length + 1;
    if (count >= this.online.count || now - this.online.at > onlineMemoryMs) this.online = { count, at: now };
    return this.online.count;
  }

  // Rows (and columns) of the member grid: none up to `gridOver` members (one member room), else about sqrt(n/2) of
  // the workspace's members, so everyone works out the same rooms. A grid is only as good as its cells are full: with
  // few of the members online, many would share a row or column with nobody and be cut off. So a member uses it only
  // while the members seen online fill it (1.5 per cell to go in, 1 to stay), else the member room as before.
  private gridSize(online: number): number {
    const nodes = new Set(this.ledger.select("nodes", "nodes_nodes", {}).map((r) => Number(r.user_id)));
    const members = this.ledger.select("members", "members_profiles", {}).filter((p) => !nodes.has(Number(p.user_id))).length;
    if (members <= this.gridOver || online <= this.gridOver) return 0;
    const size = Math.max(2, Math.round(Math.sqrt(members / 2)));
    return online >= size * size * (this.inGrid ? 1 : 1.5) ? size : 0;
  }

  // Joins and leaves rooms to match `want`, one change after the other (a room is left before it is joined again).
  private applyRooms(want: Map<string, RoomSpec>, member: MemberMode = null) {
    const room = this.room;
    const join = this.join;
    if (!room || !join) return;
    this.memberMode = member;
    // Without a room secret yet (a joiner with an mw4 code), only rooms with their own password.
    if (!this.currentSecret) for (const [key, spec] of want) if (!spec.secret) want.delete(key);
    const rejoined = new Set<string>();
    for (const [key, spec] of [...this.joined]) {
      const next = want.get(key);
      if (next?.id === spec.id && next.passive === spec.passive && next.secret === spec.secret) continue;
      if (next?.id === spec.id) rejoined.add(key);
      this.joined.delete(key);
      this.roomChange = this.roomChange.then(() => room.remove(key)).catch((e) => console.warn("Room not left:", e));
    }
    for (const [key, spec] of want) {
      if (this.joined.has(key)) continue;
      this.joined.set(key, spec);
      if (rejoined.has(key)) this.roomChange = this.roomChange.then(() => new Promise((resolve) => setTimeout(resolve, this.rejoinDelayMs())));
      this.roomChange = this.roomChange.then(() => {
        if (!this.closed) room.add(key, join(spec.id, spec.passive, spec.secret));
      }).catch((e) => console.warn("Room not joined:", e));
    }
  }

  private pick(): string | null {
    const peers = this.mesh?.directPeers() ?? [];
    if (peers.length > 0 && peers.every((p) => this.stalled.has(p))) this.stalled.clear();
    return this.order(peers.filter((p) => !this.stalled.has(p)))[0] ?? null;
  }

  private setSource(peer: string | null) {
    this.source = peer;
    this.lastProgress = performance.now();
    for (const p of this.mesh?.directPeers() ?? []) void this.sendRoom?.(this.helloTo(p, false), p);
  }

  // A source that sent nothing for `stallMs` while it has commits this member lacks gives way to the next peer.
  private checkSource() {
    if (this.source === null) return;
    const theirs = this.vectors.get(this.source);
    if (!theirs || covers(this.ledger.vector(), theirs) || performance.now() - this.lastProgress < this.stallMs) return;
    this.stalled.add(this.source);
    this.setSource(this.pick());
  }

  // Each member separately, so one that takes data slowly doesn't hold up the others.
  private toDirectPeers(message: Message) {
    for (const peer of this.mesh?.directPeers() ?? [])
      if (this.compatiblePeers.has(peer)) void this.sendRoom?.(message, peer);
  }

  // New local commits: to every direct peer, or in the hub to one node, which passes them on to everyone (the first
  // in the node order, the closest). If it never does, the others get them with the next hello.
  private broadcast(commits: Commit[]) {
    const forwarder = this.role === "member" && this.memberMode !== "active"
      ? this.order((this.mesh?.directPeers() ?? []).filter((p) => this.nodes?.isNode(p)))[0]
      : undefined;
    for (const message of batches(commits)) {
      this.channel?.postMessage(message);
      if (forwarder !== undefined && this.compatiblePeers.has(forwarder) && message.kind === "commits")
        void this.sendRoom?.({ ...message, fwd: true }, forwarder);
      else this.toDirectPeers(message);
    }
  }

  // `from`: the direct peer it came from. New commits are passed on to the direct peers `from` doesn't reach itself
  // (it sent them to all of its own), so members who can't connect to each other still get each other's changes
  // through a member both reach. A peer list that is out of date is made up for by the next hello.
  private receive(message: Message, reply: (message: Message) => void, from?: string) {
    if (message.kind === "hello") {
      if (message.protocol !== this.protocolVersion) {
        if (from) {
          this.compatiblePeers.delete(from);
          if (!this.incompatiblePeers.has(from)) {
            this.incompatiblePeers.add(from);
            this.onIncompatible?.(from);
          }
          if (from === this.source) this.setSource(null);
        } else this.tabsCompatible = false;
        return;
      }
      if (from) this.compatiblePeers.add(from);
      else this.tabsCompatible = true;
      const vector = message.vector ?? {};
      if (from && this.sendRoom) {
        if (this.source === null || !this.compatiblePeers.has(this.source)) this.setSource(from);
        const known = this.vectors.has(from);
        this.vectors.set(from, vector);
        // A peer with everything the source has and more, while this member lacks some of it, becomes the source: in
        // a burst of joins the first peer connected is often another joiner with nothing yet.
        const sourceHas = this.source === null ? undefined : this.vectors.get(this.source);
        if (from !== this.source && sourceHas && covers(vector, sourceHas) && !covers(sourceHas, vector) && !covers(this.ledger.vector(), vector))
          this.setSource(from);
        if (message.ask !== false) this.catchUp(from, message.since ?? vector, message.fullHistory === true);
        if (message.reply) reply(this.helloTo(from, false));
        // The source's vector is known now: ask the others for what it lacks.
        if (from === this.source && !known)
          for (const p of this.mesh?.directPeers() ?? []) if (p !== from) void this.sendRoom(this.helloTo(p, false), p);
      } else {
        if (message.reply) reply(this.hello(false));
        for (const part of batches(this.ledger.missing(vector))) reply(part);
      }
    } else if (Array.isArray(message.commits) && (from ? this.compatiblePeers.has(from) : this.tabsCompatible)) {
      // Kept with the call's events: a call that goes silent shows whether a catch-up came just before. Not live
      // changes (a commit or two each, from every peer passing them on), which would push the link events out.
      if (from && this.call !== null && message.commits.length >= callEventBatch)
        noteCallEvent(this.workspaceId, `sync: ${message.commits.length} commits from {peer}`, from);
      // From a peer sending the full history, a snapshot's state is only read when it is already here.
      void this.ledger.accept(message.commits, this.fullHistoryPeers.has(from ?? "")
        ? undefined
        : (ref) => this.loadSnapshot(ref)).then((fresh) => {
        if (from !== undefined && from === this.source && fresh.length > 0) this.lastProgress = performance.now();
        // A snapshot refused here (its state doesn't fit this app, e.g. one without a table of the workspace's) leaves a
        // joiner with only the commits after it, and its vector says it has nothing: the peer sent the same snapshot
        // again at every hello. Asked for the whole history instead, it catches up without it.
        if (from && !this.fullHistoryPeers.has(from) && fresh.some((c) => c.snapshot && this.ledger.refusal(c) !== null)) {
          this.fullHistoryPeers.add(from);
          void this.sendRoom?.(this.helloTo(from, false, true), from);
        }
        if (!from || fresh.length === 0 || !this.mesh) return;
        // Sent to this one only: to everyone else. Otherwise to those `from` doesn't reach itself.
        const covered = message.fwd ? new Set<string>() : this.mesh.neighborsOf(from);
        for (const peer of this.mesh.directPeers())
          if (peer !== from && !covered.has(peer)) for (const part of batches(fresh)) void this.sendRoom?.(part, peer);
      }).catch((e) => {
        console.warn("Commits not applied:", e);
        if (from) {
          this.fullHistoryPeers.add(from);
          void this.sendRoom?.(this.helloTo(from, false, true), from);
        }
      });
    }
  }

  // Sends a member what it lacks, one batch per turn in the scheduler (syncQueue.ts). What it lacks is worked out at
  // its first turn. A batch that doesn't go out ends it: the member stopped taking data, and the next hello sends
  // the rest.
  private catchUp(peer: string, vector: Record<string, number>, fullHistory = false) {
    this.scheduler.enqueue(this.prefix + peer, (run) => this.sendBatch(peer, this.ledger.missing(vector, fullHistory), 0, run));
  }

  private async loadSnapshot(ref: SnapshotRef) {
    if (!(await this.ensureContent(ref.content.slice(4)))) {
      this.retrySnapshotLater(ref.content.slice(4));
      throw new Error("Snapshot content couldn't be fetched; requesting full history instead.");
    }
    const state = await this.ledger.readSnapshot(ref);
    if (!state) throw new Error("Snapshot content is missing or has an invalid format; requesting full history instead.");
    return state;
  }

  // A snapshot's state that couldn't be fetched may be there later (a node fetching it first, a member coming online),
  // and the whole history it falls back to may be nowhere (the snapshot's maker compacted it away): asked for again
  // 5 s later, then twice as long each time up to a minute, until it is here and the ledger took the snapshot up
  // (Ledger.retrySnapshots). Joiners stayed without the workspace's data for good otherwise (mesh-test s12).
  private retrySnapshotLater(hash: string, afterMs = this.snapshotRetryMs) {
    if (this.snapshotRetry !== undefined || this.closed) return;
    this.snapshotRetry = setTimeout(async () => {
      this.snapshotRetry = undefined;
      if (this.closed || this.ledger.snapshotForBootstrap()) return;
      if (await this.ensureContent(hash).catch(() => false)) {
        await this.ledger.retrySnapshots();
        if (!this.ledger.waitingForSnapshot()) return;
      }
      this.retrySnapshotLater(hash, Math.min(afterMs * 2, 60_000));
    }, afterMs);
  }

  private async sendBatch(peer: string, missing: Commit[], from: number, run: CatchUpRun): Promise<CatchUp | void> {
    if (from >= missing.length || this.closed || run.dropped() || !this.sendRoom) return;
    const started = performance.now();
    const part = missing.slice(from, from + batch);
    if (this.call !== null && part.length >= callEventBatch) noteCallEvent(this.workspaceId, `sync: ${part.length} commits to {peer}`, peer);
    const ok = await this.sendRoom({ kind: "commits", commits: part.map(wire) }, peer);
    run.report(performance.now() - started, ok);
    if (ok && from + batch < missing.length) return (next) => this.sendBatch(peer, missing, from + batch, next);
  }

  private countPeers() {
    this.setPeers(this.mesh?.peers().length ?? 0);
  }

  private addRecoveryRoom(secret: string): void {
    if (!this.room || !this.join) return;
    const key = recoveryKey(secret);
    if (this.room.has(key)) return;
    this.room.add(key, this.join(this.workspaceId, this.role === "member", secret));
  }

  setLocalMember(member: boolean): void {
    if (!this.room) return;
    this.room.setLocalAccess(member ? "member" : "invite");
  }

  private challengePeer(peer: string): void {
    // Reuse an unanswered challenge: replacing it would reject a slow proof already in flight.
    const nonce = this.authNonces.get(peer) ?? base64url(crypto.getRandomValues(new Uint8Array(24)));
    this.authNonces.set(peer, nonce);
    void this.peerAuthSend?.({ kind: "challenge", nonce }, peer).catch((e) => console.warn("Peer challenge wasn't sent:", e));
  }

  private async receivePeerAuth(message: PeerAuth, peer: string, options: AuthOptions): Promise<void> {
    if (!message || typeof message !== "object" || typeof message.nonce !== "string" || message.nonce.length > 64) return;
    if (message.kind === "challenge") {
      this.peerNonces.set(peer, message.nonce);
      const author = this.ledger.author;
      const text = peerAuthText(this.workspaceId, message.nonce, this.selfId, peer, author);
      const signature = await this.ledger.signPeerProof(text);
      const inviteText = invitePeerProofText(this.workspaceId, message.nonce, this.selfId, peer, author);
      const proof = options.inviteToken ? inviteProof(options.inviteToken, inviteText) : null;
      void this.peerAuthSend?.({
        kind: "proof", nonce: message.nonce, author, key: this.ledger.publicKey, signature,
        ...(proof ? { inviteProof: proof } : {}),
      }, peer).catch((e) => console.warn("Peer proof wasn't sent:", e));
      return;
    }
    if (message.kind === "secret") {
      if (this.peerNonces.get(peer) !== message.nonce || !options.inviteToken) return;
      this.peerNonces.delete(peer);
      try {
        if (typeof message.secret !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(message.secret)
          || typeof message.author !== "string" || !message.key
          || typeof message.key.x !== "string" || typeof message.key.y !== "string") return;
        if (await accountId({ crv: "P-256", ...message.key }) !== message.author) return;
        const text = peerSecretText(this.workspaceId, message.nonce, peer, this.selfId, message.author, message.secret);
        if (!(await verify({ kty: "EC", crv: "P-256", ...message.key }, text, message.signature))) return;
        if (this.ledger.owner !== null) {
          const userId = userNumberOf(message.author);
          if (this.ledger.select("roles", "roles_bans", { user_id: userId }).length || !this.isWorkspaceMember(userId)) return;
        }
        this.peerAuthors.set(peer, message.author);
        this.refreshPeerAccess();
        await this.rotateSecret(message.secret);
        void this.sendRoom?.(this.helloTo(peer, true), peer);
      } catch (e) {
        console.warn("Workspace secret handoff failed:", e);
      }
      return;
    }
    if (message.kind !== "proof" || this.authNonces.get(peer) !== message.nonce
      || typeof message.author !== "string" || typeof message.signature !== "string"
      || !message.key || typeof message.key.x !== "string" || typeof message.key.y !== "string") return;
    this.authNonces.delete(peer);
    try {
      if (await accountId({ crv: "P-256", ...message.key }) !== message.author) return;
      const text = peerAuthText(this.workspaceId, message.nonce, peer, this.selfId, message.author);
      if (!(await verify({ kty: "EC", crv: "P-256", ...message.key }, text, message.signature))) return;
      this.peerAuthors.set(peer, message.author);
      const inviteId = this.hasValidInviteProof(message.inviteProof, message.nonce, peer, message.author);
      if (inviteId !== null) this.invitePeers.set(peer, inviteId);
      else if (typeof message.inviteProof === "string" && message.inviteProof.length <= 256)
        this.pendingProofs.set(peer, { nonce: message.nonce, author: message.author, proof: message.inviteProof });
      this.refreshPeerAccess();
      if (inviteId !== null) await this.handOffSecret(peer, message.nonce);
    } catch (e) {
      console.warn("Peer authentication failed:", e);
    }
  }

  // An admitted invitee gets the current room secret (its code may carry an old one, or none), from a member only.
  private async handOffSecret(peer: string, nonce: string): Promise<void> {
    if (!this.currentSecret || this.ledger.select("roles", "roles_bans", { user_id: this.ledger.me }).length
      || !this.isWorkspaceMember(this.ledger.me)) return;
    const text = peerSecretText(this.workspaceId, nonce, this.selfId, peer, this.ledger.author, this.currentSecret);
    const signature = await this.ledger.signPeerProof(text);
    await this.peerAuthSend?.({
      kind: "secret", nonce, author: this.ledger.author, key: this.ledger.publicKey, signature, secret: this.currentSecret,
    }, peer);
  }

  // From a peer in any of this workspace's rooms: each is joined with its room secret (a recovery room's an old one) or,
  // an invite's room, with a password from the invite, so meeting there already took one. Members are passive in the
  // hub, so without a node online an invitee meets them only in the member room or its invite's room; accepted in the
  // hub alone, nobody could join a workspace with no node up (mesh-test s12).
  private hasValidInviteProof(proof: string | undefined, nonce: string, peer: string, author: string,
    invites = this.ledger.select("members", "members_invites", {})): number | null {
    if (!proof) return null;
    const text = invitePeerProofText(this.workspaceId, nonce, peer, this.selfId, author);
    for (const invite of invites) {
      if (!this.inviteAvailable(invite)) continue;
      if (verifyInviteProof(String(invite.token_key), text, proof)) return Number(invite.id);
    }
    return null;
  }

  private inviteAvailable(invite: JsonRow): boolean {
    return inviteOpen(invite, this.ledger.select("members", "members_invite_joins", { invite_id: Number(invite.id) }).length);
  }

  // Proofs that matched nothing when they came, checked again once more invites are here: a member that met a joiner
  // before the invite reached it admits the joiner then, on the same connection (before, it never did).
  private recheckProofs(): void {
    if (this.pendingProofs.size === 0) return;
    const invites = this.ledger.select("members", "members_invites", {});
    if (invites.length === this.provenAgainst) return;
    this.provenAgainst = invites.length;
    for (const [peer, pending] of [...this.pendingProofs]) {
      const inviteId = this.hasValidInviteProof(pending.proof, pending.nonce, peer, pending.author, invites);
      if (inviteId === null) continue;
      this.pendingProofs.delete(peer);
      this.invitePeers.set(peer, inviteId);
      void this.handOffSecret(peer, pending.nonce).catch((e) => console.warn("Workspace secret handoff failed:", e));
    }
  }

  private refreshPeerAccess(): void {
    const room = this.room;
    if (!room) return;
    this.recheckProofs();
    const selfId = this.ledger.me;
    const selfBanned = this.ledger.select("roles", "roles_bans", { user_id: selfId }).length > 0;
    const selfMember = !selfBanned && this.isWorkspaceMember(selfId);
    room.setLocalAccess(selfMember ? "member" : "invite");
    for (const [peer, author] of this.peerAuthors) {
      const userId = userNumberOf(author);
      const banned = this.ledger.select("roles", "roles_bans", { user_id: userId }).length > 0;
      const member = !banned && (this.ledger.owner === null || this.isWorkspaceMember(userId));
      const inviteId = this.invitePeers.get(peer);
      const invite = inviteId === undefined ? undefined
        : this.ledger.select("members", "members_invites", { id: inviteId })[0];
      const inviteValid = invite !== undefined && this.inviteAvailable(invite);
      room.authorizePeer(peer, member ? "member" : inviteValid ? "invite" : null);
    }
  }

  private isWorkspaceMember(userId: number): boolean {
    return this.ledger.owner === userId
      || this.ledger.select("members", "members_profiles", { user_id: userId }).length > 0
      || this.ledger.select("nodes", "nodes_nodes", { user_id: userId }).some((row) => row.status === "authorized");
  }
}

function peerAuthText(workspaceId: string, nonce: string, from: string, to: string, author: string): string {
  return `makework-peer-auth-v1|${workspaceId}|${nonce}|${from}|${to}|${author}`;
}

function peerSecretText(workspaceId: string, nonce: string, from: string, to: string, author: string, secret: string): string {
  return `makework-peer-secret-v1|${workspaceId}|${nonce}|${from}|${to}|${author}|${secret}`;
}

function scopedRoomId(id: string, secret: string, protocol: number): string {
  if (protocol < 5) return id;
  const markers = [":members", ":call:", ":group:", ":nodes"]
    .map((marker) => id.indexOf(marker)).filter((index) => index >= 0);
  const split = markers.length ? Math.min(...markers) : id.length;
  return `${id.slice(0, split)}:room:${secretFingerprint(secret)}${id.slice(split)}`;
}

// The part of a room's id that comes from the room secret; also names that secret's recovery room in the RoomGroup.
function secretFingerprint(secret: string): string {
  return base64url(sha256(new TextEncoder().encode(secret))).slice(0, 16);
}

function recoveryKey(secret: string): string {
  return `recovery:${secretFingerprint(secret)}`;
}

// A call's room under an earlier room secret, kept while the call goes on (rotateSecret).
function callKey(secret: string): string {
  return `call:${secretFingerprint(secret)}`;
}

// Which of the workspace's rooms a room id is, from its markers (scopedRoomId keeps them). The hub and recovery
// rooms look the same: a recovery room is the hub of another secret.
type RoomKind = "hub" | "members" | "grid" | "call" | "invite" | "group" | "nodes";
function roomKind(roomId: string): RoomKind {
  if (roomId.includes(":members:")) return "grid";
  if (roomId.includes(":members")) return "members";
  if (roomId.includes(":call:")) return "call";
  if (roomId.includes(":invite:")) return "invite";
  if (roomId.endsWith(":nodes")) return "nodes";
  if (roomId.includes(":group:")) return "group";
  return "hub";
}

const appIds: Record<RoomKind, string> = {
  hub: appId, members: `${appId}-members`, grid: `${appId}-members`, call: `${appId}-call`, invite: `${appId}-invite`,
  group: `${appId}-group`, nodes: `${appId}-nodes`,
};

const roomNames: Record<Exclude<RoomKind, "hub">, string> = {
  members: "the member room", grid: "a member grid room", call: "the call room", invite: "an invite's room",
  group: "a node group's room", nodes: "the nodes' room",
};

// For messages: `hubId` is the current hub's room id.
function roomName(roomId: string, hubId: string): string {
  const kind = roomKind(roomId);
  if (kind !== "hub") return roomNames[kind];
  return roomId === hubId ? "the hub" : "a recovery room";
}

function batches(commits: Commit[]): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < commits.length; i += batch) messages.push({ kind: "commits", commits: commits.slice(i, i + batch).map(wire) });
  return messages;
}

// A member's place in the grid of member rooms: a stable hash of its user id.
// A member's cell in a grid of `size` rows and columns, from a hash of its user id (FNV-1a).
export function gridCell(user: number, size: number): { row: number; col: number } {
  let h = 2166136261;
  for (const ch of String(user)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const n = h >>> 0;
  return { row: n % size, col: Math.floor(n / size) % size };
}

// The higher seq per replica of both.
function merged(a: Vector, b: Vector): Vector {
  const out = { ...a };
  for (const [replica, seq] of Object.entries(b)) out[replica] = Math.max(out[replica] ?? -1, seq);
  return out;
}

// Whether `a` has everything `b` has.
function covers(a: Vector, b: Vector): boolean {
  return Object.entries(b).every(([replica, seq]) => (a[replica] ?? -1) >= seq);
}

function parseList(text: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
