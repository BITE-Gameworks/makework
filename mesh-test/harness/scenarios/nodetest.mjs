// Node test (node-test.sh): the real MakeWork nodes on the LAN under load, through members on the real network
// (up.sh 8 lan --bots 20: on the host's network, real Nostr relays and STUN). The workspace is a real one both nodes
// host; its invite comes in MWT_INVITE. The node on this computer is driven through tools/node-agent.mjs (MWT_AGENT_URL, MWT_AGENT_TOKEN); the
// other one (MWT_REMOTE_IP) is a black box, judged by what members get from it. Nothing in the workspace's settings
// is changed. Phases:
//   preflight  the local node runs under the agent (restarted once so its log is kept), the first app joins, both
//              nodes are authorized and online in its view, the call settings are read
//   joins      the other 7 apps and 20 bots join at once: whole history, from whom, members only on the nodes
//   messages   every member posts --per-client messages: all delivered, latency through the nodes
//   call       6 apps in the first voice channel: through which node, everyone hears everyone, a camera; then 8
//   failure    the local node stopped: members see it go, nobody falls back to the member room, the call recovers,
//              messages and 5 rejoining bots through the remote node alone; after --down-min it starts again:
//              caught up, online again, a new call served, messages again, every member and the node converge
//   cleanup    out of the call, every test account leaves without a note; the accounts are listed for kicking
// Options: --per-client 3  --down-min 3  --join-timeout-s 240
import fs from "node:fs";
import path from "node:path";
import * as d from "../lib/driver.mjs";
import { BotClient, eachBot } from "../lib/bots.mjs";
import { LocalNode, RemoteNode, sampleRealNodes } from "../lib/realNodes.mjs";
import { logPatterns } from "../lib/nodes.mjs";
import { attempt, intArg, log, mapLimit, seconds, sleep, stats } from "../lib/util.mjs";
import { containerOf, mdTable, prepare, short, usernameOf } from "./common.mjs";
import { convergence, ledgerWork, mixedRound, splitStats } from "./s8.mjs";
import { hearsAll, joinCall, levels, modes, userOf, waitAll } from "./s10.mjs";

