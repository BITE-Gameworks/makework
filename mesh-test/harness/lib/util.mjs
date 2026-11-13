// Small helpers shared by the harness: timing, timeouts, logging, statistics.

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const now = () => Date.now();

// Orders text by UTF-16 code units: what `sort()` does without a function (the app's `compareText`, core/text.ts).
export const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Resolves with the promise's value, or rejects with a TimeoutError after `ms` (the promise keeps running).
export function withTimeout(promise, ms, what = "operation") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${what} timed out after ${ms} ms`), { name: "TimeoutError" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Never throws: { ok, value } or { ok: false, error }.
export async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// Retries `fn` until it resolves or `ms` passed.
export async function retry(fn, { ms = 60_000, every = 1000, what = "retry" } = {}) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(every);
    }
  }
  throw new Error(`${what}: gave up after ${ms} ms: ${last?.message ?? last}`);
}

let logSink = null;
export function setLogSink(sink) {
  logSink = sink;
}

export function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}`;
  console.log(line);
  logSink?.(line);
}

export function percentile(values, p) {
  const sorted = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

// p50/p95/max/min/mean/count of the numbers in `values` (nulls are counted as missing).
export function stats(values) {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  return {
    count: nums.length,
    missing: values.length - nums.length,
    min: nums.length ? Math.min(...nums) : null,
    p50: percentile(nums, 50),
    p95: percentile(nums, 95),
    max: nums.length ? Math.max(...nums) : null,
    mean: nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : null,
  };
}

export const seconds = (ms) => (ms === null || ms === undefined ? "–" : `${(ms / 1000).toFixed(1)} s`);

export function pad2(n) {
  return String(n).padStart(2, "0");
}

// Runs `fn` over `items` with at most `limit` running at once; results in input order.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// Parses --key value / --flag arguments after the scenario name.
export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [key, inline] = a.slice(2).split("=", 2);
      if (inline !== undefined) args[key] = inline;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) args[key] = argv[++i];
      else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

export function intArg(args, key, fallback) {
  const v = args[key];
  if (v === undefined || v === true) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
