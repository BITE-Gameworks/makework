// S11 calls at scale (up.sh 12 single --nodes 4 [--bots 30]): one call bigger than any node takes, spread over every
// node, the nodes bridging it (ADR 0007), under churn and server load. Electron clients are the call's members (bots
// have no media); bots, when started, are members of the server who keep it busy (they join, chat, get presence).
//   1 spread    every Electron member joins the call at once, with `sfu_capacity` = members / nodes: the call lands on
//               several nodes and nobody on the mesh (a member whose reachable nodes are full is taken past the capacity
//               as its last resort; members reach only their node group), and everyone hears everyone across the bridges
//   2 media     cameras on members of different nodes, and a screen share: every other member gets each, wherever
//               they are
//   3 churn     rounds of a third of the members leaving and coming back (while bots chat): after each, the capacity
//               holds and everyone hears everyone again; the time to that is measured per round
//   4 node-lost the busiest node is killed: its members go to the other nodes they reach (past their capacity if need
//               be), nobody to the mesh, and the call stays whole
//   5 node-back that node starts again: the next churn round may use it, and everyone still hears everyone
// Measured besides: the nodes' CPU and memory (nodes.csv), per phase.
import fs from "node:fs";
import path from "node:path";
import { BotClient, eachBot } from "../lib/bots.mjs";
import * as d from "../lib/driver.mjs";
import { NodeHandle, sampleNodes } from "../lib/nodes.mjs";
import { attempt, intArg, mapLimit, seconds, sleep, stats } from "../lib/util.mjs";
import { mdTable, prepare, short } from "./common.mjs";
import { hostServer } from "./s8.mjs";
import { clientWarnings, hearsAll, joinCall, levels, modes, userOf, waitAll } from "./s10.mjs";

