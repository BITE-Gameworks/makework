// MakeWork node: a headless member that hosts servers, keeps all of their files and serves them to members, and shows
// invite pages. Built with `npm run build:node` into dist-node/; run `node dist-node/makework-node.mjs <command>`
// (`npm run node -- <command>` during development).
import { watch } from "node:fs";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { setMaxListeners } from "node:events";
import { RTCPeerConnection } from "werift";
import { joinRoom, type Room } from "trystero";
import { accountId, importAgreementKey, importPrivateKey } from "../core/identity";
import type { Place } from "../p2p/nodes";
import { listenForPairing, nodeCode, pairRoom, type HostOffer } from "../p2p/pair";
import { syncScheduler } from "../p2p/syncQueue";
import {
  configFile, dataDir, mediaPort, nodeKeyPkcs8, parseRtcPort, parseRtcPorts, randomId, savedRtcPorts, readConfig, updateConfig,
  type HostedEntry, type NodeConfig,
} from "./config";
import { GeoIp } from "./geo";
import { HostedServer, fetchScheduler, type FileCounts, type NodeIdentity } from "./host";
import { fileCommits, fileContent } from "./storage";
import { openMediasoupWorker, sharedWorker } from "./sfu";
import { startWeb } from "./web";
import { trimEnd } from "../core/text";

const usage = `MakeWork node

  start [--port 8080] [--url https://example.com] [--address IP] [--geoip country|off] [--senders 32]
        [--receivers 8] [--cache-gb 2] [--heal-after 15] [--rtc-port 40000] [--rtc-ports 20000-49999]
        Runs the node and prints its code. The options are saved for the next start.
  code [--new]
        Prints the node's code: paste it in Workspace settings > Nodes > Add a node to have this node host that
        workspace. --new makes another code; the old one stops working.
  unhost <workspace>
        Stops hosting a workspace and deletes this node's copy of its history.
  list
        The hosted workspaces and what the running node last reported about them.

  --data DIR    where the node keeps its data (default ~/.makework-node, or MAKEWORK_NODE_DATA)
  <workspace> is a workspace id or the start of one.
`;

const addHint = "Add the node in Workspace settings > Nodes > Add a node, with its code (run `code`).";

type Flags = Record<string, string | true>;

function parseArgs(argv: string[]): { command: string; args: string[]; flags: Flags } {
  const args: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split("=", 2);
    if (inline !== undefined) flags[name] = inline;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) flags[name] = argv[++i];
    else flags[name] = true;
  }
  return { command: args.shift() ?? "help", args, flags };
}

function findServer(config: NodeConfig, which: string | undefined) {
  if (!which) throw new Error("Which workspace? Give its id or the start of it.");
  const found = config.servers.filter((s) => s.id === which || s.id.startsWith(which));
  if (found.length !== 1) throw new Error(found.length ? `"${which}" matches more than one workspace.` : `No hosted workspace "${which}".`);
  return found[0];
}

// The node's code (p2p/pair.ts): its account id and the secret of the room members add it from.
async function codeOf(dir: string, renew = false): Promise<string> {
  const identity = await loadIdentity(dir);
  const config = await updateConfig(dir, (next) => {
    if (renew || !next.pairSecret) next.pairSecret = randomId();
  });
  return nodeCode({ id: identity.id, secret: config.pairSecret! });
}

async function main() {
  const { command, args, flags } = parseArgs(process.argv.slice(2));
  const dir = dataDir(typeof flags.data === "string" ? flags.data : undefined);
  switch (command) {
    case "start":
      return start(dir, flags);
    case "code": {
      const code = await codeOf(dir, flags.new === true);
      console.log(flags.new === true ? `New code (the old one no longer works):\n${code}` : code);
      return;
    }
    // Before 2026-10-16 a node was given an invite code and asked to be authorized; now a member adds it.
    case "host":
      throw new Error(`Nodes don't take invite codes any more. ${addHint}`);
    case "link":
      throw new Error("A node's invite page is set in Workspace settings > Nodes now.");
    case "unhost": {
      let id = "";
      await updateConfig(dir, (config) => {
        id = findServer(config, args[0]).id;
        config.servers = config.servers.filter((s) => s.id !== id);
      });
      await fileCommits(dir).forget(id);
      console.log(`No longer hosting ${id}.`);
      return;
    }
    case "list":
      return list(dir);
    default:
      console.log(usage);
  }
}

