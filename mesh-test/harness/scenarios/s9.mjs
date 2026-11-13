// S9 larger networks (up.sh --nodes 3 --bots B): members connect to the nodes instead of to each other (hub), the
// nodes split the files (`copies` each), heal when one is gone, and members fall back to connecting to each other
// when no node is reachable.
//   Join      everyone joins at once: history, online counts, connections per member (expect: the nodes only, and
//             with more than 3 nodes only the nodes of the member's group), files (each node keeps its share, in pieces
//             with --stripe-mb below --file-mb, with parity with --parity), messages, convergence.
//   Heal      one node is killed; the owner adds files (members still get them); after the node's heal-after time the
//             others copy its files, until no file has fewer copies than asked.
//   Fallback  (skipped above --fallback-max members) all nodes are stopped: members join the member room (above 12
//             members a grid of rooms, so each connects to about 2·sqrt(2n)) and still sync; the nodes come back:
//             members return to the hub.
//   Call      two apps join a voice channel: they connect to each other directly (call room).
import * as d from "../lib/driver.mjs";
import { BotClient, eachBot } from "../lib/bots.mjs";
import { NodeHandle, sampleNodes } from "../lib/nodes.mjs";
import { attempt, intArg, log, mapLimit, seconds, sleep, stats } from "../lib/util.mjs";
import { mdTable, prepare, short } from "./common.mjs";
import { hostServer, mixedRound, phaseTable, resourcePeaks, resourceTable, swarm, waitFiles } from "./s8.mjs";

