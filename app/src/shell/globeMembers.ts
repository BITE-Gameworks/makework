// The Nodes page globe's members: one per member, however many peers they answer from (two copies of the app, a view
// window, a browser tab, a session replaced by a restart that hasn't left the map yet). Map answers come per peer
// (p2p/memberMap.ts); drawn per peer, 3 people showed as 8 dots. Pure, so it is tested without a canvas
// (tests/shell/globeMembers.test.ts).
import type { Flow, Located, MapPlace } from "../p2p/memberMap";

// A map answer and when it came; this device's own has none and counts as the newest.
export type Answer = Located & { at?: number };

export interface GlobeMember {
  user: number;
  // From the member's newest answer with a place, and its primary node.
  place: MapPlace;
  via: number | null;
  // How many of their peers answered lately (at least 1).
  devices: number;
  // The signed-in member.
  self: boolean;
}

// Two members connected directly by any of their peers. `from` is the lower user id; `flow` is seen from `from` (1 it
// sends, -1 it receives, 0 both), undefined while idle.
export interface MemberLine {
  from: number;
  to: number;
  flow?: Flow;
}

// A member and a node any of their peers uses first or exchanges data with (`flow` seen from the member).
export interface NodeLine {
  user: number;
  node: number;
  flow?: Flow;
}

export interface GlobeInput {
  // The signed-in member (null while not known yet: then `self`'s user), and this device's peer id.
  me: number | null;
  ownPeer: string;
  // This device's own answer; null when it doesn't share its place.
  self: Located | null;
  answers: Answer[];
  // A peer counts as one of a member's devices while it answered within `recentMs` of `now`: a session a restart
  // replaced stays among the answers until the mesh reports it gone or it expires (p2p/memberMap.ts).
  now: number;
  recentMs: number;
}

export function globeMembers({ me, ownPeer, self, answers, now, recentMs }: GlobeInput): {
  members: GlobeMember[]; memberLines: MemberLine[]; nodeLines: NodeLine[];
} {
  const signedIn = me ?? self?.user ?? null;
  const all = self ? [self, ...answers] : answers;
  const byUser = new Map<number, Answer[]>();
  for (const a of all) (byUser.get(a.user) ?? byUser.set(a.user, []).get(a.user)!).push(a);
  const members: GlobeMember[] = [];
  for (const [user, list] of byUser) {
    const placed = list.filter((a): a is Answer & { place: MapPlace } => a.place !== null);
    const newest = placed.reduce<(Answer & { place: MapPlace }) | null>((best, a) => (!best || (a.at ?? Infinity) > (best.at ?? Infinity) ? a : best), null);
    if (!newest) continue;
    const devices = new Set(list.filter((a) => a.at === undefined || now - a.at <= recentMs).map((a) => a.peer)).size;
    members.push({ user, place: newest.place, via: newest.via, devices: Math.max(1, devices), self: user === signedIn });
  }
  const onGlobe = new Set(members.map((m) => m.user));
  // Whose each peer is: every answer's, and this device's own even when it sent none (it doesn't share its place).
  const owner = new Map(all.map((a) => [a.peer, a.user]));
  if (signedIn !== null && !owner.has(ownPeer)) owner.set(ownPeer, signedIn);

  // A line for every pair of members on the globe that one of their peers says is connected. Its flow is what the
  // `from` member's peers report, else what the other side's report, turned round (each side measures its own
  // counters, so they rarely agree exactly).
  const lines = new Map<string, MemberLine & { theirs?: Flow }>();
  const lineFor = (user: number, peer: string, add: boolean) => {
    const other = owner.get(peer);
    if (other === undefined || other === user || !onGlobe.has(user) || !onGlobe.has(other)) return null;
    const from = Math.min(user, other);
    const key = `${from} ${Math.max(user, other)}`;
    if (add && !lines.has(key)) lines.set(key, { from, to: Math.max(user, other) });
    return lines.get(key) ?? null;
  };
  for (const a of all) for (const peer of a.peers) lineFor(a.user, peer, true);
  for (const a of all)
    for (const [peer, flow] of a.active) {
      const line = lineFor(a.user, peer, false);
      if (!line) continue;
      if (a.user === line.from) line.flow = combined(line.flow, flow);
      else line.theirs = combined(line.theirs, turned(flow));
    }
  const memberLines = [...lines.values()].map(({ theirs, ...line }): MemberLine => {
    const flow = line.flow ?? theirs;
    return flow === undefined ? { from: line.from, to: line.to } : { from: line.from, to: line.to, flow };
  });

  const nodeLines = new Map<string, NodeLine>();
  for (const m of members)
    for (const a of byUser.get(m.user)!) {
      const reported: [number, Flow | undefined][] = [...(a.via === null ? [] : [[a.via, undefined] as [number, undefined]]), ...a.nodes];
      for (const [node, flow] of reported) {
        const key = `${m.user} ${node}`;
        const line = nodeLines.get(key) ?? nodeLines.set(key, { user: m.user, node }).get(key)!;
        const next = combined(line.flow, flow);
        if (next !== undefined) line.flow = next;
      }
    }
  return { members, memberLines, nodeLines: [...nodeLines.values()] };
}

function turned(flow: Flow): Flow {
  return flow === 0 ? 0 : (-flow as Flow);
}

// Flows one side's peers report: the same one stays, different ones are both ways.
function combined(a: Flow | undefined, b: Flow | undefined): Flow | undefined {
  if (a === undefined) return b;
  if (b === undefined || a === b) return a;
  return 0;
}
