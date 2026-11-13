#!/usr/bin/env node
// Driver of tools/join-copy.sh, inside its container: makes an offline account in the desktop app, joins the copied
// workspace (an empty ledger waiting for data, like a joiner), then feeds it the copy's commits in log order, 200 per
// batch, the way a peer's catch-up arrives (WorkspaceSync.receive doesn't wait for one batch before taking the next).
// Records per batch and overall: time to take each batch, long tasks, the longest gap between frames, JS heap,
// readable-folder passes (ContentLink.mirror) and what they sent, content scans (ContentLink.wanted), ledger events,
// and the processes' memory. Writes <out>/result.json.
//
//   node join-copy.mjs <cdp-url> <server.json> <out dir> [--interval ms] [--settle s] [--timeout s]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [base, serverFile, outDir, ...rest] = process.argv.slice(2);
const option = (name, fallback) => {
  const i = rest.indexOf(name);
  return i >= 0 ? Number(rest[i + 1]) : fallback;
};
const intervalMs = option("--interval", 100);
const settleS = option("--settle", 15);
const timeoutS = option("--timeout", 900);
// --snapshot: bootstrap from the snapshot's state (/copy/state.json, see join-copy.sh) instead of the whole history.
const snapshot = rest.includes("--snapshot");
const commitsDir = "/app/public/_joincopy";
const started = Date.now();
const log = (...parts) => console.log(`[join-copy +${((Date.now() - started) / 1000).toFixed(1)}s]`, ...parts);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pageTarget() {
  for (let i = 0; i < 600; i++) {
    try {
      const list = await (await fetch(new URL("/json/list", base))).json();
      const page = list.find((t) => t.type === "page" && t.url.startsWith("http://localhost:1420"));
      if (page) return page;
    } catch {
      // Not up yet.
    }
    await pause(200);
  }
  throw new Error("The app's page never came up.");
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    const handlers = new Map();
    let id = 0;
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error.message));
        else waiter?.resolve(message.result);
      } else handlers.get(message.method)?.forEach((handler) => handler(message.params));
    });
    ws.addEventListener("open", () => resolve({
      send: (method, params = {}) => new Promise((ok, fail) => {
        pending.set(++id, { resolve: ok, reject: fail });
        ws.send(JSON.stringify({ id, method, params }));
      }),
      on: (method, handler) => handlers.set(method, [...(handlers.get(method) ?? []), handler]),
      closed: new Promise((done) => ws.addEventListener("close", done)),
      close: () => ws.close(),
    }));
    ws.addEventListener("error", reject);
  });
}

// Runs `fn(arg)` in the page and returns its JSON value.
async function inPage(cdp, fn, arg) {
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
    expression: `(${fn})(${JSON.stringify(arg)})`, awaitPromise: true, returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

// Resident memory of Electron's processes (MB), by kind.
function memory() {
  try {
    const lines = execFileSync("ps", ["-eo", "rss=,args="], { encoding: "utf8" }).split("\n");
    const out = { main: 0, renderer: 0, gpu: 0, utility: 0 };
    for (const line of lines) {
      const match = /^(\d+)\s+(\S.*)$/.exec(line.trim());
      if (!match?.[2].includes("electron")) continue;
      const mb = Number(match[1]) / 1024;
      const kind = /--type=([a-z-]+)/.exec(match[2])?.[1];
      if (!kind) out.main += mb;
      else if (kind === "renderer") out.renderer = Math.max(out.renderer, mb);
      else if (kind === "gpu-process") out.gpu += mb;
      else out.utility += mb;
    }
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Math.round(v)]));
  } catch {
    return null;
  }
}

// --- In the page -------------------------------------------------------------------------------------------------

