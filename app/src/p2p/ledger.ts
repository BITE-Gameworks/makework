// A serverless workspace's data as a log of signed commits. The tables are what replaying every accepted commit in
// order gives; a commit is accepted when its author was allowed to make all of its changes at that point (policy).
// Local writes are checked and applied right away, then signed, stored and sent. A commit from a peer that sorts
// before ones already applied makes the log replay from that point, so every member ends up with the same tables.
// Replays start at the closest checkpoint before the late commit (tables kept every 256 commits, thinned out with
// age; a durable copy is written every 2,048 commits while idle and on close). Late commits arriving within
// `coalesceMs` replay once: replaying the whole log each time cost about 105 ms per late commit at 3,000 commits and
// held chat messages back by seconds (mesh-test NODES-REPORT.md, F1).
import type { ApiValue, ServerEvent } from "../api/types";
import { MockBackend, type Services } from "../system/backend";
import { MockPluginData, convertValues, notOwned, requireWhere, type PluginStore, type JsonRow, type MockManifest, type Values } from "../system/data";
import { AccessDenied } from "../system/errors";
import { identifier, toJson } from "../system/values";
import { sign } from "../core/identity";
import { compareText } from "../core/text";
import {
  canonical, compareCommits, genesisAction, replayCommit, workspaceIdOf, signCommit, userNumberOf, verifyCommit,
  type Commit, type Op, type SnapshotRef, type UnsignedCommit,
} from "./log";

export interface Signer {
  author: string;
  key: { x: string; y: string };
  privateKey: CryptoKey;
  replica: string;
}

export type SnapshotLoader = (ref: SnapshotRef) => Promise<StoredCheckpoint | null>;

interface AcceptedSnapshot {
  commit: Commit;
  index: number;
  ref: SnapshotRef;
}

export interface HistoryNotice {
  kind: "rejected" | "overwritten";
  commit: Commit;
  by?: Commit;
  fields: string[];
  channelId: number | null;
  reason?: string;
}

// Why a change is not allowed, or null when it is.
export type Policy = (context: PolicyContext) => string | null;

export interface PolicyContext {
  author: number;
  owner: number;
  action: string;
  op: Op;
  before: JsonRow | null;
  after: JsonRow | null;
  // The commit's signed time. A rule that depends on time (an invite's expiry) reads this, never the clock, so
  // every member replays the same commit to the same verdict.
  time: number;
  rows(ext: string, table: string, where?: Record<string, ApiValue>): JsonRow[];
  creator(ext: string, table: string, id: number): number | null;
}

export interface CommitStore {
  load(workspaceId: string): Promise<Commit[]>;
  add(workspaceId: string, commits: Commit[]): Promise<void>;
  compact?(workspaceId: string, hashes: string[]): Promise<void>;
  loadCheckpoint?(workspaceId: string): Promise<StoredCheckpoint | null>;
  saveCheckpoint?(workspaceId: string, checkpoint: StoredCheckpoint): Promise<void>;
  deleteCheckpoint?(workspaceId: string): Promise<void>;
}

interface RowState {
  values: Record<string, ApiValue>;
  creator: number;
}

type Tables = Map<string, Map<number, RowState>>;
type Change = ServerEvent["change"];
type Changes = Map<string, Map<number, Change>>;

interface Pending {
  action: string;
  // The time of the commit this request will become: taken once when the request starts, so the policy check this
  // device runs and the policy checks every member replays later see the same instant.
  time: number;
  ops: Op[];
  undo: { key: string; id: number; previous: RowState | undefined }[];
  changed: Changes;
  snapshot?: { ref: SnapshotRef; state: StoredCheckpoint };
  // The bot these changes are made for (the commit's `as`).
  as?: number;
}

// The tables after applying the first `index` commits. Rows are replaced on every change, never changed in place,
// so a copy of each table's map is enough.
interface Checkpoint {
  index: number;
  tables: Tables;
  genesis: Commit | null;
}

export interface StoredCheckpoint {
  version: 1;
  index: number;
  hash: string;
  genesisHash: string;
  tables: [string, [number, RowState][]][];
  rejected: [string, string][];
}

const checkpointEvery = 256;
const persistCheckpointEvery = 2048;
const coalesceMs = 20;

// Checkpoints near the end are dense, older ones sparse: the last few at 256, 1,024 and 4,096 commits apart, then
// every 16,384th. Late commits usually land near the end (their clocks are recent).
function keepCheckpoint(index: number, newest: number): boolean {
  const age = newest - index;
  return age <= 2 * checkpointEvery || (index % 1024 === 0 && age <= 2 * 1024) || (index % 4096 === 0 && age <= 2 * 4096)
    || index % 16384 === 0;
}

const copyTables = (tables: Tables): Tables => new Map([...tables].map(([key, rows]) => [key, new Map(rows)]));

// Ids are unique without coordination and roughly in creation order: milliseconds times 2048 plus a random
// part, counting up within this client. That stays below 2^53 until the year 2109.
let lastId = 0;
export function newRowId(): number {
  lastId = Math.max(Date.now() * 2048 + Math.floor(Math.random() * 2048), lastId + 1);
  return lastId;
}

const tableKey = (ext: string, table: string) => `${ext}/${table}`;
const rowExists = (id: number) => `Row ${id} already exists.`;

function snapshotPrefixHas(ref: SnapshotRef, commit: Commit): boolean {
  return commit.seq <= (ref.vector[commit.replica] ?? -1);
}

function compareWithCutoff(ref: SnapshotRef, commit: Commit): number {
  return commit.clock - ref.order.clock || compareText(commit.author, ref.order.author)
    || compareText(commit.replica, ref.order.replica) || commit.seq - ref.order.seq || compareText(commit.hash, ref.hash);
}

// Where a row of a commit refused for an id clash goes when the commit is written again: the same millisecond (so
// the row keeps its place in creation order), another random part, following from `seed` so a restart gets the same.
function movedId(id: number, seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  return Math.floor(id / 2048) * 2048 + ((id % 2048) + 1 + (h % 2047)) % 2048;
}

// An op with the rows its commit inserted moved to new ids: its own id, and values pointing at one (an attachment's
// message_id).
function movedOp(op: Op, moved: Map<number, number>): Op {
  const id = moved.get(op.id) ?? op.id;
  if (!op.values) return { ...op, id };
  const values = Object.fromEntries(Object.entries(op.values).map(([k, v]) => [k, typeof v === "number" ? moved.get(v) ?? v : v]));
  return { ...op, id, values };
}

// An op's values checked against its columns, or why they don't fit. The result doesn't depend on the tables, so
// replays reuse it instead of checking every value again.
const checked = new WeakMap<Op, { values: Record<string, ApiValue> } | { error: string }>();

