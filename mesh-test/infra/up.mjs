#!/usr/bin/env node
// Brings the mesh test up (called by ../up.sh): networks, the local Nostr relays (Caddy TLS front + 5 strfry),
// coturn + the TURN stub, the shared Vite dev server and N MakeWork clients in one topology, then waits until every
// client's page is up and writes run/topology.json for the harness.
//
//   up.sh <N> <topology> [--no-turn] [--no-build] [--stagger <ms>] [--timeout <s>] [--old <k>]
//         [--nodes <k>] [--bots <b>] [--bots-per <p>] [--senders <s>] [--heal-after <minutes>] [--min-stripe-mb <m>]
//         [--rtc-ports <a-b>]
//
// --rtc-ports is the UDP/TCP range a node's call SFU (mediasoup) listens on, 40000-40199 by default: every member's
// media comes in on its first port (the node's --rtc-port default), the links between nodes take the rest, announced
// on NODE_IP.
//
// --min-stripe-mb lowers the size from which nodes split files into pieces (20 GB in real use) for files a test can
// move; the nodes get it as MAKEWORK_TEST_MIN_STRIPE_MB, and s9 sets the same in the owner's app.
//
// --nodes starts k MakeWork nodes (the built dist-node, image mwt-node) and --bots b headless bot members (p per
// container, default 10), both on the first LAN, for the node stress test (scenario s8). They reach the relays like
// the clients, through Caddy (--add-host entries and the test CA).
//
// Topologies (internal networks have no internet at all; the relays, coturn and Vite sit on every LAN used):
//   single        every client on mwt-lan-a
//   split-bridge  clients alternate lan-a / lan-b; client01 and client02 on both (members can relay)
//   split-chain   clients round-robin over lan-a / lan-b / lan-c; client01 on a+b, client02 on b+c (2-hop chain)
//   split-turn    clients alternate lan-a / lan-b, nobody on both: only TURN (coturn) connects across
//   public        every client on mwt-pub (with internet): the real public relays and STUN; only TURN is redirected
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
// The repository root: app/ next to mesh-test/ (also the image build context).
const repo = path.dirname(root);
const runDir = path.join(root, "run");
const certDir = path.join(here, "certs");

const lanIndex = { "mwt-lan-a": 1, "mwt-lan-b": 2, "mwt-lan-c": 3, "mwt-pub": 10 };
const infraNet = "mwt-infra";
const infraIndex = 9;
const hosts = { caddy: 10, coturn: 11, vite: 12, viteOld: 13, harness: 250 };
// Nodes are .31-.39, bot containers .40-.99 (clients stay .101+).
const nodeHost = (k) => 30 + k;
const botsHost = (j) => 39 + j;
const botPort = 9300;
// `--old <k>`: the last k clients run this image (tag the app image before a change to compare versions).
const oldImage = "mwt-app:pre-fix";
const clientHost = (i) => 100 + i;
const relayCount = 5;
const relayImage = "docker.io/dockurr/strfry:latest";
const caddyImage = "docker.io/library/caddy:2-alpine";
const coturnImage = "docker.io/coturn/coturn:4.7";
const turnStubHost = "turn-stub.mwt.test";
const turnUser = "mwt";
const turnSecret = "mwt-turn-secret";
const topologies = ["single", "split-bridge", "split-chain", "split-turn", "public", "lan"];
// Topology lan (the node test, node-test.sh): everything on the host's own network, so members reach the real nodes on
// the LAN, this computer's own one included (rootless containers on a bridge can't reach the host's LAN address). The
// real Nostr relays and STUN, no TURN (nodes don't use it). Vite, CDP and bot ports on 127.0.0.1 only.
const lanVitePort = 1421; // the developer's own dev server has 1420
const lanCdpPort = (i) => 9240 + i;
const lanDisplay = (i) => 100 + i;

