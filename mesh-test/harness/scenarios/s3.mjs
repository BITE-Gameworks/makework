// S3 messaging convergence: all N members post M messages, first paced (gap between messages) then all at once.
// Per phase: delivery latency (sent → first accepted at each receiver), anything never delivered, identical
// commit sets / order / channel contents at the end, and the cost: commit deliveries per fresh commit
// (forwarding amplification, sync.ts receive → every other direct peer), duplicate accepts of the same commit
// (Ledger.accept race), full replays, data channel bytes by Trystero action.
import * as d from "../lib/driver.mjs";
import { attempt, intArg, stats } from "../lib/util.mjs";
import { aggregate, collect, convergence, messageRound, prepare, setupServer, short } from "./common.mjs";

export default async function s3(ctx) {
  const { run, args } = ctx;
  const perClient = intArg(args, "messages", 10);
  const gapMs = intArg(args, "gap-ms", 2000);
  await prepare(ctx);
  const [owner, ...joiners] = ctx.clients;
  const n = ctx.clients.length;
  const setup = await setupServer(ctx, owner, joiners, { mode: "burst", label: "s3" });
  if (!setup) return {};
  const { serverId } = setup;
  run.assert("s3.setup", `all ${n} clients have the data and see each other`, setup.data.missing.length === 0 && setup.visible.missing.length === 0, {
    dataMissing: setup.data.missing, visibleMissing: setup.visible.missing,
  });

  const phases = {};
  for (const [label, gap] of [["s3-paced", gapMs], ["s3-burst", 0]]) {
    const before = await counters(ctx, serverId);
    const round = await messageRound(ctx, serverId, ctx.clients, ctx.clients, { perClient, gapMs: gap, label, timeoutMs: 240_000, staggerMs: gap ? Math.floor(gap / n) : 0 });
    const conv = await convergence(ctx, serverId, ctx.clients, label);
    const after = await counters(ctx, serverId);
    const delta = diff(before, after);
    phases[label] = { round, conv, delta };
    const id = label.replace("s3-", "");
    run.assert(`s3.${id}.delivered`, `${label}: every message reaches every other client (240 s)`, round.undelivered.length === 0 && round.failedPosts.length === 0, {
      posted: round.posted, failedPosts: round.failedPosts.length, undelivered: round.undelivered,
    });
    run.assert(`s3.${id}.converged`, `${label}: identical commit sets, commit order and channel contents everywhere`, conv.sameCommits && conv.sameOrder && conv.sameMessages, {
      commitGroups: conv.commitGroups, messageGroups: conv.messageGroups, counts: conv.commitCounts,
    });
    const p95 = round.latency.p95;
    run.assert(`s3.${id}.latency`, `${label}: p95 delivery latency ≤ ${gap ? 5 : 30} s`, p95 !== null && p95 <= (gap ? 5000 : 30000), { latency: round.latency });
    run.assert(`s3.${id}.no-duplicate-accepts`, `${label}: no commit is accepted as new twice by the same client (Ledger.accept race)`, delta.dupFresh === 0, {
      dupFresh: delta.dupFresh, perClient: delta.perClient.dupFresh,
    });
    const amplification = delta.fresh ? delta.received / delta.fresh : null;
    run.assert(`s3.${id}.amplification`, `${label}: commit deliveries per fresh commit ≤ 2 (efficiency; full mesh flooding gives ≈ N-1 = ${n - 1})`,
      amplification !== null && amplification <= 2, { amplification: round2(amplification), received: delta.received, fresh: delta.fresh });
    run.number(label, {
      posted: round.posted, postMs: round.postMs, latency: round.latency, allArrivedMs: round.allArrivedMs,
      amplification: round2(amplification), commitDeliveries: delta.received, freshCommits: delta.fresh, dupFresh: delta.dupFresh,
      replays: delta.replays, replayMs: delta.replayMs, acceptMs: delta.acceptMs,
      commitsFrameBytes: delta.commitsBytes, helloFrames: delta.helloFrames, dcBytesSent: delta.dcBytes,
      perReceiver: Object.fromEntries(Object.entries(round.perReceiver).map(([k, v]) => [short(k), { delivered: `${v.delivered}/${v.expected}`, p95: v.latency.p95, max: v.latency.max }])),
      replaysPerClient: stats(Object.values(delta.perClient.replays)),
    });
  }
  const dumps = await collect(ctx, [serverId]);
  run.number("traffic-total", aggregate(dumps, serverId));
  return { serverId, clients: dumps };
}

// Per client: cumulative Ledger.accept counters and data channel traffic.
async function counters(ctx, serverId) {
  const out = {};
  await Promise.all(ctx.clients.map(async (c) => {
    const r = await attempt(() => d.instrumentation(c, [serverId]));
    if (!r.ok || !r.value) return;
    const a = r.value.acc?.[serverId] ?? {};
    out[c.name] = {
      received: a.received ?? 0, fresh: a.fresh ?? 0, dupFresh: a.dupFresh ?? 0, replays: a.replays ?? 0, replayMs: a.replayMs ?? 0, acceptMs: a.ms ?? 0,
      commitsBytes: (r.value.dc.sent.commits?.bytes ?? 0) + (r.value.dc.sent["commits(offer)"]?.bytes ?? 0) + (r.value.dc.sent["#chunk"]?.bytes ?? 0),
      helloFrames: r.value.dc.sent.hello?.n ?? 0,
      dcBytes: r.value.dc.sentBytes ?? 0,
    };
  }));
  return out;
}

function diff(before, after) {
  const keys = ["received", "fresh", "dupFresh", "replays", "replayMs", "acceptMs", "commitsBytes", "helloFrames", "dcBytes"];
  const total = Object.fromEntries(keys.map((k) => [k, 0]));
  const perClient = Object.fromEntries(keys.map((k) => [k, {}]));
  for (const [name, a] of Object.entries(after)) {
    const b = before[name] ?? {};
    for (const k of keys) {
      const v = (a[k] ?? 0) - (b[k] ?? 0);
      total[k] += v;
      perClient[k][short(name)] = Math.round(v);
    }
  }
  total.replayMs = Math.round(total.replayMs);
  total.acceptMs = Math.round(total.acceptMs);
  return { ...total, perClient };
}

const round2 = (x) => (x === null ? null : Math.round(x * 100) / 100);