export class Ledger {
  private readonly manifests = new Map<string, MockManifest>();
  private readonly commits: Commit[] = [];
  private readonly hashes = new Set<string>();
  // Signatures of the commits in the log, and of received ones still being checked and stored (see `accept`).
  private readonly sigs = new Set<string>();
  private readonly inflight = new Set<string>();
  // Resolves when the batch received before has been stored and applied (see `accept`).
  private acceptTurn: Promise<void> = Promise.resolve();
  private readonly rejected = new Map<Commit, string>();
  private readonly snapshotStates = new Map<string, StoredCheckpoint>();
  private activeSnapshot: AcceptedSnapshot | null = null;
  private snapshotBaseVector: Record<string, number> = {};
  // This device's commits refused because another member's change took a row id first, to be written again.
  private clashes: Commit[] = [];
  private redoing = false;
  private tables: Tables = new Map();
  private applied = 0;
  private checkpoints: Checkpoint[] = [];
  private persistedCheckpointIndex: number | null = null;
  private cancelCheckpointWrite: (() => void) | null = null;
  private checkpointWriting: Promise<void> = Promise.resolve();
  // The earliest place of commits added but not applied yet (waiting `coalesceMs` for more late ones), and who waits.
  private dirty: number | null = null;
  private dirtyTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly dirtyWaiters: (() => void)[] = [];
  private genesis: Commit | null = null;
  private clock = 0;
  private seq = 0;
  private pending: Pending | null = null;
  private signing: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(event: ServerEvent) => void>();
  private readonly noticeListeners = new Set<(notices: HistoryNotice[]) => void>();
  private readonly sentNotices = new Set<string>();
  private readonly sent = new Set<(commits: Commit[]) => void>();
  private readonly readyWaiters: (() => void)[] = [];

  constructor(
    readonly workspaceId: string,
    private readonly signer: Signer,
    private readonly policy: Policy,
    private readonly store: CommitStore,
    private readonly snapshotLoader?: SnapshotLoader,
  ) {}

  register(manifest: MockManifest): PluginStore {
    this.manifests.set(manifest.name, manifest);
    for (const table of manifest.tables) {
      const key = tableKey(manifest.name, table.name);
      if (!this.tables.has(key)) this.tables.set(key, new Map());
    }
    return new LedgerTables(this, manifest);
  }

  // Loads what this device stored; call after registering every plugin.
  async load(): Promise<void> {
    const [stored, checkpoint] = await Promise.all([
      this.store.load(this.workspaceId), this.store.loadCheckpoint?.(this.workspaceId) ?? Promise.resolve(null),
    ]);
    this.add(stored);
    for (const commit of this.commits) {
      if (!commit.snapshot) continue;
      const state = await this.readSnapshot(commit.snapshot);
      if (state) this.snapshotStates.set(commit.hash, state);
    }
    this.seq = Math.max(-1, ...this.commits.filter((c) => c.replica === this.signer.replica).map((c) => c.seq)) + 1;
    if (checkpoint && this.restoreCheckpoint(checkpoint)) {
      this.persistedCheckpointIndex = checkpoint.index;
      this.replay(checkpoint.index);
    } else {
      if (checkpoint) {
        console.warn("Workspace checkpoint is invalid; replaying the complete history.");
        await this.store.deleteCheckpoint?.(this.workspaceId);
      }
      this.replay();
    }
  }

  // Writes a checkpoint of the latest complete commit prefix. Called when closing a workspace.
  async flushCheckpoint(): Promise<void> {
    await this.flush();
    this.applyWaiting();
    if (this.applied > 0) this.checkpoint(this.applied, true);
    this.cancelCheckpointWrite?.();
    this.cancelCheckpointWrite = null;
    await this.writeCheckpoint();
  }

  // Replays the whole log from the start. Used after tables a plugin registered late (a workspace's declared
  // plugins, loadDeclared) are known: commits to them were rejected at load and are re-checked and applied now.
  reregister(): void {
    this.replay(0);
  }

  get me(): number {
    return userNumberOf(this.signer.author);
  }

  get author(): string {
    return this.signer.author;
  }

  get publicKey(): { x: string; y: string } {
    return this.signer.key;
  }

  signPeerProof(text: string): Promise<string> {
    return sign(this.signer.privateKey, text);
  }

  get owner(): number | null {
    return this.genesis ? userNumberOf(this.genesis.author) : null;
  }

