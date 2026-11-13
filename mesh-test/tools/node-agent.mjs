#!/usr/bin/env node
// The node test's hand on the MakeWork node running on this computer (node-test.sh starts it, scenario nodetest drives
// it). The harness runs in a container and can't reach host processes or the node's data folder, so this does, over
// HTTP with a token:
//   GET  /proc       pid, running, CPU % since the last call, RSS, uptime
//   GET  /status     the node's status.json (written every 10 s)
//   GET  /log?from=n its output since byte n (only while this agent started it), { text, next }
//   GET  /identity   the node's account id and user id (from its code; the code's pair secret never leaves here)
//   POST /stop  /start  /restart
// It finds the running node by its command line (`makework-node.mjs start`) and working folder, keeps that command
// line, and starts it again the same way, detached, its output appended to --log. On exit it leaves the node running.
//
//   node node-agent.mjs --dir ~/Desktop/node/dist-node [--data ~/.makework-node] --log <file> [--port 9411] [--host 127.0.0.1]
//     token: MWT_AGENT_TOKEN, else one is made and printed
import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
};
const home = (p) => p.replace(/^~(?=\/|$)/, os.homedir());
const dir = fs.realpathSync(home(arg("dir", "~/Desktop/node/dist-node")));
const data = home(arg("data", process.env.MAKEWORK_NODE_DATA ?? "~/.makework-node"));
const logFile = path.resolve(home(arg("log", path.join(os.tmpdir(), "mwt-local-node.log"))));
const port = Number(arg("port", 9411));
const listenHost = arg("host", "127.0.0.1");
const token = process.env.MWT_AGENT_TOKEN || crypto.randomBytes(24).toString("base64url");
const ticksPerSecond = 100;

let command = null; // { exe, args } of the node as found or last started
let child = null; // the node this agent started
let lastCpu = null; // { at, ticks }

const log = (...parts) => console.log(`[node-agent] ${new Date().toISOString()}`, ...parts);

function readCmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

// The node process started from `dir` (containers' nodes run from their own folders and don't match).
function findNode() {
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const args = readCmdline(entry);
    if (!args || !args.some((a) => a.endsWith("makework-node.mjs")) || !args.includes("start")) continue;
    let cwd = "";
    try {
      cwd = fs.realpathSync(`/proc/${entry}/cwd`);
    } catch {
      continue;
    }
    if (cwd !== dir) continue;
    let exe = args[0];
    try {
      exe = fs.readlinkSync(`/proc/${entry}/exe`);
    } catch {}
    return { pid: Number(entry), exe, args: args.slice(1) };
  }
  return null;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return fs.existsSync(`/proc/${pid}`) && !fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z");
  } catch {
    return false;
  }
};

async function stop() {
  const found = findNode();
  if (!found) return { stopped: false, why: "not running" };
  command = { exe: found.exe, args: found.args };
  process.kill(found.pid, "SIGTERM");
  for (let i = 0; i < 150 && alive(found.pid); i++) await new Promise((r) => setTimeout(r, 100));
  if (alive(found.pid)) process.kill(found.pid, "SIGKILL");
  for (let i = 0; i < 50 && alive(found.pid); i++) await new Promise((r) => setTimeout(r, 100));
  log(`stopped node ${found.pid}`);
  lastCpu = null;
  return { stopped: true, pid: found.pid };
}

function start() {
  const running = findNode();
  if (running) {
    command = { exe: running.exe, args: running.args };
    return { started: false, pid: running.pid, why: "already running" };
  }
  if (!command) throw new Error("No command line known: the node has to be running when the agent starts.");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, "a");
  fs.writeSync(out, `\n===== [node-agent] start ${new Date().toISOString()}: ${[command.exe, ...command.args].join(" ")}\n`);
  child = spawn(command.exe, command.args, { cwd: dir, detached: true, stdio: ["ignore", out, out] });
  child.unref();
  fs.closeSync(out);
  log(`started node ${child.pid}`);
  lastCpu = null;
  return { started: true, pid: child.pid };
}

