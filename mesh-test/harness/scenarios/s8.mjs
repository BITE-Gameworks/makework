// S8 nodes under a swarm: MakeWork nodes (the built dist-node, up.sh --nodes) host a server with a long history and
// some files, then every Electron client and every headless bot (up.sh --bots) joins at once.
//   Phase A  owner online: the nodes share the load with the owner.
//   Phase B  owner offline: a second server, hosted the same way, then the owner's container is killed before the
//            swarm joins, so the nodes are the only source of history and files.
//   Restart  node1 is killed while B is settled, members post meanwhile, node1 comes back and catches up.
// Measured: time to the full history and to every file (Electron and bots apart), where bots got files from
// (node or member, "busy" answers), message latency, convergence, node CPU/memory/network (podman-stats.csv), the
// nodes' sync scheduler (nodes.csv), host load (host.csv), warnings in node and bot logs.
import fs from "node:fs";
import path from "node:path";
import * as d from "../lib/driver.mjs";
import { BotClient, eachBot } from "../lib/bots.mjs";
import { NodeHandle, sampleNodes } from "../lib/nodes.mjs";
import { attempt, intArg, log, mapLimit, seconds, sleep, stats } from "../lib/util.mjs";
import { channelOf, kill, mdTable, prepare, short } from "./common.mjs";

export default async function s8(ctx) {
  const { run, args, podman, topology } = ctx;
  const history = intArg(args, "history", 3000);
  const fileCount = intArg(args, "files", 6);
  const fileMb = intArg(args, "file-mb", 4);
  const perClient = intArg(args, "messages", 3);
  const restart = !args["no-restart"];
  const nodes = (topology.nodes ?? []).map((spec) => new NodeHandle(spec, podman));
  const bots = (topology.bots ?? []).map((spec) => new BotClient(spec));
  if (nodes.length === 0) {
    run.assert("s8.setup", "the environment has nodes (up.sh --nodes 2)", false);
    return {};
  }
  if (ctx.clients.length < 2) {
    run.assert("s8.setup", "at least 2 Electron clients (owner and the side server's owner)", false);
    return {};
  }
  // The poller and trackers cover bots too.
  run.clients = [...ctx.clients, ...bots];
  ctx.nodeHandles = nodes;
  const sampler = sampleNodes(run, nodes);
  const phases = {};
  const out = { phases };
  try {
    await prepare(ctx);
    const [owner, second] = ctx.clients;
    const electronJoiners = ctx.clients.slice(1);
    run.number("setup", { electron: ctx.clients.length, bots: bots.length, nodes: nodes.length, history, files: fileCount, fileMb, members: ctx.clients.length + bots.length });

    // A side server on the last node, so its scheduler serves two servers.
    const sideNode = nodes.at(-1);
    const side = await hostServer(ctx, "s8-side", second, [sideNode], { history: 300, files: 1, fileMb: 1 });
    out.side = side && { serverId: side.serverId, hostMs: side.hostMs };

    // ---- Phase A: owner online ----
    const a = await hostServer(ctx, "s8-A", owner, nodes, { history, files: fileCount, fileMb });
    if (!a) return out;
    phases.A = await swarm(ctx, "A", a, electronJoiners, bots, [owner, ...electronJoiners], { dataTimeoutMs: 240_000, perClient });
    phases.A.hostMs = a.hostMs;
    await leaveEverywhere(ctx, a.serverId, [owner, ...electronJoiners], bots);

    // ---- Phase B: owner offline ----
    const b = await hostServer(ctx, "s8-B", owner, nodes, { history, files: fileCount, fileMb });
    if (!b) return out;
    await kill(ctx, owner);
    run.event("owner-offline", { serverId: b.serverId });
    await sleep(3000);
    phases.B = await swarm(ctx, "B", b, electronJoiners, bots, electronJoiners, { dataTimeoutMs: 360_000, perClient });
    phases.B.hostMs = b.hostMs;

    // ---- Node restart during B ----
    if (restart) phases.restart = await restartNode(ctx, b, nodes[0], electronJoiners, bots, perClient);
  } finally {
    await sampler.stop();
    const nodeLogs = {};
    for (const node of nodes) nodeLogs[node.name] = await node.scanLog();
    const botWarnings = {};
    // The warnings' text too (a count alone didn't say which emitter), a few per bot.
    const botSamples = {};
    const botFinal = await eachBot(bots, (bot) => bot.status());
    for (const [name, r] of Object.entries(botFinal)) {
      if (!r.ok) continue;
      for (const [kind, n] of Object.entries(r.value.warnings ?? {})) botWarnings[kind] = (botWarnings[kind] ?? 0) + n;
      if (r.value.lastWarnings?.length) botSamples[name] = r.value.lastWarnings;
      botWarnings.unhandled = (botWarnings.unhandled ?? 0) + (r.value.unhandled ?? 0);
    }
    const botResources = Object.values(botFinal).filter((r) => r.ok).map((r) => r.value.rss);
    out.nodeLogs = nodeLogs;
    out.botWarnings = botWarnings;
    out.resources = resourcePeaks(run, phases, sampler.samples);
    out.botRss = stats(botResources);
    const maxListeners = Object.values(nodeLogs).reduce((n, l) => n + (l.counts.maxListeners ?? 0), 0) + (botWarnings.MaxListenersExceededWarning ?? 0);
    run.assert("s8.no-max-listeners", "no MaxListenersExceededWarning in any node or bot", maxListeners === 0, { nodes: Object.fromEntries(Object.entries(nodeLogs).map(([n, l]) => [n, l.counts])), bots: botWarnings, samples: botSamples });
    const expectedStarts = (name) => (restart && name === nodes[0].name && phases.restart ? 2 : 1);
    const crashed = Object.entries(nodeLogs).filter(([name, l]) => l.counts.started > expectedStarts(name)).map(([name]) => name);
    run.assert("s8.nodes-alive", "no node restarted on its own (crash)", crashed.length === 0, { crashed });
    run.number("nodes", { logs: Object.fromEntries(Object.entries(nodeLogs).map(([n, l]) => [n, { counts: l.counts, samples: l.samples }])), resources: out.resources });
    run.number("bots", { warnings: botWarnings, rss: out.botRss });
    run.number("phases", phases);
    run.section("Phases", phaseTable(phases));
    run.section("Nodes and host", resourceTable(out.resources));
  }
  return out;
}

