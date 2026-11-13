// S10 calls (up.sh 6 single --nodes 2): calls in a mesh and through a node's SFU (ADR 0005), and screen sharing with
// its quality (ADR 0006), on Chromium's fake mic (a beep) and camera (a test pattern) and Xvfb's screen.
//   1 mesh       3 members, calls through nodes off: everyone hears everyone, a camera reaches the others, direct peers
//   2 share      5 members in a mesh: a screen share reaches the viewers (callers with the call view open, ADR 0019);
//                the copies share the 8 Mbit/s upload budget (2 Mbit/s each for 4, 2.7 for 3); a quality change
//                reaches the senders (a chosen bitrate split between the copies); a caller who opens another channel
//                stops getting a copy; numbers per quality
//   3 node       6 members, calls through nodes on (default threshold 5): everyone on the same node; sound, camera
//                and screen through it; the share goes up once, uncapped
//   4 node-lost  the serving node is killed: the call carries on (mesh or the other node), the gap is measured
//   5 below      2 members leave (4 left): back to a mesh
//   6 capacity   capacity 3 on 2 nodes, 6 members: no node over 3, and the call split across them bridged (ADR 0007)
//   7 rejoin     everyone leaves, 2 come back with calls through nodes forced: served again
// Not covered: the computer's sound (screen-sound) needs PipeWire and a real capture device; clients use fake devices.
import fs from "node:fs";
import path from "node:path";
import * as d from "../lib/driver.mjs";
import { NodeHandle, sampleNodes } from "../lib/nodes.mjs";
import { attempt, intArg, log, mapLimit, seconds, sleep, stats } from "../lib/util.mjs";
import { mdTable, prepare, short } from "./common.mjs";
import { hostServer } from "./s8.mjs";

// The fake mic's beep peaks far above this; silence (or nothing playing) stays below it.
export const heardDb = -60;
// Each copy's share of the 8 Mbit/s upload budget on Auto (voice/shareQuality.ts) with 4 viewers, and with 3; and of
// a chosen 10 Mbit/s, the whole upload (ADR 0025), with 4.
const fourViewersBits = 2_000_000;
const threeViewersBits = 2_700_000;
const chosenFourViewersBits = 2_500_000;