const ip = (net, host) => `10.231.${net === infraNet ? infraIndex : lanIndex[net]}.${host}`;
const pad = (i) => String(i).padStart(2, "0");
const log = (...parts) => console.log("[up]", ...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs() {
  const argv = process.argv.slice(2);
  const options = { turn: true, build: true, stagger: 250, timeout: 240, old: 0, nodes: 0, bots: 0, botsPer: 10, senders: 32, healAfter: 15, minStripeMb: 0, rtcPorts: "40000-40199" };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-turn") options.turn = false;
    else if (a === "--nodes") options.nodes = Number(argv[++i]);
    else if (a === "--bots") options.bots = Number(argv[++i]);
    else if (a === "--bots-per") options.botsPer = Number(argv[++i]);
    else if (a === "--senders") options.senders = Number(argv[++i]);
    else if (a === "--heal-after") options.healAfter = Number(argv[++i]);
    else if (a === "--min-stripe-mb") options.minStripeMb = Number(argv[++i]);
    else if (a === "--rtc-ports") options.rtcPorts = String(argv[++i]);
    else if (a === "--old") options.old = Number(argv[++i]);
    else if (a === "--no-build") options.build = false;
    else if (a === "--stagger") options.stagger = Number(argv[++i]);
    else if (a === "--timeout") options.timeout = Number(argv[++i]);
    else positional.push(a);
  }
  const [count, topology = "single"] = positional;
  const n = Number(count);
  const botContainers = options.bots > 0 ? Math.ceil(options.bots / options.botsPer) : 0;
  if (topology === "lan") options.turn = false;
  if (topology === "lan" && options.nodes > 0) {
    console.error("up.sh: topology lan tests the real nodes on the LAN; it starts no nodes of its own (no --nodes)");
    process.exit(1);
  }
  if (!Number.isInteger(n) || n < 1 || n > 99 || !topologies.includes(topology)
    || !(options.nodes >= 0 && options.nodes <= 9) || !(options.bots >= 0) || !(options.botsPer >= 1) || botContainers > 60
    || !(Number.isInteger(options.minStripeMb) && options.minStripeMb >= 0) || !/^\d+-\d+$/.test(options.rtcPorts)) {
    console.error(`usage: up.sh <N 1-99> <${topologies.join("|")}> [--no-turn] [--no-build] [--stagger ms] [--timeout s] [--old k] [--nodes 0-9] [--bots b] [--bots-per p] [--senders s] [--heal-after min] [--min-stripe-mb m] [--rtc-ports a-b]`);
    process.exit(1);
  }
  return { n, topology, ...options };
}