// Creates a server on `owner`, writes the history and the files, has `nodes` host it, authorizes them and waits
// until every node holds the whole history and every file.
export async function hostServer(ctx, label, owner, nodes, { history, files, fileMb, copies = null, storage = null }) {
  const { run } = ctx;
  const created = await attempt(() => d.createServer(owner, label));
  if (!created.ok || !created.value.id) {
    run.assert(`s8.${label}.create`, `${short(owner.name)} creates ${label}`, false, { error: created.error });
    return null;
  }
  const { id: serverId, invite } = created.value;
  run.watch(serverId);
  const channelId = await channelOf(owner, serverId);
  if (storage) await d.setStorage(owner, serverId, storage);
  else if (copies !== null) await d.setCopies(owner, serverId, copies);
  const seeded = await d.seedHistory(owner, serverId, channelId, history);
  const uploaded = files > 0 ? await d.uploadFiles(owner, serverId, channelId, files, fileMb) : { hashes: [], ms: 0 };
  log(`${label}: ${history} messages in ${seconds(seeded.ms)} (${seeded.commits} commits), ${files} x ${fileMb} MiB in ${seconds(uploaded.ms)}`);

  const hostStart = Date.now();
  for (const node of nodes) await d.addNode(owner, serverId, await node.code());
  run.event("hosted", { label, serverId, nodes: nodes.map((n) => n.name) });
  // Added nodes are authorized at once; this only catches any still waiting.
  const authorizeUntil = Date.now() + 240_000;
  let rows = [];
  while (Date.now() < authorizeUntil) {
    await attempt(() => d.authorizeNodes(owner, serverId));
    const r = await attempt(() => d.nodeRows(owner, serverId));
    rows = r.ok ? r.value : rows;
    if (rows.filter((x) => x.status === "authorized").length >= nodes.length) break;
    await sleep(2000);
  }
  const authorized = rows.filter((x) => x.status === "authorized").length;
  const target = (await d.ledgerInfo(owner, serverId))?.count ?? seeded.commits;
  // Complete: every commit the owner had after seeding, nothing of its share of the files still to fetch, and no
  // file with fewer copies than asked (nodes split the files), as status.json (every 10 s) says.
  const hostMs = {};
  const completeUntil = Date.now() + 420_000;
  while (Date.now() < completeUntil && Object.keys(hostMs).length < nodes.length) {
    for (const node of nodes) {
      if (hostMs[node.name]) continue;
      const info = (await node.status().catch(() => null))?.servers?.[serverId];
      if (info && info.commits >= target && info.status === "authorized" && info.missing === 0 && (info.below ?? 0) === 0)
        hostMs[node.name] = Date.now() - hostStart;
    }
    if (Object.keys(hostMs).length < nodes.length) await sleep(2000);
  }
  run.assert(`s8.${label}.hosted`, `${nodes.length} node(s) authorized, with the whole history (${target} commits) and their share of ${uploaded.hashes.length} files`,
    authorized >= nodes.length && Object.keys(hostMs).length === nodes.length, { authorized, hostMs, target });
  log(`${label}: hosted by ${Object.entries(hostMs).map(([n, ms]) => `${n} ${seconds(ms)}`).join(", ") || "nobody"}`);
  return { label, serverId, invite, channelId, hashes: uploaded.hashes, target, hostMs, seedMs: seeded.ms, uploadMs: uploaded.ms };
}