export default async function s11(ctx) {
  const { run, topology, podman, args } = ctx;
  const nodes = (topology.nodes ?? []).map((spec) => new NodeHandle(spec, podman));
  const bots = (topology.bots ?? []).map((spec) => new BotClient(spec));
  const size = Math.min(intArg(args, "members", ctx.clients.length), ctx.clients.length);
  const members = ctx.clients.slice(0, size);
  if (nodes.length < 3 || members.length < 8) {
    run.assert("s11.setup", "at least 8 Electron clients and 3 nodes (up.sh 12 single --nodes 4)", false, { clients: members.length, nodes: nodes.length });
    return {};
  }
  // So the call needs every node: members / nodes, rounded up (4 nodes, 12 members: 3 each).
  const capacity = intArg(args, "capacity", Math.ceil(members.length / nodes.length));
  const rounds = intArg(args, "rounds", 3);
  const hearMs = intArg(args, "hear-s", 120) * 1000;
  run.clients = [...ctx.clients, ...bots];
  ctx.nodeHandles = nodes;
  const sampler = sampleNodes(run, nodes);
  const out = { members: members.length, nodes: nodes.length, bots: bots.length, capacity, phases: {} };
  const phases = out.phases;
  const users = new Map();
  try {
    await prepare(ctx);
    // ---- Setup: a server hosted by every node, calls through nodes on from 5 members, `capacity` a node ----
    const owner = members[0];
    const server = await hostServer(ctx, "s11", owner, nodes, {
      history: 20, files: 0, fileMb: 0, storage: { sfu_calls: true, sfu_min_members: 5, sfu_capacity: capacity, sfu_forced: false },
    });
    if (!server) return out;
    const { serverId, invite } = server;
    out.serverId = serverId;
    const joiners = members.slice(1);
    const [joined, botJoins] = await Promise.all([
      mapLimit(joiners, 6, (c) => attempt(() => d.joinServer(c, invite))),
      eachBot(bots, (bot) => bot.join(invite), 50),
    ]);
    const everyone = [...joiners, ...bots];
    const data = await run.waitTracker(run.track("s11: has the server", everyone.map((c) => c.name), (s) => s.servers?.[serverId]?.hasData), 300_000);
    run.assert("s11.joined", `${joiners.length} call members and ${bots.length} bots join the server`,
      joined.every((j) => j.ok) && Object.values(botJoins).every((j) => j.ok) && data.missing.length === 0, { missing: data.missing });
    await Promise.all(members.map((c) => attempt(() => d.setNoiseSuppression(c, "off"))));
    const nodeRows = (await attempt(() => d.nodeRows(owner, serverId))).value ?? [];
    const nodeOf = (userId) => nodes.find((n) => n.ip === nodeRows.find((r) => r.userId === userId)?.address) ?? null;
    const nodeName = (userId) => nodeOf(userId)?.name ?? (userId === null ? "–" : `user ${userId}`);
    const call = { serverId, nodeOf, nodeName, users };

    // After each phase: what every node serves and how it is bridged, from its status.json.
    const snap = async (label) => {
      out.bridges ??= {};
      out.bridges[label] = await bridgeSnapshot(nodes, serverId);
    };
    phases.spread = await spreadPhase(ctx, call, members, capacity, nodes, hearMs);
    await snap("spread");
    phases.media = await mediaPhase(ctx, call, members, phases.spread.byNode);
    phases.churn = await churnPhase(ctx, call, members, bots, capacity, rounds, hearMs, "churn");
    await snap("churn");
    phases.nodeLost = await nodeLostPhase(ctx, call, members, nodes, hearMs);
    await snap("node-lost");
    if (phases.nodeLost.killed) {
      await nodes.find((n) => n.name === phases.nodeLost.killed)?.start();
      await sleep(20_000);
      phases.nodeBack = await churnPhase(ctx, call, members, bots, capacity, 1, hearMs, "node-back");
      await snap("node-back");
    }
    await Promise.all(members.map((c) => attempt(() => d.leaveCall(c))));
  } finally {
    await sampler.stop();
    const nodeLogs = {};
    for (const node of nodes) nodeLogs[node.name] = await node.scanLog();
    // The whole logs ([bridge] lines included) next to the results, for reading a failed run.
    fs.mkdirSync(path.join(run.dir, "nodes"), { recursive: true });
    for (const node of nodes) {
      const text = await node.logText().catch((e) => `(log unavailable: ${e.message})`);
      fs.writeFileSync(path.join(run.dir, "nodes", `${node.name}.log`), text);
    }
    out.nodeLogs = Object.fromEntries(Object.entries(nodeLogs).map(([n, l]) => [n, { counts: l.counts, samples: l.samples }]));
    const sum = (key) => Object.values(nodeLogs).reduce((n, l) => n + (l.counts[key] ?? 0), 0);
    run.assert("s11.sfu-worker", "no node turned calls off (its mediasoup worker started and kept running)", sum("callsOff") === 0, { nodes: out.nodeLogs });
    const restarted = phases.nodeLost?.killed ?? null;
    const crashed = Object.entries(nodeLogs).filter(([name, l]) => l.counts.started > (name === restarted ? 2 : 1)).map(([name]) => name);
    run.assert("s11.nodes-alive", "no node restarted on its own (crash)", crashed.length === 0, { crashed });
    run.assert("s11.nodes-no-unhandled", "no unhandled failure in a node log", sum("unhandled") === 0, { nodes: out.nodeLogs });
    out.clientWarnings = clientWarnings(run, members);
    run.number("s11", out);
    run.section("Calls at scale", phaseTable(phases, capacity));
    if (out.bridges) run.section("Bridges per phase", bridgeTable(out.bridges));
    run.section("Client warnings", mdTable(["warning", "count"], Object.entries(out.clientWarnings).map(([k, v]) => [k, v])));
  }
  return out;
}

// ---- Phases ----

