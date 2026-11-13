// Signed commits: every change to a serverless workspace is one commit, signed with its author's account key, so
// each member can check who made it and whether they were allowed to. All members order commits the same way
// (lamport clock, then author, replica and seq), so replaying them gives every copy the same state.
import type { ApiValue } from "../api/types";
import { accountId, base64url, fromBase64url } from "../core/identity";
import { compareText } from "../core/text";

export interface Op {
  ext: string;
  table: string;
  kind: "insert" | "update" | "delete";
  id: number;
  // Insert: every column. Update: the changed columns.
  values?: Record<string, ApiValue>;
}

export interface SnapshotRef {
  version: 1;
  index: number;
  hash: string;
  genesisHash: string;
  order: { clock: number; author: string; replica: string; seq: number };
  vector: Record<string, number>;
  content: string;
  archiveContent?: string;
}

export interface UnsignedCommit {
  // The workspace id; empty in the genesis commit, whose hash is the workspace id.
  server: string;
  author: string;
  key: { x: string; y: string };
  // One device's copy; seq counts that replica's commits from 0.
  replica: string;
  seq: number;
  clock: number;
  time: number;
  action: string;
  ops: Op[];
  snapshot?: SnapshotRef;
  // The bot a host's commit is made for; checked by the bot's roles (p2p/ledger.ts).
  as?: number;
}

export interface Commit extends UnsignedCommit {
  sig: string;
  hash: string;
}

export const genesisAction = "workspace.create";
// 7 (2026-10-16): nodes added by a member without an invite, invite joins as rows (members_invite_joins), public
// invites and per-invite rooms. Older apps would refuse those commits one by one, so peers on 6 don't sync with 7.
// 8 (2026-10-16): commits made by a host for its bot carry `as`; older apps would judge them as the host.
// 9 (2026-10-18): permanently deleting a closed invite (revoked, expired or used up); older apps would refuse
// those delete commits.
// 10 (2026-11-03): members' keys in their profiles; older apps would refuse those columns.
export const logVersion = 10;

// Old signed commits keep their original names and hashes; map them only for replay.
export function replayCommit(commit: Commit): Commit {
  const action = commit.action === "server.create" ? "workspace.create"
    : commit.action === "server.import" ? "workspace.import"
      : commit.action === "members.set-server-profile" ? "members.set-workspace-profile" : commit.action;
  let changed = action !== commit.action;
  const ops = commit.ops.map((op) => {
    const ext = op.ext === "ref_sheet" ? "artboard" : op.ext;
    const table = op.ext === "channels" && op.table === "channels_server" ? "channels_workspace"
      : op.table.startsWith("ref_sheet_") ? `artboard_${op.table.slice("ref_sheet_".length)}` : op.table;
    let values = op.values;
    if (op.ext === "channels" && op.table === "channels_channels" && op.values?.type === "ref_sheet") {
      values = { ...op.values, type: "artboard" };
    }
    if (ext === op.ext && table === op.table && values === op.values) return op;
    changed = true;
    return { ...op, ext, table, values };
  });
  return changed ? { ...commit, action, ops } : commit;
}

// JSON with object keys sorted, so the signed text doesn't depend on how a peer built the object.
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => compareText(a, b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

// Only the known fields count, so extra fields a peer adds can't change what was signed.
function signedText(c: UnsignedCommit): string {
  return canonical({
    server: c.server, author: c.author, key: { x: c.key.x, y: c.key.y }, replica: c.replica, seq: c.seq,
    clock: c.clock, time: c.time, action: c.action, ops: c.ops, snapshot: c.snapshot, as: c.as,
  });
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function commitHash(text: string, sig: string): Promise<string> {
  return base64url(await sha256(`${text}.${sig}`));
}

export async function signCommit(commit: UnsignedCommit, privateKey: CryptoKey): Promise<Commit> {
  const text = signedText(commit);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(text));
  const sig = base64url(new Uint8Array(signature));
  return { ...commit, sig, hash: await commitHash(text, sig) };
}

const keys = new Map<string, Promise<CryptoKey>>();

function importKey(key: { x: string; y: string }): Promise<CryptoKey> {
  const id = `${key.x}:${key.y}`;
  let imported = keys.get(id);
  if (!imported) {
    imported = crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: key.x, y: key.y }, { name: "ECDSA", namedCurve: "P-256" },
      false, ["verify"]);
    keys.set(id, imported);
  }
  return imported;
}

const authors = new Map<string, Promise<string>>();

function authorOf(key: { x: string; y: string }): Promise<string> {
  const id = `${key.x}:${key.y}`;
  let author = authors.get(id);
  if (!author) {
    author = accountId({ crv: "P-256", x: key.x, y: key.y });
    authors.set(id, author);
  }
  return author;
}

