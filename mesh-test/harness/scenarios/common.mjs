// Flows shared by the scenarios: accounts, servers, joins, message rounds, convergence and mesh snapshots.
// Nothing here throws on a test failure: misses are measured and turned into assertions by the scenario.
import * as d from "../lib/driver.mjs";
import { visibilityMatrix } from "../lib/metrics.mjs";
import { attempt, log, mapLimit, seconds, sleep, stats } from "../lib/util.mjs";

export const short = (name) => name.replace(/^mwt-client/, "c").replace(/^client/, "c");
export const usernameOf = (client) => `mwt.${short(client.name)}`.toLowerCase().replace(/[^a-z0-9._]/g, "");

// Signs every client in (registering on first use) and, unless keepServers, leaves servers from earlier runs so
// their rooms don't add traffic. Returns { ok, failed }.
export async function prepare(ctx, { keepServers = Boolean(ctx.args?.["keep-servers"]) } = {}) {
  const { run, clients } = ctx;
  run.event("prepare", { clients: clients.length });
  const results = await mapLimit(clients, 10, async (c) => {
    const r = await attempt(() => d.ensureAccount(c, usernameOf(c)));
    if (!r.ok) return { name: c.name, ok: false, error: r.error };
    let left = [];
    if (!keepServers) {
      const l = await attempt(() => d.leaveAll(c));
      left = l.ok ? l.value : [`error: ${l.error}`];
    }
    return { name: c.name, ok: true, how: r.value.how, left };
  });
  const failed = results.filter((r) => !r.ok);
  run.assert("setup.accounts", "every client is signed in", failed.length === 0, { failed });
  run.number("setup", { accounts: results.map((r) => ({ name: r.name, how: r.how, left: r.left?.length ?? 0 })) });
  return { ok: failed.length === 0, failed };
}

// Creates a server on `owner` and makes `joiners` join it.
//  mode: "burst" (all at once) | "sequential" (one after another, each waits until it has the data)
//  inviteFrom: "owner" | "chain" (each joiner uses the code from the previous one) | "random" (any member so far)
// Records trackers for data, visibility (online >= expectedOnline) and members; returns the server id and times.
export async function setupServer(ctx, owner, joiners, opts = {}) {
  const { run } = ctx;
  const {
    mode = "burst", inviteFrom = "owner", label = `mesh-${run.runId.slice(-6)}`, name = label,
    dataTimeoutMs = 180_000, visibleTimeoutMs = 240_000, sequentialStepMs = 120_000, expectedOnline = null,
  } = opts;
  const created = await attempt(() => d.createServer(owner, name));
  if (!created.ok || !created.value.id) {
    run.assert(`${label}.create`, `${short(owner.name)} creates the server`, false, { error: created.error ?? "no id" });
    return null;
  }
  const serverId = created.value.id;
  const invite = created.value.invite;
  run.event("server-created", { label, serverId, owner: owner.name, ms: created.value.ms });
  run.watch(serverId);

  const members = [owner];
  const joins = {};
  const all = [owner, ...joiners];
  const names = all.map((c) => c.name);
  const dataTracker = run.track(`${label}: has server data`, joiners.map((c) => c.name), (s) => s.servers[serverId]?.hasData);

  const codeFor = async (joiner, i) => {
    if (inviteFrom === "owner") return { code: invite, from: owner.name };
    const giver = inviteFrom === "chain" ? members.at(-1) : members[Math.floor(Math.random() * members.length)];
    const r = await attempt(() => d.invite(giver, serverId));
    return { code: r.ok && r.value ? r.value : invite, from: giver.name, fallback: !(r.ok && r.value) };
  };

  if (mode === "sequential") {
    for (const [i, joiner] of joiners.entries()) {
      const { code, from, fallback } = await codeFor(joiner, i);
      const t0 = Date.now();
      const r = await attempt(() => d.joinServer(joiner, code));
      joins[joiner.name] = { ok: r.ok, error: r.error, at: t0, from, fallback };
      const step = run.track(`${label}: ${short(joiner.name)} data`, [joiner.name], (s) => s.servers[serverId]?.hasData);
      const res = await run.waitTracker(step, sequentialStepMs);
      joins[joiner.name].dataMs = res.perClient[joiner.name];
      members.push(joiner);
    }
  } else {
    const codes = await Promise.all(joiners.map((j, i) => codeFor(j, i)));
    const t0 = Date.now();
    await Promise.all(joiners.map(async (joiner, i) => {
      const r = await attempt(() => d.joinServer(joiner, codes[i].code));
      joins[joiner.name] = { ok: r.ok, error: r.error, at: t0, from: codes[i].from };
    }));
    members.push(...joiners);
  }
  run.event("joined", { label, serverId, mode, failed: Object.entries(joins).filter(([, j]) => !j.ok).map(([n]) => n) });

  // expectedOnline: a number, or (clientName) => number when members can't all reach each other.
  const target = typeof expectedOnline === "function" ? expectedOnline : () => expectedOnline ?? all.length - 1;
  const visibleTracker = run.track(`${label}: sees ${typeof expectedOnline === "function" ? "reachable members" : target()} online`, names,
    (s, name) => (s.servers[serverId]?.online ?? 0) >= target(name));
  // The member list as the UI shows it: nodes hosting the server aren't members there.
  const membersTracker = run.track(`${label}: lists ${all.length} members`, names, (s) => (s.servers[serverId]?.membersVisible ?? 0) >= all.length);
  const data = await run.waitTracker(dataTracker, dataTimeoutMs);
  const visible = await run.waitTracker(visibleTracker, visibleTimeoutMs);
  const membersRes = await run.waitTracker(membersTracker, 60_000);
  return { serverId, invite, owner, all, names, joins, data, visible, members: membersRes, label };
}

