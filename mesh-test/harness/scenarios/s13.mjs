// S13 call presence (up.sh 8 single --nodes 2): does every member of a call list every other member, and keep listing
// them? Members of a workspace with nodes reach each other only through a node (their go-between) until the call's own room
// connects them; the participant list comes only from presence sent peer to peer (p2p/voice.ts). Each phase polls
// every member's list (voice/state.ts participants(), what the UI shows) every second for --watch-s and records, per
// (observer, subject) pair, when the subject first appeared and every time it vanished. On a miss, both sides' full
// state and presence trace (instrument.js W.voiceTrace) go to <run>/s13/.
//   burst    every client joins the call at once (8: through a node)
//   stagger  everyone leaves, then joins one by one --gap-s apart (mesh first, past the SFU threshold later)
//   churn    --rounds rounds of a third leaving and rejoining, then one client reloaded mid-call (new peer id)
//   rotate   the owner rotates the room secret mid-call (as revoking an invite does), then two members rejoin the call
//   newcomer the last client leaves the workspace and joins it again with the invite while the call runs, then joins
//            the call as soon as it has the workspace (a joiner turning member mid-connection)
//   double   a member joins the call twice at once (a rejoin on start meeting a click): the others list it and get
//            its mic, and leaving afterwards works (two joins used to cross their mic chains, then every leave threw)
// Options: --phases burst,stagger,churn,rotate,newcomer,double  --watch-s 90  --gap-s 3  --rounds 3  --within-s 5
//   --sfu-calls on|off. HARNESS_ENV="MWT_EXPERIMENTS=nocallroom" leaves the call room out (instrument.js): presence and
//   relays only through the nodes, as where members can't connect to each other directly.
import fs from "node:fs";
import path from "node:path";
import * as d from "../lib/driver.mjs";
import { NodeHandle } from "../lib/nodes.mjs";
import { attempt, intArg, log, mapLimit, seconds, sleep, stats } from "../lib/util.mjs";
import { mdTable, prepare, short } from "./common.mjs";
import { hostServer } from "./s8.mjs";

export default async function s13(ctx) {
  const { run, topology, podman, args } = ctx;
  const nodes = (topology.nodes ?? []).map((spec) => new NodeHandle(spec, podman));
  const clients = ctx.clients;
  if (clients.length < 4) {
    run.assert("s13.setup", "at least 4 Electron clients (up.sh 8 single --nodes 2)", false, { clients: clients.length });
    return {};
  }
  ctx.nodeHandles = nodes;
  const out = { phases: {}, nodes: nodes.length };
  const only = args.phases ? new Set(String(args.phases).split(",")) : null;
  const want = (name) => !only || only.has(name);
  const opts = {
    watchMs: intArg(args, "watch-s", 90) * 1000, gapMs: intArg(args, "gap-s", 3) * 1000, rounds: intArg(args, "rounds", 3),
    withinMs: intArg(args, "within-s", 5) * 1000,
  };
  fs.mkdirSync(path.join(run.dir, "s13"), { recursive: true });
  const [owner, ...joiners] = clients;
  try {
    await prepare(ctx);
    const storage = args["sfu-calls"] === "off" ? { sfu_calls: false } : null;
    let serverId;
    let invite;
    if (nodes.length > 0) {
      const server = await hostServer(ctx, "s13", owner, nodes, { history: 20, files: 0, fileMb: 0, storage });
      if (!server) return out;
      ({ serverId, invite } = server);
    } else {
      const created = await attempt(() => d.createServer(owner, "s13"));
      if (!created.ok) {
        run.assert("s13.create", "the owner creates the workspace", false, { error: created.error });
        return out;
      }
      ({ id: serverId, invite } = created.value);
      run.watch(serverId);
      if (storage) await d.setStorage(owner, serverId, storage);
    }
    out.serverId = serverId;
    const joined = await mapLimit(joiners, 8, (c) => attempt(() => d.joinServer(c, invite)));
    const data = await run.waitTracker(run.track("s13: has the workspace", joiners.map((c) => c.name), (s) => s.servers?.[serverId]?.hasData), 180_000);
    run.assert("s13.joined", `${joiners.length} members join the workspace`, joined.every((j) => j.ok) && data.missing.length === 0,
      { missing: data.missing, failed: joined.filter((j) => !j.ok).map((j) => j.error) });
    // Settle: members leave the member room once a node is reachable (hubAfterMs), so the call starts in the hub topology.
    await sleep(nodes.length > 0 ? 20_000 : 5_000);
    const call = { serverId, invite, users: new Map(), joinedAt: new Map() };
    const phases = out.phases;
    if (want("burst")) phases.burst = await burstPhase(ctx, call, clients, opts);
    if (want("stagger")) phases.stagger = await staggerPhase(ctx, call, clients, opts);
    if (want("churn")) phases.churn = await churnPhase(ctx, call, clients, opts);
    if (want("rotate")) phases.rotate = await rotatePhase(ctx, call, clients, owner, opts);
    if (want("newcomer")) phases.newcomer = await newcomerPhase(ctx, call, clients, opts);
    if (want("double")) phases.double = await doublePhase(ctx, call, clients, opts);
  } finally {
    run.number("s13", out);
    run.section("Call presence", mdTable(
      ["phase", "pairs", "listed within limit", "first seen p50 / max", "late", "never", "missing at the end", "vanished (pairs)", "relayed presences dropped", "held"],
      Object.entries(out.phases).flatMap(([name, p]) => (Array.isArray(p) ? p : [p]).map((r, i) => [
        Array.isArray(p) ? `${name} ${i + 1}` : name, r.pairs, r.inTime, `${seconds(r.firstMs?.p50)} / ${seconds(r.firstMs?.max)}`,
        r.late.length, r.never.length, r.missing.length, r.vanished.length, r.droppedRelays, r.heldRelays ?? 0,
      ])),
    ));
  }
  return out;
}