// Every member joins at once: on every node, none over its capacity, everyone hearing everyone across the bridges.
async function spreadPhase(ctx, call, members, capacity, nodes, hearMs) {
  const { run } = ctx;
  const result = { members: members.length };
  const t0 = Date.now();
  await joinCall(ctx, call, members);
  const placed = await placement(ctx, call, members, hearMs, capacity);
  Object.assign(result, placed);
  const used = Object.keys(placed.byNode).filter((where) => where !== "mesh");
  // Members reach only their node group's nodes; one whose nodes are all full is taken past the capacity (ADR 0007),
  // so the call is whole on the nodes, and over-capacity nodes are counted, not failed.
  run.assert("s11.spread.whole", `every member is on a node, nobody on the mesh (placement: ${JSON.stringify(placed.byNode)})`,
    !placed.byNode.mesh, { byNode: placed.byNode, overCap: placed.overCap.map(([where, list]) => `${where}: ${list.length}`), saw: placed.saw });
  run.assert("s11.spread.nodes", `the call spreads over more than one node (the bridges carry it), of ${nodes.length}`, used.length >= 2, { used });
  const heard = await hearEveryone(ctx, call, members, hearMs, "spread");
  result.hearMs = heard.ms;
  result.levels = heard.levels;
  result.totalMs = Date.now() - t0;
  return result;
}

// Cameras on one member of each node at once, then a screen share: every other member gets each.
async function mediaPhase(ctx, call, members, byNode) {
  const { run } = ctx;
  const result = {};
  const byName = new Map(members.map((c) => [short(c.name), c]));
  const showing = Object.entries(byNode).filter(([where]) => where !== "mesh").map(([, list]) => byName.get(list[0])).filter(Boolean);
  await Promise.all(showing.map((c) => attempt(() => d.setCamera(c, true))));
  const ids = await Promise.all(showing.map((c) => userOf(call, c)));
  const seen = await waitAll(members, call.serverId, (s) => ids.every((id) => id === s.me || s.remotes[id]?.camera), 90_000);
  result.cameras = { showing: showing.map((c) => short(c.name)), ms: stats(Object.values(seen.ms)) };
  run.assert("s11.media.cameras", `cameras on ${showing.length} members of different nodes reach every other member`, seen.missing.length === 0, { missing: seen.missing, waitingFor: ids, saw: seen.saw });
  await Promise.all(showing.map((c) => attempt(() => d.setCamera(c, false))));

  const sharer = showing[0] ?? members[1];
  await attempt(() => d.setShareQuality(sharer, { resolution: 1080, frameRate: 30, favour: "balanced", bitrate: "auto" }));
  const shared = await attempt(() => d.sharePicture(sharer));
  const sharerId = await userOf(call, sharer);
  const viewers = members.filter((c) => c !== sharer);
  const watching = await waitAll(viewers, call.serverId, (s) => !!s.remotes[sharerId]?.screen, 90_000);
  result.share = { sharer: short(sharer.name), ms: stats(Object.values(watching.ms)) };
  run.assert("s11.media.share", `a screen share reaches all ${viewers.length} viewers across the nodes`, shared.ok && watching.missing.length === 0,
    { missing: watching.missing, saw: watching.saw, error: shared.error });
  await attempt(() => d.stopPicture(sharer));
  return result;
}

// Rounds of a third of the members leaving and coming back while the bots chat: the capacity holds and everyone
// hears everyone again after each.
async function churnPhase(ctx, call, members, bots, capacity, rounds, hearMs, label) {
  const { run } = ctx;
  const result = { rounds: [] };
  // The bots keep the server busy meanwhile: chat (commits to sync) and presence to everyone.
  const chatter = bots.length > 0
    ? eachBot(bots, (bot) => bot.postTagged(call.serverId, Array.from({ length: 5 }, (_, i) => `s11-${label}-${bot.name}-${i}`), 2000), 50)
    : Promise.resolve({});
  for (let round = 0; round < rounds; round++) {
    // A different third each round (never the owner, who keeps the call going).
    const movers = members.slice(1).filter((_, i) => i % 3 === round % 3);
    const t0 = Date.now();
    await Promise.all(movers.map((c) => attempt(() => d.leaveCall(c))));
    await sleep(5000);
    await joinCall(ctx, call, movers);
    const placed = await placement(ctx, call, members, hearMs, capacity);
    const heard = await hearEveryone(ctx, call, members, hearMs, `${label}.${round + 1}`);
    run.assert(`s11.${label}.${round + 1}.whole`, `round ${round + 1}: every member on a node, nobody on the mesh (placement: ${JSON.stringify(placed.byNode)})`,
      !placed.byNode.mesh, { byNode: placed.byNode, overCap: placed.overCap.map(([where, list]) => `${where}: ${list.length}`), saw: placed.saw });
    result.rounds.push({ movers: movers.map((c) => short(c.name)), byNode: placed.byNode, hearMs: heard.ms, recoveredMs: Date.now() - t0 });
  }
  const chat = await chatter;
  result.chat = { bots: bots.length, failed: Object.values(chat).filter((r) => !r.ok).length };
  if (bots.length) run.assert(`s11.${label}.chat`, `the ${bots.length} bots chat meanwhile without failures`, result.chat.failed === 0, result.chat);
  return result;
}