  ready(): Promise<void> {
    return this.genesis ? Promise.resolve() : new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeNotices(listener: (notices: HistoryNotice[]) => void): () => void {
    this.noticeListeners.add(listener);
    return () => this.noticeListeners.delete(listener);
  }

  // Signed local commits, for sending to peers.
  onSigned(listener: (commits: Commit[]) => void): () => void {
    this.sent.add(listener);
    return () => this.sent.delete(listener);
  }

  // Changes whenever a commit comes in: lets derived data (members' keys) be kept until then.
  get commitCount(): number {
    return this.commits.length;
  }

  // Every commit in order with whether it was accepted, for the history.
  log(): { commit: Commit; rejected: string | null }[] {
    return this.commits.filter((c) => c.hash).map((commit) => ({ commit, rejected: this.rejected.get(commit) ?? null }));
  }

  async snapshotState(): Promise<StoredCheckpoint> {
    await this.flush();
    this.applyWaiting();
    const anchor = this.commits.at(-1);
    if (!anchor?.hash || !this.genesis?.hash) throw new Error("The workspace history isn't ready to snapshot.");
    const rejected = new Map<string, string>();
    const previous = this.activeSnapshot && this.snapshotStates.get(this.activeSnapshot.commit.hash);
    previous?.rejected.forEach(([hash, reason]) => rejected.set(hash, reason));
    for (const commit of this.commits) {
      const reason = this.rejected.get(commit);
      if (reason) rejected.set(commit.hash, reason);
    }
    return {
      version: 1, index: this.historyLength(), hash: anchor.hash, genesisHash: this.genesis.hash,
      tables: this.serializeTables(this.tables),
      rejected: [...rejected],
    };
  }

  private historyLength(): number {
    const snapshot = this.activeSnapshot;
    if (!snapshot) return this.commits.length;
    return snapshot.ref.index + 1 + this.commits.filter((commit) =>
      commit.hash !== snapshot.commit.hash && !snapshotPrefixHas(snapshot.ref, commit)).length;
  }

  async stateAt(index: number): Promise<StoredCheckpoint> {
    await this.flush();
    this.applyWaiting();
    if (!Number.isSafeInteger(index) || index < 1 || index > this.commits.length)
      throw new RangeError("History position is outside the workspace log.");
    const commits = this.commits.slice(0, index);
    const store: CommitStore = {
      load: async () => commits,
      add: async () => {},
    };
    const snapshots = new Map(this.commits
      .filter((commit) => commit.snapshot && this.snapshotStates.has(commit.hash))
      .map((commit) => [commit.snapshot!.content, this.snapshotStates.get(commit.hash)!]));
    const ledger = new Ledger(this.workspaceId, this.signer, this.policy, store,
      async (ref) => snapshots.get(ref.content) ?? null);
    for (const manifest of this.manifests.values()) ledger.register(manifest);
    await ledger.load();
    return ledger.snapshotState();
  }

  snapshotForBootstrap(): AcceptedSnapshot | null {
    return this.activeSnapshot;
  }

  // Why a commit in the log was refused, or null when it applied.
  refusal(commit: Commit): string | null {
    return this.rejected.get(commit) ?? null;
  }

  // A snapshot's state from this device's store, through the loader the ledger was made with (the app's content store
  // or a node's), or null when it isn't here or isn't valid. The ledger itself never reads any store.
  readSnapshot(ref: SnapshotRef): Promise<StoredCheckpoint | null> {
    return this.snapshotLoader?.(ref) ?? Promise.resolve(null);
  }

  // Snapshots refused because their state wasn't on this device yet (a joiner that couldn't fetch it in time keeps
  // only what came after the snapshot) are taken up once it is: the log replays from the earliest of them. Returns
  // whether one was. Before, such a member stayed without the workspace's data for good (mesh-test s12).
  async retrySnapshots(): Promise<boolean> {
    const loaded: Commit[] = [];
    for (const commit of this.commits.filter((c) => c.snapshot && !this.snapshotStates.has(c.hash) && this.rejected.has(c))) {
      const state = await this.readSnapshot(commit.snapshot!);
      if (!state) continue;
      this.snapshotStates.set(commit.hash, state);
      loaded.push(commit);
    }
    if (loaded.length === 0) return false;
    this.applyWaiting();
    this.replay(Math.min(...loaded.map((commit) => this.commits.indexOf(commit)).filter((i) => i >= 0)), true);
    return true;
  }

  // Whether a snapshot in the log is still refused for want of its state (see retrySnapshots).
  waitingForSnapshot(): boolean {
    return this.commits.some((commit) => commit.snapshot && !this.snapshotStates.has(commit.hash) && this.rejected.has(commit));
  }

  async compactSnapshot(): Promise<number> {
    await this.flush();
    this.applyWaiting();
    const snapshot = this.activeSnapshot;
    if (!snapshot?.ref.archiveContent) throw new Error("A verified snapshot archive is required before compaction.");
    const remove = this.commits.slice(1, snapshot.index);
    if (!remove.length) return 0;
    const hashes = remove.map((commit) => commit.hash);
    await this.store.compact?.(this.workspaceId, hashes);
    const removed = new Set(remove);
    this.commits.splice(0, this.commits.length, ...this.commits.filter((commit) => !removed.has(commit)));
    remove.forEach((commit) => {
      this.hashes.delete(commit.hash);
      this.sigs.delete(commit.sig);
      this.rejected.delete(commit);
      this.snapshotStates.delete(commit.hash);
    });
    this.checkpoints = [];
    this.persistedCheckpointIndex = null;
    await this.store.deleteCheckpoint?.(this.workspaceId);
    this.replay(0);
    return remove.length;
  }

  // Highest seq per replica with nothing missing below it. An active snapshot holds everything up to its vector, so
  // the count goes on from there: a member that started from a snapshot has only the commits after it, and counting
  // from 0 left it short forever (peers sent it the same commits again at every hello, and it never caught up).
  vector(): Record<string, number> {
    const seqs = new Map<string, Set<number>>();
    for (const c of this.commits) if (c.hash) (seqs.get(c.replica) ?? seqs.set(c.replica, new Set()).get(c.replica)!).add(c.seq);
    const vector: Record<string, number> = {};
    for (const replica of new Set([...seqs.keys(), ...Object.keys(this.snapshotBaseVector)])) {
      const set = seqs.get(replica);
      let n = this.snapshotBaseVector[replica] ?? -1;
      while (set?.has(n + 1)) n++;
      vector[replica] = n;
    }
    return vector;
  }

  // Signed commits the holder of `vector` is missing.
  missing(vector: Record<string, number>, fullHistory = false): Commit[] {
    const genesis = this.commits.find((commit) => commit.server === "");
    const onlyGenesis = Object.entries(vector).every(([replica, seq]) =>
      replica === genesis?.replica ? seq <= genesis.seq : seq < 0);
    if (!fullHistory && this.activeSnapshot && onlyGenesis && genesis) {
      const { commit: snapshot, index } = this.activeSnapshot;
      return [
        genesis,
        ...(snapshot.seq > (vector[snapshot.replica] ?? -1) ? [snapshot] : []),
        ...this.commits.slice(index + 1).filter((commit) => commit.seq > (vector[commit.replica] ?? -1)),
      ];
    }
    return this.commits.filter((c) => c.hash && c.seq > (vector[c.replica] ?? -1));
  }

  // Commits from a peer: checked, stored, applied. Returns how many were new.
  async receive(raw: unknown[]): Promise<number> {
    return (await this.accept(raw)).length;
  }

  // Like `receive`, returning the new commits.
  // Members pass every new commit on, so copies of one commit arrive from several members at once. Copies of a commit
  // already in the log or still being checked and stored here are dropped before checking (by signature), so each
  // commit is new, and passed on, only once. A copy that fails the check doesn't block a genuine one arriving later.
  // Batches are checked at once but stored and applied in the order they came in (`acceptTurn`): a catch-up comes in
  // log order, and applied in the order their checks finished, a batch landing before ones already applied made the
  // log replay from there, from commit 0 when no checkpoint was that early. A joiner taking a 17k-commit history in 89
  // batches at once replayed it 3 times and had no data for 5 s (mesh-test JOIN-REPORT.md).
  async accept(raw: unknown[], loadSnapshot: SnapshotLoader | undefined = this.snapshotLoader): Promise<Commit[]> {
    const claimed: string[] = [];
    const candidates = raw.filter((r) => {
      const sig = sigOf(r);
      if (sig === null) return true;
      if (this.sigs.has(sig) || this.inflight.has(sig)) return false;
      this.inflight.add(sig);
      claimed.push(sig);
      return true;
    });
    if (candidates.length === 0) return [];
    const turn = this.acceptTurn;
    let done!: () => void;
    this.acceptTurn = new Promise((resolve) => (done = resolve));
    try {
      const verified = await Promise.all(candidates.map(verifyCommit));
      await turn;
      const fresh: Commit[] = [];
      for (const commit of verified) {
        if (!commit || this.hashes.has(commit.hash)) continue;
        if (commit.server !== this.workspaceId && !(commit.server === "" && (await workspaceIdOf(commit)) === this.workspaceId)) continue;
        fresh.push(commit);
      }
      if (fresh.length === 0) return [];
      for (const commit of fresh) {
        if (!commit.snapshot) continue;
        const state = await loadSnapshot?.(commit.snapshot) ?? null;
        if (state) this.snapshotStates.set(commit.hash, state);
      }
      await this.store.add(this.workspaceId, fresh);
      await this.integrate(fresh);
      return fresh;
    } finally {
      done();
      for (const sig of claimed) this.inflight.delete(sig);
    }
  }

  // Runs one request's writes as one commit.
  transact<T>(action: string, run: () => T, snapshot?: { ref: SnapshotRef; state: StoredCheckpoint }): T {
    if (this.pending) return run();
    // A local change applies on top of everything received.
    this.applyWaiting();
    if ((action === "workspace.snapshot") !== !!snapshot)
      throw new AccessDenied("A signed workspace snapshot must include its verified cutoff and data.");
    if (snapshot && (snapshot.ref.index !== this.historyLength()
      || snapshot.ref.hash !== this.commits.at(-1)?.hash
      || snapshot.state.index !== snapshot.ref.index || snapshot.state.hash !== snapshot.ref.hash))
      throw new AccessDenied("The workspace history changed while the snapshot was being prepared. Try again.");
    this.pending = { action, time: Date.now(), ops: [], undo: [], changed: new Map(), ...(snapshot ? { snapshot } : {}) };
    try {
      const result = run();
      this.finish();
      return result;
    } catch (e) {
      this.rollback();
      throw e;
    }
  }

  // Like `transact`, for a bot this device's account hosts: the commit says `as`, and every member checks it against
  // the bot's own roles and rows, not the host's.
  transactAs<T>(as: number, action: string, run: () => T): T {
    if (this.pending) return run();
    return this.transact(action, () => {
      this.pending!.as = as;
      return run();
    });
  }

  // Waits until every local commit so far is signed and stored.
  flush(): Promise<void> {
    return this.signing;
  }

  write(op: Op): void {
    if (!this.pending) {
      this.transact(`${op.ext}.write`, () => this.write(op));
      return;
    }
    if (!this.genesis) throw new AccessDenied("Still waiting for the workspace's data from its members.");
    const reason = this.applyOp(op, this.signer.author, this.pending.action, this.pending, this.pending.as);
    if (reason) throw new AccessDenied(reason);
    this.pending.ops.push(op);
  }

  manifest(ext: string): MockManifest | undefined {
    return this.manifests.get(ext);
  }

  allManifests(): MockManifest[] {
    return [...this.manifests.values()];
  }

  has(ext: string, table: string, id: number): boolean {
    return this.tables.get(tableKey(ext, table))?.has(id) ?? false;
  }

  select(ext: string, table: string, where: Record<string, ApiValue>): JsonRow[] {
    const rows = this.tables.get(tableKey(ext, table));
    if (!rows) return [];
    const conditions = Object.entries(where);
    const found: JsonRow[] = [];
    for (const [id, row] of rows) {
      if (conditions.every(([column, value]) => (column === "id" ? id : row.values[column] ?? null) === value))
        found.push({ id, ...row.values } as JsonRow);
    }
    return found.sort((a, b) => a.id - b.id);
  }

  // The first commit of a new workspace, made by its owner. The workspace id is derived from it.
  static async createGenesis(signer: Signer): Promise<{ workspaceId: string; genesis: Commit }> {
    const genesis = await signCommit({
      server: "", author: signer.author, key: signer.key, replica: signer.replica, seq: 0, clock: 0,
      time: Date.now(), action: genesisAction, ops: [],
    }, signer.privateKey);
    return { workspaceId: await workspaceIdOf(genesis), genesis };
  }

  // For a workspace made on this device: stores the genesis before anything else.
  async adopt(genesis: Commit): Promise<void> {
    await this.store.add(this.workspaceId, [genesis]);
    this.add([genesis]);
    this.applyWaiting(0);
    this.seq = Math.max(this.seq, genesis.replica === this.signer.replica ? genesis.seq + 1 : 0);
  }

  private add(commits: Commit[]): number {
    let first = this.commits.length;
    for (const commit of commits) {
      if (this.hashes.has(commit.hash)) continue;
      this.hashes.add(commit.hash);
      this.sigs.add(commit.sig);
      this.clock = Math.max(this.clock, commit.clock);
      // Own commits from an earlier copy (left and joined again, a restored backup): never sign a seq peers have.
      if (commit.replica === this.signer.replica) this.seq = Math.max(this.seq, commit.seq + 1);
      let i = this.commits.length;
      while (i > 0 && compareCommits(this.commits[i - 1], commit) > 0) i--;
      this.commits.splice(i, 0, commit);
      first = Math.min(first, i);
    }
    return first;
  }

  // New commits at the end apply at once; ones that sort before applied ones wait `coalesceMs` for more, then replay
  // once from the earliest. Resolves when they are applied.
  private integrate(commits: Commit[]): Promise<void> {
    const first = this.add(commits);
    if (this.dirty === null && first >= this.applied) {
      if (commits.some((commit) => commit.action === "workspace.snapshot" || commit.snapshot))
        this.replay(first, true);
      else this.applyFrom(this.applied);
      return Promise.resolve();
    }
    this.dirty = Math.min(this.dirty ?? first, first);
    this.dirtyTimer ??= setTimeout(() => this.applyWaiting(), coalesceMs);
    return new Promise((resolve) => this.dirtyWaiters.push(resolve));
  }

  // Applies commits added but not applied yet (`dirty`, or `from`).
  private applyWaiting(from: number | null = null) {
    clearTimeout(this.dirtyTimer);
    this.dirtyTimer = undefined;
    const start = Math.min(this.dirty ?? Infinity, from ?? Infinity);
    this.dirty = null;
    if (start < this.applied) this.replay(start, true);
    else if (this.applied < this.commits.length) this.applyFrom(this.applied);
    this.dirtyWaiters.splice(0).forEach((resolve) => resolve());
  }

  private applyFrom(start: number) {
    const previousRejected = new Map(this.rejected);
    const changed: Changes = new Map();
    for (let i = start; i < this.commits.length; i++) {
      this.applyCommit(this.commits[i], changed, i);
      this.checkpoint(i + 1);
    }
    this.applied = this.commits.length;
    this.emit(changed);
    this.redoClashes();
    this.publishHistoryNotices(previousRejected, start);
  }

  // Replays the log from `start` (its place changed: a commit landed there), beginning at the closest checkpoint at
  // or before it. Only rows the replayed commits touch can differ, so only those are compared for the events.
  private replay(start = 0, notify = false, retryFullHistory = true) {
    const previousRejected = new Map(this.rejected);
    if (this.persistedCheckpointIndex !== null && start < this.persistedCheckpointIndex) {
      this.persistedCheckpointIndex = null;
      this.clearStoredCheckpoint();
    }
    const before = this.tables;
    this.checkpoints = this.checkpoints.filter((c) => c.index <= start);
    const base = this.checkpoints.at(-1);
    const from = base?.index ?? 0;
    this.tables = base ? copyTables(base.tables) : new Map();
    for (const key of before.keys()) if (!this.tables.has(key)) this.tables.set(key, new Map());
    this.genesis = base?.genesis ?? null;
    this.activeSnapshot = null;
    this.snapshotBaseVector = {};
    for (let i = from - 1; i >= 0; i--) {
      const commit = this.commits[i];
      if (commit.action !== "workspace.snapshot" || !commit.snapshot || this.rejected.has(commit)) continue;
      this.activeSnapshot = { commit, index: i, ref: commit.snapshot };
      this.snapshotBaseVector = { ...commit.snapshot.vector };
      break;
    }
    for (let i = from; i < this.commits.length; i++) this.rejected.delete(this.commits[i]);
    let segmentStart = from;
    let retry = false;
    for (let i = from; i < this.commits.length; i++) {
      const commit = this.commits[i];
      if (commit.action !== "workspace.snapshot" || !commit.snapshot) continue;
      const ref = commit.snapshot;
      const hasCutoff = this.commits.slice(0, i).some((previous) => previous.hash === ref.hash);
      if (!hasCutoff || retryFullHistory) {
        const deferred: Commit[] = [];
        for (let j = segmentStart; j < i; j++) {
          const prior = this.commits[j];
          if (!snapshotPrefixHas(ref, prior)) {
            if (compareWithCutoff(ref, prior) < 0) this.rejected.set(prior, "This change arrived after the workspace snapshot cutoff.");
            else deferred.push(prior);
          } else {
            this.applyCommit(prior, new Map(), j);
          }
        }
        this.applyCommit(commit, new Map(), i);
        if (hasCutoff && this.rejected.has(commit)) retry = true;
        for (const late of deferred) this.applyCommit(late, new Map(), this.commits.indexOf(late));
      } else {
        for (let j = segmentStart; j < i; j++) this.applyCommit(this.commits[j], new Map(), j);
        this.applyCommit(commit, new Map(), i);
      }
      segmentStart = i + 1;
      this.checkpoint(i + 1);
    }
    for (let i = segmentStart; i < this.commits.length; i++) {
      this.applyCommit(this.commits[i], new Map(), i);
      this.checkpoint(i + 1);
    }
    if (retry && retryFullHistory) {
      this.clashes = [];
      this.replay(0, notify, false);
      return;
    }
    this.applied = this.commits.length;
    const touched = new Map<string, Set<number>>();
    for (let i = from; i < this.commits.length; i++)
      for (const op of replayCommit(this.commits[i]).ops) {
        const key = tableKey(op.ext, op.table);
        (touched.get(key) ?? touched.set(key, new Set()).get(key)!).add(op.id);
      }
    this.emit(from === 0 ? diff(before, this.tables) : diffRows(before, this.tables, touched));
    this.redoClashes();
    if (notify) this.publishHistoryNotices(previousRejected, start);
  }

  private publishHistoryNotices(previousRejected: Map<Commit, string>, start: number): void {
    const notices: HistoryNotice[] = [];
    for (const [commit, reason] of this.rejected) {
      if (commit.author !== this.signer.author || previousRejected.has(commit)) continue;
      const key = `rejected:${commit.hash}`;
      if (this.sentNotices.has(key)) continue;
      this.sentNotices.add(key);
      const channelId = commit.ops.map((op) => {
        const row = this.tables.get(tableKey(op.ext, op.table))?.get(op.id);
        return op.values?.channel_id ?? row?.values.channel_id;
      }).find((id) => typeof id === "number");
      notices.push({
        kind: "rejected", commit, fields: [], channelId: typeof channelId === "number" ? channelId : null, reason,
      });
    }

    const lastOwn = new Map<string, { commit: Commit; value: ApiValue | undefined; channelId: number | null }>();
    const overwritten = new Map<string, { own: Commit; by: Commit; field: string; channelId: number | null }>();
    const rowKey = (op: Op) => `${tableKey(op.ext, op.table)}/${op.id}`;
    const fieldKey = (op: Op, field: string) => `${rowKey(op)}/${field}`;
    for (let i = 0; i < this.commits.length; i++) {
      const commit = this.commits[i];
      if (this.rejected.has(commit)) continue;
      const own = commit.author === this.signer.author;
      if (!own && i < start) continue;
      for (const op of replayCommit(commit).ops) {
        const row = this.tables.get(tableKey(op.ext, op.table))?.get(op.id);
        const channelId = typeof op.values?.channel_id === "number" ? op.values.channel_id
          : typeof row?.values.channel_id === "number" ? row.values.channel_id : null;
        const fields = op.kind === "delete" ? ["$row"]
          : op.kind === "insert" ? [...Object.keys(op.values ?? {}), "$row"]
            : Object.keys(op.values ?? {});
        for (const field of fields) {
          const key = fieldKey(op, field);
          if (own) {
            lastOwn.set(key, {
              commit, value: field === "$row" ? (op.kind === "delete" ? undefined : true) : op.values?.[field], channelId,
            });
            overwritten.delete(key);
          } else {
            const previous = lastOwn.get(key);
            if (previous) overwritten.set(key, { own: previous.commit, by: commit, field, channelId: previous.channelId ?? channelId });
          }
        }
      }
    }
    for (const [key, item] of overwritten) {
      const [ext, table, idText, ...fieldParts] = key.split("/");
      const field = fieldParts.join("/");
      if (!ext || !table || !idText || !field) continue;
      const row = this.tables.get(tableKey(ext, table))?.get(Number(idText));
      const finalValue = field === "$row" ? (row ? true : undefined) : row?.values[field];
      const ownWrite = lastOwn.get(key);
      if (!ownWrite || finalValue === ownWrite.value) continue;
      const noticeKey = `overwritten:${item.own.hash}:${item.by.hash}:${field}`;
      if (this.sentNotices.has(noticeKey)) continue;
      this.sentNotices.add(noticeKey);
      const existing = notices.find((notice) => notice.kind === "overwritten"
        && notice.commit.hash === item.own.hash && notice.by?.hash === item.by.hash
        && notice.channelId === item.channelId);
      if (existing) existing.fields.push(field === "$row" ? "row" : field);
      else notices.push({
        kind: "overwritten", commit: item.own, by: item.by,
        fields: [field === "$row" ? "row" : field], channelId: item.channelId,
      });
    }
    if (notices.length) this.noticeListeners.forEach((listener) => listener(notices));
  }

  // Two devices can draw the same row id (`newRowId`: the same millisecond and random part, once in 2048 for two
  // members writing at once), and the second insert of an id is refused on every member. So this device's commits
  // refused that way are written again: the same change, its rows under new ids (`movedId`), as a new commit. Others
  // see an ordinary commit. Bursts of posts from many members lost a message silently (mesh-test s3, s8).
  private redoClashes() {
    if (this.redoing || this.clashes.length === 0) return;
    this.redoing = true;
    try {
      for (const commit of this.clashes.splice(0)) {
        const reason = this.rejected.get(commit);
        if (reason && commit.ops.some((op) => op.kind === "insert" && reason === rowExists(op.id))) this.redo(commit);
      }
    } finally {
      this.redoing = false;
    }
  }

  private redo(commit: Commit) {
    const inserted = commit.ops.filter((op) => op.kind === "insert").map((op) => op.id);
    for (let attempt = 0; attempt < 8; attempt++) {
      const seed = `${commit.replica}:${commit.seq}:${attempt}`;
      const moved = new Map(inserted.map((id) => [id, movedId(id, seed)]));
      const replayed = replayCommit(commit);
      const ops = replayed.ops.map((op) => movedOp(op, moved));
      // Written again already (an earlier run of the app), whether that copy was taken or will be written again itself.
      const first = moved.get(inserted[0])!;
      if (this.commits.some((c) => c !== commit && c.replica === commit.replica && c.ops.some((op) => op.kind === "insert" && op.id === first))) return;
      if (ops.some((op) => op.kind === "insert" && this.has(op.ext, op.table, op.id))) continue;
      try {
        this.transact(replayed.action, () => ops.forEach((op) => this.write(op)));
        console.info(`[ledger] ${commit.action}: another member's change took a row id at the same moment; written again under new ids.`);
      } catch (e) {
        console.warn(`[ledger] ${commit.action}: not written again after a row id clash: ${(e as Error).message}`);
      }
      return;
    }
  }

  // Keeps the tables after the first `index` commits when that is a checkpoint place, and thins out old ones.
  private checkpoint(index: number, force = false) {
    if (index <= 0 || (!force && index % checkpointEvery !== 0)) return;
    if (this.checkpoints.some((c) => c.index === index)) {
      if (!force && index % persistCheckpointEvery === 0) this.scheduleCheckpointWrite();
      return;
    }
    this.checkpoints.push({ index, tables: copyTables(this.tables), genesis: this.genesis });
    this.checkpoints.sort((a, b) => a.index - b.index);
    this.checkpoints = this.checkpoints.filter((c) => keepCheckpoint(c.index, index));
    if (force || index % persistCheckpointEvery === 0) this.scheduleCheckpointWrite();
  }

  private restoreCheckpoint(checkpoint: StoredCheckpoint): boolean {
    if (checkpoint.version !== 1 || !Number.isSafeInteger(checkpoint.index) || checkpoint.index <= 0
      || checkpoint.index > this.commits.length || typeof checkpoint.hash !== "string" || !checkpoint.hash
      || this.commits[checkpoint.index - 1]?.hash !== checkpoint.hash || !Array.isArray(checkpoint.tables)
      || !Array.isArray(checkpoint.rejected)) return false;
    const genesis = this.commits.find((commit) => commit.server === "");
    if (!genesis || checkpoint.genesisHash !== genesis.hash) return false;
    const tables = new Map<string, Map<number, RowState>>([...this.tables.keys()].map((key) => [key, new Map()]));
    const seenTables = new Set<string>();
    try {
      for (const entry of checkpoint.tables) {
        if (!Array.isArray(entry) || entry.length !== 2) return false;
        const [key, rows] = entry;
        const tableRows = tables.get(key);
        if (!tableRows || seenTables.has(key) || !Array.isArray(rows)) return false;
        seenTables.add(key);
        const [ext, tableName] = key.split("/");
        const manifest = this.manifests.get(ext)?.tables.find((table) => table.name === tableName);
        if (!manifest) return false;
        for (const row of rows) {
          if (!Array.isArray(row) || row.length !== 2) return false;
          const [id, state] = row;
          if (!Number.isSafeInteger(id) || id <= 0 || tableRows.has(id) || !state || typeof state !== "object"
            || !Number.isSafeInteger(state.creator) || !state.values || typeof state.values !== "object"
            || Array.isArray(state.values)) return false;
          const values = convertValues(tableName, manifest.columns, state.values as Values);
          if (Object.keys(values).length !== Object.keys(manifest.columns).length) return false;
          tableRows.set(id, { values: Object.fromEntries(Object.entries(values).map(([column, value]) => [column, toJson(value)])), creator: state.creator });
        }
      }
      if (seenTables.size !== tables.size) return false;
      const prefix = this.commits.slice(0, checkpoint.index);
      const reasons = new Map<string, string>();
      for (const entry of checkpoint.rejected) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string"
          || !prefix.some((commit) => commit.hash === entry[0]) || reasons.has(entry[0])) return false;
        reasons.set(entry[0], entry[1]);
      }
      this.tables = tables;
      this.genesis = genesis;
      this.applied = checkpoint.index;
      this.readyWaiters.splice(0).forEach((resolve) => resolve());
      this.rejected.clear();
      for (const commit of prefix) {
        const reason = reasons.get(commit.hash);
        if (reason) {
          this.rejected.set(commit, reason);
          if (commit.replica === this.signer.replica && commit.ops.some((op) => op.kind === "insert" && reason === rowExists(op.id)))
            this.clashes.push(commit);
        }
      }
      this.checkpoints = [{ index: checkpoint.index, tables: copyTables(tables), genesis }];
      return true;
    } catch {
      return false;
    }
  }

  private scheduleCheckpointWrite(): void {
    if (!this.store.saveCheckpoint || this.cancelCheckpointWrite) return;
    const write = () => {
      this.cancelCheckpointWrite = null;
      void this.writeCheckpoint().catch((e) => console.warn("Workspace checkpoint not saved:", e));
    };
    const idle = globalThis as typeof globalThis & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (idle.requestIdleCallback) {
      const handle = idle.requestIdleCallback(write, { timeout: 30_000 });
      this.cancelCheckpointWrite = () => idle.cancelIdleCallback?.(handle);
    } else {
      const handle = setTimeout(write, 2_000);
      this.cancelCheckpointWrite = () => clearTimeout(handle);
    }
  }

  private writeCheckpoint(): Promise<void> {
    if (!this.store.saveCheckpoint) return Promise.resolve();
    this.checkpointWriting = this.checkpointWriting.catch(() => {}).then(async () => {
      await this.flush();
      const checkpoint = this.checkpoints.at(-1);
      if (!checkpoint || checkpoint.index > this.commits.length) return;
      const anchor = this.commits[checkpoint.index - 1];
      const genesis = checkpoint.genesis;
      if (!anchor?.hash || !genesis?.hash) return;
      const stored: StoredCheckpoint = {
        version: 1,
        index: checkpoint.index,
        hash: anchor.hash,
        genesisHash: genesis.hash,
        tables: [...checkpoint.tables].map(([key, rows]) => [key, [...rows].map(([id, row]) => [id, row])]),
        rejected: this.commits.slice(0, checkpoint.index)
          .flatMap((commit) => this.rejected.has(commit) ? [[commit.hash, this.rejected.get(commit)!] as [string, string]] : []),
      };
      await this.store.saveCheckpoint!(this.workspaceId, stored);
      if (this.checkpoints.includes(checkpoint) && this.commits[checkpoint.index - 1]?.hash === stored.hash)
        this.persistedCheckpointIndex = checkpoint.index;
    });
    return this.checkpointWriting;
  }

  private clearStoredCheckpoint(): void {
    if (!this.store.deleteCheckpoint) return;
    this.checkpointWriting = this.checkpointWriting.catch(() => {}).then(async () => {
      await this.store.deleteCheckpoint!(this.workspaceId);
      this.persistedCheckpointIndex = null;
    });
    void this.checkpointWriting.catch((e) => console.warn("Stale workspace checkpoint not cleared:", e));
  }

  private applyCommit(commit: Commit, changed: Changes, index: number) {
    const applied = replayCommit(commit);
    if (commit.server === "") {
      if (this.genesis || applied.action !== genesisAction || applied.ops.length > 0) {
        this.rejected.set(commit, "Not this workspace's first commit.");
        return;
      }
      this.genesis = commit;
      this.readyWaiters.splice(0).forEach((resolve) => resolve());
      return;
    }
    if (!this.genesis) {
      this.rejected.set(commit, "Made before the workspace existed.");
      return;
    }
    if (applied.action === "workspace.snapshot" || commit.snapshot) {
      this.applySnapshotCommit(commit, applied.action, changed, index);
      return;
    }
    const pending: Pending = { action: applied.action, time: commit.time, ops: [], undo: [], changed: new Map() };
    for (const op of applied.ops) {
      const reason = this.applyOp(op, commit.author, applied.action, pending, commit.as);
      if (reason) {
        this.undo(pending);
        this.rejected.set(commit, reason);
        if (commit.replica === this.signer.replica && reason === rowExists(op.id)) this.clashes.push(commit);
        return;
      }
    }
    for (const [key, ids] of pending.changed) for (const [id, change] of ids) track(changed, key, id, change);
  }

  private applySnapshotCommit(commit: Commit, action: string, changed: Changes, index: number): void {
    const ref = commit.snapshot;
    const state = this.snapshotStates.get(commit.hash);
    const genesis = this.commits.find((item) => item.server === "");
    if (action !== "workspace.snapshot" || !ref || !state || !genesis || ref.genesisHash !== genesis.hash
      || state.version !== 1 || state.index !== ref.index || state.hash !== ref.hash || state.genesisHash !== ref.genesisHash) {
      this.rejected.set(commit, "Snapshot data or its signed cutoff is invalid or unavailable.");
      return;
    }
    const snapshotTables = this.decodeTables(state.tables);
    if (!snapshotTables) {
      this.rejected.set(commit, "Snapshot tables don't match this workspace's registered data.");
      return;
    }
    const snapshotOp = replayCommit(commit).ops;
    const row = snapshotOp[0]?.values;
    if (snapshotOp.length !== 1 || snapshotOp[0].ext !== "members" || snapshotOp[0].table !== "members_snapshots"
      || snapshotOp[0].kind !== "insert" || row?.cutoff_index !== ref.index || row.cutoff_hash !== ref.hash
      || row.genesis_hash !== ref.genesisHash || row.content !== ref.content || row.vector !== JSON.stringify(ref.vector)
      || row.archive_content !== (ref.archiveContent ?? null)
      || row.created_by !== userNumberOf(commit.author) || !Array.isArray(state.rejected)
      || state.rejected.some((entry) => !Array.isArray(entry) || entry.length !== 2
        || typeof entry[0] !== "string" || typeof entry[1] !== "string")) {
      this.rejected.set(commit, "Snapshot metadata doesn't match its signed payload.");
      return;
    }
    const currentTables = this.tables;
    this.tables = snapshotTables;
    const permissionCheck: Pending = { action, time: commit.time, ops: [], undo: [], changed: new Map() };
    let permissionError: string | null = null;
    for (const op of snapshotOp) {
      permissionError = this.applyOp(op, commit.author, action, permissionCheck);
      if (permissionError) break;
    }
    this.undo(permissionCheck);
    this.tables = currentTables;
    if (permissionError) {
      this.rejected.set(commit, permissionError);
      return;
    }
    const cutoffIndex = this.commits.findIndex((item) => item.hash === ref.hash);
    const cutoff = cutoffIndex >= 0 ? this.commits[cutoffIndex] : null;
    if (cutoff && (cutoffIndex >= index || compareCommits(cutoff, commit) >= 0
      || cutoff.clock !== ref.order.clock || cutoff.author !== ref.order.author
      || cutoff.replica !== ref.order.replica || cutoff.seq !== ref.order.seq)) {
      this.rejected.set(commit, "Snapshot cutoff doesn't match its signed history.");
      return;
    }
    const replaceTables = !cutoff;
    if (!replaceTables) {
      if (canonical(this.serializeTables(this.tables)) !== canonical(this.serializeTables(snapshotTables))) {
        this.rejected.set(commit, "Snapshot tables don't match the signed history at its cutoff.");
        return;
      }
    }
    const previous = this.tables;
    const previousVector = this.snapshotBaseVector;
    if (replaceTables) {
      this.tables = snapshotTables;
      this.snapshotBaseVector = { ...ref.vector };
    }
    const pending: Pending = { action, time: commit.time, ops: [], undo: [], changed: new Map() };
    for (const op of replayCommit(commit).ops) {
      const reason = this.applyOp(op, commit.author, action, pending);
      if (reason) {
        this.tables = previous;
        this.snapshotBaseVector = previousVector;
        this.rejected.set(commit, reason);
        return;
      }
    }
    if (replaceTables) {
      for (const [key, rows] of snapshotTables) for (const id of rows.keys()) track(changed, key, id, "insert");
      for (const [key, rows] of previous) for (const id of rows.keys()) {
        if (!snapshotTables.get(key)?.has(id)) track(changed, key, id, "delete");
      }
    }
    for (const [key, ids] of pending.changed) for (const [id, change] of ids) track(changed, key, id, change);
    this.activeSnapshot = { commit, index, ref };
    this.snapshotBaseVector = { ...ref.vector };
  }

  private decodeTables(entries: StoredCheckpoint["tables"]): Tables | null {
    if (!Array.isArray(entries)) return null;
    const tables = new Map<string, Map<number, RowState>>([...this.tables.keys()].map((key) => [key, new Map()]));
    const seen = new Set<string>();
    try {
      for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length !== 2) return null;
        const [key, rows] = entry;
        const tableRows = tables.get(key);
        if (!tableRows || seen.has(key) || !Array.isArray(rows)) return null;
        seen.add(key);
        const [ext, tableName] = key.split("/");
        const manifest = this.manifests.get(ext)?.tables.find((table) => table.name === tableName);
        if (!manifest) return null;
        for (const row of rows) {
          if (!Array.isArray(row) || row.length !== 2) return null;
          const [id, state] = row;
          if (!Number.isSafeInteger(id) || id <= 0 || tableRows.has(id) || !state || typeof state !== "object"
            || !Number.isSafeInteger(state.creator) || !state.values || typeof state.values !== "object"
            || Array.isArray(state.values)) return null;
          const values = convertValues(tableName, manifest.columns, state.values as Values);
          if (Object.keys(values).length !== Object.keys(manifest.columns).length) return null;
          tableRows.set(id, {
            values: Object.fromEntries(Object.entries(values).map(([column, value]) => [column, toJson(value)])),
            creator: state.creator,
          });
        }
      }
      return seen.size === tables.size ? tables : null;
    } catch {
      return null;
    }
  }

  private serializeTables(tables: Tables): StoredCheckpoint["tables"] {
    return [...tables].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => [
      key, [...rows].sort(([a], [b]) => a - b).map(([id, row]) => [id, row]),
    ]);
  }

  // Applies one change if the author may make it; returns why not otherwise.
  private applyOp(op: Op, author: string, action: string, pending: Pending, as?: number): string | null {
    const manifest = this.manifests.get(op.ext);
    const table = manifest?.tables.find((t) => t.name === op.table);
    if (!manifest || !table) return `Unknown table ${op.ext}/${op.table}.`;
    const key = tableKey(op.ext, op.table);
    const rows = this.tables.get(key)!;
    const existing = rows.get(op.id);
    let values: Record<string, ApiValue> | null = null;
    if (op.kind !== "delete") {
      let result = checked.get(op);
      if (!result) {
        try {
          const converted = convertValues(op.table, table.columns, op.values ?? {});
          result = { values: Object.fromEntries(Object.entries(converted).map(([k, v]) => [k, toJson(v)])) };
        } catch (e) {
          result = { error: (e as Error).message };
        }
        checked.set(op, result);
      }
      if ("error" in result) return result.error;
      values = result.values;
    }
    if (op.kind === "insert" && existing) return rowExists(op.id);
    // Changes to a row someone else deleted meanwhile do nothing.
    if (op.kind !== "insert" && !existing) return null;

    let after: RowState | undefined;
    if (op.kind === "insert") {
      const full: Record<string, ApiValue> = {};
      for (const column of Object.keys(table.columns)) full[column] = values![column] ?? null;
      after = { values: full, creator: as ?? userNumberOf(author) };
    } else if (op.kind === "update") {
      after = { values: { ...existing!.values, ...values }, creator: existing!.creator };
    }
    // A host's commit marked `as` is judged as its bot: the bot must be enabled and hosted by the signer.
    let actor = userNumberOf(author);
    if (as !== undefined) {
      const bot = this.select("bots", "bots_bots", { user_id: as })[0];
      if (!bot || bot.host !== actor || bot.enabled !== true || bot.status !== "enabled") return "Not a bot this member hosts.";
      actor = as;
    }
    const reason = this.policy({
      author: actor, owner: userNumberOf(this.genesis!.author), action, op,
      before: existing ? { id: op.id, ...existing.values } as JsonRow : null,
      after: after ? { id: op.id, ...after.values } as JsonRow : null,
      time: pending.time,
      rows: (ext, t, where = {}) => this.select(ext, t, where),
      creator: (ext, t, id) => this.tables.get(tableKey(ext, t))?.get(id)?.creator ?? null,
    });
    if (reason) return reason;

    pending.undo.push({ key, id: op.id, previous: existing });
    if (after) rows.set(op.id, after);
    else rows.delete(op.id);
    track(pending.changed, key, op.id, op.kind);
    return null;
  }

  private undo(pending: Pending) {
    for (const { key, id, previous } of pending.undo.toReversed()) {
      const rows = this.tables.get(key)!;
      if (previous) rows.set(id, previous);
      else rows.delete(id);
    }
  }

  private rollback() {
    const pending = this.pending!;
    this.pending = null;
    this.undo(pending);
  }

  private finish() {
    const pending = this.pending!;
    this.pending = null;
    if (pending.ops.length === 0) return;
    const unsigned: UnsignedCommit = {
      server: this.workspaceId, author: this.signer.author, key: this.signer.key, replica: this.signer.replica,
      seq: this.seq++, clock: ++this.clock, time: pending.time, action: pending.action, ops: pending.ops,
      ...(pending.as ? { as: pending.as } : {}),
      ...(pending.snapshot ? { snapshot: pending.snapshot.ref } : {}),
    };
    // In the log right away (already applied); the hash arrives once it is signed.
    const commit: Commit = { ...unsigned, sig: "", hash: "" };
    this.commits.push(commit);
    this.applied = this.commits.length;
    this.checkpoint(this.applied);
    this.emit(pending.changed);
    this.signing = this.signing.then(async () => {
      const signed = await signCommit(unsigned, this.signer.privateKey);
      commit.sig = signed.sig;
      commit.hash = signed.hash;
      this.hashes.add(commit.hash);
      this.sigs.add(commit.sig);
      if (pending.snapshot && commit.action === "workspace.snapshot") {
        this.snapshotStates.set(commit.hash, pending.snapshot.state);
        this.activeSnapshot = { commit, index: this.commits.indexOf(commit), ref: pending.snapshot.ref };
        this.snapshotBaseVector = { ...pending.snapshot.ref.vector };
      }
      await this.store.add(this.workspaceId, [commit]);
      this.sent.forEach((listener) => listener([commit]));
    }).catch((e) => console.error("Commit not saved:", e));
  }

  private emit(changed: Changes | ServerEvent[]) {
    const events = Array.isArray(changed) ? changed : [...changed].flatMap(([key, ids]) => {
      const [plugin, table] = key.split("/");
      return (["insert", "update", "delete"] as const).map((change) => ({
        plugin, table, change, ids: [...ids].filter(([, c]) => c === change).map(([id]) => id),
      })).filter((e) => e.ids.length > 0);
    });
    for (const event of events) this.listeners.forEach((listener) => listener(event));
  }
}