export default async function nodetest(ctx) {
  const { run, topology, args, podman } = ctx;
  const invite = process.env.MWT_INVITE?.trim();
  const agentUrl = process.env.MWT_AGENT_URL;
  const out = { phases: {} };
  if (!invite || !agentUrl || !process.env.MWT_AGENT_TOKEN) {
    run.assert("nodetest.setup", "MWT_INVITE, MWT_AGENT_URL and MWT_AGENT_TOKEN are set (node-test.sh sets them)", false, { invite: !!invite, agentUrl: !!agentUrl });
    return out;
  }
  const bots = (topology.bots ?? []).map((spec) => new BotClient(spec));
  const apps = ctx.clients;
  if (apps.length < 8 || bots.length < 5) {
    run.assert("nodetest.setup", "8 apps and some bots (up.sh 8 lan --bots 20)", false, { apps: apps.length, bots: bots.length });
    return out;
  }
  run.clients = [...apps, ...bots];
  const local = new LocalNode({ url: agentUrl, token: process.env.MWT_AGENT_TOKEN });
  const remote = new RemoteNode({ ip: process.env.MWT_REMOTE_IP ?? "192.168.2.213" });
  const nodes = [local, remote];
  ctx.nodeHandles = nodes;
  const serverId = invite.split(".")[1];
  out.serverId = serverId;
  const perClient = intArg(args, "per-client", 3);
  const phases = out.phases;
  const accounts = new Map();
  let sampler = null;
  const [first, ...rest] = apps;
  try {
    phases.preflight = await preflight(ctx, { local, remote, first, invite, serverId });
    if (!phases.preflight.ok) return out;
    sampler = sampleRealNodes(run, local, nodes, first, serverId);
    phases.joins = await joinsPhase(ctx, { serverId, invite, apps: rest, bots, local, all: apps });
    phases.messages = await mixedRound(ctx, serverId, apps, bots, "msg", perClient);
    assertRound(run, "messages", phases.messages);
    const call = { serverId, users: new Map(), nodeName: (user) => nodeName(nodes, user) };
    phases.call = await callPhase(ctx, call, apps, phases.preflight.settings, nodes);
    phases.failure = await failurePhase(ctx, { call, serverId, invite, apps, bots, local, remote, nodes, perClient, first });
  } finally {
    if (sampler) {
      await sampler.stop();
      out.peaks = peaks(sampler.samples, phases);
    }
    out.cleanup = await cleanup(ctx, { serverId, apps, bots, accounts, local, podman });
    out.localLog = (({ text, ...rest }) => rest)(await local.scanLog());
    run.assert("nodetest.local-log", "the local node logged no unhandled failure, stopped drain or listener leak", ["unhandled", "stoppedDraining", "maxListeners", "catchUpFailed", "commitsNotApplied"].every((k) => !out.localLog.counts[k]), out.localLog);
    out.botLogs = await scanBotLogs(ctx, bots);
    run.assert("nodetest.bot-logs", "no bot logged an unhandled failure or a listener leak", (out.botLogs.unhandled ?? 0) + (out.botLogs.maxListeners ?? 0) === 0, out.botLogs);
    run.number("nodetest", out);
    run.section("Node test", phaseTable(phases));
    if (out.peaks) run.section("Local node (process on this computer)", mdTable(["phase", "CPU % max", "RSS MB max", "sync queued max", "online nodes min (first app's view)"],
      Object.entries(out.peaks).map(([p, v]) => [p, v.cpuMax ?? "–", v.rssMax ?? "–", v.queuedMax ?? "–", v.onlineMin ?? "–"])));
    run.section("Test accounts (kick them in Workspace settings > Members)", mdTable(["account", "user id"], [...accounts].map(([n, u]) => [n, u ?? "?"])));
  }
  return out;
}

// userNumberOf (app/src/p2p/log.ts): the first 6 bytes of the account id.
const userNumber = (accountId) => [...Buffer.from(accountId, "base64url").subarray(0, 6)].reduce((n, b) => n * 256 + b, 0);

function nodeName(nodes, user) {
  if (user === null || user === undefined) return "–";
  return nodes.find((n) => n.userId === user)?.name ?? `node ${user}`;
}

function assertRound(run, label, r) {
  run.assert(`nodetest.${label}`, `${label}: every message reaches every other member`, r.undelivered === 0 && r.failedPosts === 0,
    { undelivered: r.undelivered, failedPosts: r.failedPosts, missed: r.missed, latency: r.latency });
}

// ---- Phases ----

