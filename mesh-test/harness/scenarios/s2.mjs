// S2 invites and several servers:
//  A: every client joins in a chain, each with the invite code read from the member who joined before it.
//  B..E: four servers with overlapping members (owners other than c01; B and C take codes from random members).
//  Every member posts in every server it is in; checks delivery per server and that nothing leaks between them.
//  Then a client that shares two servers (B and C) with another leaves B: B's members must see it go, while
//  it stays connected to everyone in C (Trystero shares one connection per peer across rooms).
import * as d from "../lib/driver.mjs";
import { attempt, compareText, intArg, sleep } from "../lib/util.mjs";
import { collect, convergence, meshSnapshot, messageRound, prepare, setupServer, short } from "./common.mjs";

export default async function s2(ctx) {
  const { run, args } = ctx;
  const perClient = intArg(args, "messages", 2);
  await prepare(ctx);
  const all = ctx.clients;
  const n = all.length;
  if (n < 4) {
    run.assert("s2.clients", "at least 4 clients", false, { have: n });
    return {};
  }

  // A: chain of invites.
  const chain = await setupServer(ctx, all[0], all.slice(1), { mode: "sequential", inviteFrom: "chain", label: "s2-A-chain" });
  if (!chain) return {};
  const fallbacks = Object.entries(chain.joins).filter(([, j]) => j.fallback).map(([name]) => name);
  run.assert("s2.chain.invites", "every member can hand out a working invite code (chain)", fallbacks.length === 0 && Object.values(chain.joins).every((j) => j.ok), { fallbacks, joins: summarizeJoins(chain.joins) });
  run.assert("s2.chain.data", "every client in the chain receives the server data", chain.data.missing.length === 0 && Object.values(chain.joins).every((j) => j.dataMs !== null), {
    perClient: Object.fromEntries(Object.entries(chain.joins).map(([name, j]) => [short(name), j.dataMs])),
  });
  run.assert("s2.chain.visible", `every client in A sees ${n - 1} online`, chain.visible.missing.length === 0, { missing: chain.visible.missing });

  // B..E: overlapping memberships.
  const pick = (from, to) => all.slice(Math.max(0, from), Math.min(n, to));
  const half = Math.ceil(n / 2);
  const sets = {
    B: pick(0, half),
    C: pick(Math.floor(n / 4), Math.floor((3 * n) / 4)),
    D: pick(half - 1, n),
    E: all.filter((_, i) => i % 2 === 1),
  };
  const servers = { A: { serverId: chain.serverId, members: all } };
  for (const [key, members] of Object.entries(sets)) {
    if (members.length < 2) continue;
    const owner = members[1] ?? members[0];
    const joiners = members.filter((c) => c !== owner);
    const mode = key === "B" || key === "C" ? "sequential" : "burst";
    const inviteFrom = key === "B" || key === "C" ? "random" : "owner";
    const s = await setupServer(ctx, owner, joiners, { mode, inviteFrom, label: `s2-${key}` });
    if (!s) continue;
    servers[key] = { serverId: s.serverId, members, setup: s };
    run.assert(`s2.${key}.visible`, `every member of ${key} (${members.length}) sees the others online and has the data`,
      s.data.missing.length === 0 && s.visible.missing.length === 0, { dataMissing: s.data.missing, visibleMissing: s.visible.missing });
  }

  // Everyone posts in every server it is in, all servers at once.
  const rounds = {};
  await Promise.all(Object.entries(servers).map(async ([key, s]) => {
    rounds[key] = await messageRound(ctx, s.serverId, s.members, s.members, { perClient, label: `s2-${key}-msg`, timeoutMs: 120_000 });
  }));
  for (const [key, r] of Object.entries(rounds)) {
    run.assert(`s2.${key}.messages`, `messages in ${key} reach all its members within 120 s`, r.undelivered.length === 0 && r.failedPosts.length === 0, {
      undelivered: r.undelivered, latency: r.latency,
    });
  }

  // Isolation: each client has exactly its servers; each server's channel only holds its own round's tags.
  const leaks = [];
  for (const c of all) {
    const expected = Object.values(servers).filter((s) => s.members.includes(c)).map((s) => s.serverId).sort(compareText);
    const open = await attempt(() => d.openServers(c));
    const have = open.ok ? [...open.value].sort(compareText) : [];
    if (JSON.stringify(have) !== JSON.stringify(expected)) leaks.push({ client: c.name, kind: "servers", have: have.length, expected: expected.length });
  }
  for (const [key, s] of Object.entries(servers)) {
    const conv = await convergence(ctx, s.serverId, s.members, key);
    servers[key].conv = conv;
    for (const [name, t] of Object.entries(conv.tags)) {
      const foreign = (t.tags ?? []).filter((tag) => !tag.includes(`|s2-${key}-`));
      if (foreign.length) leaks.push({ client: name, server: key, kind: "messages", examples: foreign.slice(0, 3) });
    }
    run.assert(`s2.${key}.converged`, `members of ${key} end with the same commits`, conv.sameCommits, { groups: conv.commitGroups });
  }
  run.assert("s2.isolation", "no client is in a server it didn't join and no message shows up in another server", leaks.length === 0, { leaks });

  // Leaving one of two shared servers.
  const leaveResult = await leaveOneOfTwo(ctx, servers);
  for (const [id, a] of Object.entries(leaveResult.assertions)) run.assert(id, a.description, a.pass, a.detail);

  const snapshots = {};
  for (const [key, s] of Object.entries(servers)) {
    const members = key === "B" && leaveResult.leaver ? s.members.filter((c) => c !== leaveResult.leaver) : s.members;
    snapshots[key] = await meshSnapshot(ctx, s.serverId, members);
    run.section(`Visibility in ${key}`, snapshots[key].matrix.markdown);
  }
  run.number("servers", Object.fromEntries(Object.entries(servers).map(([key, s]) => [key, {
    serverId: s.serverId, members: s.members.map((c) => short(c.name)),
    dataMs: s.setup?.data.stats ?? chain.data.stats, visibleMs: s.setup?.visible.stats ?? chain.visible.stats,
    latency: rounds[key]?.latency, commitCounts: s.conv?.commitCounts,
  }])));
  run.number("chain", summarizeJoins(chain.joins));
  run.number("leave", leaveResult.numbers);
  const ids = Object.values(servers).map((s) => s.serverId);
  return { servers: Object.fromEntries(Object.entries(servers).map(([k, s]) => [k, s.serverId])), clients: await collect(ctx, ids) };
}