function run(command, args, { input, quiet = false, allowFail = false } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 && !allowFail) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stderr || result.stdout}`);
  }
  if (!quiet && result.status !== 0) console.error(result.stderr);
  return result;
}

function runAsync(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

// Which LANs each client sits on (index 0 = client01). The first LAN is the one it reaches the infra through.
function assign(n, topology) {
  const [a, b, c] = ["mwt-lan-a", "mwt-lan-b", "mwt-lan-c"];
  const all = Array.from({ length: n }, (_, i) => i);
  switch (topology) {
    case "single":
      return all.map(() => [a]);
    case "split-bridge":
      return all.map((i) => (i < 2 ? [a, b] : [i % 2 === 0 ? a : b]));
    case "split-chain":
      return all.map((i) => (i === 0 ? [a, b] : i === 1 ? [b, c] : [[a, b, c][(i - 2) % 3]]));
    case "split-turn":
      return all.map((i) => [i % 2 === 0 ? a : b]);
    case "public":
      return all.map(() => ["mwt-pub"]);
    case "lan":
      return all.map(() => ["host"]);
  }
  throw new Error(`unknown topology ${topology}`);
}

// Every relay a client may use, each served by its own strfry: the app's own list (`src/p2p/relays.ts`) and the 5
// Trystero picks from its defaults for the appId, which older clients (no relay list yet, e.g. image mwt-app:pre-fix)
// still use. Computed from the source and the installed Trystero so it can't drift.
async function relays() {
  const sync = fs.readFileSync(path.join(repo, "app/src/p2p/sync.ts"), "utf8");
  const appId = /const appId = "([^"]+)"/.exec(sync)?.[1];
  if (!appId) throw new Error("appId not found in src/p2p/sync.ts");
  const relaysFile = path.join(repo, "app/src/p2p/relays.ts");
  const own = fs.existsSync(relaysFile) ? [...fs.readFileSync(relaysFile, "utf8").matchAll(/"(wss:\/\/[^"]+)"/g)].map((m) => m[1]) : [];
  const nostr = path.join(repo, "app/node_modules/@trystero-p2p/nostr/dist/index.mjs");
  const { defaultRelayUrls } = await import(pathToFileURL(nostr).href);
  const { floor, sin } = Math;
  const shuffle = (xs, seed) => {
    const out = [...xs];
    const rand = () => {
      const x = sin(seed++) * 1e4;
      return x - floor(x);
    };
    let i = out.length;
    while (i) {
      const j = floor(rand() * i--);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const seed = appId.split("").reduce((sum, ch) => sum + ch.codePointAt(0), 0) % Number.MAX_SAFE_INTEGER;
  const hostOf = (url) => new URL(url).hostname;
  const picked = shuffle(defaultRelayUrls, seed).slice(0, relayCount);
  const selected = [...new Set([...own, ...picked])];
  for (const url of selected) {
    const port = new URL(url).port;
    if (port && port !== "443") throw new Error(`relay ${url} uses port ${port}; the redirect only covers 443`);
  }
  return { appId, selected: selected.map(hostOf), all: [...new Set([...defaultRelayUrls, ...own].map(hostOf))] };
}

// A local CA (kept) and one server certificate for every Trystero default relay host plus the TURN stub.
function ensureCerts(relayHosts) {
  fs.mkdirSync(certDir, { recursive: true });
  const ca = path.join(certDir, "ca.crt");
  const caKey = path.join(certDir, "ca.key");
  if (!fs.existsSync(ca) || !fs.existsSync(caKey)) {
    log("creating the test CA");
    run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", ca, "-days", "3650",
      "-subj", "/CN=MakeWork mesh-test CA", "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  }
  const names = [...relayHosts, turnStubHost].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const stampFile = path.join(certDir, "hosts.txt");
  const stamp = `${crypto.createHash("sha256").update(fs.readFileSync(ca)).digest("hex")}\n${names.join("\n")}`;
  const crt = path.join(certDir, "server.crt");
  if (fs.existsSync(crt) && fs.existsSync(stampFile) && fs.readFileSync(stampFile, "utf8") === stamp) return;
  log(`issuing the relay certificate (${names.length} names)`);
  const key = path.join(certDir, "server.key");
  const csr = path.join(certDir, "server.csr");
  const ext = path.join(certDir, "server.ext");
  fs.writeFileSync(ext, [
    `subjectAltName=${names.map((n) => `DNS:${n}`).join(",")}`,
    "basicConstraints=CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
    "",
  ].join("\n"));
  run("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", "/CN=mwt relays"]);
  run("openssl", ["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-out", crt, "-days", "365",
    "-sha256", "-extfile", ext]);
  fs.writeFileSync(stampFile, stamp);
}

// Identifies the app source that went into the image: git HEAD, dirty flag, and a hash of the files themselves.
function sourceId() {
  const head = run("git", ["-C", repo, "rev-parse", "--short", "HEAD"]).stdout.trim();
  const dirty = run("git", ["-C", repo, "status", "--porcelain", "--", "app"]).stdout.trim() !== "";
  const hash = crypto.createHash("sha256");
  const skip = new Set(["node_modules", "dist", "release", ".vscode"]);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      if (skip.has(entry.name) || entry.name.endsWith(".log") || entry.name.endsWith(".tsbuildinfo")) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) hash.update(path.relative(repo, file)).update(fs.readFileSync(file));
    }
  };
  walk(path.join(repo, "app"));
  return { gitSha: `${head}${dirty ? "-dirty" : ""}`, srcHash: hash.digest("hex").slice(0, 12) };
}

function buildImage(id) {
  log(`building mwt-app (${id.gitSha}, src ${id.srcHash})`);
  const result = spawnSync("podman", ["build", "-t", "mwt-app", "-f", path.join(root, "Containerfile"),
    "--ignorefile", path.join(root, "containerignore"), "--build-arg", `GIT_SHA=${id.gitSha}+src.${id.srcHash}`, repo],
  { stdio: ["ignore", "inherit", "inherit"] });
  if (result.status !== 0) throw new Error("podman build failed");
}

// The node and the bots, built from mwt-app (node.Containerfile).
function buildNodeImage(id) {
  log(`building mwt-node (${id.gitSha}, src ${id.srcHash})`);
  const result = spawnSync("podman", ["build", "--pull=never", "-t", "mwt-node", "-f", path.join(root, "node.Containerfile"),
    "--ignorefile", path.join(root, "containerignore"), "--build-arg", `GIT_SHA=${id.gitSha}+src.${id.srcHash}`, repo],
  { stdio: ["ignore", "inherit", "inherit"] });
  if (result.status !== 0) throw new Error("podman build of mwt-node failed");
}

// Inside a running container (no curl in the node image): resolves true when every port answers /status.
async function botsAnswer(name, ports) {
  const script = `Promise.all(${JSON.stringify(ports)}.map((p) => fetch("http://127.0.0.1:" + p + "/status").then((r) => r.ok)))`
    + `.then((all) => process.exit(all.every(Boolean) ? 0 : 1), () => process.exit(1))`;
  return (await runAsync("podman", ["exec", name, "node", "-e", script])).status === 0;
}

function caddyfile(relayHosts, turnJson) {
  const site = (host, body) => `https://${host} {\n\ttls /certs/server.crt /certs/server.key\n${body}}\n`;
  const relaySites = relayHosts.map((host, i) =>
    site(host, `\treverse_proxy ${ip(infraNet, 21 + i)}:7777\n`));
  const stub = turnJson
    // ice.ts signs its request (X-MW-Auth), so the browser asks first (preflight); the stub doesn't check the signature.
    ? `\theader {\n\t\tAccess-Control-Allow-Origin "*"\n\t\tAccess-Control-Allow-Headers "X-MW-Auth"\n\t\tCache-Control "no-store"\n\t\tContent-Type "application/json"\n\t}\n\trespond \`${turnJson}\` 200\n`
    : `\theader {\n\t\tAccess-Control-Allow-Origin "*"\n\t\tAccess-Control-Allow-Headers "X-MW-Auth"\n\t}\n\trespond \`{"iceServers":[],"ttl":600,"reason":"TURN disabled for this run"}\` 503\n`;
  return [
    "# Generated by mesh-test/infra/up.mjs for this run.",
    "{\n\tauto_https off\n\tadmin off\n\tservers {\n\t\tprotocols h1\n\t}\n}\n",
    ...relaySites,
    site(turnStubHost, stub),
  ].join("\n");
}

