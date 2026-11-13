// S16 call hold (up.sh 3 single [--nodes 1]): does a call keep its sound? Members of mesh calls stopped hearing each
// other 10-20 s in (reported 2026-10-20). Each phase puts members in a call and holds it for --hold-s while every page
// samples (instrument.js W.holdStart): every second the loudest each other member's sound got (dBFS), the bytes of
// each member's mic, every connection's states and audio/data bytes, which connection carries each call peer, and how
// the member reaches it. Every page also traces what might cut the sound (W.voiceTrace): sync hellos and commit
// batches, rooms wanted, route lists, streams placed and taken off, nodes forgotten, the call's mode, mics shown.
//   pair  2 members (the first two clients)
//   trio  3 members
//   cut   3 members; --cut-at-s into the hold the last one's networks go for --cut-s, and it comes back while still in
//         the call (reported 2026-10-21: a member back from a dropped connection stayed "Connecting…" for good, not
//         hearing a member whose side checked its proof first). Once back it checks each proof --slow-proof-ms late,
//         like a device busy reconnecting to everyone (on one idle host both sides check at once and the race never
//         shows). Drops to and from it are expected: every pair must hear each other again within --recover-s of its
//         return, and no member's call may still say "Connecting…". Any other drop fails, as in the other phases.
// A (listener, speaker) pair drops when, after it was heard, nothing above --heard-db comes for --silence-s. A drop
// with no mic bytes either is "no packets" (the path is gone), with bytes "packets, no sound". For each drop, both
// members' events from 10 s before to 2 s after go to <run>/s16/<phase>-drops.json, and the summary compares how often
// each kind of event comes in the 5 s before a drop with how often it comes in any 5 s of the hold (either member of a
// pair, both times).
// Options: --phases pair,trio  --hold-s 120  --silence-s 4  --heard-db -60  --mic speech|beep  --sfu-calls on|off
//   --cut-at-s 30  --cut-s 10  --recover-s 30  --slow-proof-ms 1500 (the cut phase)
// Experiments: HARNESS_ENV="MWT_EXPERIMENTS=norecheck" (the sync timer's hellos dropped while in a call),
// "noroutes" (members ignore route lists).
import fs from "node:fs";
import path from "node:path";
import * as d from "../lib/driver.mjs";
import { NodeHandle } from "../lib/nodes.mjs";
import { attempt, intArg, log, mapLimit, seconds, sleep, stats } from "../lib/util.mjs";
import { cut, mdTable, prepare, reattach, reconnectNetworks, short, speechMic } from "./common.mjs";
import { hostServer } from "./s8.mjs";
import { userOf } from "./s10.mjs";

const sizes = { pair: 2, trio: 3, cut: 3 };
// Before a drop, the window events are counted in; around it, the window written out.
const beforeMs = 5_000;
const aroundMs = [10_000, 2_000];