async function list(dir: string) {
  const config = await readConfig(dir);
  const status = await readFile(join(dir, "status.json"), "utf8").then((t) => JSON.parse(t) as Status, () => null);
  const running = status && Date.now() - status.at < 30_000;
  console.log(running ? `Running since ${new Date(status.started).toLocaleString()}, address ${status.address || "unknown"}.` : "Not running.");
  if (running && status.sync)
    console.log(`Catching members up: ${status.sync.active} sending, ${status.sync.queued} waiting, up to ${status.sync.limit} at once.`);
  if (running && status.uploads && status.uploads.active + status.uploads.queued > 0)
    console.log(`Taking new uploads from ${status.uploads.active} members, ${status.uploads.queued} waiting, up to ${status.uploads.limit} at once.`);
  if (config.servers.length === 0) console.log(`No workspaces hosted. ${addHint}`);
  for (const s of config.servers) {
    const info = running ? status.servers[s.id] : undefined;
    const page = info?.page ? (config.url ? `${trimEnd(config.url, "/")}/${info.page}` : `/${info.page}`) : "no invite page";
    console.log(`\n${info?.name || "(name not known yet)"}  ${s.id}\n  page: ${page}${s.addedBy ? `\n  added by account ${s.addedBy}` : ""}`);
    if (info) {
      const state = info.status === "joining" ? "not in the workspace (removed, or not caught up yet; `unhost` deletes its copy)" : info.status;
      console.log(`  ${state}, ${info.members} members, ${info.online} online, ${info.commits} commits`);
      console.log(`  files: ${info.kept} kept here, ${info.missing} still to fetch, ${info.cached ?? 0} cached, ${info.below ?? 0} with fewer copies than asked`
        + (info.pieces ? `, ${info.pieces} pieces` : ""));
    }
  }
}

type Status = {
  at: number; started: number; address: string; place: Place | null;
  // Absent in status files written before it existed.
  sync?: { queued: number; active: number; limit: number };
  // The uploaders new files are being taken from (host.ts `lanes`), and those waiting for a place.
  uploads?: { queued: number; active: number; limit: number };
  servers: Record<string, { name: string; status: string; members: number; online: number; commits: number; page?: string; calls?: ReturnType<HostedServer["callsStatus"]> } & FileCounts>;
};