export default async function s10(ctx) {
  const { run, topology, podman, args } = ctx;
  const joinMs = intArg(args, "join-s", 60) * 1000;
  const nodes = (topology.nodes ?? []).map((spec) => new NodeHandle(spec, podman));
  if (nodes.length < 2 || ctx.clients.length < 6) {
    run.assert("s10.setup", "6 Electron clients and 2 nodes (up.sh 6 single --nodes 2)", false, { clients: ctx.clients.length, nodes: nodes.length });
    return {};
  }
  ctx.nodeHandles = nodes;
  const sampler = sampleNodes(run, nodes);
  const out = { phases: {} };
  const phases = out.phases;
  const [c1, c2, c3, c4, c5, c6] = ctx.clients;
  const users = new Map();
  try {
    await prepare(ctx);
    // ---- Setup: a server hosted by both nodes, calls through nodes off for the mesh phases ----
    const server = await hostServer(ctx, "s10", c1, nodes, { history: 20, files: 0, fileMb: 0, storage: { sfu_calls: false } });
    if (!server) return out;
    const { serverId, invite } = server;
    out.serverId = serverId;
    const joiners = [c2, c3, c4, c5, c6];
    const joined = await mapLimit(joiners, 6, (c) => attempt(() => d.joinServer(c, invite)));
    const data = await run.waitTracker(run.track("s10: has the server", joiners.map((c) => c.name), (s) => s.servers?.[serverId]?.hasData), 180_000);
    run.assert("s10.joined", "5 members join the server", joined.every((j) => j.ok) && data.missing.length === 0, { missing: data.missing, failed: joined.filter((j) => !j.ok).map((j) => j.error) });
    await Promise.all(ctx.clients.map((c) => attempt(() => d.setNoiseSuppression(c, "off"))));
    const nodeRows = (await attempt(() => d.nodeRows(c1, serverId))).value ?? [];
    const nodeOf = (userId) => {
      const row = nodeRows.find((r) => r.userId === userId);
      return nodes.find((n) => n.ip === row?.address) ?? null;
    };
    const nodeName = (userId) => nodeOf(userId)?.name ?? (userId === null ? "–" : `user ${userId}`);
    const call = { serverId, nodeOf, nodeName, users };

    // `--phases mesh,share` runs only those (node-lost needs node; below and capacity expect the call they leave).
    const only = args.phases ? new Set(String(args.phases).split(",")) : null;
    const want = (name) => !only || only.has(name);
    if (want("mesh")) phases.mesh = await meshPhase(ctx, call, [c1, c2, c3]);
    if (want("share")) phases.share = await sharePhase(ctx, call, [c1, c2, c3, c4, c5], c2);
    if (want("node")) phases.node = await nodePhase(ctx, call, [c1, c2, c3, c4, c5, c6], c2, joinMs);
    if (want("node-lost") && phases.node) phases.nodeLost = await nodeLostPhase(ctx, call, [c1, c2, c3, c4, c5, c6], phases.node.nodeUser, phases.node.nodePeer);
    if (want("below")) phases.below = await belowPhase(ctx, call, [c1, c2, c3, c4], [c5, c6]);
    if (want("capacity")) phases.capacity = await capacityPhase(ctx, call, [c1, c2, c3, c4, c5, c6], [c5, c6]);
    if (want("rejoin")) phases.rejoin = await rejoinPhase(ctx, call, [c1, c2, c3, c4, c5, c6], [c1, c2]);
  } finally {
    await sampler.stop();
    const nodeLogs = {};
    for (const node of nodes) nodeLogs[node.name] = await node.scanLog();
    out.nodeLogs = Object.fromEntries(Object.entries(nodeLogs).map(([n, l]) => [n, { counts: l.counts, samples: l.samples }]));
    const callsOff = Object.values(nodeLogs).reduce((n, l) => n + (l.counts.callsOff ?? 0), 0);
    run.assert("s10.sfu-worker", "no node turned calls off (its mediasoup worker started and kept running)", callsOff === 0, { nodes: out.nodeLogs });
    const restarted = phases.nodeLost?.killed ?? null;
    const crashed = Object.entries(nodeLogs).filter(([name, l]) => l.counts.started > (name === restarted ? 2 : 1)).map(([name]) => name);
    run.assert("s10.nodes-alive", "no node restarted on its own (crash)", crashed.length === 0, { crashed });
    const unhandled = Object.values(nodeLogs).reduce((n, l) => n + (l.counts.unhandled ?? 0), 0);
    run.assert("s10.nodes-no-unhandled", "no unhandled failure in a node log", unhandled === 0, { nodes: out.nodeLogs });
    out.clientWarnings = clientWarnings(run, ctx.clients);
    run.number("s10", out);
    run.section("Calls", phaseTable(phases));
    if (phases.share?.profiles) run.section("Screen share per profile (mesh, 4 viewers)", profileTable(phases.share.profiles));
    run.section("Client warnings", mdTable(["warning", "count"], Object.entries(out.clientWarnings).map(([k, v]) => [k, v])));
  }
  return out;
}

// ---- Phases ----

