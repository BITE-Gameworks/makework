#!/usr/bin/env node
// Watches one running app over CDP without reloading it (a reload would reset what piled up), for a slowdown that
// grows while it is used: node watch.mjs --cdp http://127.0.0.1:9230 [--every-s 30] [--minutes 60] [--out <dir>]
// [--profile-every 10]
// The app must run with --remote-debugging-port (npm run dev:desktop -- --remote-debugging-port=9230). The census
// (instrument.js) is injected late, so it counts only timers, listeners and channels made after attaching; the app
// objects' collection sizes and the main thread's busy time are complete. Every window prints one line and goes to
// <out>/watch.jsonl; a CPU profile of the first window and of every --profile-every'th goes to <out>/*.cpuprofile with
// a summary. Ctrl+C ends it and prints what grew since the first window.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { instrumentSource } from "./lib/cdp.mjs";
import { busy, metrics, session, startProfile, stopProfile, summarizeProfile } from "./lib/profile.mjs";
import { intArg, parseArgs, sleep } from "./lib/util.mjs";

const args = parseArgs(process.argv.slice(2));
const cdp = String(args.cdp ?? "http://127.0.0.1:9230");
const everyMs = intArg(args, "every-s", 30) * 1000;
const minutes = intArg(args, "minutes", 60);
const profileEvery = intArg(args, "profile-every", 10);
const out = String(args.out ?? `watch-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "")}`);
fs.mkdirSync(out, { recursive: true });

const info = await (await fetch(`${cdp}/json/version`)).json();
const ws = new URL(info.webSocketDebuggerUrl);
const endpoint = new URL(cdp);
ws.hostname = endpoint.hostname;
ws.port = endpoint.port;
const browser = await chromium.connectOverCDP(ws.toString());
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => /^(https?:\/\/localhost(:\d+)?\/|app:\/\/makework\/)/.test(p.url()) && !p.url().includes("popout"));
if (!page) throw new Error("no app page");
if (!(await page.evaluate(() => Boolean(window.__mwt)))) await page.evaluate(instrumentSource);
await page.evaluate(async () => {
  await window.__mwt.patch();
  await window.__mwt.trackLinks();
});
const cdpSession = await session({ page });
const file = fs.createWriteStream(path.join(out, "watch.jsonl"), { flags: "a" });
const rows = [];
let stop = false;
process.on("SIGINT", () => {
  stop = true;
});

const flat = (obj, prefix = "", acc = {}) => {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "number") acc[key] = v;
    else if (v && typeof v === "object") flat(v, key, acc);
  }
  return acc;
};

const until = Date.now() + minutes * 60_000;
for (let i = 0; !stop && Date.now() < until; i++) {
  const profiling = i === 0 || (profileEvery > 0 && i % profileEvery === 0);
  await page.evaluate(() => window.__mwt.loadStart());
  const before = await metrics(cdpSession);
  const t0 = Date.now();
  if (profiling) await startProfile(cdpSession);
  while (!stop && Date.now() - t0 < everyMs) await sleep(250);
  const profile = profiling ? await stopProfile(cdpSession) : null;
  const after = await metrics(cdpSession);
  const ms = Date.now() - t0;
  const pageLoad = await page.evaluate(() => window.__mwt.loadRead());
  const census = await page.evaluate(() => window.__mwt.census());
  const row = { i, t: t0, ms, ...busy(before, after, ms), fps: Math.round(pageLoad.fps * 10) / 10, maxGapMs: pageLoad.maxGapMs, longTaskMs: pageLoad.longTaskMs, census };
  file.write(`${JSON.stringify(row)}\n`);
  rows.push(row);
  const peers = Object.values(census.app).map((a) => a.mesh?.direct ?? 0).reduce((a, b) => a + b, 0);
  console.log(`${new Date(t0).toLocaleTimeString()} #${i}: task ${row.taskPct}% script ${row.scriptPct}% style ${row.stylePct}% fps ${row.fps} gap ${row.maxGapMs} ms long ${row.longTaskMs} ms | heap ${census.heapMb} MB dom ${census.dom} peers ${peers} pcs ${census.pcCount} channels ${census.channelCount} listeners+ ${census.listenerCount} intervals+ ${census.intervalCount} timeouts ${census.timeoutsPending}`);
  if (profile) {
    fs.writeFileSync(path.join(out, `window-${i}.cpuprofile`), JSON.stringify(profile));
    const summary = summarizeProfile(profile, 15);
    fs.writeFileSync(path.join(out, `window-${i}.summary.json`), JSON.stringify(summary, null, 2));
    console.log(`  profile: busy ${summary.busyMs} of ${summary.totalMs} ms; top: ${summary.functions.slice(0, 5).map((f) => `${f.key} ${f.ms}`).join("; ")}`);
  }
}

if (rows.length >= 2) {
  const a = flat(rows[0].census);
  const b = flat(rows.at(-1).census);
  console.log(`\nGrew since the first window (x1.5 and +3):`);
  for (const key of Object.keys(b)) if (typeof a[key] === "number" && b[key] > a[key] * 1.5 && b[key] - a[key] >= 3) console.log(`  ${key}: ${a[key]} -> ${b[key]}`);
}
file.end();
await browser.close().catch(() => {});
