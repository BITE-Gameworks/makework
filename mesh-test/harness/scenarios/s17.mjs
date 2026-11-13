// S17 online drift (up.sh 2 single, or two dev apps in host mode): does a member's app get slower the longer another
// member stays online? Reported 2026-10-27: with two members online (in a call or not) the whole app dropped more and
// more frames; a restart made it smooth again, and it recovered once the other member went offline.
// The first client is measured throughout, in windows of --window-s; the second one comes and goes:
//   alone   the second app is away (its page shows about:blank, so its connections close), --alone-s
//   online  the second app is back with the workspace open, both on its chat channel, --online-min (--call: both in
//           the voice channel's call)
//   left    the second app is away again, --left-s
// Per window: main-thread busy time by kind (Performance domain), frames, the longest gap between frames, long tasks,
// and the census (instrument.js W.census: intervals, pending timeouts, listeners, peer connections, data channels,
// data channel frames by Trystero action, relay sockets, and the size of every collection the workspace's sync, rooms,
// mesh, ledger and presence/voice/content links hold). CPU profiles of the first and the last online window, summarized
// by function, and the heap after a garbage collection at each phase's end.
// Red: the last online window is busier than the first (task time x1.5, fps -20 % or long tasks x2) and the left
// phase comes back near alone. The summary lists every census number that grew through online and fell back.
// Options: --window-s 30  --alone-s 120  --online-min 15  --left-s 120  --call  --no-profile
// Run with --poll-ms 5000 so the harness's own probes stay light.
import fs from "node:fs";
import path from "node:path";
import * as d from "../lib/driver.mjs";
import { busy, heapAfterGc, metrics, session, startProfile, stopProfile, summarizeProfile } from "../lib/profile.mjs";
import { attempt, intArg, log, sleep } from "../lib/util.mjs";
import { mdTable, prepare, short, usernameOf } from "./common.mjs";

