// Where the globe draws crowds: members of one time zone all have the same place, so each point of a place gets a
// slot of its own around it, scattered like a sunflower's seeds (stable for the same points, at least a step apart
// on screen). A place keeps to a disk that never reaches its neighbours'; members who don't fit there are counted
// in a crowd badge instead. Pure, so it is tested without a canvas (tests/shell/globeSpread.test.ts).

export interface SpreadPoint {
  key: string;
  lon: number;
  lat: number;
  kind: "node" | "member";
  self?: boolean;
}

export interface Place<P extends SpreadPoint = SpreadPoint> {
  lon: number;
  lat: number;
  // In slot order: the signed-in member, nodes, then the others by their key's hash.
  items: P[];
}

// Points this close (degrees) are one place: time zone places are cities, nodes' are rough addresses.
const sameSpotDeg = 0.25;

// FNV-1a with murmur3's final mix (FNV alone kept keys with the same start together): a stable number from a key,
// so the same member keeps its slot.
export function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

const rank = (p: SpreadPoint) => (p.self ? 0 : p.kind === "node" ? 1 : 2);
export const slotOrder = (a: SpreadPoint, b: SpreadPoint) => rank(a) - rank(b) || hash(a.key) - hash(b.key) || (a.key < b.key ? -1 : 1);

export function groupPlaces<P extends SpreadPoint>(points: readonly P[]): Place<P>[] {
  const places: Place<P>[] = [];
  for (const point of points) {
    const place = places.find((p) => Math.abs(p.lat - point.lat) < sameSpotDeg && Math.abs(((p.lon - point.lon + 540) % 360) - 180) < sameSpotDeg);
    if (place) place.items.push(point);
    else places.push({ lon: point.lon, lat: point.lat, items: [point] });
  }
  for (const place of places) place.items.sort(slotOrder);
  return places;
}

const goldenAngle = Math.PI * (3 - Math.sqrt(5));
// Slot `i`'s distance from the middle is `spacing · step · √(i + 0.5)`: the sunflower's seeds are then at least about
// a step apart. Each slot is nudged by up to `nudge` of that, so a crowd looks scattered, not drawn by a compass.
const spacing = 0.65;
const nudge = 0.12;

// Where slot `i` of a place sits, from the place's middle (screen px). `seed` turns the whole pattern, so
// neighbouring places don't look stamped from one mould.
export function slot(i: number, step: number, seed: number): [number, number] {
  const unit = spacing * step;
  const angle = i * goldenAngle + (seed % 3600) / 10 * (Math.PI / 180);
  const r = unit * Math.sqrt(i + 0.5);
  const wobble = hash(`${seed}:${i}`);
  const nudgeAngle = ((wobble & 0xffff) / 0x10000) * Math.PI * 2;
  const nudgeBy = unit * nudge * ((wobble >>> 16) / 0x10000);
  return [r * Math.cos(angle) + nudgeBy * Math.cos(nudgeAngle), r * Math.sin(angle) + nudgeBy * Math.sin(nudgeAngle)];
}

// How many slots fit in a disk of `radius`, nudge included; at least the middle one.
export function capacity(radius: number, step: number): number {
  const unit = spacing * step;
  return Math.max(1, Math.floor(((radius - unit * nudge) / unit) ** 2 - 0.5 + 1e-9) + 1);
}

// The disk `count` slots need (a lone point sits on its place).
function needed(count: number, step: number): number {
  const unit = spacing * step;
  return count <= 1 ? 0 : unit * (Math.sqrt(count - 0.5) + nudge);
}

// How far crowd `a` may spread with `b` at `distance`: a step is left between their disks, a crowd needing at most
// half the room takes what it needs and leaves the rest to the other, two bigger ones take half each.
function share(a: number, b: number, distance: number, step: number): number {
  const room = Math.max(0, distance - step);
  const needA = needed(a, step);
  const needB = needed(b, step);
  if (needA + needB <= room || needA <= room / 2) return needA;
  return needB <= room / 2 ? room - needB : room / 2;
}