async function preflight(ctx, { local, remote, first, invite, serverId }) {
  const { run, podman } = ctx;
  const result = { ok: false, startedAt: Date.now() };
  // The test keeps the local node's log: it restarts it once under the agent if someone else started it.
  const proc = await attempt(() => local.proc());
  run.assert("nodetest.preflight.local-running", "the local node is running", proc.ok && proc.value?.running, { proc: proc.value, error: proc.error });
  if (!proc.ok || !proc.value?.running) return result;
  if (!proc.value.ours) {
    const t = Date.now();
    const r = await attempt(() => local.restart());
    const fresh = r.ok ? await local.freshStatus(t, 90_000) : null;
    result.restartMs = fresh ? fresh.at - t : null;
    run.assert("nodetest.preflight.local-restart", "the local node restarts under the test and writes its status again", !!fresh, { restart: r.value, error: r.error });
    if (!fresh) return result;
  }
  const id = await attempt(() => local.identity());
  run.assert("nodetest.preflight.local-identity", "the local node's user id is known", id.ok, { error: id.error });
  if (!id.ok) return result;
  // Members reach this computer's node at its LAN address, like members elsewhere on the LAN (call media needs it).
  const hostIp = process.env.MWT_LAN_IP ?? new URL(process.env.MWT_AGENT_URL).hostname;
  const reach = await attempt(() => podman.exec(containerOf(first), ["node", "-e",
    `fetch("http://${hostIp}:8080/").then((r) => console.log(r.status), (e) => { console.log("error " + e.message); })`], 20_000));
  result.lanReach = reach.ok ? reach.value.stdout.trim() : reach.error;
  run.assert("nodetest.preflight.lan", `an app reaches this computer's node at ${hostIp}`, reach.ok && /^\d+$/.test(result.lanReach), { got: result.lanReach });

  await prepare(ctx);
  const joined = await attempt(() => d.joinServer(first, invite));
  run.watch(serverId);
  const data = await run.waitTracker(run.track("preflight: first app has the workspace", [first.name], (s) => s.servers?.[serverId]?.hasData), 180_000);
  run.assert("nodetest.preflight.join", "the first app joins the workspace with the invite", joined.ok && data.missing.length === 0, { error: joined.error });
  if (!joined.ok || data.missing.length) return result;
  // Both nodes authorized, and online in its view (a node says hello on connecting and every 60 s): when each one
  // first showed. One that never does gets the app's whole view of it written to preflight-nodes.json.
  const t = Date.now();
  let rows = [];
  let view = null;
  const firstOnline = {};
  while (Date.now() - t < 150_000) {
    rows = (await attempt(() => d.nodeRows(first, serverId))).value ?? rows;
    view = (await attempt(() => d.nodeView(first, serverId))).value ?? view;
    for (const user of Object.keys(view?.online ?? {})) firstOnline[user] ??= Date.now() - t;
    if (rows.filter((r) => r.status === "authorized").length >= 2 && Object.keys(view?.online ?? {}).length >= 2) break;
    await sleep(2000);
  }
  const authorized = rows.filter((r) => r.status === "authorized");
  const others = authorized.filter((r) => r.userId !== local.userId);
  remote.userId = others[0]?.userId ?? null;
  result.nodes = authorized.map((r) => ({ name: r.name, userId: r.userId, address: r.address, which: r.userId === local.userId ? "local" : "remote", online: !!view?.online?.[r.userId], firstOnlineMs: firstOnline[r.userId] ?? null }));
  result.bothOnlineMs = Object.keys(view?.online ?? {}).length >= 2 ? Date.now() - t : null;
  run.assert("nodetest.preflight.nodes", "the workspace has the local node and another one, both authorized and online", authorized.some((r) => r.userId === local.userId) && others.length >= 1 && result.bothOnlineMs !== null, { nodes: result.nodes });
  if (result.bothOnlineMs === null) {
    const debug = await attempt(() => d.nodeDebug(first, serverId));
    fs.writeFileSync(path.join(run.dir, "preflight-nodes.json"), JSON.stringify({ nodes: result.nodes, localUserId: local.userId, debug: debug.value ?? debug.error }, null, 1));
    log("nodetest preflight: a node never came online for the first app; its view is in preflight-nodes.json");
  }
  result.settings = (await attempt(() => d.nodeSettings(first, serverId))).value ?? {};
  result.commits = (await attempt(() => d.ledgerInfo(first, serverId))).value?.count ?? null;
  log(`nodetest preflight: nodes ${JSON.stringify(result.nodes)}, settings ${JSON.stringify(result.settings)}, ${result.commits} commits`);
  // Goes on with the nodes that are online (the run still loads them); without any, nothing to test.
  result.ok = Object.keys(view?.online ?? {}).length >= 1;
  result.endedAt = Date.now();
  return result;
}

