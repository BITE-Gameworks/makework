// One scenario run: the 500 ms poller (timeline.jsonl, per-client console logs), condition trackers that record
// when each client met a condition (misses are kept, never dropped), assertions with pass/fail, numbers, podman
// stats, and the outputs metrics.json + summary.md in /results/<RUN_ID>/.
import fs from "node:fs";
import path from "node:path";
import { probe } from "./driver.mjs";
import { log, seconds, setLogSink, sleep, stats } from "./util.mjs";

export class Run {
  constructor({ runId, outDir, scenario, args, topology, clients, podman }) {
    this.runId = runId;
    this.dir = path.join(outDir, runId);
    this.scenario = scenario;
    this.args = args;
    this.topology = topology;
    this.clients = clients;
    this.podman = podman;
    this.startedAt = Date.now();
    this.assertions = [];
    this.numbers = {};
    this.sections = [];
    this.trackers = [];
    this.trackerResults = [];
    this.events = [];
    this.serverIds = [];
    // Per server: the tag prefix of the message round running there (counted as `seen` by the poller).
    this.prefixes = {};
    this.pollMs = 500;
    this.polling = false;
    this.pollErrors = {};
    fs.mkdirSync(path.join(this.dir, "console"), { recursive: true });
    this.timeline = fs.createWriteStream(path.join(this.dir, "timeline.jsonl"), { flags: "a" });
    this.harnessLog = fs.createWriteStream(path.join(this.dir, "harness.log"), { flags: "a" });
    setLogSink((line) => this.harnessLog.write(`${line}\n`));
    this.consoleFiles = new Map();
  }

  // Something worth seeing on the timeline (a phase starting, a kill, a partition).
  event(kind, detail = {}) {
    const e = { t: Date.now(), kind, ...detail };
    this.events.push(e);
    this.timeline.write(`${JSON.stringify({ t: e.t, event: kind, ...detail })}\n`);
    log(`event ${kind} ${JSON.stringify(detail)}`);
  }

  // Adds servers to what the poller reads on every client.
  watch(...serverIds) {
    this.serverIds = [...new Set([...this.serverIds, ...serverIds.flat()])];
  }

  unwatch(serverId) {
    this.serverIds = this.serverIds.filter((s) => s !== serverId);
  }

  setPrefix(serverId, prefix) {
    this.watch(serverId);
    this.prefixes[serverId] = prefix;
  }

  consoleFile(name) {
    let f = this.consoleFiles.get(name);
    if (!f) {
      f = fs.createWriteStream(path.join(this.dir, "console", `${name}.log`), { flags: "a" });
      this.consoleFiles.set(name, f);
    }
    return f;
  }

  startPoller() {
    if (this.polling) return;
    this.polling = true;
    this.pollLoop = (async () => {
      while (this.polling) {
        const t0 = Date.now();
        await Promise.all(this.clients.map((c) => this.pollOne(c)));
        await sleep(Math.max(0, this.pollMs - (Date.now() - t0)));
      }
    })();
    if (this.podman?.available) {
      this.statsFile = fs.createWriteStream(path.join(this.dir, "podman-stats.csv"), { flags: "a" });
      this.statsFile.write("t,name,cpu_percent,mem_bytes,net_in_bytes,net_out_bytes,pids\n");
      this.statsLoop = (async () => {
        while (this.polling) {
          try {
            const rows = await this.podman.stats([]);
            const t = Date.now();
            for (const r of rows.filter((r) => r.name?.startsWith("mwt-")))
              this.statsFile.write(`${t},${r.name},${r.cpu.toFixed(2)},${r.mem},${r.netIn},${r.netOut},${r.pids}\n`);
          } catch (e) {
            this.pollErrors.podmanStats = String(e.message ?? e);
          }
          await sleep(5000);
        }
      })();
    }
  }

  async stopPoller() {
    this.polling = false;
    await this.pollLoop?.catch(() => {});
    await this.statsLoop?.catch(() => {});
  }