// Everyone joins at once; full history, online counts, files, a message round, convergence.
export async function swarm(ctx, phase, server, electron, bots, senders, { dataTimeoutMs, perClient }) {
  const { run } = ctx;
  const { serverId, invite, hashes, target } = server;
  const members = [...electron, ...bots];
  const result = { members: members.length, electron: electron.length, bots: bots.length, startedAt: Date.now() };
  run.event("swarm-join", { phase, serverId, electron: electron.length, bots: bots.length });
  const t0 = Date.now();
  const dataTracker = run.track(`${phase}: full history (${target}+ commits)`, members.map((m) => m.name), (s) => (s.servers?.[serverId]?.commits ?? 0) >= target, { startedAt: t0 });
  // --wave N --wave-gap-s S: bots join N at a time, S seconds apart (default: all at once).
  const wave = intArg(ctx.args, "wave", 0);
  const gapMs = intArg(ctx.args, "wave-gap-s", 20) * 1000;
  const joinedAt = {};
  const joinBots = async () => {
    const out = {};
    const groups = wave > 0 ? Array.from({ length: Math.ceil(bots.length / wave) }, (_, i) => bots.slice(i * wave, (i + 1) * wave)) : [bots];
    for (const [i, group] of groups.entries()) {
      if (i > 0) await sleep(gapMs);
      for (const bot of group) joinedAt[bot.name] = Date.now() - t0;
      Object.assign(out, await eachBot(group, (bot) => bot.join(invite), 50));
    }
    return out;
  };
  for (const c of electron) joinedAt[c.name] = 0;
  const [electronJoins, botJoins] = await Promise.all([
    mapLimit(electron, 20, (c) => attempt(() => d.joinServer(c, invite))),
    joinBots(),
  ]);
  result.wave = wave ? { size: wave, gapMs } : null;
  const joinFailures = [
    ...electron.filter((_, i) => !electronJoins[i].ok).map((c) => c.name),
    ...Object.entries(botJoins).filter(([, r]) => !r.ok).map(([name]) => name),
  ];
  result.joinCallMs = Date.now() - t0;
  const waveSpanMs = wave > 0 ? (Math.ceil(bots.length / wave) - 1) * gapMs : 0;
  const data = await run.waitTracker(dataTracker, dataTimeoutMs + waveSpanMs);
  // From each member's own join (waves join later).
  const sinceJoin = Object.fromEntries(Object.entries(data.perClient).map(([name, ms]) => [name, ms === null ? null : ms - (joinedAt[name] ?? 0)]));
  result.data = splitStats(sinceJoin, bots);
  run.assert(`s8.${phase}.data`, `every member gets the full history (${seconds(dataTimeoutMs)})`, data.missing.length === 0 && joinFailures.length === 0, { missing: data.missing, joinFailures, stats: result.data });

  // Everyone online: the other members, the nodes, and the owner when online.
  const expectedOnline = members.length - 1 + ctx.topology.nodes.length + (phase === "A" ? 1 : 0);
  const online = await run.waitTracker(run.track(`${phase}: sees ${expectedOnline} online`, members.map((m) => m.name), (s) => (s.servers?.[serverId]?.online ?? 0) >= expectedOnline, { startedAt: t0 }), 120_000 + waveSpanMs);
  result.online = { ...splitStats(online.perClient, bots), missing: online.missing.length, expected: expectedOnline };
  result.onlineCounts = Object.fromEntries(members.map((m) => [short(m.name), m.lastState?.servers?.[serverId]?.online ?? null]));

  // Nodes host the server but aren't members (2026-10-12): the member list leaves them out, the Nodes page lists them.
  const lists = await mapLimit(electron.filter((c) => !c.down), 10, (c) => attempt(() => d.members(c, serverId)));
  const read = lists.filter((l) => l.ok).map((l) => l.value);
  const shownNodes = read.flatMap((l) => l.ui.filter((m) => m.node).map((m) => m.username));
  const knownNodes = read.map((l) => l.all.filter((m) => m.node).length);
  result.memberList = { read: read.length, shownNodes: shownNodes.length, knownNodes: stats(knownNodes) };
  run.assert(`s8.${phase}.nodes-hidden`, `the member list shows no node, and every member knows the ${ctx.topology.nodes.length} node(s)`,
    read.length > 0 && shownNodes.length === 0 && knownNodes.every((n) => n >= ctx.topology.nodes.length), { shownNodes, knownNodes, failedReads: lists.length - read.length });

  // Files: Electron clients sync the channel (auto-download), bots fetch every attachment (nodes first).
  if (hashes.length) {
    const f0 = Date.now();
    await Promise.all(electron.map((c) => attempt(() => d.syncChannel(c, serverId, server.channelId))));
    const botFetch = eachBot(bots, (bot) => bot.fetchFiles(serverId));
    const botFiles = run.track(`${phase}: bots hold ${hashes.length} files`, bots.map((b) => b.name), (s) => (s.servers?.[serverId]?.held ?? 0) >= hashes.length, { startedAt: f0 });
    const [electronFiles, botResult] = await Promise.all([
      waitFiles(electron, hashes, f0, 420_000),
      botFetch.then(() => run.waitTracker(botFiles, 420_000)),
    ]);
    const sources = { fromNode: 0, fromMember: 0, busy: 0, perFileMs: [] };
    for (const bot of bots) {
      const s = bot.lastState?.servers?.[serverId];
      if (!s) continue;
      sources.fromNode += s.fromNode ?? 0;
      sources.fromMember += s.fromMember ?? 0;
      sources.busy += s.busy ?? 0;
      sources.perFileMs.push(...(s.fetchMs ?? []));
    }
    result.files = {
      electron: { ...stats(Object.values(electronFiles.perClient)), missing: electronFiles.missing },
      bots: { ...stats(Object.values(botResult.perClient)), missing: botResult.missing },
      botSources: { fromNode: sources.fromNode, fromMember: sources.fromMember, busy: sources.busy, perFile: stats(sources.perFileMs) },
    };
    run.assert(`s8.${phase}.files`, `every member gets all ${hashes.length} files`, electronFiles.missing.length === 0 && botResult.missing.length === 0,
      { electronMissing: electronFiles.missing, botsMissing: botResult.missing, sources: result.files.botSources });
  }

  result.messages = await mixedRound(ctx, serverId, senders.filter((c) => !c.down), bots, `${phase}-msg`, perClient);
  run.assert(`s8.${phase}.messages`, "every message reaches every other member", result.messages.undelivered === 0 && result.messages.failedPosts === 0,
    { undelivered: result.messages.undelivered, failedPosts: result.messages.failedPosts, missed: result.messages.missed, latency: result.messages.latency });

  await sleep(25_000); // one re-hello round, then compare
  result.converged = await convergence(ctx, serverId, senders.filter((c) => !c.down), bots);
  run.assert(`s8.${phase}.converged`, "members have the same commits", result.converged.groups === 1, { groups: result.converged.groupSizes, nodeCommits: result.converged.nodes });
  result.ledger = await ledgerWork(electron.filter((c) => !c.down), serverId);
  result.endedAt = Date.now();
  return result;
}