function socketWorks(socketPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) return resolve(false);
    const request = http.get({ socketPath, path: "/_ping", timeout: 3000 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("error", () => resolve(false));
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
  });
}

// The harness drives kills, restarts and network changes through the rootless podman API.
async function podmanSocket() {
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${os.userInfo().uid}`;
  const user = path.join(runtime, "podman/podman.sock");
  if (await socketWorks(user)) return user;
  const own = path.join(runtime, "mwt-podman.sock");
  if (await socketWorks(own)) return own;
  log(`starting podman system service on ${own}`);
  const child = spawn("podman", ["system", "service", "--time=0", `unix://${own}`], { detached: true, stdio: "ignore" });
  child.unref();
  fs.writeFileSync(path.join(runDir, "podman-service.pid"), String(child.pid));
  for (let i = 0; i < 50; i++) {
    if (await socketWorks(own)) return own;
    await sleep(200);
  }
  throw new Error("podman system service did not come up");
}

// "ready": the app rendered; "blank": the document loaded but the app didn't render (a failed module load).
const readyExpression = `document.readyState !== "complete" ? "loading" : (document.getElementById("root")?.childElementCount ?? 0) > 0 ? "ready" : "blank"`;
const blankReloadSeconds = 15;

// Each client's CDP port inside its container (9222; on the host's network each has its own).
const cdpPorts = new Map();

function cdpEval(name, expression) {
  return runAsync("podman", ["exec", name, "node", "/mwt-tools/cdp-eval.mjs", `http://127.0.0.1:${cdpPorts.get(name) ?? 9222}`, expression, "--timeout", "10"]);
}

async function clientState(name) {
  const result = await cdpEval(name, readyExpression);
  return result.status === 0 ? JSON.parse(result.stdout.trim()) : "down";
}

