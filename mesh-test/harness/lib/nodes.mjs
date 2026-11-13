// MakeWork nodes (image mwt-node, the built dist-node) for scenario s8: hosting through the node's own CLI inside its
// container, its status.json (hosted servers, and the sync scheduler's queued/active/limit), its log scanned for
// warnings, and a sampler writing nodes.csv and host.csv (the host's load and free memory) into the run folder.
import fs from "node:fs";
import path from "node:path";
import { log, sleep } from "./util.mjs";

const cli = ["node", "/node/makework-node.mjs"];

// What the node log is scanned for. The first one is why the stress test exists.
export const logPatterns = {
  maxListeners: /MaxListenersExceededWarning/,
  stoppedDraining: /stopped draining/,
  unhandled: /Unhandled failure/,
  catchUpFailed: /Catch-up failed/,
  commitsNotApplied: /Commits not applied/,
  notRegistered: /not registered as a node/,
  // Calls through the node: its mediasoup worker failed to start or died (node/host.ts).
  callsOff: /Calls through this node are off/,
  started: /^MakeWork node /m,
};

export class NodeHandle {
  constructor(spec, podman) {
    this.name = spec.name;
    this.container = spec.container ?? spec.name;
    this.ip = spec.ip;
    this.url = spec.url;
    this.podman = podman;
    this.down = false;
    this.lastStatus = null;
  }

  async cli(...args) {
    const r = await this.podman.exec(this.container, [...cli, ...args, "--data", "/data"]);
    if (r.code !== 0) throw new Error(`${this.name} ${args[0]}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    return r.stdout;
  }

  // The node's code (`code`), which a member pastes to add it to a workspace (driver.mjs `addNode`).
  async code() {
    const out = (await this.cli("code")).trim().split("\n");
    return out[out.length - 1].trim();
  }

  // status.json as the running node last wrote it (every 10 s), or null.
  async status() {
    const r = await this.podman.exec(this.container, ["cat", "/data/status.json"], 15_000);
    if (r.code !== 0) return null;
    try {
      this.lastStatus = JSON.parse(r.stdout);
      return this.lastStatus;
    } catch {
      return null;
    }
  }

  // Bytes received and sent on the container's interfaces (rootless podman stats report 0 for network).
  async netBytes() {
    const r = await this.podman.exec(this.container, ["cat", "/proc/net/dev"], 15_000);
    if (r.code !== 0) return null;
    let rx = 0;
    let tx = 0;
    for (const line of r.stdout.split("\n").slice(2)) {
      const [name, rest] = line.split(":");
      if (!rest || name.trim() === "lo") continue;
      const fields = rest.trim().split(/\s+/).map(Number);
      rx += fields[0];
      tx += fields[8];
    }
    return { rx, tx };
  }

  async logText() {
    return this.podman.logs(this.container);
  }

  // Counts of each pattern in the whole log, plus the first few matching lines of the warning kinds.
  async scanLog() {
    const text = await this.logText().catch((e) => `(log unavailable: ${e.message})`);
    const lines = text.split("\n");
    const counts = {};
    const samples = {};
    for (const [key, pattern] of Object.entries(logPatterns)) {
      const hits = lines.filter((l) => pattern.test(l));
      counts[key] = hits.length;
      if (hits.length && key !== "started") samples[key] = hits.slice(0, 3).map((l) => l.slice(0, 300));
    }
    return { counts, samples, lines: lines.length };
  }

  kill() {
    this.down = true;
    return this.podman.kill(this.container);
  }

  async start() {
    await this.podman.start(this.container);
    this.down = false;
  }
}

// Every `everyMs`: each node's status.json into nodes.csv, and the host's load and memory into host.csv (the
// harness container sees the host's /proc/loadavg and /proc/meminfo). Returns stop() and the samples kept.
export function sampleNodes(run, nodes, everyMs = 5000) {
  const nodesFile = fs.createWriteStream(path.join(run.dir, "nodes.csv"), { flags: "a" });
  nodesFile.write("t,node,status_at,queued,active,limit,rx_bytes,tx_bytes,server,status,commits,online,members,kept,missing\n");
  const hostFile = fs.createWriteStream(path.join(run.dir, "host.csv"), { flags: "a" });
  hostFile.write("t,load1,load5,mem_available_bytes\n");
  const samples = { nodes: [], host: [] };
  let running = true;
  const loop = (async () => {
    while (running) {
      const t = Date.now();
      await Promise.all(nodes.map(async (node) => {
        if (node.down) return;
        const [s, net] = await Promise.all([node.status().catch(() => null), node.netBytes().catch(() => null)]);
        if (!s) return;
        const sync = s.sync ?? {};
        samples.nodes.push({ t, node: node.name, at: s.at, sync, servers: s.servers, net });
        for (const [id, info] of Object.entries(s.servers ?? {}))
          nodesFile.write(`${t},${node.name},${s.at},${sync.queued ?? ""},${sync.active ?? ""},${sync.limit ?? ""},${net?.rx ?? ""},${net?.tx ?? ""},${id.slice(0, 8)},${info.status},${info.commits},${info.online},${info.members},${info.kept},${info.missing}\n`);
      }));
      try {
        const [load1, load5] = fs.readFileSync("/proc/loadavg", "utf8").split(" ").map(Number);
        const available = Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync("/proc/meminfo", "utf8"))?.[1] ?? 0) * 1024;
        samples.host.push({ t, load1, load5, available });
        hostFile.write(`${t},${load1},${load5},${available}\n`);
      } catch (e) {
        log(`host sample failed: ${e.message}`);
      }
      await sleep(Math.max(0, everyMs - (Date.now() - t)));
    }
  })();
  return {
    samples,
    async stop() {
      running = false;
      await loop.catch(() => {});
      nodesFile.end();
      hostFile.end();
    },
  };
}