async function meshPhase(ctx, call, members) {
  const { run } = ctx;
  const result = { members: members.length };
  await joinCall(ctx, call, members);
  const heard = await waitAll(members, call.serverId, hearsAll(members.length), 60_000);
  result.hearMs = stats(Object.values(heard.ms));
  result.modes = modes(heard.last);
  run.assert("s10.mesh.mode", "a call of 3 with calls through nodes off stays a mesh on every member", Object.values(heard.last).every((s) => s?.mode === "mesh"), { modes: result.modes });
  run.assert("s10.mesh.sound", "every member's mic reaches every other member (packets arrive)", heard.missing.length === 0, { missing: heard.missing, saw: heard.saw, ms: heard.ms });
  result.levels = await levels(members, call.serverId);
  run.assert("s10.mesh.levels", `every member hears the others' beep (peak above ${heardDb} dBFS)`, result.levels.quiet.length === 0, result.levels);
  result.camera = await cameraCheck(ctx, call, members, members[1], "mesh");
  // The call room: members of a mesh call connect to each other directly.
  const rooms = await Promise.all(members.map((c) => attempt(() => d.rooms(c, call.serverId))));
  const selves = rooms.map((r) => r.value?.self);
  const missingDirect = rooms.flatMap((r, i) => selves.filter((s, j) => j !== i && s && !r.value?.direct?.includes(s)).map(() => short(members[i].name)));
  run.assert("s10.mesh.direct", "members of a mesh call connect to each other directly", missingDirect.length === 0, { missingDirect });
  return result;
}

async function sharePhase(ctx, call, members, sharer) {
  const { run } = ctx;
  const result = { members: members.length, sharer: short(sharer.name) };
  await joinCall(ctx, call, members);
  const heard = await waitAll(members, call.serverId, hearsAll(members.length), 60_000);
  run.assert("s10.share.sound", "5 members in a mesh hear each other", heard.missing.length === 0, { missing: heard.missing, saw: heard.saw });
  await attempt(() => d.setShareQuality(sharer, { resolution: 1080, frameRate: 30, favour: "balanced", bitrate: "auto" }));
  const shared = await attempt(() => d.sharePicture(sharer));
  result.capture = shared.ok ? shared.value : { error: shared.error };
  run.assert("s10.share.capture", "the sharer captures the screen (Xvfb's display)", shared.ok && !shared.value?.error, result.capture);
  if (!shared.ok || shared.value?.error) return result;
  const sharerId = await userOf(call, sharer);
  const viewers = members.filter((c) => c !== sharer);
  const seen = await waitAll(viewers, call.serverId, (s) => !!s.remotes[sharerId]?.screen, 45_000);
  result.viewMs = stats(Object.values(seen.ms));
  run.assert("s10.share.viewers", "every viewer gets the shared picture", seen.missing.length === 0, { missing: seen.missing, saw: seen.saw });

  // 4 viewers: 4 copies, each held to 2 Mbit/s.
  await sleep(6000);
  const capped = await shareNumbers(sharer, call.serverId);
  result.capped = capped;
  const copies = capped.params?.mesh ?? [];
  run.assert("s10.share.cap", "with 4 viewers the sharer sends 4 copies, each held to 2 Mbit/s, and says so",
    capped.stats?.copies === 4 && capped.stats?.cap?.capped === true && copies.length === 4 && copies.every((p) => p.encodings[0]?.maxBitrate === fourViewersBits),
    { stats: capped.stats, copies: copies.map((p) => p.encodings[0]) });

  // Sizes, rates and favours on Auto, then 1440p 60 fps sharp at 10 Mbit/s (split between the copies): what the senders
  // and the encoder make of it.
  result.profiles = [];
  for (const quality of [
    { resolution: 720, frameRate: 60, favour: "motion", bitrate: "auto" }, { resolution: 1080, frameRate: 30, favour: "balanced", bitrate: "auto" },
    { resolution: 1080, frameRate: 30, favour: "detail", bitrate: "auto" }, { resolution: 1440, frameRate: 60, favour: "detail", bitrate: 10 },
  ]) {
    await attempt(() => d.setShareQuality(sharer, quality));
    await sleep(8000);
    result.profiles.push({ quality, ...(await shareNumbers(sharer, call.serverId)) });
  }
  const last = result.profiles.at(-1);
  const lastCopies = last.params?.mesh ?? [];
  run.assert("s10.share.quality", "a new quality reaches every copy live (60 fps max, keeps the resolution, 10 Mbit/s split 4 ways)",
    lastCopies.length === 4 && lastCopies.every((p) => p.encodings[0]?.maxFramerate === 60 && p.degradationPreference === "maintain-resolution" && p.encodings[0]?.maxBitrate === chosenFourViewersBits),
    { copies: lastCopies });
  // Back to Auto for the budget lift below.
  await attempt(() => d.setShareQuality(sharer, { resolution: 1080, frameRate: 30, favour: "balanced", bitrate: "auto" }));

  // One viewer opens another channel (it stays in the call): within the 10 s linger its copy goes, and the 3 left get
  // a bigger share of the budget.
  const looker = members.at(-1);
  await attempt(() => d.viewElsewhere(looker, call.serverId));
  const lifted = await d.waitFor(async () => {
    const p = await d.screenSenderParams(sharer, call.serverId);
    return p?.mesh?.length === 3 && p.mesh.every((x) => x.encodings[0]?.maxBitrate === threeViewersBits) ? p : null;
  }, { timeoutMs: 30_000, everyMs: 1000 });
  await sleep(6000);
  result.uncapped = await shareNumbers(sharer, call.serverId);
  run.assert("s10.share.viewers-only", "a caller viewing another channel gets no copy; the 3 viewers get 2.7 Mbit/s each", !!lifted, { params: result.uncapped.params, stats: result.uncapped.stats });
  await attempt(() => d.leaveCall(looker));
  await attempt(() => d.stopPicture(sharer));
  return result;
}

