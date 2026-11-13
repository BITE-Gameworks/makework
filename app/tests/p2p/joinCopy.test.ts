// Joining a copy of a real, big workspace over the in-memory network, with the real WorkspaceSync on both sides
// (mesh-test/JOIN-REPORT.md). Skipped unless MAKEWORK_JOIN_COPY names a folder with `.makework/commits/*.jsonl` (a copy
// of a workspace kept in a folder; only read). Prints how long the joiner took and what it went through:
//
//   MAKEWORK_JOIN_COPY=/path/to/copy npx vitest run tests/p2p/joinCopy.test.ts
import fs from "node:fs";
import path from "node:path";
import type { Room } from "trystero";
import { afterEach, describe, expect, it } from "vitest";
import { createIdentity } from "../../src/core/identity";
import { memoryCommits } from "../../src/p2p/commits";
import { Ledger, createLedgerBackend, type Signer, type StoredCheckpoint } from "../../src/p2p/ledger";
import { compareCommits, type Commit } from "../../src/p2p/log";
import { localPlugins, plugins } from "../../src/p2p/plugins";
import { workspacePolicy } from "../../src/p2p/policy";
import { WorkspaceSync } from "../../src/p2p/sync";
import { snapshotLoader } from "../../src/core/workspaceSnapshots";
import { loadDeclared } from "../../src/system/declared";
import { Network } from "./fakeNetwork";

const copy = process.env.MAKEWORK_JOIN_COPY;
const minutes = 10 * 60_000;
// How long a join may take before it counts as stuck (MAKEWORK_JOIN_COPY_LIMIT_S, 5 minutes by default).
const limitMs = Number(process.env.MAKEWORK_JOIN_COPY_LIMIT_S ?? 300) * 1000;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function readCommits(folder: string): Commit[] {
  const dir = path.join(folder, ".makework", "commits");
  const byHash = new Map<string, Commit>();
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"))) {
    for (const line of fs.readFileSync(path.join(dir, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const commit = JSON.parse(line) as Commit;
        byHash.set(commit.hash, commit);
      } catch {
        // A line still being written when the copy was made.
      }
    }
  }
  return [...byHash.values()].sort(compareCommits);
}

async function signer(): Promise<Signer> {
  const identity = await createIdentity(false);
  return { author: identity.id, key: { x: identity.publicKey.x!, y: identity.publicKey.y! }, privateKey: identity.privateKey, replica: crypto.randomUUID() };
}

// Content this device has, by hash (the snapshot's state as JSON text).
type Content = (hash: string) => Promise<string | null>;

// Read through the app's own loader (core/workspaceSnapshots.ts), which also registers the declared plugins' tables.
async function openLedger(workspaceId: string, commits: Commit[], content?: Content) {
  const store = memoryCommits();
  if (commits.length) store.all.set(workspaceId, [...commits]);
  let ledger!: Ledger;
  const loader = content ? snapshotLoader(() => ledger, content) : undefined;
  ledger = new Ledger(workspaceId, await signer(), workspacePolicy, store, loader);
  const backend = createLedgerBackend(ledger, localPlugins);
  for (const plugin of plugins) backend.load(plugin);
  await ledger.load();
  const stopDeclared = loadDeclared(ledger, backend);
  return { ledger, stopDeclared };
}

// Counts the ledger's replays (and full ones, from commit 0) with their time, on every ledger.
const replays = { count: 0, full: 0, ms: 0, fullMs: 0 };
const proto = Ledger.prototype as unknown as { replay: (start?: number, notify?: boolean, retry?: boolean) => void };
const replay = proto.replay;
proto.replay = function (this: Ledger, start = 0, ...rest: [boolean?, boolean?]) {
  const t = performance.now();
  try {
    return replay.call(this, start, ...rest);
  } finally {
    const ms = performance.now() - t;
    replays.count++;
    replays.ms += ms;
    if (start === 0) {
      replays.full++;
      replays.fullMs += ms;
    }
  }
};