// A received commit's signature, before it is checked; null if there is none (verifyCommit drops it then).
function sigOf(raw: unknown): string | null {
  const sig = raw && typeof raw === "object" ? (raw as { sig?: unknown }).sig : undefined;
  return typeof sig === "string" && sig !== "" ? sig : null;
}

// Several changes to one row in a batch add up: inserted then updated is an insert, inserted then deleted is nothing.
function track(changes: Changes, key: string, id: number, change: Change) {
  const rows = changes.get(key) ?? changes.set(key, new Map()).get(key)!;
  const previous = rows.get(id);
  if (previous === "insert" && change === "delete") rows.delete(id);
  else if (previous === "insert" || (previous === "delete" && change === "insert")) rows.set(id, previous === "insert" ? "insert" : "update");
  else rows.set(id, change);
}

function diff(before: Tables, after: Tables): ServerEvent[] {
  const events: ServerEvent[] = [];
  for (const [key, rows] of after) {
    const old = before.get(key) ?? new Map<number, RowState>();
    const [plugin, table] = key.split("/");
    const inserted: number[] = [];
    const updated: number[] = [];
    const deleted: number[] = [];
    for (const [id, row] of rows) {
      const previous = old.get(id);
      if (!previous) inserted.push(id);
      else if (!sameValues(previous.values, row.values)) updated.push(id);
    }
    for (const id of old.keys()) if (!rows.has(id)) deleted.push(id);
    if (inserted.length > 0) events.push({ plugin, table, change: "insert", ids: inserted });
    if (updated.length > 0) events.push({ plugin, table, change: "update", ids: updated });
    if (deleted.length > 0) events.push({ plugin, table, change: "delete", ids: deleted });
  }
  return events;
}