export default async function s16(ctx) {
  const { run, topology, podman, args } = ctx;
  const nodes = (topology.nodes ?? []).map((spec) => new NodeHandle(spec, podman));
  const clients = ctx.clients;
  const wanted = String(typeof args.phases === "string" ? args.phases : "pair,trio").split(",").filter((p) => sizes[p]);
  const need = Math.max(2, ...wanted.map((p) => sizes[p]));
  const out = { phases: {}, nodes: nodes.length, experiments: process.env.MWT_EXPERIMENTS ?? "" };
  if (clients.length < need) {
    run.assert("s16.setup", `at least ${need} Electron clients (up.sh 3 single)`, false, { clients: clients.length });
    return out;
  }
  ctx.nodeHandles = nodes;
  const opts = {
    holdMs: intArg(args, "hold-s", 120) * 1000, silenceMs: intArg(args, "silence-s", 4) * 1000,
    heardDb: intArg(args, "heard-db", -60),
    cutAtMs: intArg(args, "cut-at-s", 30) * 1000, cutForMs: intArg(args, "cut-s", 10) * 1000,
    recoverMs: intArg(args, "recover-s", 30) * 1000, slowProofMs: intArg(args, "slow-proof-ms", 1500),
  };
  fs.mkdirSync(path.join(run.dir, "s16"), { recursive: true });
  const [owner] = clients;
  try {
    await prepare(ctx);
    const storage = args["sfu-calls"] === "off" ? { sfu_calls: false } : args["sfu-calls"] === "on" ? { sfu_calls: true } : null;
    let serverId;
    let invite;
    if (nodes.length > 0) {
      const server = await hostServer(ctx, "s16", owner, nodes, { history: 20, files: 0, fileMb: 0, storage });
      if (!server) return out;
      ({ serverId, invite } = server);
    } else {
      const created = await attempt(() => d.createServer(owner, "s16"));
      if (!created.ok) {
        run.assert("s16.create", "the owner creates the workspace", false, { error: created.error });
        return out;
      }
      ({ id: serverId, invite } = created.value);
      run.watch(serverId);
      if (storage) await d.setStorage(owner, serverId, storage);
    }
    out.serverId = serverId;
    const members = clients.slice(0, need);
    const joined = await mapLimit(members.slice(1), 8, (c) => attempt(() => d.joinServer(c, invite)));
    const data = await run.waitTracker(run.track("s16: has the workspace", members.slice(1).map((c) => c.name), (s) => s.servers?.[serverId]?.hasData), 180_000);
    run.assert("s16.joined", `${members.length - 1} members join the workspace`, joined.every((j) => j.ok) && data.missing.length === 0,
      { missing: data.missing, failed: joined.filter((j) => !j.ok).map((j) => j.error) });
    // Members leave the member room once a node is reachable (hubAfterMs): the call starts in the topology it keeps.
    await sleep(nodes.length > 0 ? 20_000 : 5_000);
    await Promise.all(members.map((c) => attempt(() => d.setNoiseSuppression(c, "off"))));
    if (args.mic !== "beep") {
      const fitted = await Promise.all(members.map((c, i) => attempt(() => c.eval(speechMic, i + 1, 10_000, "speech mic"))));
      run.assert("s16.mic", "every member's mic talks like a person", fitted.every((f) => f.ok && f.value === true), { failed: fitted.filter((f) => !f.ok).map((f) => f.error) });
    }
    for (const name of wanted) out.phases[name] = await holdPhase(ctx, serverId, members.slice(0, sizes[name]), name, opts);
  } finally {
    run.number("s16", out);
    run.section("Call hold", mdTable(
      ["phase", "pairs", "heard", "first heard p50 / max", "drops", "pairs dropped", "first drop after (min / p50 / max)", "no packets", "recovered", "longest silence"],
      Object.entries(out.phases).map(([name, p]) => [
        name, p.pairs, p.heard, `${seconds(p.firstHeardMs?.p50)} / ${seconds(p.firstHeardMs?.max)}`, p.drops, p.pairsDropped,
        p.firstDrop ? `${seconds(p.firstDrop.min)} / ${seconds(p.firstDrop.p50)} / ${seconds(p.firstDrop.max)}` : "–",
        p.noPackets, p.recovered, p.longestMs === null ? "–" : seconds(p.longestMs),
      ]),
    ));
    for (const [name, p] of Object.entries(out.phases)) {
      if (!p.before?.length) continue;
      run.section(`Call hold ${name}: what comes in the ${seconds(beforeMs)} before a drop (either member) vs. in any ${seconds(beforeMs)} of the hold`,
        mdTable(["event", "before drops", "any window"], p.before.map((b) => [b.kind, `${b.drops}/${p.drops}`, `${Math.round(b.base * 100)}%`])));
    }
  }
  return out;
}