async function joinsPhase(ctx, { serverId, invite, apps, bots, local, all }) {
  const { run } = ctx;
  const result = { startedAt: Date.now(), apps: apps.length, bots: bots.length };
  const target = (await local.status().catch(() => null))?.servers?.[serverId]?.commits ?? 0;
  result.target = target;
  const members = [...apps, ...bots];
  const t0 = Date.now();
  const tracker = run.track(`joins: whole history (${target}+ commits)`, members.map((m) => m.name), (s) => (s.servers?.[serverId]?.commits ?? 0) >= target, { startedAt: t0 });
  const [appJoins, botJoins] = await Promise.all([
    mapLimit(apps, 10, (c) => attempt(() => d.joinServer(c, invite))),
    eachBot(bots, (bot) => bot.join(invite), 50),
  ]);
  const failed = [...apps.filter((_, i) => !appJoins[i].ok).map((c) => short(c.name)), ...Object.entries(botJoins).filter(([, r]) => !r.ok).map(([n]) => n)];
  const data = await run.waitTracker(tracker, intArg(ctx.args, "join-timeout-s", 240) * 1000);
  result.data = splitStats(data.perClient, bots);
  run.assert("nodetest.joins.history", "every member gets the whole history", failed.length === 0 && data.missing.length === 0, { failed, missing: data.missing, stats: result.data });
  // Online: at least the test's members and both nodes (real members may be online too).
  const expected = all.length + bots.length - 1 + 2;
  const online = await run.waitTracker(run.track(`joins: sees ${expected}+ online`, members.map((m) => m.name), (s) => (s.servers?.[serverId]?.online ?? 0) >= expected, { startedAt: t0 }), 120_000);
  result.online = { ...splitStats(online.perClient, bots), missing: online.missing.length, expected };
  run.assert("nodetest.joins.online", `every member sees at least ${expected} online (members and both nodes)`, online.missing.length === 0, { missing: online.missing });
  // Members connect only to the nodes (their direct peers are nodes), and nobody is in the member room.
  const views = await mapLimit(all, 8, (c) => attempt(() => d.nodeView(c, serverId)));
  const offNodes = views.flatMap((v, i) => {
    if (!v.ok || !v.value) return [`${short(all[i].name)}: no view`];
    const nodePeers = new Set(Object.values(v.value.online));
    const extra = v.value.direct.filter((p) => !nodePeers.has(p));
    return extra.length || v.value.memberRoom ? [`${short(all[i].name)}: ${extra.length} direct non-node peers${v.value.memberRoom ? ", in the member room" : ""}`] : [];
  });
  result.offNodes = offNodes;
  run.assert("nodetest.joins.hub", "apps connect only to the nodes (no member room)", offNodes.length === 0, { offNodes });
  result.ledger = await ledgerWork(all, serverId);
  result.endedAt = Date.now();
  return result;
}

async function callPhase(ctx, call, apps, settings, nodes) {
  const { run } = ctx;
  const result = { startedAt: Date.now(), settings: { sfu_calls: settings.sfu_calls ?? null, sfu_min_members: settings.sfu_min_members ?? null, sfu_capacity: settings.sfu_capacity ?? null } };
  const throughNode = settings.sfu_calls !== false && 6 >= Number(settings.sfu_min_members || 5);
  result.throughNode = throughNode;
  const six = apps.slice(0, 6);
  await Promise.all(apps.map((c) => attempt(() => d.setNoiseSuppression(c, "off"))));
  await joinCall(ctx, call, six);
  if (throughNode) {
    const sfu = await waitAll(six, call.serverId, (s) => s.mode === "sfu" && s.send === "connected", 90_000);
    result.switchMs = stats(Object.values(sfu.ms));
    result.modes = modes(sfu.last);
    const served = [...new Set(Object.values(sfu.last).map((s) => s?.nodeUser ?? null))];
    result.node = served.map((u) => nodeName(nodes, u));
    run.assert("nodetest.call.node", "a call of 6 goes through one node, the same for every member", sfu.missing.length === 0 && served.length === 1 && served[0] !== null, { missing: sfu.missing, saw: sfu.saw, served: result.node });
  }
  const heard = await waitAll(six, call.serverId, hearsAll(6), 90_000);
  result.hearMs = stats(Object.values(heard.ms));
  result.levels = await levels(six, call.serverId);
  run.assert("nodetest.call.hear", "everyone in the call of 6 hears everyone", heard.missing.length === 0 && result.levels.quiet.length === 0, { missing: heard.missing, saw: heard.saw, quiet: result.levels.quiet });
  // A camera reaches the others.
  const who = six[1];
  const cam = await attempt(() => d.setCamera(who, true));
  const id = await userOf(call, who);
  const seen = await waitAll(six.filter((c) => c !== who), call.serverId, (s) => !!s.remotes[id]?.camera, 45_000);
  result.camera = { ms: stats(Object.values(seen.ms)), missing: seen.missing };
  run.assert("nodetest.call.camera", "a camera reaches every other member of the call", cam.ok && seen.missing.length === 0, { missing: seen.missing, saw: seen.saw });
  await attempt(() => d.setCamera(who, false));
  // Two more.
  await joinCall(ctx, call, apps);
  const eight = await waitAll(apps, call.serverId, hearsAll(apps.length), 90_000);
  result.eight = { hearMs: stats(Object.values(eight.ms)), missing: eight.missing, modes: modes(eight.last) };
  run.assert("nodetest.call.eight", "with 8 in the call everyone hears everyone", eight.missing.length === 0, { missing: eight.missing, saw: eight.saw });
  result.servedBy = [...new Set(Object.values(eight.last).map((s) => s?.nodeUser ?? null))].map((u) => nodeName(nodes, u));
  result.endedAt = Date.now();
  return result;
}