export default async function s9(ctx) {
  const { run, args, podman, topology } = ctx;
  const history = intArg(args, "history", 1000);
  const fileCount = intArg(args, "files", 8);
  const fileMb = intArg(args, "file-mb", 2);
  const copies = intArg(args, "copies", 2);
  const perClient = intArg(args, "messages", 2);
  const fallbackMax = intArg(args, "fallback-max", 100);
  // --stripe-mb N: files over N MiB are kept in 4 MiB pieces (below 20480 needs up.sh --min-stripe-mb); --parity P:
  // one parity piece per P pieces.
  const stripeMb = intArg(args, "stripe-mb", -1);
  const parity = intArg(args, "parity", 0);
  const storage = stripeMb >= 0 || parity > 0 ? { copies, stripe_mb: stripeMb >= 0 ? stripeMb : 20 * 1024, parity } : null;
  const striped = storage !== null && storage.stripe_mb > 0 && fileMb > storage.stripe_mb;
  const healMin = Number(topology.healAfterMin ?? 15);
  const nodes = (topology.nodes ?? []).map((spec) => new NodeHandle(spec, podman));
  const bots = (topology.bots ?? []).map((spec) => new BotClient(spec));
  if (nodes.length < 3 || ctx.clients.length < 3) {
    run.assert("s9.setup", "at least 3 nodes and 3 apps (up.sh <apps> single --nodes 3 --bots B --heal-after 1)", false);
    return {};
  }
  run.clients = [...ctx.clients, ...bots];
  ctx.nodeHandles = nodes;
  const sampler = sampleNodes(run, nodes);
  const phases = {};
  const out = { phases };
  try {
    await prepare(ctx);
    const [owner, ...apps] = ctx.clients;
    run.number("setup", { apps: ctx.clients.length, bots: bots.length, nodes: nodes.length, members: ctx.clients.length + bots.length, history, files: fileCount, fileMb, copies, storage, healMin });
    // Files are split from 20 GB in real use; a test threshold under that needs the nodes started with it (up.sh
    // --min-stripe-mb) and the same in the owner's app (set-storage, piece lists of its uploads).
    if (storage && storage.stripe_mb > 0 && storage.stripe_mb < 20 * 1024) {
      const minMb = topology.minStripeMb ?? null;
      const ok = minMb !== null && minMb <= storage.stripe_mb;
      run.assert("s9.min-stripe", `the nodes split from ${minMb ?? "20480 (default)"} MB, at most --stripe-mb ${storage.stripe_mb}`, ok, { minMb });
      if (!ok) return out;
      await d.setTestMinStripe(owner, minMb);
    }

    const server = await hostServer(ctx, "s9", owner, nodes, { history, files: fileCount, fileMb, copies, storage });
    if (!server) return out;
    const { serverId } = server;
    phases.split = await storageSplit(nodes, serverId, server.hashes.length, copies, striped);
    run.assert("s9.split", striped
      ? `the nodes keep ${server.hashes.length} files in pieces (${parity ? `parity per ${parity}` : `${copies} copies`}), none missing or below`
      : `the nodes split the files: ${server.hashes.length} files x ${copies} copies, none below`, phases.split.ok, phases.split);

    // ---- Join ----
    phases.join = await swarm(ctx, "join", server, apps, bots, [owner, ...apps], { dataTimeoutMs: 240_000, perClient });
    await sleep(20_000); // members that joined the member room before a node was known leave it after 15 s
    phases.join.connections = await connections(ctx, serverId, [owner, ...apps], bots, perMember(nodes.length));
    run.assert("s9.hub", nodes.length > 3
      ? `every member connects to the nodes of its group (${perMember(nodes.length)} of ${nodes.length}) and no other member`
      : `every member connects to the ${nodes.length} nodes and no other member`, phases.join.connections.onlyNodes,
      { notOnlyNodes: phases.join.connections.notOnlyNodes, direct: phases.join.connections.direct });

    // ---- Heal ----
    phases.heal = await heal(ctx, server, owner, apps, bots, nodes, healMin, copies, striped);

    // ---- Fallback ----
    const total = ctx.clients.length + bots.length;
    if (total <= fallbackMax) phases.fallback = await fallback(ctx, server, [owner, ...apps], bots, nodes, perClient);
    else {
      phases.fallback = { skipped: `${total} members > --fallback-max ${fallbackMax} (a full mesh of them would overload this host)` };
      for (const node of nodes) if (node.down) await node.start();
    }

    // ---- Call ----
    phases.call = await call(ctx, serverId, apps.slice(0, 2));
  } finally {
    await sampler.stop();
    const nodeLogs = {};
    for (const node of nodes) nodeLogs[node.name] = await node.scanLog();
    const botWarnings = {};
    // The warnings' text too (a count alone didn't say which emitter), a few per bot.
    const botSamples = {};
    for (const [name, r] of Object.entries(await eachBot(bots, (bot) => bot.status()))) {
      if (!r.ok) continue;
      for (const [kind, n] of Object.entries(r.value.warnings ?? {})) botWarnings[kind] = (botWarnings[kind] ?? 0) + n;
      if (r.value.lastWarnings?.length) botSamples[name] = r.value.lastWarnings;
    }
    const maxListeners = Object.values(nodeLogs).reduce((n, l) => n + (l.counts.maxListeners ?? 0), 0) + (botWarnings.MaxListenersExceededWarning ?? 0);
    run.assert("s9.no-max-listeners", "no MaxListenersExceededWarning in any node or bot", maxListeners === 0, { bots: botWarnings, samples: botSamples });
    out.resources = resourcePeaks(run, Object.fromEntries(Object.entries(phases).filter(([, p]) => p?.startedAt)), sampler.samples);
    run.number("nodes", { logs: Object.fromEntries(Object.entries(nodeLogs).map(([n, l]) => [n, { counts: l.counts, samples: l.samples }])), resources: out.resources });
    run.number("phases", phases);
    run.section("Join", phaseTable({ join: phases.join }));
    run.section("Nodes and host", resourceTable(out.resources));
    run.section("Connections per member", phases.join?.connections ? mdTable(["", "Direct connections"], [
      ["apps", `p50 ${phases.join.connections.apps.p50} / max ${phases.join.connections.apps.max}`],
      ["bots", `p50 ${phases.join.connections.bots.p50} / max ${phases.join.connections.bots.max}`],
      ...(phases.fallback?.direct ? [["bots without nodes", `p50 ${phases.fallback.direct.p50} / max ${phases.fallback.direct.max} (of ${phases.fallback.direct.others} others)`]] : []),
    ]) : "–");
  }
  return out;
}

// Nodes each member connects to: all of them, or with more than 3 its group (p2p/nodeGroups.ts: groups of at most 3,
// sizes differing by one at most, so the smallest has this many).
function perMember(nodeCount) {
  return nodeCount <= 3 ? nodeCount : Math.floor(nodeCount / Math.ceil(nodeCount / 3));
}