async function leaveOneOfTwo(ctx, servers) {
  const { run } = ctx;
  const out = { assertions: {}, numbers: {}, leaver: null };
  const B = servers.B;
  const C = servers.C;
  if (!B || !C) return out;
  const both = B.members.filter((c) => C.members.includes(c));
  if (both.length < 2) {
    out.assertions["s2.leave.setup"] = { description: "two clients share servers B and C", pass: false, detail: { both: both.map((c) => c.name) } };
    return out;
  }
  const [leaver, partner] = both;
  out.leaver = leaver;
  const before = partner.lastState?.servers[C.serverId]?.online ?? null;
  const t0 = Date.now();
  run.event("leave", { client: leaver.name, server: "B", stays: "C", partner: partner.name });
  const left = await attempt(() => d.leaveServer(leaver, B.serverId));
  const stayB = B.members.filter((c) => c !== leaver);
  const goneTracker = run.track("s2-leave: B members see the leaver gone", stayB.map((c) => c.name), (s) => (s.servers[B.serverId]?.online ?? 99) <= stayB.length - 1, { startedAt: t0 });
  const gone = await run.waitTracker(goneTracker, 90_000);
  out.assertions["s2.leave.gone"] = {
    description: `B's other members count ${stayB.length - 1} online after ${short(leaver.name)} leaves B (within 90 s)`,
    pass: left.ok && gone.missing.length === 0, detail: { error: left.error, missing: gone.missing, perClient: gone.perClient },
  };
  // Still connected in C?
  await sleep(10_000);
  const cOnline = Object.fromEntries(C.members.map((c) => [short(c.name), c.lastState?.servers[C.serverId]?.online ?? null]));
  const full = C.members.length - 1;
  const stillThere = Object.values(cOnline).every((v) => v === full);
  out.assertions["s2.leave.c-online"] = {
    description: `everyone in C still sees ${full} online after ${short(leaver.name)} left B`, pass: stillThere, detail: { cOnline, partnerBefore: before },
  };
  const r = await messageRound(ctx, C.serverId, [leaver, partner], C.members, { perClient: 2, label: "s2-C-after-leave", timeoutMs: 60_000 });
  out.assertions["s2.leave.c-messages"] = {
    description: `${short(leaver.name)} and ${short(partner.name)} still exchange messages in C with everyone (60 s)`,
    pass: r.undelivered.length === 0 && r.failedPosts.length === 0, detail: { undelivered: r.undelivered, latency: r.latency },
  };
  const mesh = await meshSnapshot(ctx, C.serverId, [leaver, partner]);
  const direct = mesh.meshes[leaver.name]?.direct?.includes(partner.selfId) ?? false;
  out.numbers = { leaver: leaver.name, partner: partner.name, goneMs: gone.perClient, cOnline, directAfterLeave: direct, latency: r.latency };
  return out;
}

function summarizeJoins(joins) {
  return Object.fromEntries(Object.entries(joins).map(([name, j]) => [short(name), { from: short(j.from ?? ""), ok: j.ok, dataMs: j.dataMs ?? null, error: j.error }]));
}
