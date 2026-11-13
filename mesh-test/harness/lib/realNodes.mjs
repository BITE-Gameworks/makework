// The node test's real nodes on the LAN: the one on the test computer, driven through tools/node-agent.mjs (status,
// CPU and memory, log, stop and start), and other ones known only from what members see of them (black boxes). Same
// shape as NodeHandle (lib/nodes.mjs) where they overlap: `name`, `down`, `status()`, `kill()`, `start()`, `scanLog()`.
import fs from "node:fs";
import path from "node:path";
import * as d from "./driver.mjs";
import { logPatterns } from "./nodes.mjs";
import { attempt, log, sleep } from "./util.mjs";

export class LocalNode {
  constructor({ url, token, name = "local" }) {
    this.name = name;
    this.url = url.replace(/\/$/, "");
    this.token = token;
    this.down = false;
    this.lastStatus = null;
    this.userId = null;
  }

  async request(method, route, timeoutMs = 30_000) {
    const res = await fetch(`${this.url}${route}`, { method, headers: { "x-token": this.token }, signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json();
    if (!res.ok) throw new Error(`${this.name} ${method} ${route}: ${body?.error ?? res.status}`);
    return body;
  }

  async status() {
    this.lastStatus = await this.request("GET", "/status", 10_000);
    return this.lastStatus;
  }

  proc() {
    return this.request("GET", "/proc", 10_000);
  }

  async identity() {
    const id = await this.request("GET", "/identity");
    this.userId = id.userId;
    return id;
  }

  async kill() {
    this.down = true;
    return this.request("POST", "/stop", 60_000);
  }

  async start() {
    const r = await this.request("POST", "/start");
    this.down = false;
    return r;
  }

  restart() {
    return this.request("POST", "/restart", 60_000);
  }

  // Its whole output since the agent started it.
  async logText() {
    let text = "";
    let from = 0;
    for (let i = 0; i < 200; i++) {
      const part = await this.request("GET", `/log?from=${from}`);
      text += part.text;
      if (part.next === from) break;
      from = part.next;
    }
    return text;
  }

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
    return { counts, samples, lines: lines.length, text };
  }

  // Waits until the node wrote its status after `since` (it writes every 10 s once running).
  async freshStatus(since, timeoutMs = 60_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const s = await this.status().catch(() => null);
      if (s && s.at >= since) return s;
      await sleep(2000);
    }
    return null;
  }
}

// A node elsewhere on the LAN: nothing but its address; members tell whether it is online and what it serves.
export class RemoteNode {
  constructor({ ip, name = "remote" }) {
    this.name = name;
    this.ip = ip;
    this.down = false;
    this.userId = null;
  }

  async status() {
    return null;
  }

  async kill() {
    throw new Error(`${this.name} is a black box: the node test doesn't stop it`);
  }

  async start() {
    // Nothing to start: a real node runs on its own.
  }

  async scanLog() {
    return { counts: {}, samples: {}, lines: 0, unavailable: true };
  }
}

// Every `everyMs`: the local node's status and process (nodes.csv), what `viewer` (an app) sees of every node
// (nodeviews.csv), and the host's load (host.csv). Returns stop() and the samples.
export function sampleRealNodes(run, local, nodes, viewer, serverId, everyMs = 5000) {
  const nodesFile = fs.createWriteStream(path.join(run.dir, "nodes.csv"), { flags: "a" });
  nodesFile.write("t,running,pid,cpu,rss_mb,status_at,queued,active,limit,commits,online,members,calls\n");
  const viewFile = fs.createWriteStream(path.join(run.dir, "nodeviews.csv"), { flags: "a" });
  viewFile.write(`t,online_nodes,${nodes.map((n) => `${n.name}_online`).join(",")},direct,member_room\n`);
  const hostFile = fs.createWriteStream(path.join(run.dir, "host.csv"), { flags: "a" });
  hostFile.write("t,load1,load5,mem_available_bytes\n");
  const samples = { local: [], views: [], host: [] };
  let running = true;
  const loop = (async () => {
    while (running) {
      const t = Date.now();
      const [proc, status, view] = await Promise.all([
        attempt(() => local.proc()), attempt(() => local.status()), attempt(() => d.nodeView(viewer, serverId)),
      ]);
      const p = proc.ok ? proc.value : {};
      const s = status.ok ? status.value : null;
      const info = s?.servers?.[serverId] ?? {};
      samples.local.push({ t, proc: p, sync: s?.sync ?? null, info });
      nodesFile.write(`${t},${p.running ?? ""},${p.pid ?? ""},${p.cpu ?? ""},${p.rssMb ?? ""},${s?.at ?? ""},${s?.sync?.queued ?? ""},${s?.sync?.active ?? ""},${s?.sync?.limit ?? ""},${info.commits ?? ""},${info.online ?? ""},${info.members ?? ""},${Object.keys(info.calls ?? {}).length}\n`);
      if (view.ok && view.value) {
        const v = view.value;
        const per = nodes.map((n) => (n.userId !== null && v.online[n.userId] ? 1 : 0));
        samples.views.push({ t, online: Object.keys(v.online).length, per, direct: v.direct.length, memberRoom: v.memberRoom });
        viewFile.write(`${t},${Object.keys(v.online).length},${per.join(",")},${v.direct.length},${v.memberRoom}\n`);
      }
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
      viewFile.end();
      hostFile.end();
    },
  };
}