async function goOffline() {
  for (let i = 0; i < 300; i++) {
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Skip, use MakeWork offline");
    if (button) {
      button.click();
      return "offline account";
    }
    if (document.querySelector(".workspace-bar, .server-bar, [data-drag-region]")
      && ![...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Sign in")) return "already signed in";
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("No sign-in page and no shell.");
}

async function instrument() {
  const S = (window.__joinCopy = {
    longtasks: { count: 0, total: 0, max: 0 }, frames: { maxGap: 0, gapsOver200: 0, gapsOver1000: 0 },
    wanted: { count: 0, total: 0, max: 0 }, mirror: { count: 0, total: 0, max: 0, running: 0 },
    mirrorApply: { count: 0, total: 0, max: 0, maxEntries: 0, maxBytes: 0, wrapped: false },
    events: 0, warnings: [], batches: [], lastActivity: performance.now(),
  });
  const touch = () => (S.lastActivity = performance.now());
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      S.longtasks.count++;
      S.longtasks.total += entry.duration;
      S.longtasks.max = Math.max(S.longtasks.max, entry.duration);
      touch();
    }
  }).observe({ type: "longtask", buffered: false });
  let last = performance.now();
  const frame = () => {
    const now = performance.now();
    const gap = now - last;
    S.frames.maxGap = Math.max(S.frames.maxGap, gap);
    if (gap > 200) S.frames.gapsOver200++;
    if (gap > 1000) S.frames.gapsOver1000++;
    last = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  const timed = (stats, run) => {
    const t = performance.now();
    const done = () => {
      const d = performance.now() - t;
      stats.count++;
      stats.total += d;
      stats.max = Math.max(stats.max, d);
      touch();
    };
    try {
      const result = run();
      if (result instanceof Promise) return result.finally(done);
      done();
      return result;
    } catch (e) {
      done();
      throw e;
    }
  };
  const { ContentLink } = await import("/src/p2p/content.ts");
  const P = ContentLink.prototype;
  const wanted = P.wanted;
  P.wanted = function (...args) {
    return timed(S.wanted, () => wanted.apply(this, args));
  };
  const mirror = P.mirror;
  P.mirror = function (...args) {
    S.mirror.running++;
    return timed(S.mirror, () => mirror.apply(this, args)).finally(() => S.mirror.running--);
  };
  const { desktop } = await import("/src/core/desktop.ts");
  try {
    const apply = desktop.mirror.apply;
    const wrapped = (key, name, entries) => {
      S.mirrorApply.maxEntries = Math.max(S.mirrorApply.maxEntries, entries.length);
      S.mirrorApply.maxBytes = Math.max(S.mirrorApply.maxBytes, JSON.stringify(entries).length);
      return timed(S.mirrorApply, () => apply(key, name, entries));
    };
    desktop.mirror.apply = wrapped;
    S.mirrorApply.wrapped = desktop.mirror.apply === wrapped;
  } catch {
    S.mirrorApply.wrapped = false;
  }
  const warn = console.warn;
  console.warn = (...args) => {
    if (S.warnings.length < 200) S.warnings.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ").slice(0, 300));
    return warn.apply(console, args);
  };
  return "instrumented";
}

async function join(entry) {
  const ws = await import("/src/p2p/workspaces.ts");
  const serverless = await import("/src/core/serverless.ts");
  const { account } = await import("/src/core/account.ts");
  const navigation = await import("/src/core/navigation.ts");
  const server = await ws.joinWorkspaceEntry(account(), {
    id: entry.id, secret: entry.secret, v: 3, generation: entry.generation ?? 0, recoverySecrets: entry.recoverySecrets,
  });
  serverless.attach(server);
  navigation.openWorkspace(entry.id);
  window.__joinCopyServer = server;
  server.ledger.subscribe(() => {
    window.__joinCopy.events++;
  });
  return { id: entry.id, commits: server.ledger.log().length };
}

// Loads the copy's commits, puts them in log order and sends them in batches of 200 without their hash (the wire
// format), `intervalMs` apart without waiting (0: each after the previous one is applied). With `snapshot`, what a
// source holding the snapshot's state sends instead (Ledger.missing): genesis, the snapshot, the commits after it;
// the joiner loads the state the way WorkspaceSync does (its own store has it, put there by the driver).
async function feed({ files, intervalMs, snapshot }) {
  const S = window.__joinCopy;
  const { compareCommits } = await import("/src/p2p/log.ts");
  let all = [];
  for (const file of files) {
    const text = await (await fetch(`/_joincopy/${file}`)).text();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        all.push(JSON.parse(line));
      } catch {
        // A line still being written when the copy was made.
      }
    }
  }
  all = [...new Map(all.map((c) => [c.hash, c])).values()].sort(compareCommits);
  const server = window.__joinCopyServer;
  const ledger = server.ledger;
  let load;
  if (snapshot) {
    const at = all.findIndex((c) => c.action === "workspace.snapshot" && c.snapshot);
    all = [all.find((c) => c.server === ""), all[at], ...all.slice(at + 1)];
    load = (ref) => server.sync.loadSnapshot(ref);
  }
  S.feed = { total: all.length, sent: 0, applied: 0, started: performance.now(), done: false, firstData: null };
  const batches = [];
  for (let i = 0; i < all.length; i += 200) batches.push(all.slice(i, i + 200).map(({ hash: _, ...wire }) => wire));
  void ledger.ready().then(() => (S.feed.firstData = performance.now() - S.feed.started));
  const pending = [];
  for (let i = 0; i < batches.length; i++) {
    const sentAt = performance.now();
    const record = { i, sentAt: sentAt - S.feed.started, ms: null, heapMb: null, events: S.events };
    S.batches.push(record);
    S.feed.sent++;
    const task = ledger.accept(batches[i], ...(load ? [load] : [])).then((fresh) => {
      record.ms = performance.now() - sentAt;
      record.fresh = fresh.length;
      record.heapMb = Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576);
      record.events = S.events - record.events;
      S.feed.applied++;
      S.lastActivity = performance.now();
    }, (error) => {
      record.ms = performance.now() - sentAt;
      record.error = String(error?.message ?? error);
      S.feed.applied++;
    });
    pending.push(task);
    if (intervalMs > 0) await new Promise((r) => setTimeout(r, intervalMs));
    else await task;
  }
  await Promise.all(pending);
  S.feed.done = true;
  S.feed.allApplied = performance.now() - S.feed.started;
  return { batches: batches.length, commits: all.length };
}