// What each node keeps of the server's files (status.json), and whether that adds up to `copies` of each. Striped
// files are kept in pieces spread over the nodes, so there the check is that no node lacks any of its share, no file
// is short of a piece or a copy, and no node holds a striped file whole.
async function storageSplit(nodes, serverId, files, copies, striped = false) {
  const per = {};
  let kept = 0;
  let below = 0;
  let missing = 0;
  let pieces = 0;
  let wholeStriped = 0;
  for (const node of nodes) {
    const info = (await node.status().catch(() => null))?.servers?.[serverId];
    per[node.name] = info ? { kept: info.kept, cached: info.cached, missing: info.missing, below: info.below, pieces: info.pieces ?? 0, wholeStriped: info.wholeStriped ?? 0 } : null;
    kept += info?.kept ?? 0;
    below = Math.max(below, info?.below ?? 0);
    missing += info?.missing ?? 0;
    pieces += info?.pieces ?? 0;
    wholeStriped += info?.wholeStriped ?? 0;
  }
  const expected = files * Math.min(copies, nodes.filter((n) => !n.down).length);
  const ok = striped ? missing === 0 && below === 0 && pieces > 0 && wholeStriped === 0 : kept === expected && below === 0;
  return { per, kept, expected: striped ? null : expected, pieces, wholeStriped, ok };
}

// Direct connections per member: in the hub, only the nodes (`nodeCount` of them at most).
async function connections(ctx, serverId, apps, bots, nodeCount) {
  const direct = {};
  const notOnlyNodes = [];
  await mapLimit(apps.filter((c) => !c.down), 10, async (c) => {
    const r = await attempt(() => d.rooms(c, serverId));
    if (!r.ok || !r.value) return;
    direct[short(c.name)] = r.value.direct.length;
  });
  for (const bot of bots) {
    const s = bot.lastState?.servers?.[serverId];
    if (!s) continue;
    direct[short(bot.name)] = s.direct;
    if (s.direct !== s.directNodes || s.memberRoom) notOnlyNodes.push(short(bot.name));
  }
  for (const [name, n] of Object.entries(direct)) if (n > nodeCount && !notOnlyNodes.includes(name)) notOnlyNodes.push(name);
  const appsCount = Object.entries(direct).filter(([n]) => !n.startsWith("bot")).map(([, v]) => v);
  const botsCount = Object.entries(direct).filter(([n]) => n.startsWith("bot")).map(([, v]) => v);
  return { onlyNodes: notOnlyNodes.length === 0, notOnlyNodes, apps: stats(appsCount), bots: stats(botsCount), direct };
}

// One node down: files stay reachable, new ones too; after heal-after its files get their copies back elsewhere.
// The file checks and the heal watch run side by side.
async function heal(ctx, server, owner, apps, bots, nodes, healMin, copies, striped) {
  const { run } = ctx;
  const result = { startedAt: Date.now() };
  const victim = nodes[2];
  const left = nodes.filter((n) => n !== victim);
  await victim.kill();
  run.event("node-killed", { node: victim.name });
  const killedAt = Date.now();
  // New files while a node is down: kept by the nodes left.
  const added = await d.uploadFiles(owner, server.serverId, server.channelId, 2, 1);
  const hashes = [...server.hashes, ...added.hashes];

  const watch = (async () => {
    const deadline = killedAt + healMin * 60_000 + 300_000;
    let maxBelow = 0;
    while (Date.now() < deadline) {
      // The files added meanwhile are small (whole files), the first ones maybe in pieces.
      const split = await storageSplit(left, server.serverId, hashes.length, copies, striped);
      const below = Math.max(...Object.values(split.per).map((p) => p?.below ?? 0));
      maxBelow = Math.max(maxBelow, below);
      if (Date.now() > killedAt + healMin * 60_000 && split.ok)
        return { healedMs: Date.now() - killedAt, maxBelow, split };
      await sleep(5_000);
    }
    return { healedMs: null, maxBelow };
  })();

  await eachBot(bots, (bot) => bot.fetchFiles(server.serverId));
  const filesStart = Date.now();
  const [appsFiles, botsFiles] = await Promise.all([
    waitFiles(apps, hashes, filesStart, 240_000),
    run.waitTracker(run.track("heal: bots hold every file", bots.map((b) => b.name), (s) => (s.servers?.[server.serverId]?.held ?? 0) >= hashes.length, { startedAt: filesStart }), 240_000),
  ]);
  result.filesDuringOutage = { appsMissing: appsFiles.missing.length, botsMissing: botsFiles.missing.length, apps: stats(Object.values(appsFiles.perClient)), bots: stats(Object.values(botsFiles.perClient)) };
  run.assert("s9.heal.reachable", "with a node down, every member still gets every file (old and new)", appsFiles.missing.length === 0 && botsFiles.missing.length === 0, result.filesDuringOutage);

  Object.assign(result, await watch);
  run.assert("s9.heal.copies", `after ${healMin} min the nodes left copy the gone node's files (every file ${copies} copies again)`, result.healedMs !== null,
    { healedMs: result.healedMs, maxBelow: result.maxBelow });
  log(`heal: up to ${result.maxBelow} files below their copies, healed ${seconds(result.healedMs)} after the kill (heal-after ${healMin} min)`);
  await victim.start();
  run.event("node-started", { node: victim.name });
  result.endedAt = Date.now();
  return result;
}