const channelCache = new Map();
export async function channelOf(client, serverId) {
  const key = `${client.name}:${serverId}`;
  if (channelCache.has(key)) return channelCache.get(key);
  const id = await d.waitFor(() => d.chatChannel(client, serverId), { timeoutMs: 60_000, everyMs: 1000 });
  if (id !== null && id !== undefined) channelCache.set(key, id);
  return id ?? null;
}

// Every sender posts `perClient` tagged messages (`gapMs` apart, all senders at once); measures when each receiver
// got each message (instrumented Ledger.accept) and checks the result against the channel's actual messages.
export async function messageRound(ctx, serverId, senders, receivers, opts = {}) {
  const { run } = ctx;
  const { perClient = 3, gapMs = 0, label = "round", timeoutMs = 180_000, staggerMs = 0 } = opts;
  const prefix = `mwt|${run.runId.slice(-6)}|${label}|`;
  run.setPrefix(serverId, prefix);
  run.event("round-start", { label, serverId, senders: senders.length, receivers: receivers.length, perClient, gapMs });

  const postStart = Date.now();
  const posted = {};
  await Promise.all(senders.map(async (sender, i) => {
    if (staggerMs) await sleep(i * staggerMs);
    const channelId = await channelOf(sender, serverId);
    if (channelId === null) {
      posted[sender.name] = [{ ok: false, error: "no chat channel (server data missing)" }];
      return;
    }
    const tags = Array.from({ length: perClient }, (_, k) => `${prefix}${short(sender.name)}|${k}`);
    const r = await attempt(() => d.postTagged(sender, serverId, channelId, tags, gapMs));
    posted[sender.name] = r.ok ? r.value : [{ ok: false, error: r.error }];
  }));
  const postEnd = Date.now();
  const ok = Object.entries(posted).flatMap(([sender, list]) => list.filter((p) => p.ok).map((p) => ({ ...p, sender })));
  const failedPosts = Object.entries(posted).flatMap(([sender, list]) => list.filter((p) => !p.ok).map((p) => ({ sender, error: p.error })));
  const expectedFor = (receiver) => ok.filter((p) => p.sender !== receiver).length;

  const tracker = run.track(`${label}: all messages arrived`, receivers.map((c) => c.name),
    (s, name) => s.servers[serverId]?.seenPrefix === prefix && (s.servers[serverId]?.seen ?? 0) >= expectedFor(name),
    { startedAt: postStart });
  const arrival = await run.waitTracker(tracker, timeoutMs);

  // Per (message, receiver): latency from the instrumentation, delivery from the channel itself.
  const latencies = [];
  const samples = [];
  const perReceiver = {};
  const undelivered = [];
  await Promise.all(receivers.map(async (receiver) => {
    const seen = await attempt(() => d.seenTimes(receiver, serverId, prefix));
    const channelId = await channelOf(receiver, serverId);
    const actual = channelId === null ? { ok: false, error: "no channel" } : await attempt(() => d.messageTags(receiver, serverId, channelId));
    const have = new Set(actual.ok ? actual.value.tags : []);
    const expected = ok.filter((p) => p.sender !== receiver.name);
    const lat = [];
    let missing = 0;
    for (const p of expected) {
      const at = seen.ok ? seen.value[p.tag] : undefined;
      if (at !== undefined) lat.push(at - p.t);
      const delivered = have.has(p.tag);
      if (!delivered) missing++;
      samples.push({ sender: p.sender, receiver: receiver.name, ms: at !== undefined ? at - p.t : null, delivered });
    }
    latencies.push(...lat);
    perReceiver[receiver.name] = { expected: expected.length, delivered: expected.length - missing, timed: lat.length, latency: stats(lat), readError: actual.ok ? undefined : actual.error };
    if (missing > 0) undelivered.push({ receiver: receiver.name, missing, of: expected.length });
  }));
  const result = {
    label, posted: ok.length, failedPosts, postMs: postEnd - postStart, latency: stats(latencies), allArrivedMs: arrival.allMs,
    undelivered, perReceiver, samples,
  };
  run.event("round-end", { label, posted: ok.length, undelivered: undelivered.length, allArrivedMs: arrival.allMs });
  log(`${label}: ${ok.length} posted, latency p50 ${seconds(result.latency.p50)} p95 ${seconds(result.latency.p95)} max ${seconds(result.latency.max)}, undelivered at ${undelivered.length} receivers`);
  return result;
}