// `diff` limited to the rows in `touched` (table key -> row ids).
function diffRows(before: Tables, after: Tables, touched: Map<string, Set<number>>): ServerEvent[] {
  const events: ServerEvent[] = [];
  for (const [key, ids] of touched) {
    const old = before.get(key);
    const rows = after.get(key);
    const [plugin, table] = key.split("/");
    const inserted: number[] = [];
    const updated: number[] = [];
    const deleted: number[] = [];
    for (const id of ids) {
      const previous = old?.get(id);
      const row = rows?.get(id);
      if (row && !previous) inserted.push(id);
      else if (row && previous && !sameValues(previous.values, row.values)) updated.push(id);
      else if (!row && previous) deleted.push(id);
    }
    if (inserted.length > 0) events.push({ plugin, table, change: "insert", ids: inserted });
    if (updated.length > 0) events.push({ plugin, table, change: "update", ids: updated });
    if (deleted.length > 0) events.push({ plugin, table, change: "delete", ids: deleted });
  }
  return events;
}

function sameValues(a: Record<string, ApiValue>, b: Record<string, ApiValue>) {
  const keys = Object.keys(b);
  return keys.length === Object.keys(a).length && keys.every((k) => a[k] === b[k]);
}

// One plugin's view of the ledger, with the same interface as its in-memory tables.
class LedgerTables implements PluginStore {
  constructor(private readonly ledger: Ledger, private readonly manifest: MockManifest) {}