// ---- Phases ----
// Each phase's steps run while `watch` polls, so a pair is timed from the moment both of its members are in the call.

async function burstPhase(ctx, call, members, opts) {
  return watch(ctx, call, members, { ...opts, label: "burst" }, () => mapLimit(members, members.length, (c) => joinOne(call, c)));
}

async function staggerPhase(ctx, call, members, opts) {
  await leaveAll(call, members);
  return watch(ctx, call, members, { ...opts, label: "stagger" }, async () => {
    for (const c of members) {
      await joinOne(call, c);
      await sleep(opts.gapMs);
    }
  });
}

async function churnPhase(ctx, call, members, opts) {
  const results = [];
  await mapLimit(members, members.length, (c) => joinOne(call, c));
  for (let round = 0; round < opts.rounds; round++) {
    const third = members.filter((_, i) => i % 3 === round % 3);
    results.push(await watch(ctx, call, members, { ...opts, label: `churn${round + 1}`, watchMs: Math.min(opts.watchMs, 45_000) }, async () => {
      await Promise.all(third.map((c) => leaveOne(call, c)));
      await sleep(5000);
      await Promise.all(third.map((c) => joinOne(call, c)));
    }));
  }
  // A reload: the same account comes back under a new peer id and rejoins the call by itself (resumeCall), timed
  // from the end of the reload.
  const reloaded = members[members.length - 1];
  results.push(await watch(ctx, call, members, { ...opts, label: "reload" }, async () => {
    call.joinedAt.delete(reloaded.name);
    const r = await attempt(async () => {
      await reloaded.page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      reloaded.logCursor = 0;
      await reloaded.waitForApp();
      await reloaded.page.evaluate(async () => window.__mwt?.patch?.());
    });
    if (!r.ok) log(`${short(reloaded.name)}: reload failed: ${r.error}`);
    call.joinedAt.set(reloaded.name, Date.now());
    // If it didn't rejoin on its own within 15 s, join it (the check is about the others listing it).
    await sleep(15_000);
    const state = await attempt(() => d.callPresence(reloaded, call.serverId));
    if (state.ok && state.value?.channel === null) {
      log(`${short(reloaded.name)}: didn't rejoin the call after the reload; joining it`);
      call.joinedAt.delete(reloaded.name);
      await joinOne(call, reloaded);
    }
  }));
  return results;
}

