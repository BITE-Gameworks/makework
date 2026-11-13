// How nodes store a big file (20 GiB and more, files of hundreds of GB): in 4 MiB pieces spread over the nodes (RAID 10
// style: each piece on `copies` nodes, placed like whole files, p2p/placement.ts), or with parity (RAID 4/5 style: each
// piece on one node, plus one parity piece per group of `parity` pieces, the XOR of the group, kept by a node holding
// none of them). A piece whose nodes are all gone is rebuilt from the rest of its group and the parity piece. No node
// ever holds the whole file: nodes take their pieces from the uploader as byte ranges and serve members piece by piece
// (node/host.ts). Members never see pieces and check the whole file's SHA-256 as always; nodes check each piece
// against the file's piece list (its SHA-256 per piece, made by the uploader, `nodes_pieces`).
import { chunkSize } from "../core/stream";
import { holders, rank, type PlacedNode } from "./placement";

export const pieceSize = chunkSize;

// The workspace's storage settings (nodes_settings): copies of each whole file or piece; files over `stripeBytes` are
// split into pieces (0: never); `parity` pieces per parity piece (0: copies instead).
export type Storage = { copies: number; stripeBytes: number; parity: number };

// Nothing under 20 GiB is split: smaller files are kept whole by `copies` nodes. Tests lower it (`setMinStripeBytes`,
// or MAKEWORK_TEST_MIN_STRIPE_MB for a node), since they can't move files of that size.
const minStripeDefault = 20 * 1024 ** 3;
const envMinMb = Number((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.MAKEWORK_TEST_MIN_STRIPE_MB);
let minStripe = Number.isFinite(envMinMb) && envMinMb > 0 ? envMinMb * 1024 * 1024 : minStripeDefault;
// The largest threshold a workspace can set, in MB (1 TiB).
export const maxStripeMb = 1024 * 1024;

export function minStripeBytes(): number {
  return minStripe;
}

export function minStripeMb(): number {
  return Math.ceil(minStripe / 1024 / 1024);
}

// Tests only. `null`: back to 20 GiB.
export function setMinStripeBytes(bytes: number | null): void {
  minStripe = bytes ?? minStripeDefault;
}

// The threshold for a stored `stripe_mb`: none stored is the minimum, 0 is never, a lower one (rows from before the
// minimum) counts as the minimum.
export function stripeLimit(mb: number | null | undefined): number {
  if (mb === null || mb === undefined || !Number.isFinite(mb)) return minStripe;
  if (mb <= 0) return 0;
  return Math.max(mb * 1024 * 1024, minStripe);
}

export const defaultStorage: Storage = {
  copies: 2,
  get stripeBytes() {
    return minStripe;
  },
  parity: 0,
};

export function striped(size: number | null, storage: Storage): boolean {
  return size !== null && storage.stripeBytes > 0 && size > storage.stripeBytes;
}

export function pieceCount(size: number): number {
  return Math.max(1, Math.ceil(size / pieceSize));
}

// Piece `i` of a file, and parity piece `g` (one per group of `parity` pieces).
export const pieceKey = (hash: string, i: number) => `${hash}:${i}`;
export const parityKey = (hash: string, g: number) => `${hash}:p${g}`;

export type PieceDuty = { key: string; kind: "data" | "parity"; index: number };

// The nodes keeping one data piece. With parity, the pieces of one group go to different nodes where there are enough
// (each to the first in its ranking not taken by an earlier piece of the group): placed one by one, all of a group
// sometimes landed on one node, and losing it lost more of the group than its parity rebuilds (RAID 5 stripes across
// disks for the same reason).
export function dataHolders(hash: string, i: number, nodes: PlacedNode[], storage: Storage): number[] {
  if (storage.parity === 0) return holders(pieceKey(hash, i), nodes, storage.copies);
  const g = groupOf(i, storage);
  const holder = groupHolders(hash, g, (g + 1) * storage.parity, nodes, storage)[i - g * storage.parity];
  return holder === undefined ? [] : [holder];
}

// With parity: the node keeping each data piece of group `g` (up to piece `end`), in one pass.
function groupHolders(hash: string, g: number, end: number, nodes: PlacedNode[], storage: Storage): number[] {
  const taken: number[] = [];
  for (let j = g * storage.parity; j < end; j++) {
    const ranked = holders(pieceKey(hash, j), nodes, nodes.length);
    const pick = ranked.find((user) => !taken.includes(user)) ?? ranked[0];
    if (pick === undefined) return [];
    taken.push(pick);
  }
  return taken;
}

// The node keeping parity piece `g`: the first in its ranking that is there and keeps none of the group's pieces (so
// losing one node never loses a piece and its parity), else the first that is there.
export function parityHolder(hash: string, g: number, size: number, nodes: PlacedNode[], storage: Storage): number | null {
  const here = nodes.filter((n) => !n.gone).map((n) => n.user);
  const group = groupHolders(hash, g, Math.min(pieceCount(size), (g + 1) * storage.parity), nodes, storage);
  const ranked = rank(parityKey(hash, g), here);
  return ranked.find((user) => !group.includes(user)) ?? ranked[0] ?? null;
}

// The data pieces in parity group `g`.
export function groupIndexes(g: number, size: number, storage: Storage): number[] {
  const count = pieceCount(size);
  const out: number[] = [];
  for (let i = g * storage.parity; i < Math.min(count, (g + 1) * storage.parity); i++) out.push(i);
  return out;
}

export const groupOf = (i: number, storage: Storage) => Math.floor(i / storage.parity);

// What one node keeps of a striped file.
export function duties(hash: string, size: number, me: number, nodes: PlacedNode[], storage: Storage): PieceDuty[] {
  const out: PieceDuty[] = [];
  const count = pieceCount(size);
  if (storage.parity === 0) {
    for (let i = 0; i < count; i++)
      if (dataHolders(hash, i, nodes, storage).includes(me)) out.push({ key: pieceKey(hash, i), kind: "data", index: i });
    return out;
  }
  const here = nodes.filter((n) => !n.gone).map((n) => n.user);
  for (let g = 0; g * storage.parity < count; g++) {
    const group = groupHolders(hash, g, Math.min(count, (g + 1) * storage.parity), nodes, storage);
    group.forEach((user, k) => {
      if (user === me) out.push({ key: pieceKey(hash, g * storage.parity + k), kind: "data", index: g * storage.parity + k });
    });
    const ranked = rank(parityKey(hash, g), here);
    if ((ranked.find((user) => !group.includes(user)) ?? ranked[0]) === me) out.push({ key: parityKey(hash, g), kind: "parity", index: g });
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.index - b.index : a.kind === "data" ? -1 : 1));
}