// The node with the most members dies: they go to the other nodes or, past their capacity, to the mesh. The call stays
// whole: members on nodes and on the mesh hear each other.
async function nodeLostPhase(ctx, call, members, nodes, hearMs) {
  const { run } = ctx;
  const before = await placement(ctx, call, members, 30_000);
  const [busiest] = Object.entries(before.byNode).filter(([where]) => where !== "mesh").sort((a, b) => b[1].length - a[1].length);
  const node = nodes.find((n) => n.name === busiest?.[0]);
  if (!node) {
    run.assert("s11.node-lost", "a node serves members of the call (to kill one)", false, { byNode: before.byNode });
    return {};
  }
  const t0 = Date.now();
  await node.kill();
  run.event("node-killed", { node: node.name, members: busiest[1] });
  // First every member off the dead node (its transports can say "connected" until ICE gives up, and its tracks stay
  // live with old bytes), as s10 waits; only then is hearing checked.
  const moved = await waitAll(members, call.serverId,
    (s) => s.mode === "mesh" || (s.mode === "sfu" && call.nodeName(s.nodeUser) !== node.name && s.send === "connected"), hearMs);
  const heard = await hearEveryone(ctx, call, members, hearMs, "node-lost");
  const after = await placement(ctx, call, members, hearMs);
  run.assert("s11.node-lost.moved", `nobody stays on the killed node (placement: ${JSON.stringify(after.byNode)})`, !after.byNode[node.name], { byNode: after.byNode });
  run.assert("s11.node-lost.whole", "its members went to the other nodes, nobody to the mesh", !after.byNode.mesh, { byNode: after.byNode });
  return {
    killed: node.name, from: busiest[1], byNode: after.byNode, onMesh: after.byNode.mesh?.length ?? 0,
    movedMs: stats(Object.values(moved.ms)), stuck: moved.missing, hearMs: heard.ms, recoveredMs: Date.now() - t0,
  };
}

// ---- Helpers ----

// Every node's calls for this server as its status.json says (rewritten every 10 s, so read after that long):
// members, own producers, producers piped in, and each bridge (other node, link id, transport up, pipes out/in).
async function bridgeSnapshot(nodes, serverId) {
  await sleep(11_000);
  const out = {};
  for (const node of nodes) {
    const status = await node.status().catch(() => null);
    out[node.name] = status?.servers?.[serverId]?.calls ?? (status ? {} : null);
  }
  return out;
}

function bridgeTable(snapshots) {
  const rows = [];
  for (const [label, byNode] of Object.entries(snapshots)) {
    for (const [name, calls] of Object.entries(byNode)) {
      if (calls === null) {
        rows.push([label, name, "down", "–"]);
        continue;
      }
      const entries = Object.entries(calls);
      if (entries.length === 0) rows.push([label, name, "no call", "–"]);
      for (const [call, c] of entries) {
        const bridges = c.bridges.map((b) => `${b.node}${b.transport ? "" : " (no transport)"} out ${b.out} in ${b.in}`).join("; ") || "none";
        rows.push([label, name, `call ${String(call).slice(-6)}: ${c.members} members, ${c.own} own, ${c.remote} piped in`, bridges]);
      }
    }
  }
  return mdTable(["after", "node", "call", "bridges"], rows);
}