  async pollOne(client) {
    if (client.down || !client.connected || (!client.isBot && !client.page)) return;
    try {
      // Bots (lib/bots.mjs) answer the same shape over HTTP.
      const state = client.isBot ? await client.probe(this.serverIds, this.prefixes) : await probe(client, this.serverIds, this.prefixes);
      client.lastState = state;
      client.pollFailures = 0;
      if (state.logs) {
        const f = this.consoleFile(client.name);
        for (const e of state.logs.entries) f.write(`${new Date(e.t).toISOString()} ${e.l.toUpperCase()} ${e.m}\n`);
        if (state.logs.dropped) f.write(`… ${state.logs.dropped} entries dropped (ring buffer)\n`);
        client.logCursor = state.logs.next;
        client.logTail = (client.logTail ?? []).concat(state.logs.entries).slice(-400);
        for (const e of state.logs.entries) this.onLog(client, e);
      }
      const { logs, ...rest } = state;
      this.timeline.write(`${JSON.stringify({ c: client.name, ...rest })}\n`);
      for (const tracker of this.trackers) tracker.feed(client.name, state);
    } catch (e) {
      client.pollFailures = (client.pollFailures ?? 0) + 1;
      const msg = String(e.message ?? e);
      this.pollErrors[client.name] = msg;
      if (client.pollFailures === 1 || client.pollFailures % 20 === 0)
        this.timeline.write(`${JSON.stringify({ t: Date.now(), c: client.name, pollError: msg, n: client.pollFailures })}\n`);
    }
  }

  // The app's own timing lines (sync.ts / servers.ts), kept per client and server.
  onLog(client, entry) {
    const m = entry.m.match(/^\[sync\] ([0-9A-Za-z_-]{8}): (first member found after ([\d.]+) s|server data received after ([\d.]+) s \((\d+) commits\)|looking for members)/);
    if (!m) return;
    client.syncLog ??= [];
    client.syncLog.push({ t: entry.t, server8: m[1], what: m[3] ? "first-member" : m[4] ? "data" : "looking", s: Number(m[3] ?? m[4] ?? 0), commits: m[5] ? Number(m[5]) : undefined });
  }

  // Records, per client, how long after `startedAt` (default now) `predicate(clientState, clientName)` first held.
  track(name, clientNames, predicate, { startedAt = Date.now() } = {}) {
    const tracker = new Tracker(name, clientNames, predicate, startedAt);
    this.trackers.push(tracker);
    // Seeded with the latest known state, so a condition that already holds counts right away.
    for (const c of this.clients) if (clientNames.includes(c.name) && c.lastState) tracker.feed(c.name, c.lastState);
    return tracker;
  }

  async waitTracker(tracker, timeoutMs) {
    const result = await tracker.wait(timeoutMs);
    this.trackers = this.trackers.filter((t) => t !== tracker);
    this.trackerResults.push(result);
    log(`tracker ${result.name}: ${result.hit}/${result.total} in ${seconds(result.allMs)}${result.missing.length ? `, missing ${result.missing.join(",")}` : ""}`);
    return result;
  }

  assert(id, description, pass, detail = {}) {
    const a = { id, description, pass: Boolean(pass), detail };
    this.assertions.push(a);
    log(`${a.pass ? "PASS" : "FAIL"} ${id}: ${description} ${JSON.stringify(detail).slice(0, 400)}`);
    return a.pass;
  }

  number(key, value) {
    this.numbers[key] = value;
  }

  section(title, markdown) {
    this.sections.push({ title, markdown });
  }

  async finish(extra = {}) {
    await this.stopPoller();
    const finishedAt = Date.now();
    const verdict = this.assertions.length > 0 && this.assertions.every((a) => a.pass) ? "PASS" : "FAIL";
    const metrics = {
      scenario: this.scenario, runId: this.runId, verdict, topology: this.topology?.topology ?? null, n: this.clients.length,
      args: this.args, startedAt: this.startedAt, finishedAt, durationMs: finishedAt - this.startedAt,
      assertions: this.assertions, numbers: this.numbers, trackers: this.trackerResults, events: this.events,
      pollErrors: this.pollErrors, sections: this.sections.map((s) => s.title), ...extra,
    };
    fs.writeFileSync(path.join(this.dir, "metrics.json"), JSON.stringify(metrics, null, 2));
    fs.writeFileSync(path.join(this.dir, "summary.md"), this.summary(metrics));
    for (const f of this.consoleFiles.values()) f.end();
    this.timeline.end();
    this.statsFile?.end();
    log(`${this.scenario}: ${verdict} (${this.assertions.filter((a) => a.pass).length}/${this.assertions.length} assertions) → ${this.dir}`);
    this.harnessLog.end();
    setLogSink(null);
    return metrics;
  }

