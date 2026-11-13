// S14 call load (up.sh 8 single --nodes 2): what a voice call costs each member, by the call's size and path. The
// user's app slowed down as a whole in calls, and the machine's network use stayed high. Voice only (Chromium's fake
// mic, noise suppression off). Each phase settles, then measures every client for --measure-s:
//   idle      everyone in the workspace, nobody in a call (the baseline)
//   mesh3     3 in a mesh call (calls through nodes off); mesh5; mesh8
//   silent8   the 8 with their mics muted: what a call sends when nobody talks
//   node8     the 8 with calls through nodes on: through a node
//   ui        (only when asked) the call of 8 with the speaking indicators styled otherwise (uiVariants): what drawing
//             them costs, apart from the rest of the call
// The mic (--mic speech, the default) talks like a person: syllables with short dips, phrases with pauses (speechMic).
// Chromium's own fake mic (--mic beep) beeps for 20 ms every 500 ms, so every speaking indicator flickers twice a
// second, which no voice does.
// Per client: kbit/s and packets/s up and down over all its WebRTC connections (audio and data channels apart), the
// audio streams going out and coming in, the streams it passes on for others, the main thread's busy time
// (CDP Performance metrics: tasks, script, style, layout), frames per second and the longest gap between frames, long
// tasks, DOM changes per second (and the speaking dots' style changes), and the container's CPU.
// Options: --measure-s 20  --settle-s 15  --mic speech|beep  --phases idle,mesh3,mesh5,mesh8,silent8,node8 (add ui; the call grows to 8 for
// ui, silent8 and node8 whatever is left out)
import fs from "node:fs";
import path from "node:path";
import * as d from "../lib/driver.mjs";
import { NodeHandle } from "../lib/nodes.mjs";
import { attempt, intArg, log, mapLimit, sleep, stats } from "../lib/util.mjs";
import { mdTable, prepare, short, speechMic } from "./common.mjs";
import { hostServer } from "./s8.mjs";
import { hearsAll, joinCall, waitAll } from "./s10.mjs";

const metricNames = new Set(["TaskDuration", "ScriptDuration", "RecalcStyleDuration", "LayoutDuration", "RecalcStyleCount", "LayoutCount"]);

// Stylesheets put over the app for the ui phases.
const uiVariants = {
  // The indicators' styles before 2026-10-17: speaking shown by color and border transitions, the dot's size and the
  // mic meter by transitions too.
  before: `.voice-dot::after, .speaker-name-lit, .voice-meter-lit, .voice-thumb::after, .voice-feed::after { display: none !important; }
    .voice-dot, .voice-dot.on { transition: transform 90ms linear, background-color var(--mw-duration) var(--mw-ease) !important; }
    .voice-dot.on:not(.muted) { background: var(--mw-success); }
    .voice-meter { transition: color var(--mw-duration) var(--mw-ease); }
    .voice-meter.speaking { color: var(--mw-accent); }
    .speaker-name { transition: color var(--mw-duration) var(--mw-ease); }
    .speaker-name.speaking { color: var(--mw-text); }
    .voice-thumb { transition: border-color var(--mw-duration) var(--mw-ease); }
    .voice-thumb.speaking { border-color: var(--mw-accent); }`,
  // No transitions: every change shows at once.
  still: `.voice-dot, .voice-dot::after, .speaker-name-lit, .voice-meter, .voice-meter-lit, .voice-thumb::after, .voice-feed::after { transition: none !important; }`,
  // The indicators not drawn at all.
  hidden: `.voice-dot, .speaker-name-lit, .voice-meter-lit, .voice-thumb::after, .voice-feed::after { display: none !important; }`,
  // As built, without the scrolling areas' edge fades (scroll-driven animations, theme/base.css).
  fadeless: `.mw-scroll-fade { animation: none !important; }`,
  // As built again, for the spread between two measurements of the same thing.
  again: "",
};

