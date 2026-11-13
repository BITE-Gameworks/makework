// S12 joining a big workspace: a replica of a real workspace's folder (BASE_FOLDER in run-scenario.sh, mounted
// read-only; only its signed commits are read) is loaded into the owner's app, and every other client joins it at once.
// Each must show at least the workspace's name and its channel list within --within-s seconds (5) of its join, and
// have everything the owner has a while later.
//
// The replica: a test client can't join the real workspace (an invite has to be signed by a member), so the owner's
// app signs its history again with the app's own code (p2p/log.ts signCommit): the base owner's commits with the
// owner client's account key, every other author's with a key made for it, user ids and account ids in the data
// mapped to the new keys', and a new genesis (so a new workspace id) and room secret. Same commits in the same order,
// the same tables: the same work for a joiner. The base's own signed snapshot is left out (its cutoff and state are
// tied to the old hashes). With --history snapshot (default, like a workspace that has one) the owner makes a new one
// once everything is loaded (core/workspaceSnapshots.ts), so joiners start from its state; --history full makes them
// take the whole history.
//
// Nodes (up.sh --nodes k) host it like in s8 and become the joiners' source. Bots (up.sh --bots b) join along; they
// have no screen, so their minimum is having the data.
import fs from "node:fs";
import path from "node:path";
import * as d from "../lib/driver.mjs";
import { BotClient, eachBot } from "../lib/bots.mjs";
import { NodeHandle } from "../lib/nodes.mjs";
import { attempt, intArg, log, mapLimit, seconds, sleep, stats } from "../lib/util.mjs";
import { mdTable, prepare, short } from "./common.mjs";
import { appLogTimes } from "./s1.mjs";