function progress() {
  const S = window.__joinCopy;
  return {
    feed: S.feed ?? null, idleMs: performance.now() - S.lastActivity, mirrorRunning: S.mirror.running,
    heapMb: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576),
    longtasks: S.longtasks, frames: S.frames, wanted: S.wanted, mirror: S.mirror, events: S.events,
  };
}

// The workspace's channels, in the order the channel bar lists them, and where the app is now.
async function channelList(workspaceId) {
  const { current } = await import("/src/core/navigation.ts");
  const ledger = window.__joinCopyServer.ledger;
  const channels = ledger.select("channels", "channels_channels", {})
    .filter((c) => c.deleted !== true)
    .map((c) => ({ id: c.id, name: String(c.name), type: String(c.type) }));
  return { channels, shown: current() ?? null, workspaceId };
}

// Opens one channel and starts counting that channel's long tasks and frame gaps from zero.
async function openOne({ workspaceId, channelId }) {
  const S = window.__joinCopy;
  S.longtasks = { count: 0, total: 0, max: 0 };
  S.frames = { maxGap: 0, gapsOver200: 0, gapsOver1000: 0 };
  const { openChannel } = await import("/src/core/navigation.ts");
  const t = performance.now();
  openChannel(workspaceId, channelId);
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  return { openMs: Math.round(performance.now() - t) };
}

function finalState() {
  const S = window.__joinCopy;
  const ledger = window.__joinCopyServer.ledger;
  const log = ledger.log();
  const rejected = log.filter((e) => e.rejected);
  const reasons = {};
  for (const e of rejected) reasons[e.rejected] = (reasons[e.rejected] ?? 0) + 1;
  return {
    commits: log.length, rejected: rejected.length, rejectedReasons: reasons, owner: ledger.owner,
    files: ledger.select("files", "files_entries", {}).length,
    channels: ledger.select("channels", "channels_channels", {}).length,
    stats: { ...S, batches: undefined, warnings: S.warnings.slice(0, 50) }, batches: S.batches,
  };
}

