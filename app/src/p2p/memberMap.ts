// Where members are, for the globe in Server settings > Nodes; works with or without nodes.
//
// Someone with "Manage nodes" who has the page open asks every member reached (signed, every 15 s). Every member
// checks the asker's signature and permission and answers, signed: the node they use first, the members they are
// connected to directly, and which of those connections carry data right now (from the connections' byte counters
// between two asks). Only members who turned on "Show my rough location to server admins" also send the place of
// their own time zone (core/timeZonePlaces.ts; no lookup, nothing leaves but that); the others send no place and
// stay off the globe. Nothing is stored; answers are forgotten after a while.
import { createStore, reconcile } from "solid-js/store";
import { selfId } from "trystero";
import { sign } from "../core/identity";
import type { Ledger } from "./ledger";
import { userNumberOf } from "./log";
import { fresh, verifySigned } from "./nodes";
import { roleTablesFrom, standing } from "./permissions";
import type { WorkspaceSync } from "./sync";

const keepMs = 45_000;
// Above this a connection counts as exchanging data; keep-alives and hellos stay well below it.
const activeBytesPerSecond = 2048;

// Which way data flows on a connection, seen from the member answering: 1 it sends, -1 it receives, 0 both.
export type Flow = 1 | -1 | 0;

export type MapPlace = { lat: number; lon: number; country: string };
type Ask = { user: number; time: number; sig: string };
// `peers`: the peer ids of the members it is connected to directly; `active`: those exchanging data, and `nodes` the
// nodes (by user id) it exchanges data with. `place` is null when the member didn't opt in to sharing location.
type Traffic = { active: [string, Flow][]; nodes: [number, Flow][] };
type Answer = { user: number; time: number; place: MapPlace | null; via: number | null; peers: string[]; sig: string } & Traffic;

export type Located = Traffic & { user: number; place: MapPlace | null; via: number | null; peer: string; peers: string[] };

const askText = (workspaceId: string, peer: string, m: Omit<Ask, "sig">) => `makework-map-ask\n${workspaceId}\n${peer}\n${m.user}\n${m.time}`;
const answerText = (workspaceId: string, peer: string, m: Omit<Answer, "sig">) =>
  `makework-map-place\n${workspaceId}\n${peer}\n${m.user}\n${m.time}\n${m.place === null ? "" : `${m.place.lat},${m.place.lon},${m.place.country}`}\n${m.via ?? ""}\n${m.peers.join(",")}` +
  `\n${m.active.map(([p, f]) => `${p}:${f}`).join(",")}\n${m.nodes.map(([n, f]) => `${n}:${f}`).join(",")}`;

export interface MapLinkOptions {
  privateKey: () => CryptoKey;
  shareLocation: () => boolean;
  // The node this member uses first.
  closestNode: () => number | null;
  // The node a peer is (its user id), or null; nodes are left out of `peers`.
  nodeUser: (peer: string) => number | null;
}

const links = new Map<string, MapLink>();
const [answers, setAnswers] = createStore<Record<string, Record<string, Located & { at: number }>>>({});

export class MapLink {
  private readonly keys = new Map<number, { x: string; y: string }>();
  private readonly sendAsk: ((data: Ask, peer?: string) => void) | null = null;
  private readonly sendAnswer: ((data: Answer, peer?: string) => void) | null = null;
  private readonly directPeers: () => string[];
  private readonly connections: () => Record<string, RTCPeerConnection>;
  // Each connection's byte counters when last read.
  private readonly samples = new Map<string, { sent: number; received: number; at: number }>();
  private readonly cleanups: (() => void)[] = [];

  constructor(private readonly workspaceId: string, private readonly ledger: Ledger, sync: WorkspaceSync, private readonly options: MapLinkOptions) {
    links.set(workspaceId, this);
    // Replaced, not merged: a store merges `{}`, so a workspace opened again kept the last link's answers.
    setAnswers(workspaceId, reconcile({}));
    const mesh = sync.mesh;
    this.directPeers = () => mesh?.directPeers() ?? [];
    this.connections = () => sync.room?.getPeers() ?? {};
    if (!mesh) return;
    this.sendAsk = mesh.channel<Ask>("map-ask", (m, peer) => void this.onAsk(m, peer).catch((e) => console.warn("Map request not answered:", e)));
    this.sendAnswer = mesh.channel<Answer>("map-place", (m, peer) => void this.onAnswer(m, peer));
    this.cleanups.push(mesh.onPeers(() => {}, (peer) => setAnswers(workspaceId, peer, undefined!)));
  }

  close(): void {
    this.cleanups.forEach((cleanup) => cleanup());
    if (links.get(this.workspaceId) === this) links.delete(this.workspaceId);
  }

  async ask(): Promise<void> {
    if (!this.sendAsk) return;
    const base = { user: this.ledger.me, time: Date.now() };
    this.sendAsk({ ...base, sig: await sign(this.options.privateKey(), askText(this.workspaceId, selfId, base)) });
    const now = Date.now();
    for (const [peer, a] of Object.entries(answers[this.workspaceId] ?? {})) if (now - a.at > keepMs) setAnswers(this.workspaceId, peer, undefined!);
  }