export default async function s17(ctx) {
  const { run, args } = ctx;
  const clients = ctx.clients;
  const out = { windows: [], profiles: {}, heap: {}, growth: [] };
  if (clients.length < 2) {
    run.assert("s17.setup", "two clients", false, { clients: clients.length });
    return out;
  }
  const opts = {
    windowMs: intArg(args, "window-s", 30) * 1000,
    aloneMs: intArg(args, "alone-s", 120) * 1000,
    onlineMs: intArg(args, "online-min", 15) * 60_000,
    leftMs: intArg(args, "left-s", 120) * 1000,
    call: Boolean(args.call),
    profile: !args["no-profile"],
  };
  const dir = path.join(run.dir, "s17");
  fs.mkdirSync(dir, { recursive: true });
  const [me, peer] = clients;
  const others = clients.slice(2);
  try {
    // Only the two: any other client goes away for good.
    for (const c of others) await away(c);
    await prepare({ ...ctx, clients: [me, peer] });
    const created = await attempt(() => d.createServer(me, "s17"));
    if (!created.ok) {
      run.assert("s17.create", "the first client creates the workspace", false, { error: created.error });
      return out;
    }
    const { id: serverId, invite } = created.value;
    out.serverId = serverId;
    run.watch(serverId);
    const joined = await attempt(() => d.joinServer(peer, invite));
    const data = await run.waitTracker(run.track("s17: has the workspace", [peer.name], (s) => s.servers?.[serverId]?.hasData), 180_000);
    run.assert("s17.joined", "the second client joins the workspace", joined.ok && data.missing.length === 0, { error: joined.error, missing: data.missing });
    if (!joined.ok || data.missing.length) return out;
    await sleep(5_000);
    await view(me, serverId);
    await view(peer, serverId);
    const cdp = await session(me);
    const census = fs.createWriteStream(path.join(dir, "census.jsonl"));
    const windows = [];
    let lastEvents = {};

    const measure = async (phase, ms, { profileFirst = false, profileLast = false } = {}) => {
      const count = Math.max(1, Math.round(ms / opts.windowMs));
      for (let i = 0; i < count; i++) {
        const profiling = opts.profile && ((profileFirst && i === 0) || (profileLast && i === count - 1));
        await me.eval(() => window.__mwt.loadStart(), undefined, 10_000, "loadStart");
        const before = await metrics(cdp);
        const t0 = Date.now();
        if (profiling) await startProfile(cdp);
        await sleep(opts.windowMs);
        const profile = profiling ? await stopProfile(cdp) : null;
        const after = await metrics(cdp);
        const ms = Date.now() - t0;
        const page = await me.eval(() => window.__mwt.loadRead(), undefined, 10_000, "loadRead");
        const c = await me.eval(() => window.__mwt.census(), undefined, 20_000, "census");
        const online = await me.eval(async (sid) => (await import("/src/core/serverless.ts")).onlinePeers(sid), serverId, 10_000, "online");
        const w = { phase, i, t: t0, ms, online, ...busy(before, after, ms), fps: round(page?.fps), maxGapMs: page?.maxGapMs, longTasks: page?.longTasks, longTaskMs: page?.longTaskMs, mutationsPerS: round(page?.mutationsPerS), census: c };
        census.write(`${JSON.stringify(w)}\n`);
        const { census: _, ...row } = w;
        out.windows.push({ ...row, heapMb: c.heapMb, dom: c.dom, pcs: c.pcCount, neverConnected: c.neverConnected, channels: c.channelCount, listeners: c.listenerCount, intervals: c.intervalCount, timeoutsPending: c.timeoutsPending });
        const delta = Object.entries(c.events).map(([k, v]) => [k, v - (lastEvents[k] ?? 0)]).filter(([, n]) => n > 0);
        lastEvents = c.events;
        log(`s17 ${phase} #${i}: task ${w.taskPct}% script ${w.scriptPct}% fps ${w.fps} gap ${w.maxGapMs} ms long ${w.longTaskMs} ms, heap ${c.heapMb} MB, pcs ${c.pcCount} (never connected ${c.neverConnected}, oldest ${c.oldestNeverConnectedS} s), channels ${c.channelCount}, online ${online} | ${delta.map(([k, n]) => `${k} ${n}`).join(", ")}`);
        if (profile) {
          const name = `${phase}-${i === 0 ? "first" : "last"}`;
          fs.writeFileSync(path.join(dir, `${name}.cpuprofile`), JSON.stringify(profile));
          out.profiles[name] = summarizeProfile(profile);
        }
        windows.push(w);
      }
      out.heap[phase] = await heapAfterGc(cdp).catch((e) => ({ error: String(e.message ?? e) }));
    };

    const url = peer.page.url();
    await away(peer);
    await measure("alone", opts.aloneMs);
    const back = await attempt(() => comeBack(ctx, peer, url, serverId));
    run.assert("s17.back", "the second client comes back online", back.ok, { error: back.error });
    await waitOnline(me, serverId, 1);
    if (opts.call) {
      await attempt(() => d.joinCall(me, serverId));
      await attempt(() => d.joinCall(peer, serverId));
    } else await view(peer, serverId);
    await measure("online", opts.onlineMs, { profileFirst: true, profileLast: true });
    if (opts.call) await attempt(() => d.leaveCall(me));
    await away(peer);
    await measure("left", opts.leftMs);
    census.end();
    verdict(run, out, windows);
  } catch (e) {
    log(`s17: ${e.stack ?? e}`);
    run.assert("s17.harness", "the scenario ran to the end", false, { error: String(e.message ?? e) });
  } finally {
    run.number("s17", { ...out, windows: out.windows });
    run.section("Online drift: windows", mdTable(
      ["phase", "#", "online", "task %", "script %", "style %", "layout %", "fps", "max gap ms", "long task ms", "heap MB", "DOM", "pcs", "never connected", "channels", "listeners", "intervals", "timeouts"],
      out.windows.map((w) => [w.phase, w.i, w.online, w.taskPct, w.scriptPct, w.stylePct, w.layoutPct, w.fps, w.maxGapMs, w.longTaskMs, w.heapMb, w.dom, w.pcs, w.neverConnected, w.channels, w.listeners, w.intervals, w.timeoutsPending]),
    ));
    if (out.growth.length) run.section("Online drift: what grew while online and fell back after", mdTable(
      ["what", "alone", "online first", "online last", "left"], out.growth.map((g) => [g.key, g.alone, g.first, g.last, g.left])));
    for (const [name, p] of Object.entries(out.profiles))
      run.section(`Online drift: CPU profile ${name} (busy ${p.busyMs} ms of ${p.totalMs} ms)`, mdTable(["function", "self ms"], p.functions.slice(0, 25).map((f) => [f.key, f.ms])));
    run.section("Online drift: heap after GC", mdTable(["phase", "used MB"], Object.entries(out.heap).map(([phase, h]) => [phase, h.usedMb ?? h.error])));
  }
  return out;
}

const round = (x) => (typeof x === "number" ? Math.round(x * 10) / 10 : null);

// Opens the workspace's chat channel, as a member reading it would.
async function view(client, serverId) {
  const channelId = await d.chatChannel(client, serverId).catch(() => null);
  if (channelId === null) return;
  await client.eval(async ({ serverId, channelId }) => (await import("/src/core/navigation.ts")).openChannel(serverId, channelId), { serverId, channelId }, 15_000, "openChannel").catch(() => {});
}