async function rotatePhase(ctx, call, members, owner, opts) {
  await mapLimit(members, members.length, (c) => joinOne(call, c));
  const pair = members.slice(1, 3);
  const result = await watch(ctx, call, members, { ...opts, label: "rotate" }, async () => {
    const rotated = await attempt(() => owner.eval(async ({ serverId }) => {
      const { rotateWorkspaceSecret } = await import("/src/core/serverless.ts");
      await rotateWorkspaceSecret(serverId);
      return true;
    }, { serverId: call.serverId }, 30_000, "rotateSecret"));
    ctx.run.assert("s13.rotate.done", "the owner rotates the room secret", rotated.ok, { error: rotated.error });
    await sleep(15_000);
    await Promise.all(pair.map((c) => leaveOne(call, c)));
    await sleep(5000);
    await Promise.all(pair.map((c) => joinOne(call, c)));
  });
  // Which call room each member is in (the secret it joined with) against the current secret.
  const rooms = await mapLimit(members, 8, (c) => attempt(() => d.callPresence(c, call.serverId, { full: true, cursor: Date.now() })));
  result.callRooms = Object.fromEntries(rooms.map((r, i) => [short(members[i].name), r.ok ? { secret: r.value.secret, call: r.value.call, rooms: r.value.rooms } : r.error]));
  return result;
}

async function newcomerPhase(ctx, call, members, opts) {
  await mapLimit(members, members.length, (c) => joinOne(call, c));
  const newcomer = members[members.length - 1];
  await leaveOne(call, newcomer);
  const left = await attempt(() => d.leaveServer(newcomer, call.serverId));
  if (!left.ok) log(`${short(newcomer.name)}: leave failed: ${left.error}`);
  await sleep(15_000);
  return watch(ctx, call, members, { ...opts, label: "newcomer" }, async () => {
    const joined = await attempt(() => d.joinServer(newcomer, call.invite));
    if (!joined.ok) log(`${short(newcomer.name)}: join failed: ${joined.error}`);
    // Into the call the moment its voice channel is there (the workspace's data arrived).
    for (let i = 0; i < 120; i++) {
      const r = await attempt(() => d.joinCall(newcomer, call.serverId));
      if (r.ok && r.value !== null) break;
      await sleep(500);
    }
    call.joinedAt.set(newcomer.name, Date.now());
    const after = await attempt(() => d.callPresence(newcomer, call.serverId));
    if (after.ok && after.value?.me != null) call.users.set(newcomer.name, after.value.me);
  });
}

async function doublePhase(ctx, call, members, opts) {
  const { run } = ctx;
  await mapLimit(members, members.length, (c) => joinOne(call, c));
  const twice = members[1];
  await leaveOne(call, twice);
  await sleep(3000);
  let joined = { ok: false };
  const result = await watch(ctx, call, members, { ...opts, label: "double" }, async () => {
    joined = await attempt(() => twice.eval(async ({ serverId }) => {
      const voice = await import("/src/voice/state.ts");
      const { workspaceApi } = await import("/src/core/workspaces.ts");
      const rows = await workspaceApi(serverId).plugin("channels").read("channels_channels");
      const channel = rows.find((r) => r.type === "voice").id;
      await Promise.all([voice.joinVoice(serverId, channel), voice.joinVoice(serverId, channel)]);
      return voice.call()?.channelId === channel;
    }, { serverId: call.serverId }, 30_000, "joinVoice twice"));
    call.joinedAt.set(twice.name, Date.now());
  });
  run.assert("s13.double.joined", "two joins at once end in the call", joined.ok && joined.value === true, { error: joined.error });
  // Its mic arrives at every other member.
  const user = call.users.get(twice.name);
  const others = members.filter((c) => c !== twice);
  const heard = await mapLimit(others, others.length, (c) => attempt(() => d.callState(c, call.serverId)));
  const deaf = others.filter((c, i) => !heard[i].ok || !heard[i].value?.remotes?.[user]?.mic).map((c) => short(c.name));
  const saw = Object.fromEntries(others.map((c, i) => [short(c.name), heard[i].ok
    ? { remote: heard[i].value?.remotes?.[user] ?? "not listed", listed: Object.keys(heard[i].value?.remotes ?? {}), mode: heard[i].value?.mode }
    : { error: heard[i].error }]));
  run.assert("s13.double.mic", "its mic reaches every other member", deaf.length === 0, { deaf, user, saw });
  const left = await attempt(() => twice.eval(async () => {
    const voice = await import("/src/voice/state.ts");
    await voice.leaveVoice(true);
    return voice.call() === null;
  }, undefined, 15_000, "leaveVoice"));
  run.assert("s13.double.left", "leaving the call afterwards works", left.ok && left.value === true, { error: left.error });
  call.joinedAt.delete(twice.name);
  return { ...result, deaf, leftOk: left.ok && left.value === true };
}