async function failurePhase(ctx, { call, serverId, invite, apps, bots, local, remote, nodes, perClient, first }) {
  const { run, args } = ctx;
  const result = { startedAt: Date.now() };
  const before = await mapLimit(apps, 8, (c) => attempt(() => d.callState(c, serverId)));
  const onLocal = before.some((s) => s.ok && s.value?.nodeUser === local.userId);
  result.callWasOn = onLocal ? "local" : [...new Set(before.map((s) => nodeName(nodes, s.value?.nodeUser ?? null)))].join(",");
  const t0 = Date.now();
  const killed = await attempt(() => local.kill());
  run.assert("nodetest.failure.stopped", "the local node stops", killed.ok && killed.value?.stopped, { result: killed.value, error: killed.error });
  // Members see it go; the remote stays.
  const gone = await waitView(first, serverId, (v) => !v.online[local.userId] && !!v.online[remote.userId], 90_000);
  result.goneMs = gone === null ? null : gone - t0;
  run.assert("nodetest.failure.seen", "members see the local node go while the remote one stays online", gone !== null, {});
  // The call: back to everyone hearing everyone (moved to the remote node or the mesh), or undisturbed.
  const w0 = Date.now();
  const heard = await waitAll(apps, serverId, hearsAll(apps.length), 120_000);
  // From the stop, not from when members saw it.
  result.callRecoveryMs = stats(Object.values(heard.ms).map((ms) => ms + (w0 - t0)));
  result.callAfter = modes(heard.last);
  result.callNodeAfter = [...new Set(Object.values(heard.last).map((s) => nodeName(nodes, s?.nodeUser ?? null)))];
  run.assert("nodetest.failure.call", `the call ${onLocal ? "recovers" : "carries on"} with the local node gone: everyone hears everyone`, heard.missing.length === 0, { missing: heard.missing, saw: heard.saw, after: result.callAfter });
  // Nobody fell back to the member room: the remote node still serves.
  await sleep(10_000);
  const views = await mapLimit(apps, 8, (c) => attempt(() => d.nodeView(c, serverId)));
  const inMemberRoom = views.filter((v) => v.ok && v.value?.memberRoom).length;
  result.inMemberRoom = inMemberRoom;
  run.assert("nodetest.failure.hub", "no app falls back to the member room while the remote node is up", inMemberRoom === 0, { inMemberRoom });
  result.messagesDown = await mixedRound(ctx, serverId, apps, bots, "msg-down", perClient);
  assertRound(run, "failure.messages", result.messagesDown);
  // Five bots leave and join again: their catch-up comes from the remote node alone.
  const five = bots.slice(0, 5);
  await eachBot(five, (bot) => bot.leave(serverId));
  await sleep(3000);
  const target = (await attempt(() => d.ledgerInfo(first, serverId))).value?.count ?? 0;
  const r0 = Date.now();
  const tracker = run.track(`failure: rejoined bots have ${target}+ commits`, five.map((b) => b.name), (s) => (s.servers?.[serverId]?.commits ?? 0) >= target, { startedAt: r0 });
  const joins = await eachBot(five, (bot) => bot.join(invite));
  const data = await run.waitTracker(tracker, 180_000);
  result.rejoin = { ms: stats(Object.values(data.perClient)), missing: data.missing, failed: Object.entries(joins).filter(([, r]) => !r.ok).map(([n]) => n) };
  run.assert("nodetest.failure.rejoin", "bots joining again get the whole history from the remote node alone", data.missing.length === 0 && result.rejoin.failed.length === 0, result.rejoin);
  // Back up after --down-min.
  const downMs = intArg(args, "down-min", 3) * 60_000;
  await sleep(Math.max(0, t0 + downMs - Date.now()));
  const s0 = Date.now();
  const started = await attempt(() => local.start());
  const fresh = started.ok ? await local.freshStatus(s0, 90_000) : null;
  run.assert("nodetest.failure.restart", "the local node starts again", !!fresh, { result: started.value, error: started.error });
  const want = (await attempt(() => d.ledgerInfo(first, serverId))).value?.count ?? 0;
  let caughtUp = null;
  while (Date.now() - s0 < 180_000) {
    const s = await local.status().catch(() => null);
    if ((s?.servers?.[serverId]?.commits ?? 0) >= want) {
      caughtUp = Date.now() - s0;
      break;
    }
    await sleep(2000);
  }
  result.catchUpMs = caughtUp;
  run.assert("nodetest.failure.catch-up", `the restarted node has every commit members have (${want})`, caughtUp !== null, { want, has: local.lastStatus?.servers?.[serverId]?.commits ?? null });
  const back = await waitView(first, serverId, (v) => !!v.online[local.userId], 120_000);
  result.backOnlineMs = back === null ? null : back - s0;
  run.assert("nodetest.failure.online", "members list the local node online again", back !== null, {});
  // A new call is served again.
  await Promise.all(apps.map((c) => attempt(() => d.leaveCall(c))));
  await sleep(10_000);
  const six = apps.slice(0, 6);
  await joinCall(ctx, call, six);
  const served = await waitAll(six, serverId, hearsAll(6), 120_000);
  result.newCall = { hearMs: stats(Object.values(served.ms)), modes: modes(served.last), node: [...new Set(Object.values(served.last).map((s) => nodeName(nodes, s?.nodeUser ?? null)))] };
  run.assert("nodetest.failure.new-call", "after the restart a new call of 6 hears everyone", served.missing.length === 0, { missing: served.missing, saw: served.saw });
  result.messagesAfter = await mixedRound(ctx, serverId, apps, bots, "msg-after", perClient);
  assertRound(run, "failure.messages-after", result.messagesAfter);
  await sleep(25_000);
  result.converged = await convergence(ctx, serverId, apps, bots);
  run.assert("nodetest.failure.converged", "members end with the same commits, and the local node has them", result.converged.groups === 1, result.converged);
  result.endedAt = Date.now();
  return result;
}