export default async function s12(ctx) {
  const { run, args, podman, topology } = ctx;
  const baseDir = String(args.base ?? process.env.MWT_BASE ?? "/base/commits");
  const history = args.history === "full" ? "full" : "snapshot";
  const withinMs = intArg(args, "within-s", 5) * 1000;
  const completeMs = intArg(args, "complete-s", 300) * 1000;
  const nodes = (topology.nodes ?? []).map((spec) => new NodeHandle(spec, podman));
  const bots = (topology.bots ?? []).map((spec) => new BotClient(spec));
  run.clients = [...ctx.clients, ...bots];
  if (ctx.clients.length < 2 || !fs.existsSync(baseDir)) {
    run.assert("s12.setup", `at least 2 apps and the base's commits at ${baseDir} (BASE_FOLDER=<workspace folder> run-scenario.sh s12)`, false,
      { apps: ctx.clients.length, base: fs.existsSync(baseDir) });
    return {};
  }
  await prepare(ctx);
  const [owner, ...joiners] = ctx.clients;

  // ---- The replica, in the owner's app ----
  const base = readBase(baseDir);
  log(`s12: base ${base.length} commits from ${baseDir}`);
  await owner.eval(() => void (window.__s12base = []), undefined, 10_000, "s12 base reset");
  for (let i = 0; i < base.length; i += 2000)
    await owner.eval((part) => window.__s12base.push(...part), base.slice(i, i + 2000), 120_000, "s12 base");
  const built = await attempt(() => owner.eval(buildReplica, undefined, 900_000, "s12 replica"));
  if (!built.ok) {
    run.assert("s12.replica", "the owner builds and loads the replica", false, { error: built.error });
    return {};
  }
  const replica = built.value;
  const serverId = replica.id;
  run.watch(serverId);
  log(`s12: replica ${serverId}: ${replica.commits} commits (${replica.rejected} refused) of ${replica.authors} authors, `
    + `signed in ${seconds(replica.signedMs)}, loaded in ${seconds(replica.loadMs)}`);
  run.assert("s12.replica", "the replica replays like the base: every commit applies (the base's snapshot left out)",
    replica.commits === base.length - replica.skipped && replica.rejected === 0, replica);

  let snapshot = null;
  if (history === "snapshot") {
    const made = await attempt(() => owner.eval(makeSnapshot, { id: serverId }, 600_000, "s12 snapshot"));
    snapshot = made.ok ? made.value : { error: made.error };
    log(`s12: snapshot ${made.ok ? `of ${snapshot.index} commits, state ${(snapshot.stateBytes / 1048576).toFixed(1)} MB, in ${seconds(snapshot.ms)}` : `failed: ${made.error}`}`);
    run.assert("s12.snapshot", "the owner makes a signed snapshot of the replica", made.ok, snapshot);
    if (!made.ok) return { replica, snapshot };
  }
  const target = await owner.eval(({ id }) => import("/src/core/serverless.ts").then((s) => {
    const ledger = s.workspaceLedger(id);
    return { vector: ledger.vector(), commits: ledger.log().length };
  }), { id: serverId }, 60_000, "s12 target");
  const invite = await d.invite(owner, serverId);

  // ---- Nodes ----
  const hostMs = {};
  if (nodes.length) {
    // The base's own nodes are in the replica too (under keys nobody has): only the ones added now count.
    const before = new Set((await d.nodeRows(owner, serverId)).map((r) => r.userId));
    const hostStart = Date.now();
    for (const node of nodes) await d.addNode(owner, serverId, await node.code());
    let authorized = 0;
    for (const until = Date.now() + 240_000; Date.now() < until && authorized < nodes.length;) {
      await attempt(() => d.authorizeNodes(owner, serverId));
      const rows = await attempt(() => d.nodeRows(owner, serverId));
      authorized = rows.ok ? rows.value.filter((r) => r.status === "authorized" && !before.has(r.userId)).length : 0;
      if (authorized < nodes.length) await sleep(2000);
    }
    // Hosted: the owner's commits and, with a snapshot, its state in the node's store (as a node that has hosted the
    // workspace for a while holds it).
    const holdsState = async (node) => !snapshot
      || (await node.podman.exec(node.container, ["test", "-f", `/data/content/${snapshot.state}`], 15_000).then((r) => r.code === 0, () => false));
    for (const until = Date.now() + 420_000; Date.now() < until && Object.keys(hostMs).length < nodes.length;) {
      for (const node of nodes) {
        const info = (await node.status().catch(() => null))?.servers?.[serverId];
        if (!hostMs[node.name] && info && info.commits >= target.commits && await holdsState(node)) hostMs[node.name] = Date.now() - hostStart;
      }
      if (Object.keys(hostMs).length < nodes.length) await sleep(2000);
    }
    run.assert("s12.hosted", `${nodes.length} node(s) hold the replica (${target.commits} commits${snapshot ? " and the snapshot's state" : ""})`,
      Object.keys(hostMs).length === nodes.length, { hostMs });
  }

  // ---- Everyone joins at once ----
  const name = replica.name;
  await mapLimit(joiners, 20, (c) => attempt(() => c.eval(watch, { id: serverId, name, target: target.vector }, 15_000, "s12 watch")));
  run.event("s12-join", { serverId, apps: joiners.length, bots: bots.length, history });
  const t0 = Date.now();
  const [appJoins, botJoins] = await Promise.all([
    mapLimit(joiners, 20, (c) => attempt(() => d.joinServer(c, invite))),
    eachBot(bots, (bot) => bot.join(invite), 50),
  ]);
  const joinFailures = [
    ...joiners.map((c, i) => ({ name: c.name, ok: appJoins[i].ok, error: appJoins[i].error })).filter((r) => !r.ok)
      .map(({ name, error }) => ({ name, error })),
    ...Object.entries(botJoins).filter(([, r]) => !r.ok).map(([n, r]) => ({ name: n, error: r.error })),
  ];
  run.assert("s12.join", "every member's join call succeeds", joinFailures.length === 0, { joinFailures });

  // Each app's own clock: from its join call to its screen and data (the watcher runs in the page).
  const apps = {};
  const pending = new Set(joiners.map((c) => c.name));
  const botsWaiting = () => bots.some((b) => !b.lastState?.servers?.[serverId]?.dataAt);
  for (const until = t0 + completeMs; (pending.size || botsWaiting()) && Date.now() < until;) {
    await sleep(1000);
    await mapLimit(joiners.filter((c) => pending.has(c.name)), 20, async (c) => {
      const i = joiners.indexOf(c);
      const r = await attempt(() => c.eval(() => window.__s12 && { ...window.__s12, content: window.__mwt?.content ?? [] }, undefined, 10_000, "s12 read"));
      const at = appJoins[i].ok ? appJoins[i].value.at : null;
      const w = r.ok ? r.value : null;
      apps[c.name] = {
        answered: r.ok, at,
        shownMs: w?.shownAt && at ? w.shownAt - at : null, channels: w?.channels ?? null,
        dataMs: w?.dataAt && at ? w.dataAt - at : null, caughtUpMs: w?.caughtUpAt && at ? w.caughtUpAt - at : null,
        // What content it asked for and from whom, and what arrived before its data, ms from its join call.
        content: (w?.content ?? []).filter((e) => at && e.t >= at).map((e) => ({ ...e, t: e.t - at })),
        events: (w?.events ?? []).map(([what, t]) => [what, at ? t - at : null]),
      };
      if (w?.shownAt && w?.caughtUpAt) pending.delete(c.name);
    });
  }
  // What each app received, per half second from its join call (KiB, first 20 s), and when the first frame of a
  // history batch ("commits") came in.
  await mapLimit(joiners, 20, async (c) => {
    const i = joiners.indexOf(c);
    const at = appJoins[i].ok ? appJoins[i].value.at : null;
    if (!at || !apps[c.name]) return;
    const r = await attempt(() => c.eval(({ at }) => {
      const out = { firstCommitsFrame: null, kib: Array.from({ length: 40 }, () => 0) };
      for (const [t, type, size] of window.__mwt?.dc?.recvTimeline ?? []) {
        const slot = Math.floor((t - at) / 500);
        if (slot < 0 || slot >= 40) continue;
        out.kib[slot] += size / 1024;
        if (type === "commits" && out.firstCommitsFrame === null) out.firstCommitsFrame = t - at;
      }
      out.kib = out.kib.map(Math.round);
      return out;
    }, { at }, 10_000, "s12 received"));
    if (r.ok) apps[c.name].received = r.value;
  });
  const botState = Object.fromEntries(bots.map((b) => [b.name, b.lastState?.servers?.[serverId] ?? null]));
  const botTimes = Object.fromEntries(Object.entries(botState).map(([n, s]) => [n, {
    dataMs: s?.dataAt && s?.joinedAt ? s.dataAt - s.joinedAt : null, commits: s?.commits ?? null,
  }]));

  const late = Object.entries(apps).filter(([, a]) => a.shownMs === null || a.shownMs > withinMs).map(([n, a]) => ({ name: n, shownMs: a.shownMs }));
  run.assert("s12.minimum", `every app shows the workspace's name and channels within ${seconds(withinMs)} of joining`, late.length === 0 && joinFailures.length === 0, {
    late, shownMs: stats(Object.values(apps).map((a) => a.shownMs).filter((x) => x !== null)),
  });
  const incomplete = Object.entries(apps).filter(([, a]) => a.caughtUpMs === null).map(([n]) => n);
  const botsWithout = Object.entries(botTimes).filter(([, b]) => b.dataMs === null).map(([n]) => n);
  run.assert("s12.complete", `every app has everything the owner has, within ${seconds(completeMs)}`, incomplete.length === 0, {
    incomplete, caughtUpMs: stats(Object.values(apps).map((a) => a.caughtUpMs).filter((x) => x !== null)),
  });
  if (bots.length) run.assert("s12.bots", "every bot gets the data", botsWithout.length === 0, { botsWithout });
  const silent = Object.entries(apps).filter(([, a]) => !a.answered).map(([n]) => n);
  run.assert("s12.responsive", "every app still answers after the join (no frozen or crashed page)", silent.length === 0, { silent });

  run.number("replica", { ...replica, history, snapshot, target: target.commits });
  run.number("join", {
    shownMs: stats(Object.values(apps).map((a) => a.shownMs).filter((x) => x !== null)),
    dataMs: stats(Object.values(apps).map((a) => a.dataMs).filter((x) => x !== null)),
    caughtUpMs: stats(Object.values(apps).map((a) => a.caughtUpMs).filter((x) => x !== null)),
    bots: stats(Object.values(botTimes).map((b) => b.dataMs).filter((x) => x !== null)),
    appLog: appLogTimes(ctx, serverId), hostMs,
  });
  run.section("Joins (ms from each app's join call)", mdTable(
    ["app", "screen (name + channels)", "channels shown", "data", "everything"],
    Object.entries(apps).map(([n, a]) => [short(n), a.shownMs ?? "never", a.channels ?? "", a.dataMs ?? "never", a.caughtUpMs ?? "never"]),
  ));
  return { serverId, replica, snapshot, apps, bots: botTimes };
}