// The app's page goes away (its connections close with it); the poller leaves the client alone meanwhile.
async function away(client) {
  client.down = true;
  await client.page.goto("about:blank", { timeout: 30_000 }).catch((e) => log(`${short(client.name)}: away: ${e.message}`));
}

async function comeBack(ctx, client, url, serverId) {
  await client.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  client.logCursor = 0;
  await client.waitForApp();
  await d.ensureAccount(client, usernameOf(client));
  client.down = false;
  await d.waitFor(() => client.eval(async (sid) => {
    const ledger = (await import("/src/core/serverless.ts")).workspaceLedger(sid);
    return !!ledger && ledger.owner !== null;
  }, serverId, 10_000, "hasData"), { timeoutMs: 120_000, everyMs: 1000 });
}

async function waitOnline(client, serverId, n) {
  await d.waitFor(() => client.eval(async (sid) => (await import("/src/core/serverless.ts")).onlinePeers(sid), serverId, 10_000, "online").then((k) => k >= n),
    { timeoutMs: 120_000, everyMs: 1000 }).catch((e) => log(`s17: still not online: ${e.message}`));
}

// Every number in a census, flattened ("app.<sid>.mesh.outbox" -> n); cumulative counters become rates per second.
function flatten(census, previous, seconds) {
  const out = {};
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === "number") out[key] = v;
      else if (v && typeof v === "object") walk(v, key);
    }
  };
  walk(census, "");
  delete out.t;
  const rates = {};
  for (const [key, v] of Object.entries(out)) {
    const cumulative = key.startsWith("dc.") || key.startsWith("events.") || key === "timeoutsMade" || key === "framesAsked" || /^ws\..*\.(in|out|eventsIn|eventsOut|reqs|created)$/.test(key);
    if (!cumulative) continue;
    rates[`${key}/s`] = previous && typeof previous[key] === "number" ? Math.round(((v - previous[key]) / seconds) * 100) / 100 : null;
    delete out[key];
    out[`#${key}`] = v;
  }
  return { ...out, ...rates };
}

function verdict(run, out, windows) {
  const flat = [];
  let previous = null;
  for (const w of windows) {
    const f = flatten(w.census, previous, w.ms / 1000);
    previous = Object.fromEntries(Object.entries(f).filter(([k]) => k.startsWith("#")).map(([k, v]) => [k.slice(1), v]));
    flat.push({ phase: w.phase, values: f });
  }
  const of = (phase) => windows.filter((w) => w.phase === phase);
  const online = of("online");
  const alone = of("alone");
  const left = of("left");
  if (online.length < 2 || !alone.length || !left.length) {
    run.assert("s17.windows", "every phase measured", false, { online: online.length, alone: alone.length, left: left.length });
    return;
  }
  const first = online[0];
  const last = online.at(-1);
  const mean = (list, key) => list.reduce((a, w) => a + (w[key] ?? 0), 0) / list.length;
  const grew = last.taskPct >= first.taskPct * 1.5 || last.fps <= first.fps * 0.8 || (last.longTaskMs >= first.longTaskMs * 2 && last.longTaskMs > 100);
  const recovered = Math.abs(mean(left, "taskPct") - mean(alone, "taskPct")) <= Math.max(1, mean(alone, "taskPct") * 0.2);
  out.drift = { first: pick(first), last: pick(last), alone: mean(alone, "taskPct"), left: mean(left, "taskPct"), grew, recovered };
  // Numbers that rose through online (last > first by half and by 3) and fell back once alone again.
  const values = (phase) => flat.filter((f) => f.phase === phase).map((f) => f.values);
  const on = values("online");
  const lv = values("left").at(-1) ?? {};
  const av = values("alone").at(-1) ?? {};
  const a = on[1] ?? on[0];
  const b = on.at(-1);
  for (const key of Object.keys(b)) {
    if (key.startsWith("#")) continue;
    const x = a[key];
    const y = b[key];
    if (typeof x !== "number" || typeof y !== "number") continue;
    if (y > x * 1.5 && y - x >= 3) out.growth.push({ key, alone: av[key] ?? null, first: x, last: y, left: lv[key] ?? null });
  }
  out.growth.sort((p, q) => (q.last - q.first) / Math.max(1, q.first) - (p.last - p.first) / Math.max(1, p.first));
  run.assert("s17.drift", "the app does not get busier the longer another member stays online (red: it does, and recovers once alone)",
    !(grew && recovered), out.drift);
}

const pick = (w) => ({ taskPct: w.taskPct, scriptPct: w.scriptPct, fps: w.fps, maxGapMs: w.maxGapMs, longTaskMs: w.longTaskMs });
