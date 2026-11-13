// Nodes in a workspace's room, seen from a member's app, and the messages both sides use (the node's side is
// src/node/host.ts).
//
// A node says which peer it is with a hello signed by its key, which its row in `nodes_nodes` names, so members know
// which peer is which node. Members ping the authorized nodes they reach and ask the one with the shortest round trip
// first for file content (closest in network terms), then the others, then everyone else. Where members are is
// p2p/memberMap.ts.
import { validVersion } from "../core/version";
import { createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { requestAction, type RequestAction } from "./requests";
import { verify } from "../core/identity";
import type { Ledger } from "./ledger";
import { groupOfNode, memberGroups, nodeGroups } from "./nodeGroups";
import { defaultStorage, stripeLimit, type Storage, bitsFromBase64, striped, pieceCount, dataHolders, slotOf, hasBit } from "./pieces";
import { defaultCopies, holders } from "./placement";
import type { WorkspaceSync } from "./sync";

// Nodes are pinged often and one that doesn't answer for `deadAfterMs` stops counting as reached: WebRTC notices a
// killed peer only after about 30 s, and members waited that long before falling back (NODES-REPORT.md A7).
const pingEveryMs = 5_000;
const deadAfterMs = 15_000;
// Signed messages older than this are refused, so a copied one can't be sent again later.
export const signedForMs = 120_000;

export type Place = { lat: number; lon: number; city: string; country: string };

// `app`: the node's version, for showing only (not signed; nodes from before it was added don't send one).
export type NodeHello = { user: number; time: number; sig: string; app?: string };
export type NodePing = { t: number; pong?: true };
export type Have = { all?: string[]; add?: string[]; remove?: string[]; pieces?: Record<string, string> };
// A member asking the nodes which of some files they hold. Nodes tell each other what they have (`node-have`), never
// members: that would be every node's whole list to each of hundreds of members. So a member asks about the files it
// shows ("Show hosting") and its own uploads on their way (p2p/deliveries.ts). `asked`: the hashes the answer covers;
// `have`: those kept whole; `pieces`: bitmaps of the pieces kept of big ones, as in `Have`. Nodes from before this
// don't answer: their files show as "unknown".
export type HoldsAsk = { hashes: string[] };
export type HoldsReply = { asked: string[]; have: string[]; pieces?: Record<string, string> };
export const holdsAskMax = 500;
// How long an answer about a file shown counts before it is asked about again, and how long an answer is waited for.
const askAgainMs = 15_000;
const holdsTimeoutMs = 5_000;
const hashPattern = /^[0-9a-f]{64}$/;
// Whole files by hash, pieces as "<hash>:<n>" or "<hash>:p<g>".
const keyPattern = /^[0-9a-f]{64}(:p?\d+)?$/;
const validKeys = (list: unknown, pattern = keyPattern): string[] =>
  (Array.isArray(list) ? list.filter((h): h is string => typeof h === "string" && pattern.test(h)) : []);

export type HostingNode = {
  userId: number;
  name: string;
  city: string;
  country?: string;
  shouldHold: boolean;
  hasWhole: boolean;
  pieces?: { have: number; total: number };
  // "unknown": the node is reached but hasn't said (not asked yet, or a node from before `node-holds`); "offline": not
  // reached now.
  status: "holds" | "healing" | "missing" | "unknown" | "offline";
};

export type ContentHosting = {
  striped: boolean;
  size: number | null;
  piecesTotal?: number;
  parity?: number;
  parityPieces?: number;
  nodes: HostingNode[];
};

export const nodeChannels = { hello: "node-hello", ping: "node-ping", have: "node-have", holds: "node-holds" } as const;

export function helloText(workspaceId: string, peer: string, time: number): string {
  return `makework-node-hello\n${workspaceId}\n${peer}\n${time}`;
}

export function fresh(time: unknown): boolean {
  return typeof time === "number" && Math.abs(Date.now() - time) < signedForMs;
}

export function jwk(key: { x: string; y: string }): JsonWebKey {
  return { kty: "EC", crv: "P-256", x: key.x, y: key.y };
}

export async function verifySigned(key: { x: string; y: string } | null | undefined, text: string, sig: unknown): Promise<boolean> {
  if (!key || typeof sig !== "string") return false;
  try {
    return await verify(jwk(key), text, sig);
  } catch {
    return false;
  }
}

export type NodeRow = {
  user_id: number; name: string; status: string; key_x: string; key_y: string; address: string; url: string; page: string;
  country: string; city: string; lat: number | null; lon: number | null; created_at: string;
};

export function nodeRows(ledger: Ledger): NodeRow[] {
  return ledger.select("nodes", "nodes_nodes", {}).map((r) => ({
    user_id: Number(r.user_id), name: String(r.name ?? ""), status: String(r.status ?? "pending"),
    key_x: String(r.key_x ?? ""), key_y: String(r.key_y ?? ""), address: String(r.address ?? ""), url: String(r.url ?? ""),
    page: String(r.page ?? ""), country: String(r.country ?? ""), city: String(r.city ?? ""),
    lat: r.lat === null || r.lat === undefined || r.lat === "" ? null : Number(r.lat),
    lon: r.lon === null || r.lon === undefined || r.lon === "" ? null : Number(r.lon),
    created_at: String(r.created_at ?? ""),
  }));
}

// How many nodes keep each file (nodes_settings, set in Server settings > Nodes).
export function copiesOf(ledger: Ledger): number {
  const copies = Number(ledger.select("nodes", "nodes_settings", {})[0]?.copies);
  return Number.isInteger(copies) && copies >= 1 ? copies : defaultCopies;
}

// How the nodes store files (nodes_settings; p2p/pieces.ts).
export function storageOf(ledger: Ledger): Storage {
  const row = ledger.select("nodes", "nodes_settings", {})[0];
  const number = (value: unknown, fallback: number) => (value === null || value === undefined || value === "" ? fallback : Number(value));
  return {
    copies: copiesOf(ledger),
    stripeBytes: stripeLimit(row?.stripe_mb === null || row?.stripe_mb === undefined || row?.stripe_mb === "" ? null : Number(row.stripe_mb)),
    parity: number(row?.parity, defaultStorage.parity),
  };
}

// The node groups for this peer (p2p/nodeGroups.ts): a node gets its own group, a member its groups nearest first
// (`place`: this device's rough place, else by a hash of its user id). One group up to 3 nodes; a node that isn't
// authorized yet stays out of the groups.
export function groupsFor(ledger: Ledger, place: { lat: number; lon: number } | null, node: boolean): { count: number; order: number[] } {
  const rows = nodeRows(ledger).filter((n) => n.status === "authorized").map((n) => ({ user: n.user_id, lat: n.lat, lon: n.lon }));
  const groups = nodeGroups(rows);
  if (groups.length <= 1) return { count: 1, order: [0] };
  if (node) {
    const mine = groupOfNode(groups, ledger.me);
    return mine < 0 ? { count: 1, order: [0] } : { count: groups.length, order: [mine] };
  }
  return { count: groups.length, order: memberGroups(groups, rows, place, String(ledger.me)) };
}

// The user ids of the authorized nodes.
export function authorizedNodes(ledger: Ledger): number[] {
  return nodeRows(ledger).filter((n) => n.status === "authorized").map((n) => n.user_id);
}

type NodePeer = { user: number; rtt: number | null; app: string | null };

const links = new Map<string, NodeLink>();
export function nodeLinkOf(workspaceId: string): NodeLink | undefined {
  return links.get(workspaceId);
}
const [peerState, setPeerState] = createStore<Record<string, Record<string, NodePeer>>>({});

export class NodeLink {
  private readonly peers = new Map<string, NodePeer>();
  // The last hello of peers whose row isn't here yet, checked again when node rows change. A member who just joined
  // gets a node's hello on connect, before the data with the node's row; nodes say hello again only once a minute,
  // so dropping it left new members asking anyone for files, not nodes first (found by mesh-test s8).
  private readonly waiting = new Map<string, NodeHello>();
  private readonly pinged = new Map<string, number>();
  // When each node peer last answered (or said hello).
  private readonly heard = new Map<string, number>();
  // Nodes that stopped answering, still pinged: an answer brings one back at once (a busy node isn't dead).
  private readonly silent = new Map<string, NodePeer>();
  private readonly sendPing: ((data: NodePing, peer?: string) => void) | null = null;
  private readonly sendHelloTo: ((data: NodeHello, peer?: string) => void) | null = null;
  // The `node-have` channel is this link's: Trystero keeps the first action of a name, so a second listener (the
  // node's host.ts once had its own) never hears anything. Others send and listen through `sendHave`/`onHave`.
  private readonly sendHaveTo: ((data: Have, peer?: string) => void) | null = null;
  private readonly haveHandlers = new Set<(peer: string, have: Have) => void>();
  private readonly holdings = new Map<string, Set<string>>();
  private readonly pieceHoldings = new Map<string, Map<string, Uint8Array>>();
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private readonly cleanups: (() => void)[] = [];
  private readonly nodeHandlers = new Set<(peer: string, user: number | null) => void>();
  // `node-holds`, this link's like `node-have` (one owner per action name): a node answers it, a member asks.
  private readonly holds: RequestAction<HoldsAsk, HoldsReply> | null = null;
  // The hashes each node answered about, so a file it hasn't is "unknown", not "missing".
  private readonly known = new Map<string, Set<string>>();
  // Files shown with their hosting: when each was last asked about, and those waiting for the next ask.
  private readonly askedAt = new Map<string, number>();
  private readonly toAsk = new Set<string>();
  private askTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  // Read by `contentHosting`, so what shows it follows the answers.
  private readonly holdingsVersion = createSignal(0);

  // `answerPings`: on a node, which answers members' pings (and sends its own hello with `sendHello`). `answerHoldings`:
  // on a node, what it holds of files a member asks about (`node-holds`). `pingEveryMs`/`deadAfterMs`: shorter in tests.
  constructor(
    private readonly workspaceId: string, private readonly ledger: Ledger, sync: WorkspaceSync,
    private readonly options: {
      answerPings?: boolean; answerHoldings?: (hashes: string[]) => Promise<HoldsReply>; pingEveryMs?: number; deadAfterMs?: number;
    } = {},
  ) {
    links.set(workspaceId, this);
    setPeerState(workspaceId, {});
    const mesh = sync.mesh;
    if (!mesh) return;
    this.sendHelloTo = mesh.channel<NodeHello>(nodeChannels.hello, (hello, peer) => void this.receiveHello(hello, peer));
    this.sendPing = mesh.channel<NodePing>(nodeChannels.ping, (ping, peer) => {
      if (options.answerPings && !ping?.pong && typeof ping?.t === "number") this.sendPing?.({ t: ping.t, pong: true }, peer);
      else this.receivePong(ping, peer);
    });
    this.sendHaveTo = mesh.channel<Have>(nodeChannels.have, (have, peer) => {
      this.receiveHave(peer, have);
      for (const handler of this.haveHandlers) handler(peer, have);
    });
    if (sync.room) {
      const answer = options.answerHoldings;
      this.holds = requestAction<HoldsAsk, HoldsReply>(sync.room, nodeChannels.holds, answer
        ? (ask) => answer(validKeys(ask?.hashes, hashPattern).slice(0, holdsAskMax))
        : undefined);
    }
    this.cleanups.push(mesh.onPeers(() => {}, (peer) => {
      this.waiting.delete(peer);
      this.silent.delete(peer);
      this.pinged.delete(peer);
      this.holdings.delete(peer);
      this.pieceHoldings.delete(peer);
      this.known.delete(peer);
      this.forget(peer);
    }));
    this.cleanups.push(ledger.subscribe((event) => {
      if (event.plugin !== "nodes") return;
      for (const peer of [...this.peers.keys()]) if (!this.authorized(this.peers.get(peer)!.user)) this.forget(peer);
      for (const [peer, hello] of [...this.waiting]) {
        this.waiting.delete(peer);
        void this.receiveHello(hello, peer);
      }
    }));
    this.timers.push(setInterval(() => this.pingAll(), options.pingEveryMs ?? pingEveryMs));
  }

  close(): void {
    this.timers.forEach(clearInterval);
    clearTimeout(this.askTimer);
    clearTimeout(this.refreshTimer);
    this.cleanups.forEach((cleanup) => cleanup());
    if (links.get(this.workspaceId) === this) links.delete(this.workspaceId);
  }

  // `peers` with the authorized nodes first, the closest first.
  order(peers: string[]): string[] {
    const rank = (peer: string) => {
      const node = this.peers.get(peer);
      return node ? node.rtt ?? 1e6 : Infinity;
    };
    return [...peers].sort((a, b) => rank(a) - rank(b));
  }

  // The node this member uses first, if any.
  closest(): { peer: string; user: number } | null {
    const [peer] = this.order([...this.peers.keys()]);
    return peer ? { peer, user: this.peers.get(peer)!.user } : null;
  }

  // The node a peer is, by user id; null for other peers.
  nodeUser(peer: string): number | null {
    return this.peers.get(peer)?.user ?? null;
  }

  // Whether a peer is an authorized node, reached now or gone quiet for a while: a node busy taking in an upload over a
  // slow link misses pings, and is still the node that upload went to (p2p/deliveries.ts).
  isNode(peer: string): boolean {
    return this.peers.has(peer) || this.silent.has(peer);
  }

  // Whether the nodes keep a file of this size whole (taken in as one whole send), not in pieces (p2p/pieces.ts).
  keptWhole(size: number): boolean {
    return !striped(size, storageOf(this.ledger));
  }

  // Whether the workspace has any authorized node (members then connect to nodes rather than to each other, sync.ts).
  hasNodes(): boolean {
    return nodeRows(this.ledger).some((n) => n.status === "authorized");
  }

  // A node's own hello (node/host.ts), to everyone or one peer.
  sendHello(hello: NodeHello, peer?: string): void {
    this.sendHelloTo?.(hello, peer);
  }

  // The authorized nodes reached now: user id -> peer.
  onlineNodes(): Map<number, string> {
    return new Map([...this.peers].map(([peer, n]) => [n.user, peer]));
  }

  // What a node has (whole files and pieces), to another node or every peer.
  sendHave(data: Have, peer?: string): void {
    this.sendHaveTo?.(data, peer);
  }

  // Every `node-have` that arrives, after this link took it in.
  onHave(handler: (peer: string, have: Have) => void): () => void {
    this.haveHandlers.add(handler);
    return () => this.haveHandlers.delete(handler);
  }

  // Called when a peer turns out to be a node (its user id) or stops being one (null).
  onNodes(handler: (peer: string, user: number | null) => void): () => void {
    this.nodeHandlers.add(handler);
    return () => this.nodeHandlers.delete(handler);
  }

  // `peers` for downloading one file: the nodes that keep it (p2p/placement.ts; nodes not reached count as gone), the
  // closest first, then the other nodes (they fetch it on demand), then everyone else.
  orderFor(hash: string, peers: string[]): string[] {
    const online = this.onlineNodes();
    const all = authorizedNodes(this.ledger);
    const keep = new Set(holders(hash, all.map((user) => ({ user, gone: !online.has(user) })), copiesOf(this.ledger)));
    const ordered = this.order(peers);
    const isHolder = (peer: string) => keep.has(this.peers.get(peer)?.user ?? -1);
    return [...ordered.filter(isHolder), ...ordered.filter((p) => !isHolder(p))];
  }

  private authorized(user: number): NodeRow | null {
    return nodeRows(this.ledger).find((n) => n.user_id === user && n.status === "authorized") ?? null;
  }

  private async receiveHello(hello: NodeHello, peer: string) {
    if (!fresh(hello?.time)) return;
    const row = this.authorized(Number(hello.user));
    if (!row) {
      this.waiting.set(peer, hello);
      return;
    }
    if (!(await verifySigned({ x: row.key_x, y: row.key_y }, helloText(this.workspaceId, peer, hello.time), hello.sig))) return;
    const known = this.peers.get(peer);
    this.silent.delete(peer);
    this.heard.set(peer, performance.now());
    this.peers.set(peer, { user: row.user_id, rtt: known?.rtt ?? null, app: validVersion(hello.app) ? hello.app : known?.app ?? null });
    this.publish();
    if (!known) {
      this.ping(peer);
      this.nodeHandlers.forEach((handler) => handler(peer, row.user_id));
    }
  }

  // Pings the nodes reached; one that hasn't answered for `deadAfterMs` is forgotten until its next hello.
  private pingAll() {
    const now = performance.now();
    for (const [peer, node] of [...this.peers]) {
      if (now - (this.heard.get(peer) ?? now) > (this.options.deadAfterMs ?? deadAfterMs)) {
        this.forget(peer);
        this.silent.set(peer, node);
      }
      this.ping(peer);
    }
    for (const peer of this.silent.keys()) this.ping(peer);
  }

  private ping(peer: string) {
    const t = performance.now();
    this.pinged.set(peer, t);
    this.sendPing?.({ t }, peer);
  }

  // Any answer to one of this member's pings counts, not only to the last one: pings go out every 5 s, and a busy
  // node answering in more than that had its answers dropped, counted as silent after 15 s and never brought back
  // while it stayed slow (mesh-test s9). `t` is this member's own clock, so the round trip is right either way.
  private receivePong(ping: NodePing, peer: string) {
    const last = this.pinged.get(peer);
    const ours = !!ping?.pong && typeof ping.t === "number" && last !== undefined && ping.t <= last;
    const quiet = this.silent.get(peer);
    if (quiet && ours) {
      this.silent.delete(peer);
      this.peers.set(peer, quiet);
      this.publish();
      this.nodeHandlers.forEach((handler) => handler(peer, quiet.user));
    }
    const node = this.peers.get(peer);
    if (!ours || !node) return;
    const rtt = performance.now() - ping.t;
    this.heard.set(peer, performance.now());
    node.rtt = node.rtt === null ? rtt : node.rtt * 0.7 + rtt * 0.3;
    this.publish();
  }

  private forget(peer: string) {
    if (!this.peers.delete(peer)) return;
    this.heard.delete(peer);
    this.publish();
    this.nodeHandlers.forEach((handler) => handler(peer, null));
  }

  // Asks the nodes reached which of `hashes` they hold (`node-holds`, at most `holdsAskMax`); resolves with those one
  // holds whole. The answers are kept for `contentHosting` too. Nodes that don't answer (gone, or from before
  // `node-holds`) count as holding none.
  async askHoldings(hashes: string[]): Promise<Set<string>> {
    const list = [...new Set(validKeys(hashes, hashPattern))].slice(0, holdsAskMax);
    const held = new Set<string>();
    const holds = this.holds;
    if (!holds || !list.length) return held;
    await Promise.all([...this.onlineNodes().values()].map(async (peer) => {
      const reply = await holds.request({ hashes: list }, { target: peer, timeoutMs: holdsTimeoutMs }).catch(() => null);
      if (!reply || typeof reply !== "object") return;
      for (const hash of this.takeHoldings(peer, reply)) held.add(hash);
    }));
    return held;
  }

  // Whether a node reached now is known to hold all of the file (it answered `askHoldings`, or took it from here),
  // without asking. Unknown counts as no.
  holdsWhole(hash: string): boolean {
    for (const peer of this.onlineNodes().values()) if (this.holdings.get(peer)?.has(hash)) return true;
    return false;
  }

  // A node received all of a file from here (ContentStreams `onSent`): it holds it now.
  noteHeld(peer: string, hash: string): void {
    if (!this.isNode(peer) || !hashPattern.test(hash)) return;
    this.takeHoldings(peer, { asked: [hash], have: [hash] });
  }

  // An answer from `peer`: what it holds of what it answered about (and no longer what it didn't say it holds). Returns
  // the hashes it holds whole.
  private takeHoldings(peer: string, reply: HoldsReply): string[] {
    const asked = validKeys(reply.asked, hashPattern);
    const have = new Set(validKeys(reply.have, hashPattern));
    const known = this.known.get(peer) ?? new Set<string>();
    const set = this.holdings.get(peer) ?? new Set<string>();
    for (const hash of asked) {
      known.add(hash);
      if (have.has(hash)) set.add(hash);
      else set.delete(hash);
    }
    this.known.set(peer, known);
    this.holdings.set(peer, set);
    const bitmaps = this.pieceHoldings.get(peer) ?? new Map<string, Uint8Array>();
    if (reply.pieces && typeof reply.pieces === "object")
      for (const [hash, text] of Object.entries(reply.pieces)) {
        const bits = hashPattern.test(hash) && typeof text === "string" ? bitsFromBase64(text) : null;
        if (bits) bitmaps.set(hash, bits);
      }
    this.pieceHoldings.set(peer, bitmaps);
    this.holdingsVersion[1]((n) => n + 1);
    return asked.filter((hash) => have.has(hash));
  }

  // A file shown with its hosting: asked about soon, with the others shown (one request each `holdsAskMax`), and again
  // after `askAgainMs` while it stays shown (what shows it runs again then, as it reads `holdingsVersion`).
  private wantHoldings(hash: string) {
    if (!this.holds || this.options.answerHoldings || !this.onlineNodes().size) return;
    const at = this.askedAt.get(hash);
    if (at !== undefined && performance.now() - at < askAgainMs) return;
    this.askedAt.set(hash, performance.now());
    this.toAsk.add(hash);
    this.askTimer ??= setTimeout(() => this.askShown(), 200);
    this.refreshTimer ??= setTimeout(() => {
      this.refreshTimer = undefined;
      this.holdingsVersion[1]((n) => n + 1);
    }, askAgainMs);
  }

  private askShown() {
    this.askTimer = undefined;
    const batch = [...this.toAsk].slice(0, holdsAskMax);
    for (const hash of batch) this.toAsk.delete(hash);
    void this.askHoldings(batch);
    if (this.toAsk.size) this.askTimer = setTimeout(() => this.askShown(), 200);
  }

  private receiveHave(peer: string, have: Have) {
    if (!have || typeof have !== "object") return;
    const valid = (list: unknown) => validKeys(list);
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

  contentHosting(hash: string, size: number | null): ContentHosting | null {
    this.holdingsVersion[0]();
    this.wantHoldings(hash);
    const rows = nodeRows(this.ledger);
    const auth = rows.filter((n) => n.status === "authorized");
    const storage = storageOf(this.ledger);
    const isStriped = striped(size, storage);
    const result: ContentHosting = {
      striped: isStriped,
      size,
      parity: storage.parity,
      nodes: [],
    };
    if (isStriped && size !== null) {
      const pt = pieceCount(size);
      result.piecesTotal = pt;
      if (storage.parity > 0) result.parityPieces = Math.ceil(pt / storage.parity);
    }
    for (const row of auth) {
      const peer = this.onlineNodes().get(row.user_id);
      const node = { user: row.user_id, gone: peer === undefined };
      let should = false;
      if (isStriped && size !== null) {
        const pc = pieceCount(size);
        for (let i = 0; i < pc && !should; i++) {
          if (dataHolders(hash, i, [node], storage).includes(row.user_id)) should = true;
        }
      } else {
        should = holders(hash, [node], copiesOf(this.ledger)).includes(row.user_id);
      }
      let hasWhole = false;
      let piecesHave = 0;
      let piecesTotal = isStriped && size !== null ? pieceCount(size) : 0;
      if (peer) {
        if (!isStriped) {
          const set = this.holdings.get(peer);
          hasWhole = set?.has(hash) || set?.has(hash.slice(0, 64)) || false;
        } else if (size !== null) {
          piecesTotal = pieceCount(size);
          for (let i = 0; i < piecesTotal; i++) {
            const key = hash + ":" + i;
            const ph = this.pieceHoldings.get(peer)?.get(hash);
            const slot = slotOf(key, hash, size);
            const set = this.holdings.get(peer);
            const has = set?.has(key) || set?.has(hash) || (slot !== null && hasBit(ph, slot));
            if (has) piecesHave++;
          }
        }
      }
      // Whether the node told us about this file at all (asked, or its `node-have` on a node): else it is "unknown".
      const told = !!peer && (this.known.get(peer)?.has(hash) || this.holdings.get(peer)?.has(hash) || this.pieceHoldings.get(peer)?.has(hash) || false);
      let status: HostingNode["status"];
      if (!peer) status = "offline";
      else if (!isStriped) status = hasWhole ? "holds" : told ? "missing" : "unknown";
      else if (piecesTotal > 0 && piecesHave >= piecesTotal) status = "holds";
      else if (piecesHave > 0) status = "healing";
      else status = told ? "missing" : "unknown";
      result.nodes.push({
        userId: row.user_id,
        name: row.name,
        city: row.city,
        country: row.country,
        shouldHold: should,
        hasWhole,
        pieces: isStriped ? { have: piecesHave, total: piecesTotal } : undefined,
        status,
      });
    }
    return result;
  }

  private publish() {
    setPeerState(this.workspaceId, reconcile(Object.fromEntries([...this.peers].map(([peer, n]) => [peer, { ...n }]))));
  }
}

// Authorized nodes reached now, by peer, with their round trip in ms once measured.
export function nodePeers(workspaceId: string): NodePeer[] {
  return Object.values(peerState[workspaceId] ?? {});
}

export function closestNode(workspaceId: string): number | null {
  const [best] = nodePeers(workspaceId).sort((a, b) => (a.rtt ?? 1e6) - (b.rtt ?? 1e6));
  return best?.user ?? null;
}

export function contentHosting(workspaceId: string, hash: string, size: number | null): ContentHosting | null {
  return links.get(workspaceId)?.contentHosting(hash, size) ?? null;
}
