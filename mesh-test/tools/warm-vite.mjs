#!/usr/bin/env node
// Warms the shared Vite server before clients start: requests the app's whole static module graph from
// /src/index.tsx until every module answers 200 and the optimized-deps version (`?v=`) stops changing. A client
// whose first load lands mid-optimization gets "Failed to fetch dynamically imported module" and an empty page.
//
//   node warm-vite.mjs [http://127.0.0.1:1420] [--timeout <s>]
const args = process.argv.slice(2);
const timeoutIndex = args.indexOf("--timeout");
const timeoutSeconds = timeoutIndex >= 0 ? Number(args.splice(timeoutIndex, 2)[1]) : 180;
const base = args[0] ?? "http://127.0.0.1:1420";
// Either only spaces before the quote, or anything up to `from`: written as two choices, not as spaces followed by an
// optional "anything", where both parts took the same spaces and a long run of them was tried over and over.
const importPattern = /(?:import|export)(?:\s*|[^"'`;]*?from\s*)["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
// Orders text by UTF-16 code units: what `sort()` does without a function.
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

async function crawl() {
  const seen = new Set();
  const queue = ["/src/index.tsx"];
  const failed = [];
  const versions = new Set();
  while (queue.length) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    const response = await fetch(base + url);
    const body = await response.text();
    if (response.status !== 200) {
      failed.push(`${response.status} ${url}`);
      continue;
    }
    for (const match of body.matchAll(importPattern)) {
      const spec = match[1] ?? match[2];
      if (!spec.startsWith("/")) continue;
      const version = /[?&]v=([0-9a-f]+)/.exec(spec)?.[1];
      if (version) versions.add(version);
      queue.push(spec);
    }
  }
  return { modules: seen.size, failed, versions: [...versions].sort(compareText).join(",") };
}

const started = Date.now();
let previous = null;
for (;;) {
  let result;
  try {
    result = await crawl();
  } catch (e) {
    result = { modules: 0, failed: [String(e.message)], versions: "" };
  }
  const stable = result.failed.length === 0 && previous !== null && previous.versions === result.versions && previous.failed.length === 0;
  if (stable) {
    console.log(`vite warm: ${result.modules} modules, deps version ${result.versions || "-"} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    process.exit(0);
  }
  if (Date.now() - started > timeoutSeconds * 1000) {
    console.error(`vite not warm after ${timeoutSeconds} s: ${result.failed.slice(0, 5).join("; ")}`);
    process.exit(1);
  }
  previous = result;
  await new Promise((resolve) => setTimeout(resolve, result.failed.length ? 1000 : 300));
}