// The length of piece `i` (the last one is shorter).
export function pieceLength(i: number, size: number): number {
  return Math.max(0, Math.min(pieceSize, size - i * pieceSize));
}

// XOR of pieces, each taken as `pieceSize` bytes (shorter ones padded with zeros): the parity of a group, or a lost
// piece from the others and the parity (cut to its own length by the caller).
export function xorPieces(pieces: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(pieceSize));
  for (const piece of pieces) for (let j = 0; j < piece.byteLength; j++) out[j] ^= piece[j];
  return out;
}

// Pointers between nodes (node/host.ts) say which pieces of a file a node has as one bit per slot (data piece i is
// slot i, parity piece g is slot count + g), sent as base64: a list of piece keys ran to megabytes for a big file.
export function slotCount(size: number, storage: Storage): number {
  const count = pieceCount(size);
  return count + (storage.parity > 0 ? Math.ceil(count / storage.parity) : 0);
}

export function slotOf(key: string, hash: string, size: number): number | null {
  const suffix = key.slice(hash.length + 1);
  const n = Number(suffix.startsWith("p") ? suffix.slice(1) : suffix);
  if (!key.startsWith(`${hash}:`) || !Number.isSafeInteger(n) || n < 0) return null;
  return suffix.startsWith("p") ? pieceCount(size) + n : n;
}

export function keyOfSlot(hash: string, slot: number, size: number): string {
  const count = pieceCount(size);
  return slot < count ? pieceKey(hash, slot) : parityKey(hash, slot - count);
}

export function hasBit(bits: Uint8Array | undefined, slot: number): boolean {
  return !!bits && slot >> 3 < bits.length && (bits[slot >> 3] & (1 << (slot & 7))) !== 0;
}

// Sets or clears a bit, growing the bitmap when needed; returns it.
export function setBit(bits: Uint8Array, slot: number, on: boolean): Uint8Array {
  const out = slot >> 3 < bits.length ? bits : (() => {
    const grown = new Uint8Array((slot >> 3) + 1);
    grown.set(bits);
    return grown;
  })();
  if (on) out[slot >> 3] |= 1 << (slot & 7);
  else out[slot >> 3] &= ~(1 << (slot & 7));
  return out;
}

export function bitsToBase64(bits: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bits.length; i += 0x8000) text += String.fromCharCode(...bits.subarray(i, i + 0x8000));
  return btoa(text);
}

export function bitsFromBase64(text: string): Uint8Array | null {
  try {
    const raw = atob(text);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// A piece list: the SHA-256 of each piece of a file, one after the other (32 bytes each, 2.4 MB for 300 GB), kept as
// content of its own and named in `nodes_pieces` (made by core/stream.ts `storeFile` while the file is copied in).
export const digestBytes = 32;

export async function digestOf(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

// Whether piece `i` matches its entry in the list (a list too short for it doesn't match).
export async function matchesList(list: Uint8Array, i: number, bytes: Uint8Array<ArrayBuffer>): Promise<boolean> {
  if ((i + 1) * digestBytes > list.length) return false;
  const digest = await digestOf(bytes);
  for (let k = 0; k < digestBytes; k++) if (digest[k] !== list[i * digestBytes + k]) return false;
  return true;
}