export default async function s14(ctx) {
  const { run, topology, podman, args } = ctx;
  const nodes = (topology.nodes ?? []).map((spec) => new NodeHandle(spec, podman));
  const clients = ctx.clients;
  const out = { phases: {} };
  if (clients.length < 8 || nodes.length < 1) {
    run.assert("s14.setup", "8 Electron clients and a node (up.sh 8 single --nodes 2)", false, { clients: clients.length, nodes: nodes.length });
    return out;
  }
  ctx.nodeHandles = nodes;
  const measureMs = intArg(args, "measure-s", 20) * 1000;
  const settleMs = intArg(args, "settle-s", 15) * 1000;
  const wanted = new Set(String(typeof args.phases === "string" ? args.phases : "idle,mesh3,mesh5,mesh8,silent8,node8").split(","));
  const on = (name) => wanted.has(name);
  const [owner, ...joiners] = clients;
  try {
    await prepare(ctx);
    const server = await hostServer(ctx, "s14", owner, nodes, { history: 20, files: 0, fileMb: 0, storage: { sfu_calls: false } });
    if (!server) return out;
    const { serverId, invite } = server;
    out.serverId = serverId;
    const joined = await mapLimit(joiners, 8, (c) => attempt(() => d.joinServer(c, invite)));
    const data = await run.waitTracker(run.track("s14: has the workspace", joiners.map((c) => c.name), (s) => s.servers?.[serverId]?.hasData), 180_000);
    run.assert("s14.joined", `${joiners.length} members join`, joined.every((j) => j.ok) && data.missing.length === 0, { missing: data.missing });
    await Promise.all(clients.map((c) => attempt(() => d.setNoiseSuppression(c, "off"))));
    if (args.mic !== "beep") {
      const fitted = await Promise.all(clients.map((c, i) => attempt(() => c.eval(speechMic, i + 1, 10_000, "speech mic"))));
      run.assert("s14.mic", "every client's mic talks like a person", fitted.every((f) => f.ok && f.value === true), { failed: fitted.filter((f) => !f.ok).map((f) => f.error) });
    }
    const sessions = new Map();
    for (const c of clients) {
      const session = await c.page.context().newCDPSession(c.page);
      await session.send("Performance.enable");
      sessions.set(c.name, session);
    }
    const call = { serverId, users: new Map() };
    const phase = async (name, inCall) => {
      await sleep(settleMs);
      out.phases[name] = await measure(ctx, serverId, clients, inCall, sessions, measureMs);
      log(`s14 ${name}: ${summaryLine(out.phases[name])}`);
    };

    const style = (css) => Promise.all(clients.map((c) => attempt(() => c.eval((text) => {
      let el = document.getElementById("mwt-ui-variant");
      if (!text) return void el?.remove();
      el ??= document.head.appendChild(Object.assign(document.createElement("style"), { id: "mwt-ui-variant" }));
      el.textContent = text;
    }, css, 10_000, "ui variant"))));

    if (on("idle")) await phase("idle", []);
    const needAll = ["ui", "silent8", "node8"].some(on);
    for (const size of [3, 5, 8].filter((n) => on(`mesh${n}`) || (n === 8 && needAll))) {
      const members = clients.slice(0, size);
      await joinCall(ctx, call, members);
      const heard = await waitAll(members, serverId, hearsAll(size), 90_000);
      run.assert(`s14.mesh${size}.heard`, `a mesh call of ${size}: everyone hears everyone`, heard.missing.length === 0, { missing: heard.missing, saw: heard.saw });
      if (on(`mesh${size}`)) await phase(`mesh${size}`, members);
    }
    if (on("ui")) {
      for (const [name, css] of Object.entries(uiVariants)) {
        await style(css || null);
        await phase(`mesh8-${name}`, clients);
      }
      await style(null);
    }
    if (on("silent8")) {
      await Promise.all(clients.map((c) => attempt(() => c.eval(async () => {
        const voice = await import("/src/voice/state.ts");
        if (!voice.muted()) voice.toggleMute();
        return voice.muted();
      }, undefined, 10_000, "mute"))));
      await phase("silent8", clients);
      await Promise.all(clients.map((c) => attempt(() => c.eval(async () => {
        const voice = await import("/src/voice/state.ts");
        if (voice.muted()) voice.toggleMute();
        return voice.muted();
      }, undefined, 10_000, "unmute"))));
    }
    if (on("node8")) {
      await attempt(() => d.setStorage(owner, serverId, { sfu_calls: true }));
      const sfu = await waitAll(clients, serverId, (s) => s.mode === "sfu" && s.send === "connected", 120_000);
      run.assert("s14.node8.mode", "with calls through nodes on, the call of 8 goes through a node", sfu.missing.length === 0, { missing: sfu.missing, saw: sfu.saw });
      await phase("node8", clients);
    }
    await Promise.all(clients.map((c) => attempt(() => d.leaveCall(c))));
  } finally {
    out.cpu = cpuByPhase(run, out.phases, clients);
    run.number("s14", out);
    run.section("Call load per member (median / max over the clients in the call; idle: all)", phaseTable(out.phases, out.cpu));
  }
  return out;
}