  // This member as an answer would describe it, for showing yourself; null when not sharing.
  async self(): Promise<Located | null> {
    if (!this.options.shareLocation()) return null;
    const place = await ownPlace();
    return place && { place, user: this.ledger.me, via: this.options.closestNode(), peer: selfId, peers: this.peers(), ...(await this.traffic()) };
  }

  private peers() {
    return this.directPeers().filter((peer) => this.options.nodeUser(peer) === null);
  }

  // Connections that moved more than `activeBytesPerSecond` since the counters were last read.
  private async traffic(): Promise<Traffic> {
    const now = performance.now();
    const result: Traffic = { active: [], nodes: [] };
    for (const [peer, connection] of Object.entries(this.connections())) {
      let sent = 0;
      let received = 0;
      try {
        (await connection.getStats()).forEach((s: { type: string; bytesSent?: number; bytesReceived?: number }) => {
          if (s.type !== "transport") return;
          sent += s.bytesSent ?? 0;
          received += s.bytesReceived ?? 0;
        });
      } catch {
        continue;
      }
      const before = this.samples.get(peer);
      this.samples.set(peer, { sent, received, at: now });
      const seconds = before ? (now - before.at) / 1000 : 0;
      if (!before || seconds <= 0) continue;
      const out = (sent - before.sent) / seconds > activeBytesPerSecond;
      const into = (received - before.received) / seconds > activeBytesPerSecond;
      if (!out && !into) continue;
      const flow: Flow = out && into ? 0 : out ? 1 : -1;
      const node = this.options.nodeUser(peer);
      if (node === null) result.active.push([peer, flow]);
      else result.nodes.push([node, flow]);
    }
    for (const peer of this.samples.keys()) if (!(peer in this.connections())) this.samples.delete(peer);
    return result;
  }

  private async onAsk(m: Ask, peer: string) {
    if (!fresh(m?.time) || typeof m.user !== "number") return;
    if (!(await verifySigned(this.keyOf(m.user), askText(this.workspaceId, peer, m), m.sig))) return;
    if (!standing(roleTables(this.ledger), m.user, this.ledger.owner).permissions.has("manage_nodes")) return;
    const place = this.options.shareLocation() ? await ownPlace().catch(() => null) : null;
    const base = { user: this.ledger.me, time: Date.now(), place, via: this.options.closestNode(), peers: this.peers(), ...(await this.traffic()) };
    this.sendAnswer?.({ ...base, sig: await sign(this.options.privateKey(), answerText(this.workspaceId, selfId, base)) }, peer);
  }

  private async onAnswer(m: Answer, peer: string) {
    if (!fresh(m?.time) || typeof m.user !== "number" || m.place === undefined || !Array.isArray(m.peers)) return;
    if (m.place !== null && (typeof m.place.lat !== "number" || typeof m.place.lon !== "number" || typeof m.place.country !== "string")) return;
    if (!(await verifySigned(this.keyOf(m.user), answerText(this.workspaceId, peer, m), m.sig))) return;
    if (!Array.isArray(m.active) || !Array.isArray(m.nodes)) return;
    setAnswers(this.workspaceId, peer, {
      user: m.user, place: m.place, via: typeof m.via === "number" ? m.via : null, peer,
      peers: m.peers.filter((p) => typeof p === "string").slice(0, 200), active: m.active.filter(isFlowPair).slice(0, 200),
      nodes: m.nodes.filter(isFlowPair).slice(0, 50), at: Date.now(),
    });
  }

  // A member's key, from their signed commits.
  private keyOf(user: number): { x: string; y: string } | null {
    const known = this.keys.get(user);
    if (known) return known;
    for (const { commit } of this.ledger.log()) if (userNumberOf(commit.author) === user) this.keys.set(user, commit.key);
    return this.keys.get(user) ?? null;
  }
}

function isFlowPair<T extends string | number>(pair: unknown): pair is [T, Flow] {
  return Array.isArray(pair) && pair.length === 2 && (typeof pair[0] === "string" || typeof pair[0] === "number") && [1, -1, 0].includes(pair[1]);
}

function roleTables(ledger: Ledger) {
  return roleTablesFrom((plugin, table) => ledger.select(plugin, table, {}));
}

// This device's time zone's place; the table is loaded on first use. Also picks the nearest node group (sync.ts).
export async function ownPlace(): Promise<MapPlace | null> {
  const { zonePlaces, zoneLinks } = await import("../core/timeZonePlaces");
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const found = zonePlaces[zone] ?? zonePlaces[zoneLinks[zone] ?? ""];
  if (!found) return null;
  const [lat, lon, code] = found;
  let country = code;
  try {
    country = new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    // The code is shown.
  }
  return { lat, lon, country };
}

// Per peer, with when each came (`at`): one member can answer from several (shell/globeMembers.ts draws them once).
export function mapAnswers(workspaceId: string): (Located & { at: number })[] {
  return Object.values(answers[workspaceId] ?? {});
}

// This device's peer id, which other members' answers name among their peers.
export function ownPeer(): string {
  return selfId;
}

export function askMap(workspaceId: string): void {
  void links.get(workspaceId)?.ask().catch((e) => console.warn("Member map not asked:", e));
}

export function mapSelf(workspaceId: string): Promise<Located | null> {
  return links.get(workspaceId)?.self() ?? Promise.resolve(null);
}