// Resolves with the seconds each client took until its app rendered. A page that stays blank is reloaded (counted
// in `reloads`), so a rare failed first load doesn't fail the whole start.
async function waitReady(names, timeoutSeconds, reloads) {
  const started = Date.now();
  const readyAt = new Map();
  const blankSince = new Map();
  while (readyAt.size < names.length) {
    if (Date.now() - started > timeoutSeconds * 1000) {
      const missing = names.filter((n) => !readyAt.has(n));
      throw new Error(`clients not ready after ${timeoutSeconds} s: ${missing.join(", ")} (see podman logs <name>)`);
    }
    await Promise.all(names.filter((n) => !readyAt.has(n)).map(async (name) => {
      const status = run("podman", ["inspect", "-f", "{{.State.Status}}", name], { allowFail: true, quiet: true }).stdout.trim();
      if (status === "exited") throw new Error(`${name} exited during start:\n${run("podman", ["logs", "--tail", "40", name], { allowFail: true }).stderr}`);
      const state = await clientState(name);
      if (state === "ready") readyAt.set(name, (Date.now() - started) / 1000);
      else if (state !== "blank") blankSince.delete(name);
      else if (!blankSince.has(name)) blankSince.set(name, Date.now());
      else if (Date.now() - blankSince.get(name) > blankReloadSeconds * 1000) {
        log(`${name}: page loaded but the app didn't render; reloading it`);
        reloads.set(name, (reloads.get(name) ?? 0) + 1);
        blankSince.delete(name);
        await cdpEval(name, "setTimeout(() => location.reload(), 10), true");
      }
    }));
    if (readyAt.size < names.length) await sleep(1000);
  }
  return readyAt;
}