  summary(m) {
    const lines = [];
    lines.push(`# ${m.scenario} — ${m.verdict}`, "");
    lines.push(`Run \`${m.runId}\`, topology \`${m.topology}\`, ${m.n} clients, ${seconds(m.durationMs)}, args \`${JSON.stringify(m.args)}\``, "");
    lines.push("| | Assertion | Detail |", "|---|---|---|");
    for (const a of m.assertions) lines.push(`| ${a.pass ? "✅" : "❌"} | ${a.id}: ${a.description} | ${mdEscape(JSON.stringify(a.detail)).slice(0, 300)} |`);
    lines.push("");
    if (m.trackers.length) {
      lines.push("## Time to condition (per client, from the moment the step started)", "");
      lines.push("| Condition | Hit | p50 | p95 | max (all) | Missing |", "|---|---|---|---|---|---|");
      for (const t of m.trackers) {
        const s = stats(Object.values(t.perClient));
        lines.push(`| ${t.name} | ${t.hit}/${t.total} | ${seconds(s.p50)} | ${seconds(s.p95)} | ${seconds(t.allMs)} | ${t.missing.join(", ") || "–"} |`);
      }
      lines.push("");
    }
    if (Object.keys(m.numbers).length) {
      lines.push("## Numbers", "", "```json", JSON.stringify(m.numbers, null, 2).slice(0, 20000), "```", "");
    }
    for (const s of this.sections) lines.push(`## ${s.title}`, "", s.markdown, "");
    return lines.join("\n");
  }
}

class Tracker {
  constructor(name, clientNames, predicate, startedAt) {
    this.name = name;
    this.names = clientNames;
    this.predicate = predicate;
    this.startedAt = startedAt;
    this.hitAt = {};
    this.waiters = [];
  }

  feed(clientName, state) {
    if (!this.names.includes(clientName) || clientName in this.hitAt) return;
    // A sample from before the step started (e.g. before a kill or a new round) says nothing about the step.
    if (state.t < this.startedAt) return;
    let ok = false;
    try {
      ok = Boolean(this.predicate(state, clientName));
    } catch {}
    if (!ok) return;
    this.hitAt[clientName] = Math.max(0, state.t - this.startedAt);
    if (Object.keys(this.hitAt).length === this.names.length) this.waiters.forEach((w) => w());
  }

  result() {
    const perClient = Object.fromEntries(this.names.map((n) => [n, this.hitAt[n] ?? null]));
    const missing = this.names.filter((n) => !(n in this.hitAt));
    const values = Object.values(perClient).filter((v) => v !== null);
    return {
      name: this.name, startedAt: this.startedAt, total: this.names.length, hit: values.length, missing, perClient,
      allMs: missing.length === 0 ? Math.max(0, ...values) : null, stats: stats(Object.values(perClient)),
    };
  }

  wait(timeoutMs) {
    if (Object.keys(this.hitAt).length === this.names.length) return Promise.resolve(this.result());
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.result()), timeoutMs);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve(this.result());
      });
    });
  }
}

function mdEscape(s) {
  return s.replaceAll("|", String.raw`\|`);
}

// Who sees whom: rows are observers, columns peers; D direct, R relayed, F failed (direct attempt failed and
// not reachable), . not seen, - self. `meshes[name]` is driver.meshInfo(); `selfIds[name]` the Trystero id.
export function visibilityMatrix(names, meshes, selfIds) {
  const byId = Object.fromEntries(Object.entries(selfIds).filter(([, id]) => id).map(([n, id]) => [id, n]));
  const short = (n) => n.replace(/^mwt-client/, "c").replace(/^client/, "c");
  const rows = [];
  const counts = {};
  for (const observer of names) {
    const mesh = meshes[observer];
    const direct = new Set((mesh?.direct ?? []).map((id) => byId[id] ?? `?${id.slice(0, 4)}`));
    const via = new Map((mesh?.via ?? []).map(([id, relay]) => [byId[id] ?? `?${id.slice(0, 4)}`, byId[relay] ?? relay]));
    const failed = new Set((mesh?.failed ?? []).map((id) => byId[id] ?? `?${id.slice(0, 4)}`));
    const row = names.map((peer) => {
      if (peer === observer) return "-";
      if (!mesh) return "?";
      if (direct.has(peer)) return "D";
      if (via.has(peer)) return "R";
      if (failed.has(peer)) return "F";
      return ".";
    });
    counts[observer] = { direct: direct.size, relayed: via.size, missing: row.filter((x) => x === "." || x === "F").length };
    rows.push([observer, ...row]);
  }
  const header = String.raw`| observer \ peer | ${names.map(short).join(" | ")} |`;
  const sep = `|---|${names.map(() => "---").join("|")}|`;
  const body = rows.map(([o, ...r]) => `| ${short(o)} | ${r.join(" | ")} |`);
  return { rows, counts, markdown: [header, sep, ...body].join("\n") };
}