// Whether every client ends with the same commits, the same order and the same channel contents.
export async function convergence(ctx, serverId, clients, label = "final") {
  const infos = {};
  const tags = {};
  await Promise.all(clients.map(async (c) => {
    const li = await attempt(() => d.ledgerInfo(c, serverId));
    infos[c.name] = li.ok ? li.value : { error: li.error };
    const channelId = await channelOf(c, serverId);
    const mt = channelId === null ? { ok: false, error: "no channel" } : await attempt(() => d.messageTags(c, serverId, channelId));
    tags[c.name] = mt.ok ? mt.value : { error: mt.error };
  }));
  const group = (fn) => {
    const groups = {};
    for (const c of clients) (groups[fn(c.name)] ??= []).push(short(c.name));
    return groups;
  };
  const sets = group((n) => infos[n]?.setDigest ?? `error:${infos[n]?.error ?? "none"}`);
  const orders = group((n) => infos[n]?.orderDigest ?? `error:${infos[n]?.error ?? "none"}`);
  const messages = group((n) => (tags[n]?.tags ? `${tags[n].tags.length}:${hashList(tags[n].tags)}` : `error:${tags[n]?.error}`));
  const counts = Object.fromEntries(clients.map((c) => [short(c.name), infos[c.name]?.count ?? null]));
  const collisions = Object.fromEntries(clients.filter((c) => infos[c.name]?.collisions?.length).map((c) => [short(c.name), infos[c.name].collisions.length]));
  const rejected = Object.fromEntries(clients.filter((c) => infos[c.name]?.rejected).map((c) => [short(c.name), infos[c.name].rejected]));
  return {
    label,
    sameCommits: Object.keys(sets).length === 1 && !Object.keys(sets)[0].startsWith("error"),
    sameOrder: Object.keys(orders).length === 1 && !Object.keys(orders)[0].startsWith("error"),
    sameMessages: Object.keys(messages).length === 1 && !Object.keys(messages)[0].startsWith("error"),
    commitGroups: Object.values(sets).length > 1 ? sets : undefined,
    messageGroups: Object.values(messages).length > 1 ? messages : undefined,
    commitCounts: counts,
    collisions,
    rejected,
    infos,
    tags,
  };
}