// What the Electron clients' ledgers did for this server (instrumented Ledger.accept/replay): copies received per
// new commit (both nodes send a joiner the whole history), replays (a late commit replays the whole log) and time.
export async function ledgerWork(clients, serverId) {
  const per = [];
  await mapLimit(clients, 10, async (c) => {
    const r = await attempt(() => d.instrumentation(c, [serverId]));
    const a = r.ok ? r.value?.acc?.[serverId] : null;
    if (a) per.push(a);
  });
  const sum = (key) => per.reduce((n, a) => n + (a[key] ?? 0), 0);
  return {
    clients: per.length,
    copiesPerCommit: sum("fresh") ? +(sum("received") / sum("fresh")).toFixed(2) : null,
    dupFresh: sum("dupFresh"),
    replaysPerClient: stats(per.map((a) => a.replays)),
    replayMsPerClient: stats(per.map((a) => a.replayMs)),
    msPerReplay: sum("replays") ? Math.round(sum("replayMs") / sum("replays")) : null,
    acceptCallsPerClient: stats(per.map((a) => a.calls)),
  };
}

export async function waitFiles(clients, hashes, since, timeoutMs) {
  const perClient = {};
  const missing = [];
  await Promise.all(clients.map(async (c) => {
    while (Date.now() - since < timeoutMs) {
      const r = await attempt(() => d.contentHeld(c, hashes));
      if (r.ok && r.value >= hashes.length) {
        perClient[c.name] = Date.now() - since;
        return;
      }
      await sleep(2000);
    }
    perClient[c.name] = null;
    missing.push(c.name);
  }));
  return { perClient, missing };
}