// Every node stopped: members connect to each other (member room) and keep syncing; nodes back: members return.
async function fallback(ctx, server, apps, bots, nodes, perClient) {
  const { run } = ctx;
  const result = { startedAt: Date.now() };
  for (const node of nodes) if (!node.down) await node.kill();
  run.event("nodes-down", {});
  const t0 = Date.now();
  const inRoom = run.track("fallback: in the member room", bots.map((b) => b.name), (s) => s.servers?.[server.serverId]?.memberRoom === true, { startedAt: t0 });
  const res = await run.waitTracker(inRoom, 90_000);
  result.memberRoomMs = res.allMs;
  // Above 12 members, a grid of rooms: each bot's direct connections, once they settled.
  await sleep(15_000);
  const others = apps.length + bots.length - 1;
  result.direct = { ...stats(bots.map((b) => b.lastState?.servers?.[server.serverId]?.direct).filter((n) => typeof n === "number")), others };
  log(`fallback: bots connect directly to p50 ${result.direct.p50} / max ${result.direct.max} of ${others} other members`);
  result.messages = await mixedRound(ctx, server.serverId, apps.filter((c) => !c.down), bots, "fallback-msg", perClient);
  run.assert("s9.fallback", "with no node, members connect to each other and messages still reach everyone", res.missing.length === 0 && result.messages.undelivered === 0,
    { memberRoomMissing: res.missing, undelivered: result.messages.undelivered, latency: result.messages.latency });

  for (const node of nodes) await node.start();
  run.event("nodes-up", {});
  const t1 = Date.now();
  const back = run.track("return: back in the hub", bots.map((b) => b.name),
    (s) => s.servers?.[server.serverId]?.memberRoom === false && (s.servers?.[server.serverId]?.directNodes ?? 0) >= perMember(nodes.length), { startedAt: t1 });
  const backRes = await run.waitTracker(back, 180_000);
  result.backMs = backRes.allMs;
  result.afterMessages = await mixedRound(ctx, server.serverId, apps.filter((c) => !c.down), bots, "return-msg", perClient);
  run.assert("s9.return", "when the nodes are back, members leave the member room and messages still reach everyone", backRes.missing.length === 0 && result.afterMessages.undelivered === 0,
    { notBack: backRes.missing, undelivered: result.afterMessages.undelivered });
  result.endedAt = Date.now();
  return result;
}

// Two apps in a call connect to each other directly (call room).
async function call(ctx, serverId, pair) {
  const { run } = ctx;
  const result = {};
  if (pair.length < 2) return result;
  const [a, b] = pair;
  const joined = await Promise.all(pair.map((c) => attempt(() => d.joinCall(c, serverId))));
  let direct = false;
  for (let i = 0; i < 30 && !direct; i++) {
    const [ra, rb] = await Promise.all([attempt(() => d.rooms(a, serverId)), attempt(() => d.rooms(b, serverId))]);
    direct = ra.ok && rb.ok && ra.value && rb.value && ra.value.direct.includes(rb.value.self) && rb.value.direct.includes(ra.value.self);
    if (!direct) await sleep(1_000);
  }
  result.direct = direct;
  await Promise.all(pair.map((c) => attempt(() => d.leaveCall(c))));
  run.assert("s9.call", "two members in a call connect to each other directly", direct, { joined: joined.map((j) => j.ok ? j.value : j.error) });
  return result;
}
