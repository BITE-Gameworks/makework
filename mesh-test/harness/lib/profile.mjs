// What a page's main thread does, over CDP: Performance domain metrics (busy time by kind), CPU profiles summarized by
// function, and the heap after a garbage collection. One session per client (`session(client)`).
import { sleep } from "./util.mjs";

export const metricNames = ["TaskDuration", "ScriptDuration", "RecalcStyleDuration", "LayoutDuration", "RecalcStyleCount", "LayoutCount", "JSHeapUsedSize", "Nodes", "JSEventListeners"];

export async function session(client) {
  const s = await client.page.context().newCDPSession(client.page);
  await s.send("Performance.enable");
  return s;
}

export async function metrics(s) {
  const { metrics: list } = await s.send("Performance.getMetrics");
  return Object.fromEntries(list.filter((m) => metricNames.includes(m.name)).map((m) => [m.name, m.value]));
}

// Busy time between two metrics samples, as a share of the wall time between them (percent).
export function busy(before, after, ms) {
  const share = (key) => (before && after ? Math.round(((after[key] - before[key]) / (ms / 1000)) * 1000) / 10 : null);
  return { taskPct: share("TaskDuration"), scriptPct: share("ScriptDuration"), stylePct: share("RecalcStyleDuration"), layoutPct: share("LayoutDuration") };
}

export async function startProfile(s, intervalUs = 500) {
  await s.send("Profiler.enable");
  await s.send("Profiler.setSamplingInterval", { interval: intervalUs });
  await s.send("Profiler.start");
}

export async function stopProfile(s) {
  const { profile } = await s.send("Profiler.stop");
  return profile;
}

export async function cpuProfile(s, ms) {
  await startProfile(s);
  await sleep(ms);
  return stopProfile(s);
}

// Self time per function and per source file, most first (ms over the profile).
export function summarizeProfile(profile, top = 40) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const deltas = profile.timeDeltas ?? [];
  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i]);
    const dt = (deltas[i + 1] ?? deltas[i] ?? 0) / 1000;
    self.set(node, (self.get(node) ?? 0) + dt);
  }
  const fns = new Map();
  const files = new Map();
  let total = 0;
  for (const [node, ms] of self) {
    const f = node.callFrame;
    const file = (f.url || "(native)").replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const key = `${f.functionName || "(anonymous)"} ${file}:${f.lineNumber + 1}`;
    fns.set(key, (fns.get(key) ?? 0) + ms);
    files.set(file, (files.get(file) ?? 0) + ms);
    total += ms;
  }
  const idle = ["(idle)", "(program)", "(garbage collector)"];
  const rank = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, top).map(([key, ms]) => ({ key, ms: Math.round(ms * 10) / 10 }));
  const busyMs = [...fns].filter(([k]) => !idle.some((i) => k.startsWith(i))).reduce((a, [, ms]) => a + ms, 0);
  return { totalMs: Math.round(total), busyMs: Math.round(busyMs), functions: rank(fns), files: rank(files) };
}

// The JS heap after a full collection (MB).
export async function heapAfterGc(s) {
  await s.send("HeapProfiler.enable");
  await s.send("HeapProfiler.collectGarbage");
  const { usedSize, totalSize } = await s.send("Runtime.getHeapUsage");
  return { usedMb: Math.round(usedSize / 1_048_576 * 10) / 10, totalMb: Math.round(totalSize / 1_048_576 * 10) / 10 };
}

// How many live objects have `prototypeExpression`'s value as their prototype (e.g. "RTCPeerConnection.prototype").
export async function countObjects(s, prototypeExpression) {
  const { result: proto } = await s.send("Runtime.evaluate", { expression: prototypeExpression });
  if (!proto.objectId) return null;
  const { objects } = await s.send("Runtime.queryObjects", { prototypeObjectId: proto.objectId });
  const { result } = await s.send("Runtime.callFunctionOn", { objectId: objects.objectId, functionDeclaration: "function () { return this.length; }", returnByValue: true });
  await s.send("Runtime.releaseObject", { objectId: objects.objectId }).catch(() => {});
  await s.send("Runtime.releaseObject", { objectId: proto.objectId }).catch(() => {});
  return result.value;
}