function hashList(list) {
  let h = 2166136261;
  for (const s of list) for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

// Each client's mesh for the server, mapped to client names.
export async function meshSnapshot(ctx, serverId, clients) {
  const meshes = {};
  await Promise.all(clients.map(async (c) => {
    const r = await attempt(() => d.meshInfo(c, serverId));
    meshes[c.name] = r.ok ? r.value : null;
    if (r.ok && r.value?.self) c.selfId = r.value.self;
  }));
  const selfIds = Object.fromEntries(clients.map((c) => [c.name, c.selfId ?? null]));
  const matrix = visibilityMatrix(clients.map((c) => c.name), meshes, selfIds);
  return { meshes, selfIds, matrix };
}

// Final per-client dump of the instrumentation, for metrics.json.
export async function collect(ctx, serverIds) {
  const out = {};
  await Promise.all(ctx.clients.map(async (c) => {
    if (c.down) {
      out[c.name] = { down: true };
      return;
    }
    const r = await attempt(() => d.instrumentation(c, serverIds));
    out[c.name] = r.ok ? r.value : { error: r.error };
    if (out[c.name] && !out[c.name].error) out[c.name].syncLog = c.syncLog ?? [];
  }));
  return out;
}

// Totals over all clients: commit deliveries vs unique commits (amplification), duplicate accepts, replays,
// data channel traffic by action, Nostr frames, peer connection outcomes.
export function aggregate(dumps, serverId) {
  let received = 0;
  let fresh = 0;
  let dupFresh = 0;
  let replays = 0;
  let replayMs = 0;
  let acceptMs = 0;
  const sentByType = {};
  const ws = { eventsOut: 0, eventsIn: 0, okFalse: 0, rateLimited: 0, errors: 0, closes: 0 };
  const pcs = { total: 0, connectedNow: 0, failedEver: 0, withTurn: 0, pairs: {} };
  for (const dump of Object.values(dumps)) {
    if (!dump || dump.error || dump.down) continue;
    const a = dump.acc?.[serverId];
    if (a) {
      received += a.received;
      fresh += a.fresh;
      dupFresh += a.dupFresh;
      replays += a.replays;
      replayMs += a.replayMs;
      acceptMs += a.ms;
    }
    for (const [type, v] of Object.entries(dump.dc?.sent ?? {})) {
      const e = (sentByType[type] ??= { n: 0, bytes: 0 });
      e.n += v.n;
      e.bytes += v.bytes;
    }
    for (const [url, r] of Object.entries(dump.ws ?? {})) {
      if (!url.startsWith("wss://") && !url.startsWith("ws://relay") && !/nostr|relay/i.test(url)) continue;
      ws.eventsOut += r.eventsOut;
      ws.eventsIn += r.eventsIn;
      ws.okFalse += r.okFalse;
      ws.rateLimited += r.rateLimited;
      ws.errors += r.errors;
      ws.closes += r.closes;
    }
    if (dump.pcs) {
      pcs.total += dump.pcs.total;
      pcs.connectedNow += dump.pcs.connected;
      pcs.failedEver += dump.pcs.failedEver;
      pcs.withTurn += dump.pcs.withTurn;
      for (const [k, v] of Object.entries(dump.pcs.pairs ?? {})) pcs.pairs[k] = (pcs.pairs[k] ?? 0) + v;
    }
  }
  return { commitDeliveries: received, freshCommits: fresh, dupFresh, replays, replayMs, acceptMs, sentByType, ws, pcs };
}

// Polls the channel of each client until it holds every tag in `tagsFor(client)` (ground truth, no
// instrumentation needed). Returns { perClient: { name: ms | null }, missing: { name: count } }.
export async function waitTags(ctx, serverId, clients, tagsFor, { timeoutMs = 180_000, everyMs = 2000, since = Date.now(), label = "tags" } = {}) {
  const perClient = {};
  const missing = {};
  await Promise.all(clients.map(async (c) => {
    const want = tagsFor(c);
    const until = since + timeoutMs;
    let left = want.length;
    while (Date.now() < until) {
      if (!c.down && c.connected) {
        const channelId = await channelOf(c, serverId).catch(() => null);
        const r = channelId === null ? { ok: false } : await attempt(() => d.messageTags(c, serverId, channelId));
        if (r.ok) {
          const have = new Set(r.value.tags);
          left = want.filter((t) => !have.has(t)).length;
          if (left === 0) {
            perClient[c.name] = Date.now() - since;
            return;
          }
        }
      }
      await sleep(everyMs);
    }
    perClient[c.name] = null;
    missing[c.name] = left;
  }));
  const values = Object.values(perClient);
  log(`${label}: ${values.filter((v) => v !== null).length}/${clients.length} complete, slowest ${seconds(values.includes(null) ? null : Math.max(0, ...values))}`);
  return { perClient, missing, stats: stats(values), allMs: values.includes(null) ? null : Math.max(0, ...values) };
}

// Cuts a client off every network it is on (it keeps running; CDP goes too).
export async function cut(ctx, client) {
  const { podman, run } = ctx;
  client.down = true;
  client.savedIps = await podman.ips(containerOf(client));
  for (const net of Object.keys(client.savedIps)) await podman.disconnect(net, containerOf(client));
  run.event("cut", { client: client.name, networks: Object.keys(client.savedIps) });
}

// Puts it back on the same networks with the same addresses and reattaches CDP.
export async function heal(ctx, client) {
  await reconnectNetworks(ctx, client);
  await reattach(ctx, client);
}

// Heals several at once: every network first (so they come back together), then CDP in parallel.
export async function healAll(ctx, clients) {
  for (const c of clients) await reconnectNetworks(ctx, c);
  await Promise.all(clients.map((c) => reattach(ctx, c)));
}

export async function reconnectNetworks(ctx, client) {
  const { podman, run } = ctx;
  for (const [net, ip] of Object.entries(client.savedIps ?? {})) {
    const r = await attempt(() => podman.connect(net, containerOf(client), ip));
    if (!r.ok) {
      log(`${client.name}: reconnect to ${net} with ${ip} failed (${r.error}); trying without a fixed address`);
      await podman.connect(net, containerOf(client));
    }
  }
  run.event("heal", { client: client.name });
}

// Kills the client's container (Electron dies with it).
export async function kill(ctx, client) {
  client.down = true;
  await ctx.podman.kill(containerOf(client));
  await client.close();
  ctx.run.event("kill", { client: client.name });
}

export async function start(ctx, client) {
  await ctx.podman.start(containerOf(client));
  ctx.run.event("start", { client: client.name });
  await reattach(ctx, client);
}

// Re-reads the client's address (it may change) and reconnects CDP without reloading the page.
export async function reattach(ctx, client, timeoutMs = 180_000) {
  const ips = await attempt(() => ctx.podman.ips(containerOf(client)));
  if (ips.ok) {
    const lan = client.spec.lans?.find((l) => ips.value[l]) ?? Object.keys(ips.value)[0];
    const ip = ips.value[lan] ?? Object.values(ips.value)[0];
    if (ip) client.cdp = `http://${ip}:${new URL(client.cdp).port || 9223}`;
  }
  const r = await attempt(() => client.reconnect({ timeoutMs }));
  client.down = !r.ok;
  ctx.run.event("reattach", { client: client.name, ok: r.ok, error: r.error, cdp: client.cdp });
  return r.ok;
}

export const containerOf = (client) => client.spec.container ?? client.name;

// LAN of each client as the topology says ("lan-a" or "mwt-lan-a" both work); bridges are on more than one.
export const lansOf = (client) => (client.spec.lans ?? []).map((l) => l.replace(/^mwt-/, ""));
export const isBridge = (client) => lansOf(client).length > 1;

// Latency stats per (sender LAN → receiver LAN) from messageRound samples; bridges count as "bridge".
export function latencyByLan(ctx, samples) {
  const lanKey = (name) => {
    const c = ctx.byName[name];
    return c ? (isBridge(c) ? "bridge" : lansOf(c)[0] ?? "?") : "?";
  };
  const groups = {};
  for (const s of samples) {
    const key = `${lanKey(s.sender)}→${lanKey(s.receiver)}`;
    const g = (groups[key] ??= { ms: [], undelivered: 0 });
    if (s.ms !== null) g.ms.push(s.ms);
    if (!s.delivered) g.undelivered++;
  }
  return Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, { ...stats(g.ms), undelivered: g.undelivered }]));
}