// The base folder's commits (.jsonl, one per plugin), each once; a line still being written is skipped.
function readBase(dir) {
  const byHash = new Map();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of fs.readFileSync(path.join(dir, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const commit = JSON.parse(line);
        if (commit?.hash) byHash.set(commit.hash, commit);
      } catch {
        // Incomplete last line.
      }
    }
  }
  return [...byHash.values()];
}

// In the owner's page: signs window.__s12base again (see the top of this file), opens it as a workspace and loads it.
async function buildReplica() {
  const log = await import("/src/p2p/log.ts");
  const identity = await import("/src/core/identity.ts");
  const account = await import("/src/core/account.ts");
  const workspaces = await import("/src/p2p/workspaces.ts");
  const serverless = await import("/src/core/serverless.ts");
  const navigation = await import("/src/core/navigation.ts");
  const { workspaces: store } = await import("/src/core/workspaces.ts");
  const started = Date.now();
  const base = window.__s12base.sort(log.compareCommits);
  window.__s12base = null;
  const genesis = base.find((c) => c.server === "");
  const me = account.account();
  const signers = new Map([[genesis.author, { id: me.id, key: { x: me.publicKey.x, y: me.publicKey.y }, privateKey: account.accountKey() }]]);
  const oldKeys = new Map();
  for (const c of base) {
    oldKeys.set(c.author, c.key);
    if (signers.has(c.author)) continue;
    const made = await identity.createIdentity(false);
    signers.set(c.author, { id: made.id, key: { x: made.publicKey.x, y: made.publicKey.y }, privateKey: made.privateKey });
  }
  // User ids (numbers) and account ids and key halves (strings) of the old authors, as whole values.
  const users = new Map();
  const strings = new Map();
  for (const [old, signer] of signers) {
    users.set(log.userNumberOf(old), log.userNumberOf(signer.id));
    strings.set(old, signer.id);
    strings.set(oldKeys.get(old).x, signer.key.x);
    strings.set(oldKeys.get(old).y, signer.key.y);
  }
  // Inside JSON objects too: sealed invites and room secrets name their sender and recipient (`from`, `to`), and the
  // policy checks them against the author.
  const deep = (v) => (typeof v === "number" ? users.get(v) ?? v : typeof v === "string" ? strings.get(v) ?? v
    : Array.isArray(v) ? v.map(deep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);
  const value = (v) => {
    if (typeof v === "string" && v.startsWith("{")) {
      try {
        return JSON.stringify(deep(JSON.parse(v)));
      } catch {
        // Not JSON.
      }
    }
    return deep(v);
  };
  const ops = (list) => list.map((op) => (op.values ? { ...op, values: Object.fromEntries(Object.entries(op.values).map(([k, v]) => [k, value(v)])) } : op));
  const sign = (c, server) => {
    const signer = signers.get(c.author);
    return log.signCommit({
      server, author: signer.id, key: signer.key, replica: c.replica, seq: c.seq, clock: c.clock, time: c.time,
      action: c.action, ops: ops(c.ops),
    }, signer.privateKey);
  };
  const newGenesis = await sign(genesis, "");
  const id = await log.workspaceIdOf(newGenesis);
  const rest = base.filter((c) => c !== genesis && !(c.action === "workspace.snapshot" && c.snapshot));
  const replica = [newGenesis];
  for (let i = 0; i < rest.length; i += 500) replica.push(...(await Promise.all(rest.slice(i, i + 500).map((c) => sign(c, id)))));
  const signedMs = Date.now() - started;
  // Rotated room secrets in the history are sealed for the old accounts: start at their generation.
  let generation = 0;
  for (const c of rest) for (const op of c.ops) if (op.table === "members_rotations" && op.values?.generation != null) generation = Math.max(generation, Number(op.values.generation));

  const secret = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const server = await workspaces.joinWorkspaceEntry(me, { id, secret, v: 3, generation, recoverySecrets: [] });
  serverless.attach(server);
  navigation.openWorkspace(id);
  const loading = Date.now();
  for (let i = 0; i < replica.length; i += 1000)
    await server.ledger.accept(replica.slice(i, i + 1000).map(({ hash: _, ...wire }) => wire));
  const loadMs = Date.now() - loading;
  for (const until = Date.now() + 60_000; store.byId[id]?.status !== "ready" && Date.now() < until;) await new Promise((r) => setTimeout(r, 200));
  const entries = server.ledger.log();
  const rejectedFor = {};
  for (const e of entries) if (e.rejected) rejectedFor[e.rejected] = (rejectedFor[e.rejected] ?? 0) + 1;
  return {
    id, name: store.byId[id]?.info.name ?? null, commits: entries.length, rejected: entries.filter((e) => e.rejected).length, rejectedFor,
    skipped: base.length - 1 - rest.length, authors: signers.size, files: server.ledger.select("files", "files_entries", {}).length,
    channels: server.ledger.select("channels", "channels_channels", {}).length, signedMs, loadMs, generation,
  };
}

// In the owner's page: a signed snapshot of everything, as Workspace settings > History makes one (its state and the
// history archive go into the owner's store; the owner's own log keeps only what is after it).
async function makeSnapshot({ id }) {
  const { createWorkspaceSnapshot } = await import("/src/core/workspaceSnapshots.ts");
  const { contentSize } = await import("/src/core/stream.ts");
  const serverless = await import("/src/core/serverless.ts");
  const ledger = serverless.workspaceLedger(id);
  const started = Date.now();
  const commit = await createWorkspaceSnapshot(ledger);
  const state = commit.snapshot.content.slice(4);
  return { ms: Date.now() - started, index: commit.snapshot.index, state, stateBytes: await contentSize(state), commits: ledger.log().length };
}

// In each joiner's page before it joins: when the channel bar first shows the workspace's name and at least one
// channel (the screen's bare minimum), when its data first arrived, and when it has everything in `target`.
async function watch({ id, name, target }) {
  const serverless = await import("/src/core/serverless.ts");
  const { WorkspaceSync } = await import("/src/p2p/sync.ts");
  const W = (window.__s12 = { shownAt: null, channels: null, dataAt: null, caughtUpAt: null, events: [] });
  // What arrives for this workspace before its data: the peer authentication steps, hellos, batches (first 40).
  const mark = (what) => W.events.length < 40 && W.events.push([what, Date.now()]);
  const P = WorkspaceSync.prototype;
  if (!P.__s12) {
    const receive = P.receive;
    P.receive = function (message, ...rest) {
      if (this.workspaceId === window.__s12?.id) mark(message.kind === "commits" ? `commits ${message.commits.length}` : message.kind);
      return receive.call(this, message, ...rest);
    };
    const auth = P.receivePeerAuth;
    P.receivePeerAuth = function (message, ...rest) {
      if (this.workspaceId === window.__s12?.id) mark(`auth ${message?.kind}`);
      return auth.call(this, message, ...rest);
    };
    P.__s12 = true;
  }
  W.id = id;
  const covers = (a, b) => Object.entries(b).every(([replica, seq]) => (a[replica] ?? -1) >= seq);
  const screen = () => {
    const title = document.querySelector(".workspace-channels h1")?.textContent?.trim();
    const channels = document.querySelectorAll(".channel-list .channel-name").length;
    if (title === name && channels > 0) {
      W.shownAt = Date.now();
      W.channels = channels;
    } else setTimeout(screen, 50);
  };
  const data = () => {
    const ledger = serverless.workspaceLedger(id);
    if (ledger && W.dataAt === null && ledger.owner !== null) W.dataAt = Date.now();
    if (ledger && W.dataAt !== null && covers(ledger.vector(), target)) W.caughtUpAt = Date.now();
    else setTimeout(data, 250);
  };
  screen();
  data();
}