  insert(table: string, values: Values): number {
    const t = this.own(table);
    const converted = convertValues(t.name, t.columns, values);
    let id = newRowId();
    // Another member's row may hold the id this device drew (both drew it in the same millisecond): draw again.
    while (this.ledger.has(this.manifest.name, t.name, id)) id = newRowId();
    const full: Record<string, ApiValue> = {};
    for (const column of Object.keys(t.columns)) full[column] = toJson(converted[column] ?? null);
    this.ledger.write({ ext: this.manifest.name, table: t.name, kind: "insert", id, values: full });
    return id;
  }

  select(table: string, where: Values = {}): JsonRow[] {
    const t = this.own(table);
    return this.ledger.select(this.manifest.name, t.name, this.conditions(t, where));
  }

  update(table: string, values: Values, where: Values): number {
    const t = this.own(table);
    requireWhere(where);
    const changes = Object.fromEntries(Object.entries(convertValues(t.name, t.columns, values)).map(([k, v]) => [k, toJson(v)]));
    const rows = this.ledger.select(this.manifest.name, t.name, this.conditions(t, where));
    this.ledger.transact(`${this.manifest.name}.update`, () => {
      for (const row of rows) {
        const changed = Object.fromEntries(Object.entries(changes).filter(([k, v]) => row[k] !== v));
        if (Object.keys(changed).length > 0)
          this.ledger.write({ ext: this.manifest.name, table: t.name, kind: "update", id: row.id, values: changed });
      }
    });
    return rows.length;
  }