// Where each member's call goes, once every member's mode settled (sfu with a connected send transport, or mesh).
// A member on the mesh counts as placed only once it stayed there `meshSettleMs`: one that just joined starts as a mesh
// call and moves to a node once it heard enough members' presence (from `sfu_min_members`) and a node answered, a few
// seconds later. Read at once, a member rejoining in a churn round was recorded on the mesh while it was joining a node
// (node-back.1.whole). Longer than the app's join retry (15 s, p2p/sfu.ts), so a member refused once gets its retry.
const meshSettleMs = 20_000;

async function placement(ctx, call, members, timeoutMs, capacity = Infinity) {
  const meshSince = new Map();
  const placed = (s) => {
    if (s.mode !== "mesh") {
      meshSince.delete(s.me);
      return s.send === "connected";
    }
    if (!meshSince.has(s.me)) meshSince.set(s.me, Date.now());
    return Date.now() - meshSince.get(s.me) >= meshSettleMs;
  };
  const settled = await waitAll(members, call.serverId, placed, timeoutMs + meshSettleMs);
  const byNode = {};
  for (const [name, s] of Object.entries(settled.last)) {
    const key = s?.mode === "sfu" ? call.nodeName(s.nodeUser) : s ? "mesh" : "not in call";
    (byNode[key] ??= []).push(short(name));
  }
  const overCap = Object.entries(byNode).filter(([where, list]) => where !== "mesh" && where !== "not in call" && list.length > capacity);
  return { byNode, overCap, modes: modes(settled.last), saw: settled.saw };
}

// Everyone hears everyone: every member lists every other and their mic arrives; then the levels of what plays.
async function hearEveryone(ctx, call, members, timeoutMs, label) {
  const { run } = ctx;
  const heard = await waitAll(members, call.serverId, hearsAll(members.length), timeoutMs);
  // Levels over 3 s, read again (twice, 5 s apart) while some direction is silent: a connection that blinked during
  // the reading is left and joined again within seconds by design, and only silence that stays is a failure. What the
  // first reading found silent is kept in the result (`quietFirst`).
  const first = await levels(members, call.serverId);
  let lv = first;
  for (let again = 0; again < 2 && lv.quiet.length > 0; again++) {
    await sleep(5000);
    lv = await levels(members, call.serverId);
  }
  run.assert(`s11.${label}.sound`, `${label}: all ${members.length} members hear each other (${members.length * (members.length - 1)} directions)`,
    heard.missing.length === 0 && lv.quiet.length === 0,
    { missing: heard.missing, saw: heard.saw, quiet: lv.quiet.slice(0, 20), quietFirst: first.quiet.slice(0, 20) });
  return { ms: stats(Object.values(heard.ms)), levels: lv.peakDb };
}

const ms = (s) => (s && s.max !== null && s.max !== undefined ? `${seconds(s.p50)} / ${seconds(s.max)}` : "–");

function phaseTable(phases, capacity) {
  const rows = [];
  if (phases.spread) rows.push(["1 spread", ms(phases.spread.hearMs), JSON.stringify(phases.spread.byNode), `capacity ${capacity}`]);
  if (phases.media) rows.push(["2 media", "–", `cameras ${ms(phases.media.cameras?.ms)}`, `share ${ms(phases.media.share?.ms)}`]);
  for (const [i, r] of (phases.churn?.rounds ?? []).entries()) rows.push([`3 churn ${i + 1}`, ms(r.hearMs), JSON.stringify(r.byNode), `back in ${seconds(r.recoveredMs)}`]);
  if (phases.nodeLost?.killed) rows.push(["4 node lost", ms(phases.nodeLost.hearMs), JSON.stringify(phases.nodeLost.byNode), `killed ${phases.nodeLost.killed}, ${phases.nodeLost.onMesh} on the mesh, back in ${seconds(phases.nodeLost.recoveredMs)}`]);
  for (const r of phases.nodeBack?.rounds ?? []) rows.push(["5 node back", ms(r.hearMs), JSON.stringify(r.byNode), `back in ${seconds(r.recoveredMs)}`]);
  return mdTable(["phase", "hear everyone (p50 / max)", "placement", "other"], rows);
}