async function nodePhase(ctx, call, members, sharer, joinMs) {
  const { run } = ctx;
  const result = { members: members.length };
  await attempt(() => d.setStorage(members[0], call.serverId, { sfu_calls: true }));
  await sleep(3000);
  await joinCall(ctx, call, members);
  const sfu = await waitAll(members, call.serverId, (s) => s.mode === "sfu" && s.send === "connected", joinMs);
  result.switchMs = stats(Object.values(sfu.ms));
  result.modes = modes(sfu.last);
  result.nodeUsers = [...new Set(Object.values(sfu.last).map((s) => s?.nodeUser ?? null))];
  result.nodeUser = result.nodeUsers.length === 1 ? result.nodeUsers[0] : null;
  result.nodePeer = [...new Set(Object.values(sfu.last).map((s) => s?.node ?? null))][0] ?? null;
  result.node = call.nodeName(result.nodeUser);
  run.assert("s10.node.mode", `a call of ${members.length} (threshold 5) goes through a node on every member, sending transport connected`, sfu.missing.length === 0, { missing: sfu.missing, modes: result.modes });
  run.assert("s10.node.same", "every member is on the same call node", result.nodeUsers.length === 1 && result.nodeUser !== null, { nodes: result.nodeUsers.map(call.nodeName) });
  const heard = await waitAll(members, call.serverId, hearsAll(members.length), 60_000);
  result.hearMs = stats(Object.values(heard.ms));
  run.assert("s10.node.sound", "every member's mic reaches every other member through the node", heard.missing.length === 0, { missing: heard.missing, saw: heard.saw });
  result.levels = await levels(members, call.serverId);
  run.assert("s10.node.levels", `every member hears the others' beep through the node (peak above ${heardDb} dBFS)`, result.levels.quiet.length === 0, result.levels);
  result.camera = await cameraCheck(ctx, call, members, members[2], "node");

  // The share goes up once to the node, so no viewer cap with 5 viewers.
  await attempt(() => d.setShareQuality(sharer, { resolution: 1080, frameRate: 30, favour: "balanced", bitrate: "auto" }));
  const shared = await attempt(() => d.sharePicture(sharer));
  const sharerId = await userOf(call, sharer);
  const viewers = members.filter((c) => c !== sharer);
  const seen = await waitAll(viewers, call.serverId, (s) => !!s.remotes[sharerId]?.screen, 45_000);
  result.viewMs = stats(Object.values(seen.ms));
  run.assert("s10.node.share", "every viewer gets the shared picture through the node", shared.ok && seen.missing.length === 0, { missing: seen.missing, saw: seen.saw, error: shared.error });
  await sleep(6000);
  result.share = await shareNumbers(sharer, call.serverId);
  const producer = result.share.params?.node;
  run.assert("s10.node.share-uncapped", "through a node the sharer sends one copy, not capped, at Auto's 4 Mbit/s for 1080p 30 fps",
    result.share.stats?.viaNode === true && result.share.stats?.copies === 1 && result.share.stats?.cap?.capped === false && producer?.encodings[0]?.maxBitrate === 4_000_000,
    { stats: result.share.stats, producer });
  await attempt(() => d.stopPicture(sharer));
  return result;
}