// ---- Helpers ----

async function joinOne(call, c) {
  const state = await attempt(() => d.callPresence(c, call.serverId));
  if (state.ok && state.value?.channel !== null) {
    call.users.set(c.name, state.value.me);
    if (!call.joinedAt.has(c.name)) call.joinedAt.set(c.name, Date.now());
    return;
  }
  const r = await attempt(() => d.joinCall(c, call.serverId));
  if (!r.ok || r.value === null) log(`${short(c.name)}: joinCall failed: ${r.error ?? "no voice channel"}`);
  call.joinedAt.set(c.name, Date.now());
  const after = await attempt(() => d.callPresence(c, call.serverId));
  if (after.ok && after.value?.me != null) call.users.set(c.name, after.value.me);
}

// Leaves like the user's button (leaveVoice(true) forgets the call to resume; driver.leaveCall keeps it, like a call
// dropped by the app, so the next workspace open rejoined it by itself and raced the scenario's own join).
async function leaveOne(call, c) {
  const r = await attempt(() => c.eval(async () => (await import("/src/voice/state.ts")).leaveVoice(true), undefined, 15_000, "leaveVoice"));
  if (!r.ok) log(`${short(c.name)}: leaving the call failed: ${r.error}`);
  call.joinedAt.delete(c.name);
}

async function leaveAll(call, members) {
  await Promise.all(members.map((c) => leaveOne(call, c)));
  // Past the "left" resends (3 refreshes of 20 s would be the whole tail; the first one is what matters here).
  await sleep(10_000);
}