async function start(dir: string, flags: Flags) {
  // werift's data channels are EventEmitters (warning past 10 listeners per event) and Trystero adds a few to a
  // channel for each send waiting for it to drain. Sync sends one batch at a time per member (p2p/sync.ts), but a
  // member also gets presence, mesh lists and file chunks: room for bursts, while a real leak still warns.
  setMaxListeners(100);
  const config0 = await updateConfig(dir, (config) => {
    if (typeof flags.port === "string") config.port = Number(flags.port) || config.port;
    if (typeof flags.url === "string") config.url = trimEnd(flags.url, "/");
    if (typeof flags.address === "string") config.address = flags.address;
    if (flags.geoip === "off" || flags.geoip === "country") config.geoip = flags.geoip;
    if (typeof flags.senders === "string") config.senders = Math.max(1, Math.min(500, Math.round(Number(flags.senders)) || config.senders));
    if (typeof flags.receivers === "string") config.receivers = Math.max(1, Math.min(500, Math.round(Number(flags.receivers)) || config.receivers));
    if (typeof flags["cache-gb"] === "string") config.cacheGb = Math.max(0, Number(flags["cache-gb"]) || 0);
    if (typeof flags["heal-after"] === "string") config.healAfterMin = Math.max(0.1, Number(flags["heal-after"]) || config.healAfterMin);
    if (typeof flags["rtc-ports"] === "string") {
      const { min, max } = parseRtcPorts(flags["rtc-ports"]);
      config.rtcMinPort = min;
      config.rtcMaxPort = max;
    }
    if (typeof flags["rtc-port"] === "string") config.rtcPort = parseRtcPort(flags["rtc-port"]);
  });
  const identity = await loadIdentity(dir);
  const commits = fileCommits(dir);
  const content = fileContent(dir);
  const geo = new GeoIp(dir, config0.geoip === "off" ? "off" : "country");
  const started = Date.now();
  let config = config0;
  console.info(`MakeWork node ${identity.id.slice(0, 8)}, data in ${dir}`);

  await geo.update();
  setInterval(() => void geo.update(), 24 * 3_600_000);
  const address = config.address || (await publicAddress()) || "";
  const place = await geo.lookup(address);
  geo.release();
  console.info(`Address ${address || "unknown"}${place ? ` (${[place.city, place.country].filter(Boolean).join(", ")})` : ""}`);

  const hosted = new Map<string, HostedServer>();
  const describe = () => ({ address, url: config.url, place });
  // One mediasoup worker for every hosted server (started with the first call, again after it died).
  // A range saved by an older check is checked again now: half a range would have mediasoup use ports nobody opened.
  const rtcPorts = savedRtcPorts(config0);
  // Members' media comes in on one port, at the public address and, behind a router, at the LAN address too (members
  // on the node's own network can't reach it through the public one without NAT hairpinning). An address of this
  // machine itself (a VPS, mesh-test's containers) is no router's: the port listens everywhere then, since the route
  // out may leave over another interface than the one the address is on.
  const route = await routeAddress();
  const behindRouter = !!address && !ownAddresses().includes(address);
  const media = { port: mediaPort(config0, rtcPorts), address, lanAddress: behindRouter ? route : null };
  const lan = media.lanAddress && media.lanAddress !== address ? `, and at ${media.lanAddress} on this network` : "";
  console.info(`Call media on port ${media.port} (UDP and TCP)${lan}.`);
  const sfuWorker = sharedWorker(() => openMediasoupWorker({ rtcMinPort: rtcPorts?.min, rtcMaxPort: rtcPorts?.max, media }));
  // One queue for every hosted workspace: the uploaders they take new files from share the downlink.
  const fetches = fetchScheduler(config.receivers);
  const context = {
    identity, commits, content, senders: config.senders, fetches, healAfterMs: config.healAfterMin * 60_000,
    lanAddress: media.lanAddress,
    wantedElsewhere: (hash: string, here: HostedServer) => [...hosted.values()].some((s) => s !== here && s.wanted().has(hash)),
    updateEntry: async (entry: HostedEntry) => {
      config = await updateConfig(dir, (next) => {
        const index = next.servers.findIndex((server) => server.id === entry.id);
        if (index >= 0) next.servers[index] = { ...next.servers[index], ...entry };
      });
    },
    openSfu: () => sfuWorker.get(),
  };

  let reconciling: Promise<void> = Promise.resolve();
  const reconcile = () => (reconciling = reconciling.then(async () => {
    config = await readConfig(dir).catch((e) => {
      console.warn((e as Error).message);
      return config;
    });
    const wanted = new Map(config.servers.map((s) => [s.id, s]));
    for (const [id, server] of hosted) {
      if (wanted.has(id)) continue;
      hosted.delete(id);
      await server.close();
      console.info(`Stopped hosting ${server.name() || id}.`);
    }
    for (const entry of wanted.values()) {
      if (hosted.has(entry.id)) continue;
      try {
        hosted.set(entry.id, await HostedServer.open(entry, context, describe));
        console.info(`Hosting ${entry.id}.`);
      } catch (e) {
        console.warn(`Workspace ${entry.id} not opened:`, (e as Error).message);
      }
    }
    if (config.pairSecret !== pairing.secret) pairing.start(config.pairSecret);
  }));

  // Members add this node to their workspaces from its code (p2p/pair.ts): it waits in its room, and `code --new`
  // moves it to a new one.
  const pairing = {
    secret: undefined as string | undefined,
    room: null as Room | null,
    start(secret: string | undefined) {
      void this.room?.leave();
      this.room = null;
      this.secret = secret;
      if (!secret) return;
      const code = { id: identity.id, secret };
      const { roomId, config: roomConfig } = pairRoom(code);
      this.room = joinRoom({ ...roomConfig, rtcPolyfill: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection }, roomId);
      listenForPairing(this.room, { ...identity, key: identity.key }, (offer) => host(offer));
      console.info(`Node code (Workspace settings > Nodes > Add a node):\n  ${nodeCode(code)}`);
    },
  };
  const host = async (offer: HostOffer) => {
    await updateConfig(dir, (next) => {
      const existing = next.servers.find((s) => s.id === offer.workspace);
      if (!existing) {
        next.servers.push({
          id: offer.workspace, secret: offer.secret, v: 3, generation: offer.generation, recoverySecrets: offer.recoverySecrets,
          replica: randomId(), addedBy: offer.addedBy,
        });
        return;
      }
      // Added again: it keeps following the workspace's secret itself; a newer one from the member is taken.
      existing.addedBy = offer.addedBy;
      if ((existing.generation ?? 0) < offer.generation) {
        existing.recoverySecrets = [...new Set([...(existing.recoverySecrets ?? []), existing.secret, ...offer.recoverySecrets])]
          .filter((secret) => secret !== offer.secret);
        existing.secret = offer.secret;
        existing.generation = offer.generation;
      }
    });
    console.info(`Added to ${offer.name || offer.workspace} by account ${offer.addedBy}.`);
  };
  await codeOf(dir);
  await reconcile();

  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(dir, (_event, name) => {
    if (name !== "node.json") return;
    clearTimeout(timer);
    timer = setTimeout(() => void reconcile(), 300);
  });

  // A page per hosted workspace, at the path a member set on this node's row; two workspaces with one path: the first.
  startWeb(config.port, (link) => {
    const server = [...hosted.values()].find((s) => s.page() === link);
    if (!server || server.ledger.owner === null) return null;
    return {
      name: server.name(), icon: server.icon(), color: server.color(), members: server.memberCount(), online: server.sync.peers(),
      invite: server.pageInvite(),
      node: String(server.ledger.select("members", "members_profiles", { user_id: server.ledger.me })[0]?.display_name || "a MakeWork node"),
    };
  });

  const writeStatus = async () => {
    const servers: Status["servers"] = {};
    for (const [id, s] of hosted)
      servers[id] = {
        name: s.name(), status: s.status(), members: s.memberCount(), online: s.sync.peers(), commits: s.ledger.log().length, ...(await s.counts()),
        page: s.page(), calls: s.callsStatus(),
      };
    const status: Status = { at: Date.now(), started, address, place, sync: syncScheduler.stats(), uploads: fetches.stats(), servers };
    await writeFile(join(dir, "status.json"), JSON.stringify(status, null, 2)).catch(() => {});
  };
  setInterval(() => void writeStatus(), 10_000);
  void writeStatus();
  // Soon after the start too: a node restarted more often than hourly never cleaned up, and what was deleted for good
  // while it was off goes then.
  setTimeout(() => void prune(dir, hosted, config.cacheGb), 600_000);
  setInterval(() => void prune(dir, hosted, config.cacheGb), 3_600_000);

  const stop = async () => {
    console.info("Stopping...");
    for (const server of hosted.values()) await server.close().catch(() => {});
    sfuWorker.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  // A failed send to one member must not stop every server hosted here.
  process.on("unhandledRejection", (e) => console.warn("Unhandled failure:", e));
  console.info(`Watching ${configFile(dir)} for workspaces to host.`);
}

// Deletes content no hosted server points at any more, once every server's data is here, and the oldest cached
// files (ones this node doesn't keep by placement) past `cacheGb`.
async function prune(dir: string, hosted: Map<string, HostedServer>, cacheGb: number) {
  const servers = [...hosted.values()];
  if (servers.some((s) => s.ledger.owner === null)) return;
  const wanted = new Set<string>();
  const held = new Set<string>();
  for (const server of servers) {
    for (const hash of server.wanted()) wanted.add(hash);
    for (const hash of server.held()) held.add(hash);
  }
  for (const folder of ["content", "parts"]) {
    const names = await readdir(join(dir, folder)).catch(() => [] as string[]);
    for (const name of names) {
      const hash = name.replace(/\.part$/, "");
      if (/^[0-9a-f]{64}$/.test(hash) && !wanted.has(hash)) await rm(join(dir, folder, name), { force: true });
    }
  }
  const cached: { hash: string; size: number; at: number }[] = [];
  for (const name of await readdir(join(dir, "content")).catch(() => [] as string[])) {
    if (!/^[0-9a-f]{64}$/.test(name) || held.has(name)) continue;
    const info = await stat(join(dir, "content", name)).catch(() => null);
    if (info) cached.push({ hash: name, size: info.size, at: info.mtimeMs });
  }
  let total = cached.reduce((n, c) => n + c.size, 0);
  const removed: string[] = [];
  for (const c of cached.toSorted((a, b) => a.at - b.at)) {
    if (total <= cacheGb * 1024 ** 3) break;
    await rm(join(dir, "content", c.hash), { force: true });
    total -= c.size;
    removed.push(c.hash);
  }
  // Pieces: of files no server points at, or no longer this node's to keep once the nodes keeping them have them.
  const local = await fileContent(dir).pieces();
  const kept = new Set(servers.flatMap((s) => [...s.keptPieces()]));
  const extra = new Set(servers.flatMap((s) => s.extraPieces(local)));
  for (const [hash, keys] of local)
    for (const key of keys)
      if (!kept.has(key) && (!wanted.has(hash) || extra.has(key))) {
        await fileContent(dir).removePiece(key);
        removed.push(key);
      }
  for (const server of servers) server.dropped(removed);
}

async function loadIdentity(dir: string): Promise<NodeIdentity> {
  const pkcs8 = await nodeKeyPkcs8(dir);
  const extractable = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const { x, y } = await crypto.subtle.exportKey("jwk", extractable);
  const key = { x: x!, y: y! };
  return {
    id: await accountId({ crv: "P-256", ...key }), key,
    privateKey: await importPrivateKey(pkcs8, false), agreementKey: await importAgreementKey(pkcs8),
  };
}

const stunServers = [["stun.cloudflare.com", 3478], ["stun.l.google.com", 19302]] as const;

// The addresses of this machine's own network interfaces.
function ownAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((entry) => entry.address));
}