function procInfo() {
  const found = findNode();
  if (!found) return { running: false };
  const stat = fs.readFileSync(`/proc/${found.pid}/stat`, "utf8").split(") ")[1].split(" ");
  // Fields after "pid (comm) ": state is [0], utime [11], stime [12], starttime [19] (proc(5), counted from 1 at pid).
  const ticks = Number(stat[11]) + Number(stat[12]);
  const now = Date.now();
  const cpu = lastCpu?.pid === found.pid ?((ticks - lastCpu.ticks) / ticksPerSecond) / ((now - lastCpu.at) / 1000) * 100 : null;
  lastCpu = { pid: found.pid, ticks, at: now };
  const status = fs.readFileSync(`/proc/${found.pid}/status`, "utf8");
  const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
  const uptimeS = Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]);
  const startedS = Number(stat[19]) / ticksPerSecond;
  return { running: true, pid: found.pid, cpu: cpu === null ? null : Math.round(cpu * 10) / 10, rssMb: Math.round(rssKb / 1024), upS: Math.round(uptimeS - startedS), ours: child?.pid === found.pid };
}

let identity = null;
function nodeIdentity() {
  if (identity) return Promise.resolve(identity);
  const found = findNode();
  const exe = found?.exe ?? command?.exe ?? process.execPath;
  return new Promise((resolve, reject) => {
    execFile(exe, ["makework-node.mjs", "code", "--data", data], { cwd: dir, timeout: 30_000 }, (error, stdout) => {
      if (error) return reject(error);
      const code = /mwn1\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/.exec(stdout);
      if (!code) return reject(new Error("No node code in the output."));
      const id = code[1];
      const bytes = Buffer.from(id, "base64url");
      // userNumberOf (p2p/log.ts): the first 6 bytes of the account id.
      const userId = [...bytes.subarray(0, 6)].reduce((n, b) => n * 256 + b, 0);
      identity = { accountId: id, userId };
      resolve(identity);
    });
  });
}

function readLog(from) {
  if (!fs.existsSync(logFile)) return { text: "", next: 0 };
  const size = fs.statSync(logFile).size;
  const start = Math.min(Math.max(0, from), size);
  const length = Math.min(size - start, 1024 * 1024);
  const fd = fs.openSync(logFile, "r");
  const buffer = Buffer.alloc(length);
  fs.readSync(fd, buffer, 0, length, start);
  fs.closeSync(fd);
  return { text: buffer.toString("utf8"), next: start + length };
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://agent");
  const send = (code, body) => response.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
  if ((request.headers["x-token"] ?? url.searchParams.get("token")) !== token) return send(403, { error: "token" });
  try {
    const route = `${request.method} ${url.pathname}`;
    if (route === "GET /proc") return send(200, procInfo());
    if (route === "GET /status") {
      const file = path.join(data, "status.json");
      return send(200, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);
    }
    if (route === "GET /log") return send(200, readLog(Number(url.searchParams.get("from") ?? 0)));
    if (route === "GET /identity") return send(200, await nodeIdentity());
    if (route === "POST /stop") return send(200, await stop());
    if (route === "POST /start") return send(200, start());
    if (route === "POST /restart") {
      const stopped = await stop();
      return send(200, { ...stopped, ...start() });
    }
    send(404, { error: "no such route" });
  } catch (e) {
    send(500, { error: String(e?.message ?? e) });
  }
});

const found = findNode();
if (found) command = { exe: found.exe, args: found.args };
log(found ? `node ${found.pid}: ${[found.exe, ...found.args].join(" ")}` : `no node running from ${dir}`);
server.listen(port, listenHost, () => {
  log(`listening on ${listenHost}:${port}, log ${logFile}`);
  if (!process.env.MWT_AGENT_TOKEN) console.log(`token ${token}`);
});

// Whatever happens to the test, the node is left running.
let leaving = false;
async function leave(signal) {
  if (leaving) return;
  leaving = true;
  try {
    if (!findNode() && command) start();
  } catch (e) {
    log(`could not start the node again: ${e.message}`);
  }
  log(`exit (${signal}); node ${findNode()?.pid ?? "not running"}`);
  server.close();
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => void leave(signal));