describe.skipIf(!copy)("joining a copy of a big workspace", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

  const commits = copy ? readCommits(copy) : [];
  const workspaceId = commits.find((c) => c.server !== "")?.server ?? "";
  const snapshotCommit = commits.filter((c) => c.action === "workspace.snapshot" && c.snapshot).at(-1);

  // The state at the snapshot's cutoff, made again from the commits it covers (the copy doesn't have the original).
  async function stateAtCutoff(): Promise<StoredCheckpoint | null> {
    const ref = snapshotCommit?.snapshot;
    if (!ref) return null;
    const prefix = commits.filter((c) => c.seq <= (ref.vector[c.replica] ?? -1) && c.hash !== snapshotCommit!.hash);
    const { ledger, stopDeclared } = await openLedger(workspaceId, prefix);
    const state = await ledger.snapshotState();
    stopDeclared();
    if (state.hash !== ref.hash || state.index !== ref.index) return null;
    // For tools/join-copy.sh --state: the desktop app bootstrapping from it.
    if (process.env.MAKEWORK_JOIN_COPY_STATE_OUT) fs.writeFileSync(process.env.MAKEWORK_JOIN_COPY_STATE_OUT, JSON.stringify(state));
    return state;
  }

  // The source has the copy's history (`sourceLoader` decides whether it holds the snapshot's state); the joiner has
  // nothing. Measures until the joiner has everything the source has.
  async function join(options: { sourceContent?: Content; joinerContent?: Content; ensureContent?: (hash: string) => Promise<boolean> }) {
    const network = new Network();
    const source = await openLedger(workspaceId, commits, options.sourceContent);
    const joiner = await openLedger(workspaceId, [], options.joinerContent);
    const syncA = new WorkspaceSync(source.ledger, workspaceId, "secret", { room: network.room("a") as unknown as Room, self: "a", tabs: false });
    const syncB = new WorkspaceSync(joiner.ledger, workspaceId, "secret", {
      room: network.room("b") as unknown as Room, self: "b", tabs: false, ensureContent: options.ensureContent ?? (async () => false),
    });
    cleanups.push(() => {
      syncA.close();
      syncB.close();
      source.stopDeclared();
      joiner.stopDeclared();
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const accept = joiner.ledger.accept.bind(joiner.ledger);
    joiner.ledger.accept = async (...args) => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      try {
        return await accept(...args);
      } finally {
        inFlight--;
      }
    };
    Object.assign(replays, { count: 0, full: 0, ms: 0, fullMs: 0 });
    const target = source.ledger.vector();
    const covered = () => Object.entries(target).every(([replica, seq]) => (joiner.ledger.vector()[replica] ?? -1) >= seq);
    let peakHeap = 0;
    const started = performance.now();
    let firstData: number | null = null;
    void joiner.ledger.ready().then(() => (firstData = performance.now() - started));
    network.link("a", "b");
    let lastReport = started;
    while (!covered() && performance.now() - started < limitMs) {
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      if (performance.now() - lastReport > 10_000) {
        lastReport = performance.now();
        const lacking = Object.entries(target).filter(([replica, seq]) => (joiner.ledger.vector()[replica] ?? -1) < seq);
        console.info(`[join-copy] after ${Math.round((lastReport - started) / 1000)} s: ${joiner.ledger.log().length} commits,`
          + ` ${network.count("a", "b", "commits")} batches, lacking ${lacking.length} replicas`
          + ` (${lacking.slice(0, 3).map(([r, s]) => `${r.slice(0, 6)} ${joiner.ledger.vector()[r] ?? -1}/${s}`).join(", ")})`);
      }
      await pause(50);
    }
    const result = {
      caughtUp: covered(), ms: Math.round(performance.now() - started), firstDataMs: firstData && Math.round(firstData),
      commits: joiner.ledger.log().length, sourceCommits: source.ledger.log().length,
      rejected: joiner.ledger.log().filter((e) => e.rejected).length,
      rejectedFor: Object.fromEntries([...new Set(joiner.ledger.log().map((e) => e.rejected).filter(Boolean))].map((reason) =>
        [reason, joiner.ledger.log().filter((e) => e.rejected === reason).length])),
      batchesSent: network.count("a", "b", "commits"), hellos: network.count("b", "a", "hello"),
      maxAcceptsAtOnce: maxInFlight, replays: { ...replays, ms: Math.round(replays.ms), fullMs: Math.round(replays.fullMs) },
      peakHeapMb: Math.round(peakHeap / 1048576),
    };
    return { result, source, joiner };
  }

  it("takes the whole history from a member without the snapshot's state", async () => {
    const { result } = await join({});
    console.info("[join-copy] full history:", JSON.stringify(result));
    expect(result.caughtUp).toBe(true);
  }, minutes);

  it("bootstraps from the snapshot when its state can be fetched", async () => {
    const state = await stateAtCutoff();
    console.info(`[join-copy] state at the cutoff made again: ${state ? `${JSON.stringify(state).length} bytes` : "no (cutoff doesn't match)"}`);
    if (!state) return;
    const text = JSON.stringify(state);
    const hash = snapshotCommit!.snapshot!.content.slice(4);
    const content: Content = async (wanted) => (wanted === hash ? text : null);
    const { result } = await join({ sourceContent: content, joinerContent: content, ensureContent: async () => true });
    console.info("[join-copy] snapshot bootstrap:", JSON.stringify(result));
    expect(result.caughtUp).toBe(true);
  }, minutes);

  it("falls back to the whole history when the snapshot's state can't be fetched", async () => {
    const state = await stateAtCutoff();
    if (!state) return;
    const text = JSON.stringify(state);
    const hash = snapshotCommit!.snapshot!.content.slice(4);
    // A content download that finds nobody with it: every peer asked in turn (10 s each at most in the app).
    const { result } = await join({
      sourceContent: async (wanted) => (wanted === hash ? text : null), joinerContent: async () => null,
      ensureContent: async () => (await pause(3_000), false),
    });
    console.info("[join-copy] snapshot unavailable:", JSON.stringify(result));
    expect(result.caughtUp).toBe(true);
  }, minutes);
});
