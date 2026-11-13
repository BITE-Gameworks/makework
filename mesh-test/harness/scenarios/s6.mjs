// S6 TURN fallback (topology split-turn): two LANs, no member on both, a TURN server reachable from both.
// Cross-LAN pairs can't connect directly and nobody can relay, so mesh.ts flags needsTurn, ice.ts fetches
// credentials (the local stub, never production) and the next connection attempt should go through TURN.
// Measures how long until the far LAN gets the data, sees everyone, and exchanges messages; checks that relay
// candidate pairs are actually in use.
import { compareText, intArg } from "../lib/util.mjs";
import { aggregate, collect, convergence, isBridge, lansOf, latencyByLan, meshSnapshot, messageRound, prepare, setupServer, short } from "./common.mjs";
import { hold } from "./s1.mjs";

export default async function s6(ctx) {
  const { run, args } = ctx;
  const perClient = intArg(args, "messages", 1);
  await prepare(ctx);
  const n = ctx.clients.length;
  const lans = [...new Set(ctx.clients.flatMap(lansOf))].sort(compareText);
  const bridges = ctx.clients.filter(isBridge);
  run.number("layout", { lans, bridges: bridges.length });
  if (lans.length < 2) {
    run.assert("s6.topology", "topology has at least two LANs", false, { lans });
    return {};
  }
  const owner = ctx.clients.find((c) => lansOf(c)[0] === lans[0]) ?? ctx.clients[0];
  const joiners = ctx.clients.filter((c) => c !== owner);
  const far = ctx.clients.filter((c) => !lansOf(c).includes(lansOf(owner)[0]));
  const setup = await setupServer(ctx, owner, joiners, { mode: "burst", label: "s6", dataTimeoutMs: 360_000, visibleTimeoutMs: 420_000 });
  if (!setup) return {};
  const { serverId } = setup;
  const farData = Object.fromEntries(far.map((c) => [short(c.name), setup.data.perClient[c.name] ?? null]));
  run.assert("s6.far-data", `members on the other LAN get the server data through TURN (360 s)`, far.every((c) => setup.data.perClient[c.name] !== null && setup.data.perClient[c.name] !== undefined), { farData });
  run.assert("s6.visible", `every member counts all ${n - 1} others online (420 s)`, setup.visible.missing.length === 0, { missing: setup.visible.missing, stats: setup.visible.stats });

  const drops = await hold(ctx, serverId, n - 1, 30_000);
  run.assert("s6.stable", "online counts hold for 30 s", Object.keys(drops).length === 0, { drops });
  const mesh = await meshSnapshot(ctx, serverId, ctx.clients);
  run.section("Visibility matrix (D direct, R relayed, F failed, . not seen)", mesh.matrix.markdown);

  const round = await messageRound(ctx, serverId, ctx.clients, ctx.clients, { perClient, label: "s6-cross", timeoutMs: 180_000, staggerMs: 50 });
  const byLan = latencyByLan(ctx, round.samples);
  run.assert("s6.messages", "messages cross between the LANs (180 s)", round.undelivered.length === 0 && round.failedPosts.length === 0, { undelivered: round.undelivered, byLan });
  const conv = await convergence(ctx, serverId, ctx.clients);
  run.assert("s6.converged", "every member ends with the same commits", conv.sameCommits, { commitGroups: conv.commitGroups });

  const dumps = await collect(ctx, [serverId]);
  const agg = aggregate(dumps, serverId);
  const relayPairs = Object.entries(agg.pcs.pairs).filter(([k]) => k.includes("relay")).reduce((a, [, v]) => a + v, 0);
  run.assert("s6.turn-used", "connections that use a TURN relay candidate exist", relayPairs > 0, { pairs: agg.pcs.pairs, withTurnConfig: agg.pcs.withTurn });
  const needsTurn = Object.fromEntries(ctx.clients.map((c) => [short(c.name), mesh.meshes[c.name]?.needsTurn ?? null]));
  run.number("turn", {
    farDataMs: farData, visibleMs: setup.visible.stats, perClientVisible: setup.visible.perClient, needsTurn, pairs: agg.pcs.pairs,
    pcsWithTurnConfig: agg.pcs.withTurn, pcFailures: agg.pcs.failedEver, latencyByLan: byLan, turnFetchLogs: turnLogs(ctx),
  });
  run.number("traffic", agg);
  return { serverId, clients: dumps };
}

// ice.ts warns "TURN credentials not loaded" on failure; sync.ts "Could not connect to member" per failed pair.
function turnLogs(ctx) {
  const out = {};
  for (const c of ctx.clients) {
    const tail = c.logTail ?? [];
    out[short(c.name)] = {
      credentialFailures: tail.filter((e) => e.m.includes("TURN credentials not loaded")).length,
      joinErrors: tail.filter((e) => e.m.includes("Could not connect to member")).length,
    };
  }
  return out;
}