// This machine's own address on its route to the internet (behind a home router, its LAN address): a UDP socket
// connected to a STUN server picks the route without sending anything. Null without a route.
function routeAddress(): Promise<string | null> {
  const socket = createSocket("udp4");
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const done = (address: string | null) => {
      if (settled) return;
      settled = true;
      socket.close();
      resolve(address);
    };
    socket.on("error", () => done(null));
    const [host, port] = stunServers[0];
    socket.connect(port, host, () => {
      try {
        done(socket.address().address);
      } catch {
        done(null);
      }
    });
  });
}

// This machine's address as the internet sees it: a STUN binding request (RFC 5389) to a public STUN server, whose
// answer names the address it came from. Null when no answer came in 5 s.
function publicAddress(): Promise<string | null> {
  const servers = stunServers;
  const socket = createSocket("udp4");
  const transaction = randomBytes(12);
  const request = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42]), transaction]);
  return new Promise<string | null>((resolve) => {
    const done = (address: string | null) => {
      clearTimeout(timer);
      socket.close();
      resolve(address);
    };
    const timer = setTimeout(() => done(null), 5000);
    socket.on("error", () => done(null));
    socket.on("message", (message) => {
      if (message.length < 20 || !message.subarray(8, 20).equals(transaction)) return;
      for (let at = 20; at + 4 <= message.length;) {
        const type = message.readUInt16BE(at);
        const length = message.readUInt16BE(at + 2);
        // XOR-MAPPED-ADDRESS, IPv4: port and address XORed with the magic cookie.
        if (type === 0x0020 && message[at + 5] === 0x01)
          return done([0, 1, 2, 3].map((i) => message[at + 8 + i] ^ [0x21, 0x12, 0xa4, 0x42][i]).join("."));
        at += 4 + Math.ceil(length / 4) * 4;
      }
    });
    for (const [host, port] of servers) socket.send(request, port, host);
  });
}

main().catch((e) => {
  console.error((e as Error).message ?? e);
  process.exit(1);
});