// Electron and bots post `perClient` tagged messages each; arrival tracked by the poller, latency from each
// receiver's first-seen times.
export async function mixedRound(ctx, serverId, electron, bots, label, perClient) {
  const { run } = ctx;
  const prefix = `mwt|${run.runId.slice(-6)}|${label}|`;
  run.setPrefix(serverId, prefix);
  const tagsOf = (name) => Array.from({ length: perClient }, (_, k) => `${prefix}${short(name)}|${k}`);
  const t0 = Date.now();
  const posted = {};
  await Promise.all([
    mapLimit(electron, 20, async (c) => {
      const channelId = await channelOf(c, serverId);
      const r = channelId === null ? { ok: false, error: "no channel" } : await attempt(() => d.postTagged(c, serverId, channelId, tagsOf(c.name), 500));
      posted[c.name] = r.ok ? r.value : [{ ok: false, error: r.error }];
    }),
    eachBot(bots, async (bot) => {
      const r = await attempt(() => bot.postTagged(serverId, tagsOf(bot.name), 500));
      posted[bot.name] = r.ok ? r.value : [{ ok: false, error: r.error }];
    }),
  ]);
  const ok = Object.entries(posted).flatMap(([sender, list]) => list.filter((p) => p.ok).map((p) => ({ ...p, sender })));
  const failedPosts = Object.values(posted).flat().filter((p) => !p.ok).length;
  const receivers = [...electron, ...bots];
  const expectedFor = (name) => ok.filter((p) => p.sender !== name).length;
  const tracker = run.track(`${label}: all messages arrived`, receivers.map((r) => r.name),
    (s, name) => s.servers?.[serverId]?.seenPrefix === prefix && (s.servers?.[serverId]?.seen ?? 0) >= expectedFor(name), { startedAt: t0 });
  const arrival = await run.waitTracker(tracker, 180_000);
  const latencies = { electron: [], bots: [] };
  let undelivered = 0;
  // Tag -> the receivers that never saw it (apps and bots), to tell one lost message from a slow member.
  const missedBy = {};
  await mapLimit(receivers, 25, async (r) => {
    const seen = await attempt(() => (r.isBot ? r.seenTimes(serverId, prefix) : d.seenTimes(r, serverId, prefix)));
    for (const p of ok) {
      if (p.sender === r.name) continue;
      const at = seen.ok ? seen.value[p.tag] : undefined;
      if (at === undefined) {
        undelivered++;
        (missedBy[p.tag] ??= []).push(short(r.name));
      } else (r.isBot ? latencies.bots : latencies.electron).push(at - p.t);
    }
  });
  const missed = await missedMessages(serverId, prefix, electron, ok, missedBy);
  const all = [...latencies.electron, ...latencies.bots];
  log(`${label}: ${ok.length} posted, latency p50 ${seconds(stats(all).p50)} p95 ${seconds(stats(all).p95)}, ${undelivered} undelivered`);
  return { posted: ok.length, failedPosts, undelivered, missed, latency: stats(all), electron: stats(latencies.electron), bots: stats(latencies.bots), allArrivedMs: arrival.allMs };
}