async function main() {
  const options = parseArgs();
  const { n, topology } = options;
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(root, "results"), { recursive: true });

  // Always from a clean slate: fresh profiles, fresh networks.
  run("bash", [path.join(root, "down.sh"), "--quiet"], { allowFail: true });

  const relay = await relays();
  log(`appId "${relay.appId}" relays: ${relay.selected.join(", ")}`);
  ensureCerts(relay.all);
  const id = sourceId();
  if (options.build || run("podman", ["image", "exists", "mwt-app"], { allowFail: true, quiet: true }).status !== 0) buildImage(id);
  const swarm = options.nodes > 0 || options.bots > 0;
  if (swarm && (options.build || run("podman", ["image", "exists", "mwt-node"], { allowFail: true, quiet: true }).status !== 0)) buildNodeImage(id);
  const imageSha = run("podman", ["image", "inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", "mwt-app"]).stdout
    .split("\n").find((l) => l.startsWith("MWT_GIT_SHA="))?.slice("MWT_GIT_SHA=".length) ?? "unknown";

  const lanSets = assign(n, topology);
  const lans = Object.keys(lanIndex).filter((lan) => lanSets.some((set) => set.includes(lan)));
  const isLan = topology === "lan";
  const isPublic = topology === "public" || isLan;
  const turn = options.turn;

  for (const lan of lans) {
    run("podman", ["network", "create", ...(lan === "mwt-pub" ? [] : ["--internal"]), "--subnet", `10.231.${lanIndex[lan]}.0/24`, lan]);
  }
  if (!isPublic) run("podman", ["network", "create", "--internal", "--subnet", `10.231.${infraIndex}.0/24`, infraNet]);
  const vitePort = isLan ? lanVitePort : 1420;

  const netArgs = (nets, host) => nets.flatMap((net) => ["--network", `${net}:ip=${ip(net, host)}`]);
  const turnUrls = lans.map((lan) => `turn:${ip(lan, hosts.coturn)}:3478?transport=udp`);
  const turnJson = turn ? JSON.stringify({ iceServers: [{ urls: turnUrls, username: turnUser, credential: turnSecret }], ttl: 86400 }) : null;
  fs.writeFileSync(path.join(runDir, "Caddyfile"), caddyfile(relay.selected, turnJson));

  if (!isPublic) {
    for (let i = 0; i < relay.selected.length; i++) {
      run("podman", ["run", "-d", "--name", `mwt-relay${i + 1}`, "--label", "mwt.role=relay", ...netArgs([infraNet], 21 + i),
        "-v", `${path.join(here, "strfry.conf")}:/etc/strfry.conf:ro,z`, "--tmpfs", "/app/strfry-db", relayImage]);
    }
  }
  if (turn) {
    // Not through the image's entrypoint: it runs every argument through `eval echo`, which eats "-n".
    run("podman", ["run", "-d", "--name", "mwt-coturn", "--label", "mwt.role=coturn", ...netArgs(lans, hosts.coturn),
      "--entrypoint", "turnserver", coturnImage, "-n", "--log-file=stdout", "--simple-log", "--listening-port=3478", "--fingerprint", "--lt-cred-mech",
      `--user=${turnUser}:${turnSecret}`, "--realm=mwt.test", "--no-tls", "--no-dtls", "--no-cli",
      `--relay-ip=${ip(lans[0], hosts.coturn)}`, "--min-port=49160", "--max-port=49999", "--no-multicast-peers"]);
  }
  if (!isLan) run("podman", ["run", "-d", "--name", "mwt-caddy", "--label", "mwt.role=caddy",
    ...netArgs(isPublic ? lans : [infraNet, ...lans], hosts.caddy),
    "-v", `${path.join(runDir, "Caddyfile")}:/etc/caddy/Caddyfile:ro,z`, "-v", `${certDir}:/certs:ro,z`, caddyImage]);
  // Old clients (--old) load the old source from their own Vite.
  const old = Math.min(Math.max(options.old || 0, 0), n);
  if (old > 0 && run("podman", ["image", "exists", oldImage], { allowFail: true, quiet: true }).status !== 0) {
    throw new Error(`--old needs the image ${oldImage}`);
  }
  const vites = [["mwt-vite", "mwt-app", hosts.vite], ...(old > 0 ? [["mwt-vite-old", oldImage, hosts.viteOld]] : [])];
  for (const [name, image, host] of vites) {
    run("podman", ["run", "-d", "--name", name, "--label", "mwt.role=vite",
      ...(isLan ? ["--network", "host", "-e", `VITE_PORT=${vitePort}`, "-e", "VITE_HOST=127.0.0.1"] : netArgs(lans, host)),
      // On the host's network no TURN stub: the app's request fails at once and it goes on without TURN.
      "-e", `VITE_TURN_URL=${isLan ? "http://127.0.0.1:9/" : `https://${turnStubHost}/`}`, image, "vite"]);
  }

  // Every module transformed and the dependencies optimized before the first client loads the page.
  for (const [name] of vites) {
    const viteStart = Date.now();
    for (;;) {
      const probe = await runAsync("podman", ["exec", name, "curl", "-sf", "-o", "/dev/null", `http://127.0.0.1:${vitePort}/`]);
      if (probe.status === 0) break;
      if (Date.now() - viteStart > 60_000) throw new Error(`${name} not answering:\n${run("podman", ["logs", "--tail", "40", name], { allowFail: true }).stdout}`);
      await sleep(300);
    }
    const warm = await runAsync("podman", ["exec", name, "node", "/mwt-tools/warm-vite.mjs", `http://127.0.0.1:${vitePort}`]);
    if (warm.status !== 0) throw new Error(`warming ${name} failed: ${warm.stderr || warm.stdout}`);
    log(`${name}: ${warm.stdout.trim()}; ready after ${((Date.now() - viteStart) / 1000).toFixed(1)} s`);
  }

  const clients = lanSets.map((set, i) => {
    const index = i + 1;
    const name = `mwt-client${pad(index)}`;
    const home = set[0];
    const caddy = isLan ? null : ip(home, hosts.caddy);
    if (isLan) cdpPorts.set(name, lanCdpPort(index));
    const rules = isLan ? [] : isPublic
      ? [`MAP ${turnStubHost} ${caddy}`]
      : [...relay.selected.map((host) => `MAP ${host} ${caddy}`), `MAP ${turnStubHost} ${caddy}`, "MAP * ~NOTFOUND", "EXCLUDE localhost"];
    const isOld = index > n - old;
    if (isLan) {
      return { name, index, lans: set, ips: { host: "127.0.0.1" }, cdp: `http://127.0.0.1:${lanCdpPort(index)}`, hostRules: "", viteAddr: "", image: "mwt-app" };
    }
    return {
      name, index, lans: set,
      ips: Object.fromEntries(set.map((lan) => [lan, ip(lan, clientHost(index))])),
      cdp: `http://${ip(home, clientHost(index))}:9223`,
      hostRules: rules.join(","),
      viteAddr: ip(home, isOld ? hosts.viteOld : hosts.vite),
      image: isOld ? oldImage : "mwt-app",
    };
  });
  // IPv6 off: the container's link-local address leaves DAD ("tentative") a second or two after start, Chromium sees
  // a network change and aborts every request in flight, and the first page load ends up blank about half the time.
  // The test networks are IPv4 only anyway.
  const startClient = (c) => run("podman", ["run", "-d", "--name", c.name, "--hostname", c.name, "--label", "mwt.role=client",
    "--shm-size=1g",
    // The host's network: its own settings stay as they are (no sysctl).
    ...(isLan
      ? ["--network", "host", "-e", "MWT_HOST_NET=1", "-e", `MWT_DISPLAY_NUM=${lanDisplay(c.index)}`, "-e", `MWT_CDP_PORT=${lanCdpPort(c.index)}`, "-e", `MWT_VITE_PORT=${vitePort}`]
      : ["--sysctl", "net.ipv6.conf.all.disable_ipv6=1", "--sysctl", "net.ipv6.conf.default.disable_ipv6=1", ...netArgs(c.lans, clientHost(c.index))]),
    "-v", `mwt-profile-${pad(c.index)}:/profile`, "-v", `mwt-home-${pad(c.index)}:/home/test`,
    "-v", `${path.join(certDir, "ca.crt")}:/certs/ca.crt:ro,z`,
    "-e", `VITE_ADDR=${c.viteAddr}`, "-e", `HOST_RULES=${c.hostRules}`, "-e", `MWT_CLIENT=${c.name}`,
    "-e", `ELECTRON_ENABLE_LOGGING=${process.env.MWT_ELECTRON_LOGGING ?? "1"}`,
    ...(process.env.MWT_ELECTRON_ARGS ? ["-e", `MWT_ELECTRON_ARGS=${process.env.MWT_ELECTRON_ARGS}`] : []),
    c.image, "client"]);

  // Nodes and bots sit on the first LAN and resolve the relay hosts to Caddy there.
  const swarmLan = lans[0];
  const relayHostArgs = isPublic ? [] : relay.selected.flatMap((host) => ["--add-host", `${host}:${ip(swarmLan, hosts.caddy)}`]);
  const lanBotPort = (j) => botPort + 20 * j;
  const nodes = Array.from({ length: options.nodes }, (_, k) => {
    const address = ip(swarmLan, nodeHost(k + 1));
    return { name: `mwt-node${k + 1}`, container: `mwt-node${k + 1}`, ip: address, url: `http://${address}:8080`, lan: swarmLan };
  });
  const botGroups = Array.from({ length: options.bots > 0 ? Math.ceil(options.bots / options.botsPer) : 0 }, (_, j) => {
    const base = j * options.botsPer + 1;
    const count = Math.min(options.botsPer, options.bots - j * options.botsPer);
    return isLan
      ? { container: `mwt-bots${pad(j + 1)}`, ip: "127.0.0.1", base, count, port: lanBotPort(j) }
      : { container: `mwt-bots${pad(j + 1)}`, ip: ip(swarmLan, botsHost(j + 1)), base, count, port: botPort };
  });
  const bots = botGroups.flatMap((g) => Array.from({ length: g.count }, (_, i) => ({
    name: `bot${String(g.base + i).padStart(3, "0")}`, container: g.container, url: `http://${g.ip}:${g.port + i}`,
  })));
  const swarmEnv = ["-v", `${path.join(certDir, "ca.crt")}:/certs/ca.crt:ro,z`, "-e", "NODE_EXTRA_CA_CERTS=/certs/ca.crt", ...relayHostArgs];
  const startNode = (node, k) => run("podman", ["run", "-d", "--init", "--name", node.container, "--hostname", node.container,
    "--label", "mwt.role=node", "--sysctl", "net.ipv6.conf.all.disable_ipv6=1", "--network", `${swarmLan}:ip=${node.ip}`,
    "-v", `mwt-node-data-${k + 1}:/data`, ...swarmEnv,
    "-e", `NODE_IP=${node.ip}`, "-e", `MWT_NODE=${node.name}`, "-e", `SENDERS=${options.senders}`,
    "-e", `HEAL_AFTER=${options.healAfter}`, "-e", `RTC_PORTS=${options.rtcPorts}`,
    ...(options.minStripeMb > 0 ? ["-e", `MAKEWORK_TEST_MIN_STRIPE_MB=${options.minStripeMb}`] : []), "mwt-node", "node"]);
  const startBots = (g) => run("podman", ["run", "-d", "--init", "--name", g.container, "--hostname", g.container, "--label", "mwt.role=bots",
    ...(isLan ? ["--network", "host", "-e", `BOT_PORT=${g.port}`, "-e", "BOT_HOST=127.0.0.1"] : ["--sysctl", "net.ipv6.conf.all.disable_ipv6=1", "--network", `${swarmLan}:ip=${g.ip}`]),
    ...swarmEnv, "-e", `BOTS=${g.count}`, "-e", `BOT_BASE=${g.base}`, "mwt-node", "bots"]);

  const socket = await podmanSocket();
  const reloads = new Map();
  const topologyJson = (readyAt) => ({
    topology, n, turn, lans,
    subnets: Object.fromEntries(lans.map((lan) => [lan, `10.231.${lanIndex[lan]}.0/24`])),
    infra: {
      relayHosts: relay.selected,
      caddy: Object.fromEntries(lans.map((lan) => [lan, ip(lan, hosts.caddy)])),
      vite: Object.fromEntries(lans.map((lan) => [lan, ip(lan, hosts.vite)])),
      coturn: turn ? Object.fromEntries(lans.map((lan) => [lan, ip(lan, hosts.coturn)])) : null,
      turnUrl: `https://${turnStubHost}/`,
      turnServers: turn ? { urls: turnUrls, username: turnUser, credential: turnSecret } : null,
    },
    clients: clients.map(({ name, index, lans: set, ips, cdp, hostRules, image }) => ({
      name, index, lans: set, ips, cdp, hostRules, image, readyAfterSeconds: readyAt?.get(name) ?? null, startReloads: reloads.get(name) ?? 0,
    })),
    nodes, bots, healAfterMin: options.healAfter, minStripeMb: options.minStripeMb || null,
    harnessIps: Object.fromEntries(lans.map((lan) => [lan, ip(lan, hosts.harness)])),
    // The harness joins the host's network too (run-scenario.sh).
    hostNetwork: isLan,
    podmanSocket: socket,
    app: { image: "mwt-app", gitSha: imageSha },
    ready: Boolean(readyAt),
    createdAt: new Date().toISOString(),
  });
  const topologyFile = path.join(runDir, "topology.json");
  fs.writeFileSync(topologyFile, JSON.stringify(topologyJson(null), null, 2));

  // The first client warms Vite's transform cache; the rest start together (staggered a little).
  const t0 = Date.now();
  startClient(clients[0]);
  const first = await waitReady([clients[0].name], options.timeout, reloads);
  log(`${clients[0].name} ready after ${first.get(clients[0].name).toFixed(1)} s`);
  for (const c of clients.slice(1)) {
    startClient(c);
    if (options.stagger > 0) await sleep(options.stagger);
  }
  const rest = clients.length > 1 ? await waitReady(clients.slice(1).map((c) => c.name), options.timeout, reloads) : new Map();
  const readyAt = new Map([...first, ...rest]);

  // Nodes and bots after the clients, so their start doesn't compete with the clients' page loads.
  if (swarm) {
    const swarmStart = Date.now();
    nodes.forEach((node, k) => startNode(node, k));
    botGroups.forEach(startBots);
    for (;;) {
      const nodesUp = nodes.every((node) => run("podman", ["logs", node.container], { allowFail: true, quiet: true }).stdout.includes("Watching"));
      const botsUp = (await Promise.all(botGroups.map((g) => botsAnswer(g.container, Array.from({ length: g.count }, (_, i) => g.port + i))))).every(Boolean);
      if (nodesUp && botsUp) break;
      for (const c of [...nodes.map((x) => x.container), ...botGroups.map((g) => g.container)]) {
        const status = run("podman", ["inspect", "-f", "{{.State.Status}}", c], { allowFail: true, quiet: true }).stdout.trim();
        if (status === "exited") throw new Error(`${c} exited during start:\n${run("podman", ["logs", "--tail", "40", c], { allowFail: true }).stderr}`);
      }
      if (Date.now() - swarmStart > options.timeout * 1000) throw new Error("nodes or bots not up in time (podman logs mwt-node1 / mwt-bots01)");
      await sleep(1000);
    }
    log(`${nodes.length} node(s) and ${bots.length} bot(s) up in ${((Date.now() - swarmStart) / 1000).toFixed(1)} s`);
  }
  fs.writeFileSync(topologyFile, JSON.stringify(topologyJson(readyAt), null, 2));
  log(`${n} client(s) ready in ${((Date.now() - t0) / 1000).toFixed(1)} s (${topology}${turn ? "" : ", no TURN"}); wrote ${path.relative(process.cwd(), topologyFile)}`);
  for (const c of clients) log(`  ${c.name}  ${c.lans.join("+").padEnd(20)} ${c.cdp}`);
  for (const node of nodes) log(`  ${node.name}  ${node.lan.padEnd(20)} ${node.url}`);
  if (bots.length) log(`  ${bots.length} bots in ${botGroups.length} container(s), ${bots[0].url} ... ${bots.at(-1).url}`);
}

main().catch((e) => {
  console.error(`[up] ${e.message}`);
  process.exit(1);
});
