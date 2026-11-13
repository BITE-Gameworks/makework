// S1 scale/visibility: one server, every client joins (burst or one after another). The main question: do all
// members get the data, see each other online, list each other, and can each one reach all others?
import { intArg, sleep, stats } from "../lib/util.mjs";
import { aggregate, collect, convergence, meshSnapshot, messageRound, prepare, setupServer, short } from "./common.mjs";

export default async function s1(ctx) {
  const { run, args } = ctx;
  const mode = args.join === "sequential" ? "sequential" : "burst";
  const perClient = intArg(args, "messages", 1);
  const holdMs = intArg(args, "hold-s", 30) * 1000;
  await prepare(ctx);
  const [owner, ...joiners] = ctx.clients;
  const n = ctx.clients.length;
  const setup = await setupServer(ctx, owner, joiners, { mode, label: `s1-${mode}` });
  if (!setup) return {};
  const { serverId } = setup;

  run.assert("s1.data", `every joiner receives the server data (${mode} join)`, setup.data.missing.length === 0, { missing: setup.data.missing, stats: setup.data.stats });
  run.assert("s1.visible", `every client sees the other ${n - 1} online`, setup.visible.missing.length === 0, { missing: setup.visible.missing, stats: setup.visible.stats });
  run.assert("s1.members", `every client lists all ${n} members`, setup.members.missing.length === 0, { missing: setup.members.missing });

  // Does visibility hold, or do members drop out and come back?
  const drops = await hold(ctx, serverId, n - 1, holdMs);
  run.assert("s1.stable", `nobody drops below ${n - 1} online during ${holdMs / 1000} s`, Object.keys(drops).length === 0, { drops });

  const mesh = await meshSnapshot(ctx, serverId, ctx.clients);
  run.section("Visibility matrix (D direct, R relayed, F failed, . not seen)", mesh.matrix.markdown);

  const round = await messageRound(ctx, serverId, ctx.clients, ctx.clients, { perClient, label: "s1-reach", timeoutMs: 120_000, staggerMs: 50 });
  run.assert("s1.messages", "a message from every client reaches every other client within 120 s", round.undelivered.length === 0 && round.failedPosts.length === 0, {
    undelivered: round.undelivered, failedPosts: round.failedPosts.length, latency: round.latency,
  });
  const conv = await convergence(ctx, serverId, ctx.clients);
  run.assert("s1.converged", "every client has the same commits", conv.sameCommits, { commitGroups: conv.commitGroups, counts: conv.commitCounts });

  const dumps = await collect(ctx, [serverId]);
  const agg = aggregate(dumps, serverId);
  run.number("join", {
    mode, n,
    dataMs: setup.data.stats, visibleMs: setup.visible.stats, membersMs: setup.members.stats,
    appLog: appLogTimes(ctx, serverId),
    perClient: Object.fromEntries(ctx.clients.map((c) => [short(c.name), {
      dataMs: setup.data.perClient[c.name] ?? null, visibleMs: setup.visible.perClient[c.name] ?? null,
      membersMs: setup.members.perClient[c.name] ?? null, joinCall: setup.joins[c.name] ?? null,
    }])),
  });
  run.number("mesh", mesh.matrix.counts);
  run.number("messages", { latency: round.latency, allArrivedMs: round.allArrivedMs, perReceiver: round.perReceiver });
  run.number("traffic", agg);
  return { serverId, clients: dumps };
}

// Watches the poller's states for `ms`; returns { client: { min, drops } } for clients that fell below `target`
// (a number, or (clientName) => number).
export async function hold(ctx, serverId, target, ms) {
  const want = typeof target === "function" ? target : () => target;
  const until = Date.now() + ms;
  const out = {};
  let lastT = {};
  while (Date.now() < until) {
    for (const c of ctx.clients) {
      const s = c.lastState;
      if (!s || s.t === lastT[c.name]) continue;
      lastT[c.name] = s.t;
      const online = s.servers[serverId]?.online ?? 0;
      if (online < want(c.name)) {
        const e = (out[c.name] ??= { min: online, drops: 0, firstAt: s.t });
        e.min = Math.min(e.min, online);
        e.drops++;
      }
    }
    await sleep(500);
  }
  return out;
}

// The app's own "[sync] … first member found after X s" and "server data received after X s" lines.
export function appLogTimes(ctx, serverId) {
  const key = serverId.slice(0, 8);
  const first = [];
  const data = [];
  for (const c of ctx.clients) {
    for (const e of c.syncLog ?? []) {
      if (e.server8 !== key) continue;
      if (e.what === "first-member") first.push(e.s * 1000);
      if (e.what === "data") data.push(e.s * 1000);
    }
  }
  return { firstMemberFound: stats(first), dataReceived: stats(data) };
}