// The missed messages (up to 10): who sent each, how many members missed it, and its row id as an app received it,
// with any other message inserted under the same id (the ledger refuses the second insert of an id, on every member;
// apps count a message when its commit arrives, bots when its row is in the table).
async function missedMessages(serverId, prefix, electron, ok, missedBy) {
  const tags = Object.keys(missedBy).slice(0, 10);
  if (tags.length === 0) return [];
  const reader = electron.find((c) => !c.down);
  const ids = reader ? await attempt(() => d.rowIds(reader, serverId, prefix)) : { ok: false };
  const idOf = ids.ok ? ids.value : {};
  return tags.map((tag) => {
    const id = idOf[tag] ?? null;
    const sameId = id === null ? [] : Object.keys(idOf).filter((other) => other !== tag && idOf[other] === id);
    return { tag, sender: short(ok.find((p) => p.tag === tag)?.sender ?? "?"), missedBy: missedBy[tag].length, id, sameId };
  });
}

export async function convergence(ctx, serverId, electron, bots) {
  const digests = {};
  await Promise.all(electron.map(async (c) => {
    const r = await attempt(() => d.ledgerInfo(c, serverId));
    digests[c.name] = r.ok && r.value ? `${r.value.count}:${r.value.setDigest}` : `error:${r.error ?? "none"}`;
  }));
  const botInfo = await eachBot(bots, (bot) => bot.ledgerInfo(serverId));
  for (const [name, r] of Object.entries(botInfo)) digests[name] = r.ok ? `${r.value.count}:${r.value.setDigest}` : `error:${r.error}`;
  const groups = {};
  for (const [name, digest] of Object.entries(digests)) (groups[digest] ??= []).push(short(name));
  const nodes = {};
  for (const node of ctx.nodeHandles ?? []) nodes[node.name] = (await node.status().catch(() => null))?.servers?.[serverId]?.commits ?? null;
  return { groups: Object.keys(groups).length, groupSizes: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k.slice(0, 16), v.length])), nodes };
}