// Members of a crowd who don't fit, drawn as one "+N" badge in the crowd's last slot.
export interface CrowdBadge {
  // Stays the same while the crowd's first place does: the crowd card follows it.
  id: string;
  at: [number, number];
  keys: string[];
}

export interface Spread {
  // Points drawn as themselves.
  spots: Map<string, [number, number]>;
  // Where each point's lines end: its spot, or its crowd's badge.
  ends: Map<string, [number, number]>;
  badges: CrowdBadge[];
}

// Lays out the places on the near side, `at` their projected middle (screen px). `step` is the least distance between
// two points, `maxRadius` how far a crowd may spread (it grows with the zoom, so zooming in shows more of it). Places
// closer than two steps make one crowd, and so do crowds closer than four, around their middle (two disks that small
// would show hardly anyone); a lone point (a node) is never moved for that. The others keep to disks that leave a
// step between neighbours (`share`).
export function layout<P extends SpreadPoint>(
  places: readonly { place: Place<P>; at: [number, number] }[], options: { step: number; maxRadius: number },
): Spread {
  const { step, maxRadius } = options;
  const crowds = places.map(({ place, at }) => {
    const id = `${place.lon},${place.lat}`;
    return { id, seed: hash(id), at, items: place.items };
  });
  // Joined until no two are close enough: a joined crowd's middle moves, maybe near one that stayed apart before.
  const joins = (a: (typeof crowds)[number], b: (typeof crowds)[number]) => {
    const distance = Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1]);
    return distance < step * 2 || (distance < step * 4 && a.items.length > 1 && b.items.length > 1);
  };
  // Joins the first pair that is close enough; false when none is.
  const joinOne = () => {
    for (let i = 0; i < crowds.length; i++) {
      for (let j = i + 1; j < crowds.length; j++) {
        const [crowd, other] = [crowds[i], crowds[j]];
        if (!joins(crowd, other)) continue;
        const [a, b] = [crowd.items.length, other.items.length];
        crowd.at = [(crowd.at[0] * a + other.at[0] * b) / (a + b), (crowd.at[1] * a + other.at[1] * b) / (a + b)];
        crowd.items = [...crowd.items, ...other.items].sort(slotOrder);
        crowds.splice(j, 1);
        return true;
      }
    }
    return false;
  };
  // A joined crowd's middle moved: everything is looked at again.
  let joined = joinOne();
  while (joined) joined = joinOne();
  const spread: Spread = { spots: new Map(), ends: new Map(), badges: [] };
  for (const crowd of crowds) {
    const [x, y] = crowd.at;
    if (crowd.items.length === 1) {
      spread.spots.set(crowd.items[0].key, crowd.at);
      spread.ends.set(crowd.items[0].key, crowd.at);
      continue;
    }
    let radius = maxRadius;
    for (const other of crowds) {
      if (other !== crowd) radius = Math.min(radius, share(crowd.items.length, other.items.length, Math.hypot(other.at[0] - x, other.at[1] - y), step));
    }
    const room = capacity(radius, step);
    // The signed-in member and nodes always get a slot.
    const kept = crowd.items.filter((p) => p.self || p.kind === "node").length;
    const shown = crowd.items.length <= room ? crowd.items.length : Math.max(room - 1, kept);
    crowd.items.forEach((point, i) => {
      if (i >= shown) return;
      const [dx, dy] = slot(i, step, crowd.seed);
      const spot: [number, number] = [x + dx, y + dy];
      spread.spots.set(point.key, spot);
      spread.ends.set(point.key, spot);
    });
    if (shown === crowd.items.length) continue;
    const [dx, dy] = slot(shown, step, crowd.seed);
    const badge: CrowdBadge = { id: crowd.id, at: [x + dx, y + dy], keys: crowd.items.slice(shown).map((p) => p.key) };
    for (const key of badge.keys) spread.ends.set(key, badge.at);
    spread.badges.push(badge);
  }
  return spread;
}