async function nodeLostPhase(ctx, call, members, nodeUser, nodePeer) {
  const { run } = ctx;
  const result = {};
  const node = call.nodeOf(nodeUser);
  if (!node) {
    run.assert("s10.node-lost", "the serving node is known (phase 3 put the call on one node)", false, { nodeUser });
    return result;
  }
  result.killed = node.name;
  const t0 = Date.now();
  await node.kill();
  run.event("node-killed", { node: node.name });
  // Off the dead node (a mesh, or the other node), then hearing everyone again. By peer id: the dead node's user
  // drops out of the online list, and its transport can still say "connected" until ICE gives up.
  const moved = await waitAll(members, call.serverId, (s) => s.mode === "mesh" || (s.mode === "sfu" && s.node !== nodePeer && s.send === "connected"), 120_000);
  const heard = await waitAll(members, call.serverId, hearsAll(members.length), 60_000);
  result.levels = await levels(members, call.serverId);
  result.movedMs = stats(Object.values(moved.ms));
  result.recoveredMs = Date.now() - t0;
  result.modes = modes(heard.last);
  result.nodes = [...new Set(Object.values(heard.last).map((s) => (s?.mode === "sfu" ? call.nodeName(s.nodeUser) : "mesh")))];
  run.assert("s10.node-lost.moves", `when the call's node dies every member leaves it within 120 s (${result.nodes.join(", ")})`, moved.missing.length === 0, { missing: moved.missing, saw: moved.saw });
  run.assert("s10.node-lost.sound", "after the node died everyone hears everyone again", heard.missing.length === 0 && result.levels.quiet.length === 0, { missing: heard.missing, saw: heard.saw, quiet: result.levels.quiet });
  await node.start();
  await sleep(15_000);
  return result;
}

async function belowPhase(ctx, call, stay, leave) {
  const { run } = ctx;
  const result = { members: stay.length };
  await Promise.all(leave.map((c) => attempt(() => d.leaveCall(c))));
  const mesh = await waitAll(stay, call.serverId, (s) => s.mode === "mesh" && s.participants === stay.length, 90_000);
  const heard = await waitAll(stay, call.serverId, hearsAll(stay.length), 60_000);
  result.meshMs = stats(Object.values(mesh.ms));
  result.modes = modes(mesh.last);
  result.levels = await levels(stay, call.serverId);
  run.assert("s10.below.mode", `a call that drops to ${stay.length} (below 5) goes back to a mesh on every member`, mesh.missing.length === 0, { missing: mesh.missing, modes: result.modes });
  run.assert("s10.below.sound", "after going back to a mesh everyone hears everyone", heard.missing.length === 0 && result.levels.quiet.length === 0, { missing: heard.missing, saw: heard.saw, quiet: result.levels.quiet });
  return result;
}

