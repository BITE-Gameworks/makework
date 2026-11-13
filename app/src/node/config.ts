// A node's settings and its servers, in <data>/node.json. The command line changes the file; a running node watches it
// and starts or stops hosting servers to match, so `host` works whether or not the node is running.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GeoMode } from "./geo";

// A workspace this node hosts, added by a member with "Manage nodes" pairing with it (p2p/pair.ts). Entries from
// before pairing also have the invite they were hosted with (`token`) and their page path (`link`): both unused now,
// the node is part of the workspace through its row and the page path is set in Workspace settings > Nodes.
export interface HostedEntry {
  id: string;
  secret: string;
  v?: 2 | 3;
  generation?: number;
  recoverySecrets?: string[];
  // This node's replica in the server, new each time it starts hosting it (as with a member's join).
  replica: string;
  // The account that added the node to the workspace.
  addedBy?: string;
}

export interface NodeConfig {
  port: number;
  // Where the web server is reached from outside, for the links shown in Server settings > Nodes.
  url: string;
  // This node's public address; found through STUN when empty.
  address: string;
  // How members sharing their location are placed (geo.ts); "off" never downloads a GeoIP database.
  geoip: GeoMode;
  // At most this many members are sent file content at once, per hosted server (the number adapts below it, see
  // p2p/stream.ts). Each holds one 4 MiB chunk in memory and shares the upload.
  senders: number;
  // At most this many members' new uploads are taken at once, for all hosted workspaces together (they share the
  // downlink): each uploader is one lane, one file at a time, the others wait in line (node/host.ts `lanes`).
  receivers: number;
  // Room for files this node doesn't keep (p2p/placement.ts) but fetched for a member or still has: the oldest go
  // first past this many GB.
  cacheGb: number;
  // Minutes before a node not reached counts as gone and the other nodes copy its files (self-healing).
  healAfterMin: number;
  // Where the links between nodes serving one call (sfuBridge.ts) take their UDP ports from: mediasoup's range. Both
  // keep their defaults (mediasoup picks when a direction is missing) but a firewall usually asks for one explicit range.
  rtcMinPort?: number;
  rtcMaxPort?: number;
  // The one port (UDP and TCP) members send call media to, so a node behind a router forwards one port; the range
  // above is then only for the links between nodes. Defaults to the range's first port (`mediaPort`).
  rtcPort?: number;
  // Opens the room members add this node from: half of the node's code (p2p/pair.ts), made on first start; `code --new`
  // makes another, and the old code stops working.
  pairSecret?: string;
  servers: HostedEntry[];
}

export const defaultConfig: NodeConfig = {
  port: 8080, url: "", address: "", geoip: "country", senders: 32, receivers: 8, cacheGb: 2, healAfterMin: 15, servers: [],
};

export function dataDir(fromArgs?: string): string {
  return fromArgs || process.env.MAKEWORK_NODE_DATA || join(homedir(), ".makework-node");
}

export const configFile = (dir: string) => join(dir, "node.json");

export async function readConfig(dir: string): Promise<NodeConfig> {
  try {
    const config = JSON.parse(await readFile(configFile(dir), "utf8")) as Partial<NodeConfig>;
    return {
      ...defaultConfig, ...config,
      servers: (config.servers ?? []).map((entry) => {
        const recoverySecrets = [...new Set((entry.recoverySecrets ?? [])
          .filter((secret) => typeof secret === "string" && secret !== entry.secret))];
        return { ...entry, v: 3 as const, ...(recoverySecrets.length ? { recoverySecrets } : {}) };
      }),
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ...defaultConfig, servers: [] };
    throw new Error(`${configFile(dir)} can't be read: ${(e as Error).message}`);
  }
}

// Written to a temporary file first, so a running node never reads half a file.
export async function writeConfig(dir: string, config: NodeConfig): Promise<void> {
  await mkdir(dir, { recursive: true });
  const temp = `${configFile(dir)}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, configFile(dir));
}

export async function updateConfig(dir: string, change: (config: NodeConfig) => NodeConfig | void): Promise<NodeConfig> {
  const config = await readConfig(dir);
  const next = change(config) ?? config;
  await writeConfig(dir, next);
  return next;
}

export function randomId(): string {
  return randomBytes(16).toString("base64url");
}

// The node's own key pair (PKCS#8, as for an account), made on first start. Its id is the node's account id.
export async function nodeKeyPkcs8(dir: string): Promise<Uint8Array<ArrayBuffer>> {
  const file = join(dir, "key.json");
  try {
    const stored = JSON.parse(await readFile(file, "utf8")) as { pkcs8: string };
    return new Uint8Array(Buffer.from(stored.pkcs8, "base64url"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify({ pkcs8: pkcs8.toString("base64url") }), { mode: 0o600 });
  return new Uint8Array(pkcs8);
}

// `--rtc-ports a-b`: the UDP range calls through the node use (opened in the firewall). Only a whole range of whole
// ports is taken; a single number or a typo used to pass and save half a range, so mediasoup used ports nobody opened.
export function parseRtcPorts(text: string): { min: number; max: number } {
  const match = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(text);
  const [min, max] = match ? [Number(match[1]), Number(match[2])] : [Number.NaN, Number.NaN];
  if (!(min >= 1 && max <= 65535 && min <= max)) throw new Error("--rtc-ports wants a range like 20000-49999.");
  return { min, max };
}

// `--rtc-port N`: the port members' call media comes in on, UDP and TCP.
export function parseRtcPort(text: string): number {
  const port = /^\s*\d+\s*$/.test(text) ? Number(text) : Number.NaN;
  if (!(port >= 1 && port <= 65535)) throw new Error("--rtc-port wants a port like 40000.");
  return port;
}

// Inside mediasoup's default range (10000-59999), so a firewall opened for that range already lets it in.
export const defaultRtcPort = 40000;

// The port members' media comes in on: the saved one, else the first of the saved range (whoever opened the range for
// the old random ports opened it too), else defaultRtcPort.
export function mediaPort(config: Pick<NodeConfig, "rtcPort">, range: { min: number } | null): number {
  if (config.rtcPort === undefined) return range?.min ?? defaultRtcPort;
  if (!(Number.isInteger(config.rtcPort) && config.rtcPort >= 1 && config.rtcPort <= 65535)) {
    throw new Error(`node.json has rtcPort ${config.rtcPort}: set it with --rtc-port, like 40000.`);
  }
  return config.rtcPort;
}

// The range saved in node.json, checked when the node starts (an older check could save half a range); null when none
// is set (mediasoup then takes any free port).
export function savedRtcPorts(config: Pick<NodeConfig, "rtcMinPort" | "rtcMaxPort">): { min: number; max: number } | null {
  if (config.rtcMinPort === undefined && config.rtcMaxPort === undefined) return null;
  try {
    return parseRtcPorts(`${config.rtcMinPort ?? ""}-${config.rtcMaxPort ?? ""}`);
  } catch {
    throw new Error(`node.json has rtcMinPort ${config.rtcMinPort ?? "(none)"} and rtcMaxPort ${config.rtcMaxPort ?? "(none)"}: set both with --rtc-ports, like 20000-49999.`);
  }
}