async function cleanup(ctx, { serverId, apps, bots, accounts, local }) {
  const result = {};
  await Promise.all(apps.map((c) => attempt(() => d.leaveCall(c))));
  for (const c of apps) {
    const me = await attempt(() => d.selfInfo(c, serverId));
    accounts.set(me.value?.username ?? usernameOf(c), me.value?.userId ?? null);
  }
  for (const bot of bots) {
    const s = await attempt(() => bot.status());
    accounts.set(bot.name, s.value?.account ? userNumber(s.value.account) : null);
  }
  const left = await mapLimit(apps, 8, (c) => attempt(() => d.leaveQuietly(c, serverId)));
  await eachBot(bots, (bot) => bot.leave(serverId));
  result.appsLeft = left.filter((l) => l.ok).length;
  // The local node keeps running (the agent starts it if it isn't).
  const proc = await attempt(() => local.proc());
  if (proc.ok && !proc.value.running) await attempt(() => local.start());
  result.localRunning = (await attempt(() => local.proc())).value?.running ?? null;
  ctx.run.assert("nodetest.cleanup.local-running", "the local node is running at the end", result.localRunning === true, result);
  return result;
}

// ---- Helpers ----

// When the first app's view of the nodes first matched, or null.
async function waitView(client, serverId, predicate, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = await attempt(() => d.nodeView(client, serverId));
    if (v.ok && v.value && predicate(v.value)) return Date.now();
    await sleep(1000);
  }
  return null;
}