export async function leaveEverywhere(ctx, serverId, electron, bots) {
  await Promise.all([
    mapLimit(electron, 10, (c) => attempt(() => d.leaveServer(c, serverId))),
    eachBot(bots, (bot) => bot.leave(serverId)),
  ]);
  ctx.run.unwatch(serverId);
  ctx.run.event("left", { serverId });
  await sleep(5000);
}

// Kills node1 while the swarm is in B, has members post meanwhile, starts it again and times its catch-up.
async function restartNode(ctx, server, node, electron, bots, perClient) {
  const { run } = ctx;
  const result = { node: node.name, startedAt: Date.now() };
  await node.kill();
  run.event("node-killed", { node: node.name });
  await sleep(5000);
  result.outageMessages = await mixedRound(ctx, server.serverId, electron, bots, "restart-outage", perClient);
  const reference = electron.find((c) => !c.down) ?? null;
  const target = reference ? (await d.ledgerInfo(reference, server.serverId))?.count ?? 0 : 0;
  const t0 = Date.now();
  await node.start();
  run.event("node-started", { node: node.name, target });
  let back = null;
  while (Date.now() - t0 < 180_000) {
    const info = (await node.status().catch(() => null));
    const s = info?.servers?.[server.serverId];
    if (info && info.at > t0 && s && s.commits >= target) {
      back = Date.now() - t0;
      break;
    }
    await sleep(2000);
  }
  result.target = target;
  result.backMs = back;
  run.assert("s8.restart", `${node.name} back with every commit (${target}) within 180 s of restarting`, back !== null, { backMs: back });
  await sleep(15_000); // let the sampler see the hello burst settle
  result.endedAt = Date.now();
  return result;
}

// Electron and bot times apart.
export function splitStats(perClient, bots) {
  const botNames = new Set(bots.map((b) => b.name));
  const e = [];
  const b = [];
  for (const [name, ms] of Object.entries(perClient)) (botNames.has(name) ? b : e).push(ms);
  return { electron: stats(e), bots: stats(b) };
}

