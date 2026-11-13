// S5 mesh relay fallback across LANs (topologies split-bridge, split-chain). Clients on different LANs can't
// connect directly; members on two LANs ("bridges") can pass things along (mesh.ts: one hop, after 15 s or a
// failed attempt). Expectations:
//  split-bridge: every member reaches every other directly or relayed through a bridge; messages cross LANs.
//  split-chain (lan-a – bridge – lan-b – bridge – lan-c): lan-a and lan-c have no common neighbour, so mesh.ts
//  can't relay (one hop) and the online count misses them; commits still cross by forwarding hop by hop.
import { compareText, intArg } from "../lib/util.mjs";
import {
  aggregate, collect, convergence, isBridge, lansOf, latencyByLan, meshSnapshot, messageRound, prepare, setupServer, short,
} from "./common.mjs";
import { hold } from "./s1.mjs";

export default async function s5(ctx) {
  const { run, args, topology } = ctx;
  const perClient = intArg(args, "messages", 1);
  await prepare(ctx);
  const n = ctx.clients.length;
  const bridges = ctx.clients.filter(isBridge);
  const plain = ctx.clients.filter((c) => !isBridge(c));
  const lans = [...new Set(plain.flatMap(lansOf))].sort(compareText);
  run.number("layout", { topology: topology.topology, lans, bridges: bridges.map((c) => `${short(c.name)}:${lansOf(c).join("+")}`) });
  if (bridges.length === 0 || lans.length < 2) {
    run.assert("s5.topology", "topology has at least two LANs and a bridge member", false, { lans, bridges: bridges.length });
    return {};
  }
  // Who should be able to see whom: same LAN, or relayed by a member on both their LANs (one hop).
  const reachable = (a, b) => {
    const share = (x, y) => lansOf(x).some((l) => lansOf(y).includes(l));
    if (share(a, b)) return "direct";
    return ctx.clients.some((m) => m !== a && m !== b && share(m, a) && share(m, b)) ? "relay" : "none";
  };
  const unreachablePairs = [];
  for (const a of ctx.clients) for (const b of ctx.clients) if (a !== b && reachable(a, b) === "none") unreachablePairs.push([short(a.name), short(b.name)]);
  const reachableCount = (name) => ctx.clients.filter((o) => o.name !== name && reachable(ctx.byName[name], o) !== "none").length;
  const chain = topology.topology === "split-chain" || lans.length > 2 || unreachablePairs.length > 0;

  // Owner on the first LAN, not a bridge, so the data itself has to cross.
  const owner = plain.find((c) => lansOf(c)[0] === lans[0]) ?? ctx.clients[0];
  const joiners = ctx.clients.filter((c) => c !== owner);
  const setup = await setupServer(ctx, owner, joiners, {
    mode: "burst", label: "s5", dataTimeoutMs: 240_000, visibleTimeoutMs: 300_000, expectedOnline: chain ? reachableCount : null,
  });
  if (!setup) return {};
  const { serverId } = setup;

  run.assert("s5.data", "every member gets the server data across LANs (240 s)", setup.data.missing.length === 0, { missing: setup.data.missing, stats: setup.data.stats });
  const mesh = await meshSnapshot(ctx, serverId, ctx.clients);
  run.section("Visibility matrix (D direct, R relayed, F failed, . not seen)", mesh.matrix.markdown);

  if (!chain) {
    run.assert("s5.visible", `every member counts all ${n - 1} others online (direct or relayed) within 300 s`, setup.visible.missing.length === 0, {
      missing: setup.visible.missing, stats: setup.visible.stats,
    });
  } else {
    const ends = ctx.clients.filter((c) => !isBridge(c) && (lansOf(c)[0] === lans[0] || lansOf(c)[0] === lans.at(-1)));
    const endsSee = ends.every((c) => (c.lastState?.servers[serverId]?.online ?? 0) >= n - 1);
    run.assert("s5.chain.ends-visible", `members two hops apart (${lans[0]} ↔ ${lans.at(-1)}) count each other online`, endsSee, {
      unreachablePairs: unreachablePairs.length, online: Object.fromEntries(ends.map((c) => [short(c.name), c.lastState?.servers[serverId]?.online ?? null])), expected: n - 1,
    });
    run.assert("s5.chain.one-hop-visible", "every member counts everyone within one hop online (300 s)", setup.visible.missing.length === 0, {
      missing: setup.visible.missing, stats: setup.visible.stats,
    });
  }
  const drops = await hold(ctx, serverId, chain ? reachableCount : n - 1, 30_000);
  run.assert("s5.stable", "online counts hold for 30 s", Object.keys(drops).length === 0, { drops });

  const round = await messageRound(ctx, serverId, ctx.clients, ctx.clients, { perClient, label: "s5-cross", timeoutMs: 180_000, staggerMs: 50 });
  const byLan = latencyByLan(ctx, round.samples);
  run.assert("s5.messages", "messages from every LAN reach every member (180 s)", round.undelivered.length === 0 && round.failedPosts.length === 0, {
    undelivered: round.undelivered, byLan,
  });
  const conv = await convergence(ctx, serverId, ctx.clients);
  run.assert("s5.converged", "every member ends with the same commits", conv.sameCommits, { commitGroups: conv.commitGroups });

  const dumps = await collect(ctx, [serverId]);
  run.number("visibility", {
    dataMs: setup.data.stats, visibleMs: setup.visible.stats, perClient: setup.visible.perClient, matrix: mesh.matrix.counts,
    unreachablePairs: unreachablePairs.length,
  });
  run.number("messages", { latency: round.latency, byLan });
  run.number("traffic", aggregate(dumps, serverId));
  return { serverId, clients: dumps };
}