// Every client measured over the same window: two network samples, the page counters and the CDP metrics.
async function measure(ctx, serverId, clients, inCall, sessions, measureMs) {
  const metrics = async (c) => {
    const { metrics: list } = await sessions.get(c.name).send("Performance.getMetrics");
    return Object.fromEntries(list.filter((m) => metricNames.has(m.name)).map((m) => [m.name, m.value]));
  };
  const startedAt = Date.now();
  await Promise.all(clients.map((c) => attempt(() => d.loadStart(c))));
  const before = await mapLimit(clients, 8, async (c) => ({ load: await attempt(() => d.callLoad(c, serverId)), metrics: await attempt(() => metrics(c)) }));
  await sleep(measureMs);
  const after = await mapLimit(clients, 8, async (c) => ({ load: await attempt(() => d.callLoad(c, serverId)), metrics: await attempt(() => metrics(c)) }));
  const names = new Set(inCall.map((c) => c.name));
  const perClient = {};
  clients.forEach((c, i) => {
    const a = before[i].load.value;
    const b = after[i].load.value;
    const ma = before[i].metrics.value;
    const mb = after[i].metrics.value;
    if (!a || !b) return void (perClient[short(c.name)] = { error: before[i].load.error ?? after[i].load.error });
    const s = (b.t - a.t) / 1000;
    // Over the connections open at the end: what each sent since the first sample (all of it for a newer one).
    const sent = (key) => Object.entries(b.byPc).reduce((sum, [id, c]) => sum + c[key] - (a.byPc[id]?.[key] ?? 0), 0);
    const kbps = (key) => Math.round((sent(key) * 8) / 1000 / s);
    const share = (key) => (ma && mb ? Math.round(((mb[key] - ma[key]) / s) * 1000) / 10 : null);
    perClient[short(c.name)] = {
      inCall: names.has(c.name),
      upKbps: kbps("bytesSent"), downKbps: kbps("bytesReceived"),
      audioUpKbps: kbps("audioSent"), audioDownKbps: kbps("audioReceived"), dataUpKbps: kbps("dataSent"), dataDownKbps: kbps("dataReceived"),
      packetsOutPerS: Math.round(sent("packetsSent") / s), packetsInPerS: Math.round(sent("packetsReceived") / s),
      audioOut: b.audioOut, audioIn: b.audioIn, connections: b.connections, forwarded: b.forwarded,
      // Share of wall time (%), and counts per second.
      taskPct: share("TaskDuration"), scriptPct: share("ScriptDuration"), stylePct: share("RecalcStyleDuration"), layoutPct: share("LayoutDuration"),
      styleRecalcsPerS: ma && mb ? Math.round((mb.RecalcStyleCount - ma.RecalcStyleCount) / s) : null,
      layoutsPerS: ma && mb ? Math.round((mb.LayoutCount - ma.LayoutCount) / s) : null,
      fps: b.page ? Math.round(b.page.fps) : null, maxFrameGapMs: b.page?.maxGapMs ?? null,
      longTasks: b.page?.longTasks ?? null, longTaskMs: b.page?.longTaskMs ?? null,
      domChangesPerS: b.page ? Math.round(b.page.mutationsPerS) : null, dotStylesPerS: b.page ? Math.round(b.page.dotStylesPerS) : null,
    };
  });
  const result = { startedAt, endedAt: Date.now(), size: inCall.length, perClient };
  fs.writeFileSync(path.join(ctx.run.dir, `s14-${inCall.length}-${startedAt}.json`), JSON.stringify(result, null, 1));
  return result;
}