// Peaks per phase window: node CPU/memory/network from podman-stats.csv, the scheduler from nodes.csv samples, host
// load and memory.
export function resourcePeaks(run, phases, samples) {
  const file = path.join(run.dir, "podman-stats.csv");
  const rows = fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").trim().split("\n").slice(1).map((l) => l.split(",")).map(([t, name, cpu, mem, netIn, netOut]) => ({ t: Number(t), name, cpu: Number(cpu), mem: Number(mem), netIn: Number(netIn), netOut: Number(netOut) }))
    : [];
  const out = {};
  for (const [phase, p] of Object.entries(phases)) {
    if (!p?.startedAt) continue;
    const end = p.endedAt ?? Date.now();
    const inWindow = (t) => t >= p.startedAt && t <= end;
    const perNode = {};
    for (const r of rows.filter((r) => inWindow(r.t) && r.name.startsWith("mwt-node"))) {
      const e = (perNode[r.name] ??= { cpuMax: 0, memMax: 0, netIn0: r.netIn, netOut0: r.netOut, netIn: 0, netOut: 0 });
      e.cpuMax = Math.max(e.cpuMax, r.cpu);
      e.memMax = Math.max(e.memMax, r.mem);
      e.netIn = r.netIn - e.netIn0;
      e.netOut = r.netOut - e.netOut0;
    }
    const bots = rows.filter((r) => inWindow(r.t) && r.name.startsWith("mwt-bots"));
    const clients = rows.filter((r) => inWindow(r.t) && r.name.startsWith("mwt-client"));
    for (const n of Object.values(perNode)) {
      delete n.netIn0;
      delete n.netOut0;
    }
    const sched = {};
    for (const s of samples.nodes.filter((s) => inWindow(s.t))) {
      // Network from the node's own /proc/net/dev (counters restart with the container).
      if (s.net) {
        const n = (perNode[s.node] ??= { cpuMax: 0, memMax: 0, netIn: 0, netOut: 0 });
        n.rx0 ??= s.net.rx;
        n.tx0 ??= s.net.tx;
        if (s.net.rx >= n.rx0) n.netIn = s.net.rx - n.rx0;
        if (s.net.tx >= n.tx0) n.netOut = s.net.tx - n.tx0;
      }
      const e = (sched[s.node] ??= { queuedMax: 0, activeMax: 0, limitMin: Infinity, limitMax: 0 });
      e.queuedMax = Math.max(e.queuedMax, s.sync.queued ?? 0);
      e.activeMax = Math.max(e.activeMax, s.sync.active ?? 0);
      e.limitMin = Math.min(e.limitMin, s.sync.limit ?? Infinity);
      e.limitMax = Math.max(e.limitMax, s.sync.limit ?? 0);
    }
    for (const n of Object.values(perNode)) {
      delete n.rx0;
      delete n.tx0;
    }
    const host = samples.host.filter((s) => inWindow(s.t));
    out[phase] = {
      nodes: perNode, scheduler: sched,
      botsCpuMaxPerContainer: Math.max(0, ...bots.map((r) => r.cpu)),
      clientsCpuMax: Math.max(0, ...clients.map((r) => r.cpu)),
      hostLoadMax: Math.max(0, ...host.map((s) => s.load1)),
      hostMemAvailableMin: host.length ? Math.min(...host.map((s) => s.available)) : null,
    };
  }
  return out;
}

const mb = (bytes) => (bytes === null || bytes === undefined ? "–" : `${(bytes / 1024 / 1024).toFixed(0)} MB`);

export function phaseTable(phases) {
  const rows = [];
  for (const [name, p] of Object.entries(phases)) {
    if (!p?.data) continue;
    rows.push([
      name, p.members,
      `${seconds(p.data.electron.p50)} / ${seconds(p.data.electron.max)}`, `${seconds(p.data.bots.p50)} / ${seconds(p.data.bots.max)}`,
      p.files ? `${seconds(p.files.electron.p50)} / ${seconds(p.files.electron.max)}` : "–",
      p.files ? `${seconds(p.files.bots.p50)} / ${seconds(p.files.bots.max)}` : "–",
      p.files ? `${p.files.botSources.fromNode} / ${p.files.botSources.fromMember} / ${p.files.botSources.busy}` : "–",
      `${seconds(p.messages.latency.p50)} / ${seconds(p.messages.latency.p95)}`, p.messages.undelivered, p.converged.groups,
    ]);
  }
  return mdTable(["Phase", "Members", "History p50/max (Electron)", "History p50/max (bots)", "Files p50/max (Electron)", "Files p50/max (bots)",
    "Bot files node/member/busy", "Message p50/p95", "Undelivered", "Commit groups"], rows);
}

export function resourceTable(resources) {
  const rows = [];
  for (const [phase, r] of Object.entries(resources)) {
    for (const [node, n] of Object.entries(r.nodes)) {
      const s = r.scheduler[node] ?? {};
      rows.push([phase, node, `${n.cpuMax.toFixed(0)}%`, mb(n.memMax), mb(n.netIn), mb(n.netOut),
        `${s.queuedMax ?? "–"} / ${s.activeMax ?? "–"}`, s.limitMax ? `${s.limitMin}–${s.limitMax}` : "–", r.hostLoadMax.toFixed(1), mb(r.hostMemAvailableMin)]);
    }
  }
  return mdTable(["Phase", "Node", "CPU max", "Memory max", "Net in", "Net out", "Queued / active max", "Limit", "Host load max", "Host mem free min"], rows);
}