async function capacityPhase(ctx, call, members, rejoin) {
  const { run } = ctx;
  const result = { members: members.length, capacity: 3 };
  await attempt(() => d.setStorage(members[0], call.serverId, { sfu_capacity: 3 }));
  await sleep(3000);
  await joinCall(ctx, call, rejoin);
  const sfu = await waitAll(members, call.serverId, (s) => s.mode === "sfu" && s.send === "connected", 90_000);
  result.modes = modes(sfu.last);
  result.byNode = {};
  for (const [name, s] of Object.entries(sfu.last)) {
    const key = s?.mode === "sfu" ? call.nodeName(s.nodeUser) : "mesh";
    (result.byNode[key] ??= []).push(short(name));
  }
  // ADR 0007: a node takes at most its capacity of a call, the rest go to the next node, and the nodes bridge.
  const overCap = Object.entries(result.byNode).filter(([where, list]) => where === "mesh" || list.length > result.capacity);
  run.assert("s10.capacity.cap", `no node serves more than the capacity (${result.capacity}) and nobody is left on the mesh (placement: ${JSON.stringify(result.byNode)})`,
    overCap.length === 0, { byNode: result.byNode });
  const heard = await waitAll(members, call.serverId, hearsAll(members.length), 60_000);
  result.levels = await levels(members, call.serverId);
  result.unheard = heard.missing;
  run.assert("s10.capacity.sound", `with capacity 3 and ${members.length} members split across nodes, everyone still hears everyone (placement: ${JSON.stringify(result.byNode)})`,
    heard.missing.length === 0 && result.levels.quiet.length === 0, { byNode: result.byNode, missing: heard.missing, quiet: result.levels.quiet });
  await attempt(() => d.setStorage(members[0], call.serverId, { sfu_capacity: 20 }));
  return result;
}

async function rejoinPhase(ctx, call, everyone, pair) {
  const { run } = ctx;
  const result = {};
  await Promise.all(everyone.map((c) => attempt(() => d.leaveCall(c))));
  await sleep(10_000);
  await attempt(() => d.setStorage(everyone[0], call.serverId, { sfu_forced: true }));
  await sleep(3000);
  await joinCall(ctx, call, pair);
  const sfu = await waitAll(pair, call.serverId, (s) => s.mode === "sfu" && s.send === "connected", 60_000);
  const heard = await waitAll(pair, call.serverId, hearsAll(pair.length), 60_000);
  result.levels = await levels(pair, call.serverId);
  result.modes = modes(sfu.last);
  result.node = [...new Set(Object.values(sfu.last).map((s) => call.nodeName(s?.nodeUser ?? null)))];
  run.assert("s10.rejoin", "after everyone left, 2 members with calls through nodes forced are served again and hear each other",
    sfu.missing.length === 0 && heard.missing.length === 0 && result.levels.quiet.length === 0, { missing: sfu.missing, unheard: heard.missing, quiet: result.levels.quiet, modes: result.modes });
  await Promise.all(pair.map((c) => attempt(() => d.leaveCall(c))));
  await attempt(() => d.setStorage(everyone[0], call.serverId, { sfu_forced: false }));
  return result;
}

// ---- Helpers ----

// Joins whoever isn't in the call yet (all at once, or one by one `--join-gap-ms` apart), and remembers each member's
// user id in the server.
export async function joinCall(ctx, call, members) {
  const gapMs = intArg(ctx.args, "join-gap-ms", 0);
  const one = async (c) => {
    const state = await attempt(() => d.callState(c, call.serverId));
    if (!state.ok || !state.value) {
      const r = await attempt(() => d.joinCall(c, call.serverId));
      if (!r.ok || r.value === null) log(`${short(c.name)}: joinCall failed: ${r.error ?? "no voice channel"}`);
      else if (gapMs > 0) await sleep(gapMs);
    }
    await userOf(call, c);
  };
  if (gapMs > 0) for (const c of members) await one(c);
  else await mapLimit(members, 6, one);
}