// --- Driver ------------------------------------------------------------------------------------------------------

const entry = JSON.parse(fs.readFileSync(serverFile, "utf8"));
const files = fs.readdirSync(commitsDir).filter((f) => f.endsWith(".jsonl"));
const result = { options: { intervalMs, settleS, timeoutS, snapshot }, samples: [], crash: null };
const save = () => fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 1));

const target = await pageTarget();
const cdp = await connect(target.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
await cdp.send("Inspector.enable").catch(() => {});
cdp.on("Inspector.targetCrashed", () => {
  result.crash = { at: (Date.now() - started) / 1000, kind: "renderer crashed" };
  log("RENDERER CRASHED");
});
const consoleLines = [];
cdp.on("Runtime.consoleAPICalled", (event) => {
  if (consoleLines.length > 2000) return;
  consoleLines.push(`${event.type}: ${event.args.map((a) => a.value ?? a.description ?? "").join(" ")}`.slice(0, 400));
});
for (let i = 0; i < 300; i++) {
  const ready = await inPage(cdp, () => document.readyState === "complete" && !!document.querySelector("#root, body > div")).catch(() => false);
  if (ready) break;
  await pause(200);
}
log(await inPage(cdp, goOffline));
await pause(2000);
log(await inPage(cdp, instrument));
if (snapshot) {
  // The state goes into the app's own content store (a workspace without a folder: <userData>/local/content), as if
  // it had been fetched from the source.
  const commit = files.flatMap((f) => fs.readFileSync(path.join(commitsDir, f), "utf8").split("\n"))
    .filter((line) => line.includes("\"workspace.snapshot\"")).map((line) => JSON.parse(line)).find((c) => c.snapshot);
  const hash = commit.snapshot.content.slice(4);
  fs.mkdirSync("/profile/local/content", { recursive: true });
  fs.copyFileSync("/copy/state.json", `/profile/local/content/${hash}`);
  log(`snapshot state in place as ${hash.slice(0, 8)} (${fs.statSync("/copy/state.json").size} bytes)`);
}
log("joined", JSON.stringify(await inPage(cdp, join, entry)));
const feeding = inPage(cdp, feed, { files, intervalMs, snapshot }).then(
  (value) => log("fed", JSON.stringify(value)),
  (error) => {
    result.feedError = String(error.message);
    log("feed failed:", error.message);
  },
);

let fed = false;
void feeding.then(() => (fed = true));
const deadline = Date.now() + timeoutS * 1000;
let lastLog = 0;
while (Date.now() < deadline && !result.crash) {
  await pause(1000);
  let p;
  try {
    p = await Promise.race([inPage(cdp, progress), pause(20_000).then(() => null)]);
  } catch (error) {
    if (result.crash) break;
    p = null;
  }
  const sample = { t: (Date.now() - started) / 1000, mem: memory(), page: p };
  result.samples.push(sample);
  if (!p) {
    log("page didn't answer within 20 s", JSON.stringify(sample.mem));
    continue;
  }
  if (Date.now() - lastLog > 5000) {
    lastLog = Date.now();
    log(`sent ${p.feed?.sent ?? 0}/${Math.ceil((p.feed?.total ?? 0) / 200)} applied ${p.feed?.applied ?? 0}, heap ${p.heapMb} MB,`
      + ` mem ${JSON.stringify(sample.mem)}, longest frame gap ${Math.round(p.frames.maxGap)} ms, mirror ${p.mirror.count}`
      + ` (${Math.round(p.mirror.total)} ms), wanted ${p.wanted.count} (${Math.round(p.wanted.total)} ms)`);
  }
  if (fed && p.feed?.done && p.mirrorRunning === 0 && p.idleMs > settleS * 1000) break;
}
result.timedOut = Date.now() >= deadline;
if (!result.crash) {
  try {
    result.final = await inPage(cdp, finalState);
  } catch (error) {
    result.finalError = String(error.message);
  }
}

// Each channel opened in turn, as a member looking around after joining: how long its view blocks the page.
if (!result.crash && !result.timedOut) {
  result.channels = [];
  const { channels, shown } = await inPage(cdp, channelList, entry.id);
  result.shownAfterJoin = shown;
  for (const channel of channels) {
    if (result.crash) break;
    const record = { ...channel };
    result.channels.push(record);
    try {
      const opened = await Promise.race([inPage(cdp, openOne, { workspaceId: entry.id, channelId: channel.id }), pause(60_000).then(() => null)]);
      record.openMs = opened?.openMs ?? "no answer in 60 s";
    } catch (error) {
      record.error = String(error.message);
      continue;
    }
    // Until the page has been quiet for 2 s (at most 30 s).
    const begun = Date.now();
    let p = null;
    while (Date.now() - begun < 30_000 && !result.crash) {
      await pause(500);
      p = await Promise.race([inPage(cdp, progress).catch(() => null), pause(20_000).then(() => null)]);
      if (p && p.idleMs > 2000 && Date.now() - begun > 3000) break;
    }
    record.longestFrameGapMs = p ? Math.round(p.frames.maxGap) : "no answer";
    record.longtasks = p && { count: p.longtasks.count, totalMs: Math.round(p.longtasks.total), maxMs: Math.round(p.longtasks.max) };
    record.heapMb = p?.heapMb;
    record.mem = memory();
    log(`channel ${channel.type} "${channel.name}": open ${record.openMs} ms, longest frame gap ${record.longestFrameGapMs} ms,`
      + ` long tasks ${JSON.stringify(record.longtasks)}, heap ${record.heapMb} MB`);
  }
}
result.console = consoleLines;
const last = result.samples.at(-1)?.page;
const maxOf = (pick) => Math.max(0, ...result.samples.map((s) => pick(s) ?? 0));
result.summary = {
  crash: result.crash, timedOut: result.timedOut, feedError: result.feedError ?? null,
  commits: result.final?.commits, rejected: result.final?.rejected, files: result.final?.files,
  firstDataMs: last?.feed?.firstData != null ? Math.round(last.feed.firstData) : null,
  allAppliedMs: last?.feed?.allApplied != null ? Math.round(last.feed.allApplied) : null,
  settledAfterS: result.samples.at(-1)?.t,
  longestFrameGapMs: Math.round(last?.frames.maxGap ?? 0), frameGapsOver1s: last?.frames.gapsOver1000,
  longtasks: last && { count: last.longtasks.count, totalMs: Math.round(last.longtasks.total), maxMs: Math.round(last.longtasks.max) },
  mirrorPasses: last && { count: last.mirror.count, totalMs: Math.round(last.mirror.total), maxMs: Math.round(last.mirror.max) },
  mirrorApply: result.final?.stats.mirrorApply,
  wantedScans: last && { count: last.wanted.count, totalMs: Math.round(last.wanted.total), maxMs: Math.round(last.wanted.max) },
  ledgerEvents: last?.events,
  peakHeapMb: maxOf((s) => s.page?.heapMb),
  peakRendererMb: maxOf((s) => s.mem?.renderer), peakMainMb: maxOf((s) => s.mem?.main),
  slowestBatchMs: Math.round(Math.max(0, ...(result.final?.batches ?? []).map((b) => b.ms ?? 0))),
  slowestChannel: (result.channels ?? []).reduce((worst, c) =>
    (typeof c.longestFrameGapMs === "number" ? c.longestFrameGapMs : Infinity) > (worst?.gap ?? -1)
      ? { name: c.name, type: c.type, gap: c.longestFrameGapMs } : worst, null),
};
save();
log("summary", JSON.stringify(result.summary));
cdp.close();
process.exit(result.crash ? 2 : 0);