async function scanBotLogs(ctx, bots) {
  const counts = {};
  for (const container of new Set(bots.map((b) => b.spec.container))) {
    const text = await ctx.podman.logs(container).catch(() => "");
    for (const [key, pattern] of Object.entries(logPatterns)) counts[key] = (counts[key] ?? 0) + text.split("\n").filter((l) => pattern.test(l)).length;
  }
  return counts;
}

function peaks(samples, phases) {
  const out = {};
  for (const [name, p] of Object.entries(phases)) {
    if (!p?.startedAt) continue;
    const end = p.endedAt ?? Date.now();
    const local = samples.local.filter((s) => s.t >= p.startedAt && s.t <= end);
    const views = samples.views.filter((s) => s.t >= p.startedAt && s.t <= end);
    const max = (list) => (list.length ? Math.max(...list) : null);
    out[name] = {
      cpuMax: max(local.map((s) => s.proc?.cpu).filter((x) => typeof x === "number")),
      rssMax: max(local.map((s) => s.proc?.rssMb).filter((x) => typeof x === "number")),
      queuedMax: max(local.map((s) => s.sync?.queued).filter((x) => typeof x === "number")),
      onlineMin: views.length ? Math.min(...views.map((v) => v.online)) : null,
    };
  }
  return out;
}

const ms = (s) => (s && s.max !== null && s.max !== undefined ? `${seconds(s.p50)} / ${seconds(s.max)}` : "–");

function phaseTable(phases) {
  const rows = [];
  const p = phases;
  if (p.preflight) rows.push(["preflight", `both nodes online after ${seconds(p.preflight.bothOnlineMs)}`, `LAN reach: ${p.preflight.lanReach ?? "–"}`, `restart ${seconds(p.preflight.restartMs)}`]);
  if (p.joins) rows.push(["joins", `history apps ${ms(p.joins.data?.electron)}, bots ${ms(p.joins.data?.bots)}`, `copies per commit ${p.joins.ledger?.copiesPerCommit ?? "–"}`, `off the nodes: ${p.joins.offNodes?.length ?? "–"}`]);
  if (p.messages) rows.push(["messages", `undelivered ${p.messages.undelivered}`, `latency ${ms(p.messages.latency)}`, ""]);
  if (p.call) rows.push(["call", `node ${p.call.node?.join(",") ?? "mesh"}`, `hear ${ms(p.call.hearMs)}, 8: ${ms(p.call.eight?.hearMs)}`, `camera ${ms(p.call.camera?.ms)}`]);
  if (p.failure) {
    const f = p.failure;
    rows.push(["failure", `call was on ${f.callWasOn}; gone seen ${seconds(f.goneMs)}`, `call back ${ms(f.callRecoveryMs)} (${f.callNodeAfter?.join(",") ?? "–"})`, `rejoin ${ms(f.rejoin?.ms)}`]);
    rows.push(["restart", `caught up ${seconds(f.catchUpMs)}`, `online again ${seconds(f.backOnlineMs)}`, `new call ${f.newCall?.node?.join(",") ?? "–"} ${ms(f.newCall?.hearMs)}`]);
  }
  return mdTable(["phase", "", "", ""], rows);
}