// A member's user id in the server, read again from its call state while unknown. Read once at the join, a read that
// failed under load left it undefined, and every later check waiting for that member's media could never pass (s11:
// all four cameras reached every member, and the check failed for all 12).
export async function userOf(call, c) {
  for (let i = 0; i < 5 && call.users.get(c.name) == null; i++) {
    if (i > 0) await sleep(1000);
    const now = await attempt(() => d.callState(c, call.serverId));
    if (now.ok && now.value?.me != null) call.users.set(c.name, now.value.me);
  }
  const id = call.users.get(c.name);
  if (id == null) log(`${short(c.name)}: user id in the server unknown (its call state couldn't be read)`);
  return id;
}

// Every other member of an n-member call is listed and their mic arrives.
export const hearsAll = (n) => (s) => s.participants === n && Object.keys(s.remotes).length === n - 1 && Object.values(s.remotes).every((r) => r.mic);

// Polls callState on each member until `predicate` holds for all or `timeoutMs` passed.
export async function waitAll(members, serverId, predicate, timeoutMs) {
  const t0 = Date.now();
  const ms = {};
  const last = {};
  while (Date.now() - t0 < timeoutMs) {
    await Promise.all(members.filter((c) => ms[c.name] === undefined).map(async (c) => {
      const r = await attempt(() => d.callState(c, serverId));
      if (!r.ok) return;
      last[c.name] = r.value;
      if (r.value && predicate(r.value)) ms[c.name] = Date.now() - t0;
    }));
    if (members.every((c) => ms[c.name] !== undefined)) break;
    await sleep(1000);
  }
  const missing = members.filter((c) => ms[c.name] === undefined);
  // What each member that never got there last saw: how many in the call, and per other member what arrives.
  const saw = Object.fromEntries(missing.map((c) => {
    const s = last[c.name];
    const flags = (r) => ["mic", "camera", "screen"].filter((k) => r[k]).join("+") || "nothing";
    return [short(c.name), s ? `${s.mode} ${s.participants} in call, send ${s.send ?? "–"}: ${Object.entries(s.remotes).map(([u, r]) => `${u}=${flags(r)}`).join(" ")}` : "not in call"];
  }));
  return { ms, last, saw, missing: missing.map((c) => short(c.name)) };
}

// Each member's loudest other participant and quietest one; `quiet` lists who doesn't hear whom.
export async function levels(members, serverId) {
  const read = await mapLimit(members, 6, (c) => attempt(() => d.audioLevels(c, serverId, 3000)));
  const quiet = [];
  const peaks = [];
  read.forEach((r, i) => {
    for (const [user, db] of Object.entries(r.ok && r.value ? r.value : {})) {
      peaks.push(db);
      if (db === null || db < heardDb) quiet.push(`${short(members[i].name)} <- user ${user} (${db ?? "nothing playing"})`);
    }
    if (!r.ok) quiet.push(`${short(members[i].name)}: ${r.error}`);
  });
  return { quiet, peakDb: stats(peaks) };
}

// One member turns the camera on; every other member gets it live; then it goes off again.
export async function cameraCheck(ctx, call, members, who, label) {
  const on = await attempt(() => d.setCamera(who, true));
  const id = await userOf(call, who);
  const others = members.filter((c) => c !== who);
  const seen = await waitAll(others, call.serverId, (s) => !!s.remotes[id]?.camera, 45_000);
  ctx.run.assert(`s10.${label}.camera`, `a camera reaches every other member (${label})`, on.ok && on.value?.on && seen.missing.length === 0,
    { missing: seen.missing, saw: seen.saw, error: on.error ?? on.value?.error });
  await attempt(() => d.setCamera(who, false));
  return { ms: stats(Object.values(seen.ms)), missing: seen.missing };
}

// The sharer's live line twice (2 s apart, so the bitrate is measured) and its senders' settings.
export async function shareNumbers(sharer, serverId) {
  await attempt(() => d.shareStats(sharer));
  await sleep(2000);
  const s = await attempt(() => d.shareStats(sharer));
  const p = await attempt(() => d.screenSenderParams(sharer, serverId));
  return { stats: s.ok ? s.value : { error: s.error }, params: p.ok ? p.value : { error: p.error } };
}