// Mean container CPU per client during each phase's window (podman-stats.csv, every 5 s).
function cpuByPhase(run, phases, clients) {
  const file = path.join(run.dir, "podman-stats.csv");
  if (!fs.existsSync(file)) return {};
  const rows = fs.readFileSync(file, "utf8").trim().split("\n").slice(1).map((l) => l.split(",")).map(([t, name, cpu]) => ({ t: Number(t), name, cpu: Number(cpu) }));
  const out = {};
  for (const [name, p] of Object.entries(phases)) {
    out[name] = {};
    for (const c of clients) {
      const values = rows.filter((r) => r.name === (c.spec?.container ?? c.name) && r.t >= p.startedAt && r.t <= p.endedAt).map((r) => r.cpu);
      out[name][short(c.name)] = values.length ? Math.round(values.reduce((x, y) => x + y, 0) / values.length) : null;
    }
  }
  return out;
}

const pick = (p, key) => Object.values(p.perClient).filter((c) => !c.error && (p.size === 0 || c.inCall)).map((c) => c[key]).filter((v) => typeof v === "number");
const medMax = (p, key) => {
  const s = stats(pick(p, key));
  return s.count ? `${Math.round(s.p50)} / ${Math.round(s.max)}` : "–";
};

function summaryLine(p) {
  return ["upKbps", "downKbps", "packetsOutPerS", "taskPct", "fps", "domChangesPerS"].map((k) => `${k} ${medMax(p, k)}`).join(", ");
}

function phaseTable(phases, cpu) {
  const rows = Object.entries(phases).map(([name, p]) => {
    const members = Object.entries(p.perClient).filter(([, c]) => !c.error && (p.size === 0 || c.inCall)).map(([n]) => n);
    const cpuValues = members.map((n) => cpu?.[name]?.[n]).filter((v) => typeof v === "number");
    const cpuStats = stats(cpuValues);
    return [
      name, p.size, medMax(p, "upKbps"), medMax(p, "downKbps"), medMax(p, "audioUpKbps"), medMax(p, "dataUpKbps"),
      medMax(p, "packetsOutPerS"), medMax(p, "audioOut"), medMax(p, "forwarded"), medMax(p, "taskPct"), medMax(p, "scriptPct"),
      medMax(p, "styleRecalcsPerS"), medMax(p, "fps"), medMax(p, "maxFrameGapMs"), medMax(p, "domChangesPerS"), medMax(p, "dotStylesPerS"),
      cpuStats.count ? `${Math.round(cpuStats.p50)} / ${Math.round(cpuStats.max)}` : "–",
    ];
  });
  return mdTable(["phase", "in call", "up kbit/s", "down kbit/s", "audio up", "data up", "packets out/s", "audio streams out", "forwarded",
    "main thread busy %", "script %", "style recalcs/s", "fps", "longest frame gap ms", "DOM changes/s", "dot styles/s", "CPU %"], rows);
}