  delete(table: string, where: Values): number {
    const t = this.own(table);
    requireWhere(where);
    const rows = this.ledger.select(this.manifest.name, t.name, this.conditions(t, where));
    this.ledger.transact(`${this.manifest.name}.delete`, () => {
      for (const row of rows) this.ledger.write({ ext: this.manifest.name, table: t.name, kind: "delete", id: row.id });
    });
    return rows.length;
  }

  private conditions(t: MockManifest["tables"][number], where: Values): Record<string, ApiValue> {
    const converted = convertValues(t.name, { id: "bigint", ...t.columns }, where);
    return Object.fromEntries(Object.entries(converted).map(([k, v]) => [k, toJson(v)]));
  }

  private own(table: string) {
    const name = identifier(table);
    const t = this.manifest.tables.find((x) => x.name === name);
    if (!t) throw notOwned(this.manifest, name);
    return t;
  }
}

// A backend whose plugins keep their tables in the ledger, acting as its signer. Plugins named in `local`
// keep theirs in memory on this device instead (short-lived state like voice presence).
export function createLedgerBackend(ledger: Ledger, local: string[] = [], services: Services = {}): MockBackend {
  return new MockBackend({
    userId: ledger.me,
    services,
    store: (manifest, emit) => {
      if (local.includes(manifest.name)) return new MockPluginData(manifest, emit);
      ledger.subscribe((event) => event.plugin === manifest.name && emit(event));
      return ledger.register(manifest);
    },
    transact: (run, action, as) => (as ? ledger.transactAs(as, action, run) : ledger.transact(action, run)),
  });
}