export function mdTable(headers, rows) {
  return [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

// In the page: the app's next microphone is band-limited noise in syllables (120-240 ms, then a 40-100 ms dip) and
// phrases (2-4 s, then 1-2 s of room noise), from a seeded random sequence so every client talks differently.
export function speechMic(seed) {
  let state = seed >>> 0 || 1;
  const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const real = window.__mwtRealGetUserMedia ?? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.__mwtRealGetUserMedia = real;
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (!constraints?.audio || constraints.video) return real(constraints);
    void window.__mwtSpeech?.close();
    const context = (window.__mwtSpeech = new AudioContext({ sampleRate: 48000 }));
    void context.resume();
    const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = random() * 2 - 1;
    const noise = context.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 900;
    band.Q.value = 0.8;
    const voice = context.createGain();
    voice.gain.value = 0;
    const room = context.createGain();
    room.gain.value = 0.003;
    const out = context.createMediaStreamDestination();
    noise.connect(band).connect(voice).connect(out);
    noise.connect(room).connect(out);
    noise.start();
    // Ten minutes ahead.
    for (let t = context.currentTime + 0.5, end = t + 600; t < end; ) {
      const until = t + 2 + random() * 2;
      while (t < until) {
        voice.gain.setValueAtTime(0.25 + random() * 0.25, t);
        t += 0.12 + random() * 0.12;
        voice.gain.setValueAtTime(0.03, t);
        t += 0.04 + random() * 0.06;
      }
      voice.gain.setValueAtTime(0, t);
      t += 1 + random();
    }
    return out.stream;
  };
  return true;
}