export const modes = (last) => Object.fromEntries(Object.entries(last).map(([name, s]) => [short(name), s ? `${s.mode}${s.mode === "sfu" ? `:${s.nodeUser ?? "?"}` : ""}` : "not in call"]));

// What the clients' consoles said about calls: warnings from the SFU link, media and the mic.
export function clientWarnings(run, clients) {
  const patterns = {
    "Calls through nodes": /Calls through nodes:/, "Receiving (SFU)": /Receiving (mic|camera|screen|screen-sound):/,
    "Voice: call dropped": /Voice: call dropped/, "Screen share sender settings": /Screen share: sender settings not applied/,
    "Screen share capture": /Screen share: capture not changed/,
  };
  const counts = Object.fromEntries(Object.keys(patterns).map((k) => [k, 0]));
  for (const c of clients) {
    const file = path.join(run.dir, "console", `${c.name}.log`);
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    for (const line of text.split("\n")) for (const [k, re] of Object.entries(patterns)) if (re.test(line)) counts[k]++;
  }
  return counts;
}

const ms = (s) => (s && s.max !== null && s.max !== undefined ? `${seconds(s.p50)} / ${seconds(s.max)}` : "–");

function phaseTable(phases) {
  const rows = [
    ["1 mesh (3)", ms(phases.mesh?.hearMs), JSON.stringify(phases.mesh?.modes ?? {}), phases.mesh?.levels?.peakDb?.p50 ?? "–", ms(phases.mesh?.camera?.ms)],
    ["2 share (5)", "–", "mesh", "–", `picture ${ms(phases.share?.viewMs)}`],
    ["3 node (6)", ms(phases.node?.hearMs), `${phases.node?.node ?? "–"}, switch ${ms(phases.node?.switchMs)}`, phases.node?.levels?.peakDb?.p50 ?? "–", `camera ${ms(phases.node?.camera?.ms)}, picture ${ms(phases.node?.viewMs)}`],
    ["4 node lost", `back in ${seconds(phases.nodeLost?.recoveredMs)}`, (phases.nodeLost?.nodes ?? []).join(", ") || "–", phases.nodeLost?.levels?.peakDb?.p50 ?? "–", `killed ${phases.nodeLost?.killed ?? "–"}`],
    ["5 below (4)", ms(phases.below?.meshMs), JSON.stringify(phases.below?.modes ?? {}), phases.below?.levels?.peakDb?.p50 ?? "–", "–"],
    ["6 capacity 3 (6)", "–", JSON.stringify(phases.capacity?.byNode ?? {}), phases.capacity?.levels?.peakDb?.p50 ?? "–", `unheard ${(phases.capacity?.unheard ?? []).join(", ") || "none"}`],
    ["7 rejoin (2, forced)", "–", (phases.rejoin?.node ?? []).join(", ") || "–", phases.rejoin?.levels?.peakDb?.p50 ?? "–", "–"],
  ];
  return mdTable(["phase", "hear everyone (p50 / max)", "mode / node", "peak dBFS (p50)", "other"], rows);
}

function profileTable(profiles) {
  return mdTable(["quality", "size", "fps", "Mbit/s per copy", "limited by", "sender max / fps / preference"], profiles.map((p) => {
    const s = p.stats ?? {};
    const sender = p.params?.mesh?.[0];
    return [
      `${p.quality.resolution}p${p.quality.frameRate} ${p.quality.favour} / ${p.quality.bitrate}`, s.width ? `${s.width}x${s.height}` : "–", s.fps !== undefined ? Math.round(s.fps) : "–",
      s.bitrate !== undefined ? (s.bitrate / 1e6).toFixed(2) : "–", s.limitation ?? "none",
      sender ? `${(sender.encodings[0]?.maxBitrate ?? 0) / 1e6} / ${sender.encodings[0]?.maxFramerate ?? "–"} / ${sender.degradationPreference ?? "–"}` : "–",
    ];
  }));
}