async function holdPhase(ctx, serverId, members, label, opts) {
  const { run } = ctx;
  const names = members.map((c) => c.name);
  await Promise.all(members.map((c) => attempt(() => c.eval(async (sid) => {
    await window.__mwt?.traceVoice?.();
    window.__mwt?.traceCall?.();
    return window.__mwt?.holdStart?.(sid);
  }, serverId, 15_000, "holdStart"))));
  const t0 = Date.now();
  const joinedAt = {};
  const call = { serverId, users: new Map() };
  await mapLimit(members, members.length, async (c) => {
    joinedAt[c.name] = Date.now();
    const r = await attempt(() => d.joinCall(c, serverId));
    if (!r.ok || r.value === null) log(`${short(c.name)}: joinCall failed: ${r.error ?? "no voice channel"}`);
    // The instances exist now (a workspace opened after the patch): wrap them too.
    await attempt(() => c.eval(() => window.__mwt?.traceCall?.(), undefined, 10_000, "traceCall"));
  });
  for (const c of members) await userOf(call, c);
  const samples = Object.fromEntries(names.map((n) => [n, []]));
  const cursors = Object.fromEntries(names.map((n) => [n, 0]));
  // A member cut off (`down`) isn't asked: each ask waited out its timeout, and the cut lasted 27 s instead of 10. Its
  // page keeps sampling meanwhile; what it heard is read once it is back.
  const read = () => mapLimit(members.filter((c) => !c.down), members.length, async (c) => {
    const r = await attempt(() => c.eval((cursor) => window.__mwt?.holdRead?.(cursor) ?? { samples: [], next: cursor }, cursors[c.name], 20_000, "holdRead"));
    if (!r.ok) return;
    samples[c.name].push(...r.value.samples);
    cursors[c.name] = r.value.next;
  });
  // The cut phase: the last member goes off every network and comes back while it stays in the call, checking the
  // others' proofs late once back (W.slowProofMs, as a device busy reconnecting to everyone at once). The hold lasts
  // until its recovery is due at least, counted from when it is actually back.
  const cutting = label === "cut" ? members.at(-1) : null;
  let until = t0 + (cutting ? Math.max(opts.holdMs, opts.cutAtMs + opts.cutForMs + opts.recoverMs + 10_000) : opts.holdMs);
  let cutAt = null;
  let backAt = null;
  // Without the late proof checks the race this phase is for never shows on one idle host: said, not assumed.
  let slowProof = null;
  // Back counts from its networks' return, not from the harness reaching its page again (that can take a while).
  const comeBack = async () => {
    const back = await attempt(() => reconnectNetworks(ctx, cutting));
    backAt = Date.now();
    until = Math.max(until, backAt + opts.recoverMs + 5_000);
    log(`s16 ${label}: ${short(cutting.name)} back after ${seconds(backAt - cutAt)}${back.ok ? "" : ` (networks: ${back.error})`}`);
    await attempt(() => reattach(ctx, cutting));
  };
  try {
    while (Date.now() < until) {
      await sleep(Math.min(5000, Math.max(0, until - Date.now())));
      if (cutting && cutAt === null && Date.now() - t0 >= opts.cutAtMs) {
        slowProof = await attempt(() => cutting.eval((ms) => void (window.__mwt.slowProofMs = ms), opts.slowProofMs, 10_000, "slowProof"));
        // Before the first network goes: the call's sound may stop with it.
        cutAt = Date.now();
        const off = await attempt(() => cut(ctx, cutting));
        log(`s16 ${label}: ${short(cutting.name)} cut off at +${seconds(cutAt - t0)}${off.ok ? "" : ` (partly: ${off.error})`}`);
      } else if (cutting && cutAt !== null && backAt === null && Date.now() - cutAt >= opts.cutForMs) await comeBack();
      await read();
      // Progress: whom each member heard in the last few seconds.
      const now = Date.now();
      const line = names.map((n) => {
        const recent = samples[n].filter((s) => s.t > now - opts.silenceMs);
        const heard = new Set(recent.flatMap((s) => Object.entries(s.level).filter(([, db]) => db !== null && db >= opts.heardDb).map(([u]) => Number(u))));
        const others = names.filter((m) => m !== n).map((m) => call.users.get(m));
        return `${short(n)} hears ${others.map((u) => (heard.has(u) ? u : `!${u}`)).join(",")}`;
      }).join("; ");
      log(`s16 ${label} +${seconds(now - t0)}: ${line}`);
    }
  } finally {
    // Never left cut off or checking proofs late, whatever went wrong in the hold.
    if (cutting && cutAt !== null && backAt === null) await comeBack();
    if (cutting) await attempt(() => cutting.eval(() => void (window.__mwt.slowProofMs = 0), undefined, 10_000, "slowProof"));
  }
  await read();
  await Promise.all(members.map((c) => attempt(() => c.eval(() => window.__mwt?.holdStop?.(), undefined, 10_000, "holdStop"))));
  // Everything each member traced and logged since a little before the phase, and its connections.
  const since = t0 - 10_000;
  const dumps = Object.fromEntries(await mapLimit(members, members.length, async (c) => {
    const r = await attempt(() => c.eval((from) => {
      const W = window.__mwt;
      return {
        trace: (W?.voiceTrace ?? []).filter((e) => e.t >= from),
        logs: (W?.logs ?? []).filter((l) => l.t >= from && (l.l !== "log" && l.l !== "debug")).slice(-3000),
        pcs: (W?.pcDetail?.() ?? []).filter((p) => !p.closedAt || p.closedAt >= from),
      };
    }, since, 30_000, "hold dump"));
    return [c.name, r.ok ? r.value : { trace: [], logs: [], pcs: [], error: r.error }];
  }));
  const users = Object.fromEntries([...call.users].map(([n, u]) => [n, u]));
  for (const n of names) {
    fs.writeFileSync(path.join(run.dir, "s16", `${label}-timeline-${short(n)}.json`),
      JSON.stringify({ me: users[n], joinedAt: joinedAt[n], samples: samples[n], ...dumps[n] }, null, 1));
  }

  // Each (listener, speaker) pair through the listener's samples.
  const pairs = [];
  for (const l of names) {
    for (const s of names) {
      if (l === s) continue;
      const user = users[s];
      const from = Math.max(joinedAt[l], joinedAt[s]);
      const pair = { listener: short(l), speaker: short(s), user, firstHeard: null, drops: [] };
      let lastHeard = null;
      let lastFlow = null;
      let bytes = null;
      let open = null;
      for (const sample of samples[l]) {
        if (sample.t < from) continue;
        const db = sample.level?.[user];
        const heard = typeof db === "number" && db >= opts.heardDb;
        const b = sample.micBytes?.[user];
        if (typeof b === "number" && (bytes === null || b !== bytes)) {
          if (bytes !== null) lastFlow = sample.t;
          bytes = b;
        }
        if (heard) {
          if (pair.firstHeard === null) pair.firstHeard = sample.t;
          if (open) {
            open.recoveredAt = sample.t;
            pair.drops.push(open);
            open = null;
          }
          lastHeard = sample.t;
          continue;
        }
        if (open || lastHeard === null || sample.t - lastHeard < opts.silenceMs) continue;
        // Silent for --silence-s after being heard: the drop starts at the last sample heard.
        open = {
          onset: lastHeard, cause: lastFlow !== null && lastFlow > lastHeard ? "packets, no sound" : "no packets",
          mic: sample.mic?.[user] ?? null, mode: sample.mode, peers: sample.peers, recoveredAt: null,
        };
      }
      if (open) pair.drops.push(open);
      for (const drop of pair.drops) {
        drop.afterMs = drop.onset - from;
        drop.lastMs = (drop.recoveredAt ?? samples[l].at(-1)?.t ?? drop.onset) - drop.onset;
      }
      pairs.push({ ...pair, from, l, s });
    }
  }

  // Around each drop: both members' events, logs and connection state changes.
  const eventsOf = (n) => [
    ...dumps[n].trace.map((e) => ({ ...e, who: short(n), kind: e.e })),
    ...dumps[n].logs.map((l) => ({ t: l.t, who: short(n), kind: `log:${logKind(l.m)}`, m: l.m })),
    ...dumps[n].pcs.flatMap((p) => [
      ...p.states.map(([t, state]) => ({ t, who: short(n), kind: `pc:${state}`, pc: p.id })),
      ...p.iceStates.map(([t, state]) => ({ t, who: short(n), kind: `ice:${state}`, pc: p.id })),
    ]),
  ].sort((a, b) => a.t - b.t);
  const events = Object.fromEntries(names.map((n) => [n, eventsOf(n)]));
  const drops = pairs.flatMap((p) => p.drops.map((drop) => ({
    pair: `${p.listener} hears ${p.speaker}`, members: [p.l, p.s], ...drop,
    around: [...events[p.l], ...events[p.s]].filter((e) => e.t >= drop.onset - aroundMs[0] && e.t <= drop.onset + aroundMs[1])
      .sort((a, b) => a.t - b.t).map((e) => ({ ...e, at: e.t - drop.onset })),
  })));
  fs.writeFileSync(path.join(run.dir, "s16", `${label}-drops.json`), JSON.stringify({ t0, users, joinedAt, drops }, null, 1));

  // Which kinds of events come in the `beforeMs` before a drop, against any `beforeMs` window of the hold.
  const before = [];
  if (drops.length > 0) {
    const kinds = new Set(drops.flatMap((drop) => drop.around.filter((e) => e.at >= -beforeMs && e.at <= 1000).map((e) => e.kind)));
    const end = until;
    for (const kind of kinds) {
      const hits = drops.filter((drop) => drop.around.some((e) => e.kind === kind && e.at >= -beforeMs && e.at <= 1000)).length;
      // Like a drop, a window counts it from either member of a pair.
      let windows = 0;
      let withKind = 0;
      for (const p of pairs) {
        const times = [...events[p.l], ...events[p.s]].filter((e) => e.kind === kind).map((e) => e.t);
        for (let t = t0 + beforeMs; t <= end; t += 1000) {
          windows++;
          if (times.some((x) => x >= t - beforeMs && x <= t + 1000)) withKind++;
        }
      }
      before.push({ kind, drops: hits, base: windows ? withKind / windows : 0 });
    }
    before.sort((a, b) => b.drops / drops.length - b.base - (a.drops / drops.length - a.base));
  }

  const listed = (list) => list.map((x) => `${x.pair} at +${seconds(x.afterMs)} for ${seconds(x.lastMs)}${x.recoveredAt === null ? " (to the end)" : ""}: ${x.cause}`);
  const heardPairs = pairs.filter((p) => p.firstHeard !== null);
  const firstDrops = pairs.filter((p) => p.drops.length > 0).map((p) => p.drops[0].afterMs);
  const result = {
    pairs: pairs.length, heard: heardPairs.length, firstHeardMs: stats(heardPairs.map((p) => p.firstHeard - p.from)),
    drops: drops.length, pairsDropped: firstDrops.length, firstDrop: firstDrops.length ? stats(firstDrops) : null,
    noPackets: drops.filter((x) => x.cause === "no packets").length, recovered: drops.filter((x) => x.recoveredAt !== null).length,
    longestMs: drops.length ? Math.max(...drops.map((x) => x.lastMs)) : null,
    list: listed(drops),
    before: before.slice(0, 25), users,
    ...(cutting && { cut: { member: short(cutting.name), atMs: cutAt && cutAt - t0, backMs: backAt && backAt - t0 } }),
  };
  log(`s16 ${label}: ${result.heard}/${result.pairs} pairs heard, ${result.drops} drops${result.list.length ? `: ${result.list.join("; ")}` : ""}`);
  run.assert(`s16.${label}.heard`, `${label}: every member hears every other`, result.heard === result.pairs,
    { never: pairs.filter((p) => p.firstHeard === null).map((p) => `${p.listener} hears ${p.speaker}`) });
  if (cutting) {
    // The cut explains only drops to and from the member cut off, from the cut on (a drop starts at the last sound
    // heard, which may be up to --silence-s before). Any other drop is a call going silent, as in the other phases.
    // A drop starting once the member is back and heard again is a call going silent too.
    const byCut = (x) => cutAt !== null && x.members.includes(cutting.name) && x.onset >= cutAt - opts.silenceMs
      && (backAt === null || x.onset <= backAt + opts.silenceMs);
    run.assert(`s16.${label}.slow`, `${label}: ${short(cutting.name)} checks proofs ${opts.slowProofMs} ms late once back (the race this phase is for)`,
      opts.slowProofMs === 0 || slowProof?.ok === true, { error: slowProof?.error ?? (slowProof ? null : "never set") });
    const other = drops.filter((x) => !byCut(x));
    run.assert(`s16.${label}.held`, `${label}: nobody's sound drops for ${seconds(opts.silenceMs)} or more, but to and from ${short(cutting.name)} while it is cut off`,
      other.length === 0, { drops: listed(other) });
    // Each drop it explains must end within --recover-s of the member's return (or of its own start, when later).
    const late = drops.filter(byCut).filter((x) => backAt === null || x.recoveredAt === null || x.recoveredAt - Math.max(backAt, x.onset) > opts.recoverMs);
    run.assert(`s16.${label}.recovered`, `${label}: every pair hears each other again within ${seconds(opts.recoverMs)} of ${short(cutting.name)} coming back`,
      cutAt !== null && backAt !== null && late.length === 0, { late: late.map((x) => `${x.pair} from +${seconds(x.onset - t0)}${x.recoveredAt === null ? " to the end" : ` to +${seconds(x.recoveredAt - t0)}`}`) });
    const connecting = Object.fromEntries(await mapLimit(members, members.length, async (c) => {
      const r = await attempt(() => c.eval(async () => (await import("/src/voice/state.ts")).callConnecting(), undefined, 10_000, "callConnecting"));
      return [short(c.name), r.ok ? r.value : `unread: ${r.error}`];
    }));
    run.assert(`s16.${label}.connected`, `${label}: no member's call still says "Connecting…"`, Object.values(connecting).every((v) => v === false), { connecting });
  } else run.assert(`s16.${label}.held`, `${label}: nobody's sound drops for ${seconds(opts.silenceMs)} or more during ${seconds(opts.holdMs)}`, drops.length === 0, { drops: listed(drops) });

  await Promise.all(members.map((c) => attempt(() => c.eval(async () => (await import("/src/voice/state.ts")).leaveVoice(true), undefined, 15_000, "leaveVoice"))));
  // Past the first "left" refresh, so the next phase starts with an empty call.
  await sleep(10_000);
  return result;
}

// A console line's kind for the drop table: Trystero's own, the app's call and sync lines, else the level.
function logKind(text) {
  if (/trystero/i.test(text)) return /peer error/i.test(text) ? "trystero-peer-error" : /disconnecting peer/i.test(text) ? "trystero-disconnect" : "trystero";
  if (/^Call:/.test(text)) return "call";
  if (/Could not connect/.test(text)) return "connect-failed";
  if (/^\[sync\]/.test(text)) return "sync";
  if (/Stream (not|placed)/.test(text)) return "stream";
  return "other";
}