// Polls every member's participant list each second while `steps` run and for `watchMs` after, and judges each
// (observer, subject) pair from the moment both are in the call (`since`, a later rejoin starts it over): listed within
// `withinMs`, never vanishing afterwards, listed at the end. Polls before `since` don't count.
async function watch(ctx, call, members, { label, watchMs, withinMs }, steps = async () => {}) {
  const { run } = ctx;
  const t0 = Date.now();
  const names = members.map((c) => c.name);
  const pairs = new Map();
  const fresh = (o, s, since) => ({ o, s, since, first: null, gaps: [], open: null, listed: false, polls: 0 });
  for (const o of names) for (const s of names) if (o !== s) pairs.set(`${o}>${s}`, fresh(o, s, null));
  const sinceOf = (o, s) => {
    const a = call.joinedAt.get(o);
    const b = call.joinedAt.get(s);
    return a === undefined || b === undefined ? null : Math.max(t0, a, b);
  };
  let stepsDone = null;
  const running = steps().catch((e) => log(`s13 ${label}: step failed: ${e.stack ?? e}`)).finally(() => (stepsDone = Date.now()));
  let polls = 0;
  while (stepsDone === null || Date.now() < stepsDone + watchMs) {
    const tick = Date.now();
    const views = await mapLimit(members, members.length, (c) => attempt(() => d.callPresence(c, call.serverId)));
    polls++;
    views.forEach((v, i) => {
      if (!v.ok || !v.value) return;
      const o = names[i];
      if (v.value.me != null) call.users.set(o, v.value.me);
      const listed = new Set(v.value.listed);
      for (const s of names) {
        if (s === o) continue;
        const key = `${o}>${s}`;
        const since = sinceOf(o, s);
        if (since === null || tick < since) continue;
        let p = pairs.get(key);
        if (p.since !== since) pairs.set(key, (p = fresh(o, s, since)));
        const user = call.users.get(s);
        const now = user !== undefined && listed.has(user);
        p.polls++;
        if (now && p.first === null) p.first = tick;
        if (p.first !== null && p.listed && !now) p.open = tick;
        if (p.first !== null && !p.listed && now && p.open !== null) {
          p.gaps.push({ from: p.open - t0, ms: tick - p.open });
          p.open = null;
        }
        p.listed = now;
      }
    });
    await sleep(Math.max(0, 1000 - (Date.now() - tick)));
  }
  await running;
  for (const p of pairs.values()) if (p.open !== null) p.gaps.push({ from: p.open - t0, ms: null });
  const pairName = (p) => `${short(p.o)} sees ${short(p.s)}`;
  const all = [...pairs.values()].filter((p) => p.since !== null);
  const after = (p) => p.first - p.since;
  const firstMs = all.filter((p) => p.first !== null).map((p) => Math.max(0, after(p)));
  const late = all.filter((p) => p.first !== null && after(p) > withinMs).map((p) => `${pairName(p)} after ${seconds(after(p))}`);
  const never = all.filter((p) => p.first === null).map(pairName);
  const missing = all.filter((p) => !p.listed).map((p) => `${pairName(p)}${p.first === null ? " (never)" : " (vanished)"}`);
  const vanished = all.filter((p) => p.gaps.length > 0).map((p) => `${pairName(p)}: ${p.gaps.map((g) => `${seconds(g.from)}+${g.ms === null ? "end" : seconds(g.ms)}`).join(", ")}`);
  const inTime = all.filter((p) => p.first !== null && after(p) <= withinMs).length;
  // Every member's full state and presence trace since a little before the phase.
  let droppedRelays = 0;
  let heldRelays = 0;
  const dumps = await mapLimit(members, members.length, (c) => attempt(() => d.callPresence(c, call.serverId, { full: true, cursor: t0 - 5000 })));
  dumps.forEach((r, i) => {
    if (!r.ok || !r.value) return;
    droppedRelays += r.value.trace.filter((e) => e.e === "relay-in-dropped" || e.e === "pass-on-dropped").length;
    heldRelays += r.value.trace.filter((e) => e.e === "relay-in-held").length;
    fs.writeFileSync(path.join(run.dir, "s13", `${label}-${short(names[i])}.json`), JSON.stringify(r.value, null, 1));
  });
  const users = Object.fromEntries([...call.users].map(([n, u]) => [short(n), u]));
  fs.writeFileSync(path.join(run.dir, "s13", `${label}-pairs.json`), JSON.stringify({ t0, users, joinedAt: Object.fromEntries(call.joinedAt), pairs: all }, null, 1));
  const result = { pairs: all.length, polls, inTime, firstMs: stats(firstMs), late, never, missing, vanished, droppedRelays, heldRelays, users };
  log(`s13 ${label}: ${inTime}/${all.length} listed within ${seconds(withinMs)}, ${never.length} never, ${missing.length} missing at the end, ${vanished.length} vanished, ${droppedRelays} relayed presences dropped, ${heldRelays} held for their go-between's news`);
  run.assert(`s13.${label}.listed`, `${label}: every member lists every other within ${seconds(withinMs)}`, late.length === 0 && never.length === 0, { late, never });
  run.assert(`s13.${label}.kept`, `${label}: nobody vanishes from a list, and everyone is listed at the end`, missing.length === 0 && vanished.length === 0, { missing, vanished });
  return result;
}