// A commit from a peer, checked: well formed, the key belongs to the author, the signature matches. The hash is
// always computed here, never taken from the peer.
export async function verifyCommit(raw: unknown): Promise<Commit | null> {
  if (!isCommitShape(raw)) return null;
  try {
    if ((await authorOf(raw.key)) !== raw.author) return null;
    const text = signedText(raw);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await importKey(raw.key),
      fromBase64url(raw.sig), new TextEncoder().encode(text));
    if (!ok) return null;
    const { server, author, key, replica, seq, clock, time, action, ops, snapshot, sig } = raw;
    const as = typeof raw.as === "number" && Number.isSafeInteger(raw.as) ? raw.as : undefined;
    return { server, author, key: { x: key.x, y: key.y }, replica, seq, clock, time, action, ops, snapshot, ...(as !== undefined ? { as } : {}), sig, hash: await commitHash(text, sig) };
  } catch {
    return null;
  }
}

// What goes over the wire and into storage: the commit without its hash.
export function wire(commit: Commit): Omit<Commit, "hash"> {
  const { hash: _, ...rest } = commit;
  return rest;
}

export async function workspaceIdOf(genesis: Commit): Promise<string> {
  return base64url(fromBase64url(genesis.hash).slice(0, 16));
}

export function compareCommits(a: Commit, b: Commit): number {
  return a.clock - b.clock || compareText(a.author, b.author) || compareText(a.replica, b.replica) || a.seq - b.seq
    || compareText(a.hash, b.hash);
}

// A member's user id inside every workspace: the first 6 bytes of the account id.
export function userNumberOf(author: string): number {
  return fromBase64url(author).slice(0, 6).reduce((n, byte) => n * 256 + byte, 0);
}

const opKinds = new Set(["insert", "update", "delete"]);

function isCommitShape(raw: unknown): raw is Omit<Commit, "hash"> {
  if (typeof raw !== "object" || raw === null) return false;
  const c = raw as Record<string, unknown>;
  const key = c.key as Record<string, unknown> | null;
  return typeof c.server === "string" && typeof c.author === "string" && typeof c.replica === "string"
    && typeof c.action === "string" && typeof c.sig === "string"
    && Number.isSafeInteger(c.seq) && (c.seq as number) >= 0 && Number.isSafeInteger(c.clock) && (c.clock as number) >= 0
    && typeof c.time === "number" && Number.isFinite(c.time)
    && typeof key === "object" && key !== null && typeof key.x === "string" && typeof key.y === "string"
    && Array.isArray(c.ops) && c.ops.every(isOpShape)
    && (c.snapshot === undefined || isSnapshotRef(c.snapshot));
}

function isSnapshotRef(raw: unknown): raw is SnapshotRef {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const snapshot = raw as Record<string, unknown>;
  const vector = snapshot.vector;
  return snapshot.version === 1 && Number.isSafeInteger(snapshot.index) && (snapshot.index as number) > 0
    && typeof snapshot.hash === "string" && snapshot.hash.length > 0
    && typeof snapshot.genesisHash === "string" && snapshot.genesisHash.length > 0
    && !!snapshot.order && typeof snapshot.order === "object" && !Array.isArray(snapshot.order)
    && Number.isSafeInteger((snapshot.order as Record<string, unknown>).clock)
    && ((snapshot.order as Record<string, number>).clock >= 0)
    && typeof (snapshot.order as Record<string, unknown>).author === "string"
    && typeof (snapshot.order as Record<string, unknown>).replica === "string"
    && Number.isSafeInteger((snapshot.order as Record<string, unknown>).seq)
    && ((snapshot.order as Record<string, number>).seq >= 0)
    && typeof snapshot.content === "string" && /^mwc:[0-9a-f]{64}$/.test(snapshot.content)
    && (snapshot.archiveContent === undefined
      || (typeof snapshot.archiveContent === "string" && /^mwc:[0-9a-f]{64}$/.test(snapshot.archiveContent)))
    && !!vector && typeof vector === "object" && !Array.isArray(vector)
    && Object.entries(vector).every(([replica, seq]) => replica.length > 0 && Number.isSafeInteger(seq) && (seq as number) >= 0);
}

function isOpShape(raw: unknown): raw is Op {
  if (typeof raw !== "object" || raw === null) return false;
  const op = raw as Record<string, unknown>;
  if (typeof op.ext !== "string" || typeof op.table !== "string" || !opKinds.has(op.kind as string)) return false;
  if (!Number.isSafeInteger(op.id)) return false;
  if (op.values === undefined) return op.kind === "delete";
  if (typeof op.values !== "object" || op.values === null || Array.isArray(op.values)) return false;
  return Object.values(op.values).every((v) => v === null || ["string", "number", "boolean"].includes(typeof v));
}
