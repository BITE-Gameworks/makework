// A headless member for the node stress test (scenario s8): the app's own sync code (ledger, WorkspaceSync over werift,
// content streams, node ordering) in plain Node, like a node (app/src/node/host.ts) but never registering as one. It
// joins like the app: with the invite's token (peer authentication, then its profile), and from a workspace's signed
// snapshot when its source has one (the state fetched from peers into its own store, as a node does).
// One member per process (Trystero's peer id is per process); bots.mjs starts several. Bundled by vite.config.mts
// into dist-node/mwt-bot.mjs in the mwt-node image. The harness drives it over HTTP on its LAN address:
//
//   GET  /status?prefixes=<json {serverId: prefix}>   per server: data, commits, online, members, tags seen, content
//   GET  /seen?server=<id>&prefix=<p>                  first-seen times of tagged messages from others, by tag
//   GET  /ledger?server=<id>                           commit count and the digest of the commit set
//   POST /join {invite}  /leave {serverId}  /post {serverId, tags, gapMs}  /fetch {serverId}
import { createHash } from "node:crypto";
import { setMaxListeners } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { RTCPeerConnection } from "werift";
import { selfId } from "trystero";
import { ApiClient } from "@app/api/client";
import { createIdentity } from "@app/core/identity";
import { snapshotLoader } from "@app/core/workspaceSnapshots";
import { MockTransport } from "@app/mock/transport";
import { Ledger, createLedgerBackend, type CommitStore } from "@app/p2p/ledger";
import type { Commit } from "@app/p2p/log";
import { compareCommits } from "@app/p2p/log";
import { parseInvite } from "@app/p2p/invite";
import { NodeLink, groupsFor } from "@app/p2p/nodes";
import { localPlugins, plugins } from "@app/p2p/plugins";
import { workspacePolicy } from "@app/p2p/policy";
import { ContentStreams } from "@app/p2p/stream";
import { WorkspaceSync } from "@app/p2p/sync";
import { loadDeclared } from "@app/system/declared";
import { fileContent } from "@app/node/storage";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : [])).filter((x) => x.length));
const port = Number(args.port ?? 9300);
const name = String(args.name ?? `bot${port}`);
const tagPattern = /mwt\|[A-Za-z0-9_.:|-]+/;

// The same room for listeners as a node (src/node/main.ts): werift's data channels are EventEmitters and Trystero adds a
// few to a channel per send waiting for it to drain, so bursts pass 10; a real leak still passes 100 and warns. Bots
// ran with the default and warned on a busy join (s9, 2026-10-14).
setMaxListeners(100);

// Warnings and failures are part of what the test measures (MaxListenersExceededWarning above all).
const warnings: Record<string, number> = {};
const lastWarnings: string[] = [];
let unhandled = 0;
process.on("warning", (w) => {
  warnings[w.name] = (warnings[w.name] ?? 0) + 1;
  lastWarnings.push(`${w.name}: ${w.message}`.slice(0, 300));
  if (lastWarnings.length > 5) lastWarnings.shift();
  console.warn(`[${name}] ${w.name}: ${w.message}`);
});
process.on("unhandledRejection", (e) => {
  unhandled++;
  console.warn(`[${name}] unhandled:`, e);
});

const identity = await createIdentity(false);
const content = fileContent(`/tmp/${name}`);
// A snapshot's state from this bot's own store (like a node: no IndexedDB in Node).
async function readText(hash: string): Promise<string | null> {
  const size = await content.size(hash);
  const bytes = size === null ? null : await content.readRange(hash, 0, size);
  return bytes ? new TextDecoder().decode(bytes) : null;
}

function memoryStore(): CommitStore {
  const all = new Map<string, Commit[]>();
  return {
    load: async (serverId) => [...(all.get(serverId) ?? [])].sort(compareCommits),
    add: async (serverId, commits) => void all.set(serverId, [...(all.get(serverId) ?? []), ...commits]),
  };
}

type Fetched = { hash: string; ms: number; from: "node" | "member" | null; result: string; busy: number };

class Member {
  readonly ledger: Ledger;
  readonly api: ApiClient;
  readonly sync: WorkspaceSync;
  readonly nodes: NodeLink;
  readonly streams: ContentStreams | null;
  readonly joinedAt = Date.now();
  dataAt: number | null = null;
  profileAt: number | null = null;
  // Tag -> first time a message carrying it was seen here (messages from others only).
  readonly seen = new Map<string, number>();
  private readonly seenIds = new Set<number>();
  readonly fetched = new Map<string, Fetched>();
  fetching = false;
  // After the first /fetch: files added later are fetched too, like a member syncing the channel.
  private autoFetch = false;
  private fetchAgain = false;
  private fetchTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly stop: () => void;

  static async open(invite: string): Promise<Member> {
    const entry = parseInvite(invite);
    if (!entry) throw new Error("bad invite");
    const signer = { author: identity.id, key: { x: identity.publicKey.x!, y: identity.publicKey.y! }, privateKey: identity.privateKey, replica: crypto.randomUUID() };
    let ledger!: Ledger;
    ledger = new Ledger(entry.id, signer, workspacePolicy, memoryStore(), snapshotLoader(() => ledger, readText));
    const backend = createLedgerBackend(ledger, localPlugins);
    for (const plugin of plugins) backend.load(plugin);
    await ledger.load();
    const member = new Member(entry.id, entry.secret, entry.token, ledger, backend);
    void member.arrive();
    return member;
  }

  private constructor(readonly serverId: string, secret: string, private readonly inviteToken: string | undefined, ledger: Ledger,
    backend: ReturnType<typeof createLedgerBackend>) {
    this.ledger = ledger;
    this.api = new ApiClient(new MockTransport(backend));
    const stopDeclared = loadDeclared(ledger, backend);
    this.sync = new WorkspaceSync(ledger, serverId, secret, {
      tabs: false, rtcPolyfill: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection,
      peerAuth: { localAccess: "invite", ...(inviteToken ? { inviteToken } : {}) },
      ensureContent: (hash) => this.fetchOne(hash),
    });
    this.nodes = new NodeLink(serverId, ledger, this.sync);
    this.sync.setSourceOrder((peers) => this.nodes.order(peers));
    this.sync.setNodes({ known: () => this.nodes.hasNodes(), isNode: (peer) => this.nodes.nodeUser(peer) !== null });
    this.sync.setGroups(() => groupsFor(ledger, null, false));
    this.streams = this.sync.room ? new ContentStreams(this.sync.room, content) : null;
    const stopScan = ledger.subscribe(() => {
      this.scan();
      if (this.autoFetch) {
        clearTimeout(this.fetchTimer);
        this.fetchTimer = setTimeout(() => void this.fetchAll(), 1_000);
      }
    });
    this.stop = () => {
      stopScan();
      stopDeclared();
    };
  }

  // Like the app on a join (p2p/workspaces.ts): once the data stopped arriving, the profile, with the invite's token.
  private async arrive() {
    await this.ledger.ready();
    this.dataAt = Date.now();
    await quiet(this.ledger);
    await this.api.plugin("members").call("set-profile", {
      username: name, display_name: name, color: "", avatar: `gen:${identity.id}`,
      ...(this.inviteToken ? { invite_token: this.inviteToken } : {}),
    });
    this.profileAt = Date.now();
  }

  // One file (a snapshot's state) from whoever has it, nodes first; true once it is here.
  private async fetchOne(hash: string): Promise<boolean> {
    if (await content.has(hash)) return true;
    if (!this.streams || !this.sync.room) return false;
    for (const peer of this.nodes.orderFor(hash, Object.keys(this.sync.room.getPeers())))
      if ((await this.streams.download(hash, peer)) === "done") return true;
    return false;
  }

  private scan() {
    const t = Date.now();
    for (const row of this.ledger.select("chat", "chat_messages", {})) {
      const id = Number(row.id);
      if (this.seenIds.has(id)) continue;
      this.seenIds.add(id);
      if (Number(row.author_id) === this.ledger.me) continue;
      const tag = typeof row.body === "string" ? row.body.match(tagPattern)?.[0] : undefined;
      if (tag && !this.seen.has(tag)) this.seen.set(tag, t);
    }
  }

  chatChannel(): number | null {
    const chats = this.ledger.select("channels", "channels_channels", {}).filter((c) => c.type === "chat");
    return Number((chats.find((c) => c.name === "general") ?? chats[0])?.id ?? 0) || null;
  }

  members(): number {
    const nodeIds = new Set(this.ledger.select("nodes", "nodes_nodes", {}).map((n) => Number(n.user_id)));
    return this.ledger.select("members", "members_profiles", {}).filter((p) => !nodeIds.has(Number(p.user_id))).length;
  }

  wanted(): string[] {
    const hashes = new Set<string>();
    for (const a of this.ledger.select("chat", "chat_attachments", {}))
      for (const m of String(a.url ?? "").matchAll(/mwc:([a-f0-9]{64})/g)) hashes.add(m[1]);
    return [...hashes];
  }

  // Every attachment, one at a time, nodes first (closest round trip first), as the app's ContentLink orders them.
  async fetchAll() {
    this.autoFetch = true;
    // A pass already running took its list of files before this call: run again after it.
    if (this.fetching) {
      this.fetchAgain = true;
      return;
    }
    if (!this.streams || !this.sync.room) return;
    this.fetching = true;
    let failed = 0;
    try {
      for (const hash of this.wanted()) {
        if ((await content.has(hash)) || this.fetched.get(hash)?.result === "done") continue;
        const started = Date.now();
        const record: Fetched = { hash, ms: 0, from: null, result: "missing", busy: 0 };
        for (let round = 0; round < 20 && record.result !== "done"; round++) {
          for (const peer of this.nodes.orderFor(hash, Object.keys(this.sync.room.getPeers()))) {
            const result = await this.streams.download(hash, peer);
            if (result === "busy") record.busy++;
            if (result === "done") {
              record.result = "done";
              record.from = this.nodes.nodeUser(peer) !== null ? "node" : "member";
              break;
            }
            record.result = result;
          }
          if (record.result !== "done") await new Promise((r) => setTimeout(r, 3000));
        }
        record.ms = Date.now() - started;
        this.fetched.set(hash, record);
        if (record.result !== "done") failed++;
      }
    } finally {
      this.fetching = false;
      // Files that arrived during the pass, then the ones that failed (later).
      if (this.fetchAgain) {
        this.fetchAgain = false;
        void this.fetchAll();
      } else if (failed > 0) {
        clearTimeout(this.fetchTimer);
        this.fetchTimer = setTimeout(() => void this.fetchAll(), 5_000);
      }
    }
  }

  async post(tags: string[], gapMs: number) {
    const channelId = this.chatChannel();
    const out: { tag: string; t: number; ok: boolean; error?: string }[] = [];
    for (let i = 0; i < tags.length; i++) {
      if (i > 0 && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
      const t = Date.now();
      const tag = `${tags[i]}|${t}`;
      if (channelId === null) {
        out.push({ tag, t, ok: false, error: "no chat channel (server data missing)" });
        continue;
      }
      try {
        await this.api.plugin("chat").call("post-message", { channel_id: channelId, body: tag });
        out.push({ tag, t, ok: true });
      } catch (e) {
        out.push({ tag, t, ok: false, error: String((e as Error)?.message ?? e) });
      }
    }
    return out;
  }

  async state(prefix: string | undefined) {
    const files = this.wanted();
    let held = 0;
    for (const hash of files) if (await content.has(hash)) held++;
    const fetched = [...this.fetched.values()];
    return {
      open: true,
      hasData: this.ledger.owner !== null,
      commits: this.ledger.log().length,
      online: this.sync.peers(),
      direct: this.sync.mesh?.directPeers().length ?? 0,
      directNodes: (this.sync.mesh?.directPeers() ?? []).filter((p) => this.nodes.nodeUser(p) !== null).length,
      memberRoom: this.sync.inMemberRoom(),
      members: this.members(),
      joinedAt: this.joinedAt, dataAt: this.dataAt, profileAt: this.profileAt,
      seen: prefix ? [...this.seen.keys()].filter((t) => t.startsWith(prefix)).length : null,
      seenPrefix: prefix ?? null,
      files: files.length, held, fetching: this.fetching,
      fromNode: fetched.filter((f) => f.from === "node").length,
      fromMember: fetched.filter((f) => f.from === "member").length,
      busy: fetched.reduce((n, f) => n + f.busy, 0),
      fetchMs: fetched.filter((f) => f.result === "done").map((f) => f.ms),
    };
  }

  async close() {
    clearTimeout(this.fetchTimer);
    this.autoFetch = false;
    this.stop();
    this.nodes.close();
    this.streams?.close();
    this.sync.close();
    this.api.close();
    await this.ledger.flush();
  }
}

function quiet(ledger: Ledger, quietMs = 3000, maxMs = 60_000): Promise<void> {
  return new Promise((resolve) => {
    let timer = setTimeout(done, quietMs);
    const cap = setTimeout(done, maxMs);
    const stop = ledger.subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(done, quietMs);
    });
    function done() {
      clearTimeout(timer);
      clearTimeout(cap);
      stop();
      resolve();
    }
  });
}

const members = new Map<string, Member>();
let cpuBase = process.cpuUsage();
let cpuAt = Date.now();

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", "http://bot");
  const send = (status: number, value: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  };
  const member = (id: unknown) => {
    const m = members.get(String(id));
    if (!m) throw Object.assign(new Error(`not in server ${String(id)}`), { status: 404 });
    return m;
  };
  if (request.method === "GET" && url.pathname === "/status") {
    const prefixes = JSON.parse(url.searchParams.get("prefixes") || "{}") as Record<string, string>;
    const servers: Record<string, unknown> = {};
    for (const [id, m] of members) servers[id] = await m.state(prefixes[id]);
    const cpu = process.cpuUsage(cpuBase);
    const elapsed = Date.now() - cpuAt;
    cpuBase = process.cpuUsage();
    cpuAt = Date.now();
    return send(200, {
      t: Date.now(), name, self: selfId, account: identity.id, servers,
      rss: process.memoryUsage().rss, cpuPercent: elapsed > 0 ? ((cpu.user + cpu.system) / 1000 / elapsed) * 100 : 0,
      warnings, lastWarnings, unhandled,
    });
  }
  if (request.method === "GET" && url.pathname === "/seen") {
    const m = member(url.searchParams.get("server"));
    const prefix = url.searchParams.get("prefix") ?? "";
    return send(200, Object.fromEntries([...m.seen].filter(([tag]) => tag.startsWith(prefix))));
  }
  if (request.method === "GET" && url.pathname === "/ledger") {
    const m = member(url.searchParams.get("server"));
    const hashes = m.ledger.log().map((e) => e.commit.hash).sort();
    return send(200, { count: hashes.length, setDigest: createHash("sha256").update(hashes.join(",")).digest("hex") });
  }
  if (request.method !== "POST") return send(404, { error: "unknown" });
  const input = await body(request);
  if (url.pathname === "/join") {
    const id = parseInvite(String(input.invite))?.id;
    if (!id) return send(400, { error: "bad invite" });
    if (!members.has(id)) members.set(id, await Member.open(String(input.invite)));
    return send(200, { serverId: id, at: members.get(id)!.joinedAt });
  }
  if (url.pathname === "/leave") {
    const m = member(input.serverId);
    members.delete(m.serverId);
    await m.close();
    return send(200, { left: true });
  }
  if (url.pathname === "/post") return send(200, await member(input.serverId).post((input.tags as string[]) ?? [], Number(input.gapMs ?? 0)));
  if (url.pathname === "/fetch") {
    void member(input.serverId).fetchAll();
    return send(200, { started: true });
  }
  return send(404, { error: "unknown" });
}

createServer((request, response) => {
  handle(request, response).catch((e) => {
    response.writeHead((e as { status?: number }).status ?? 500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: String((e as Error)?.message ?? e) }));
  });
// On the host's network (topology lan) only this computer drives it: BOT_HOST=127.0.0.1.
}).listen(port, process.env.BOT_HOST || "0.0.0.0", () => console.info(`[${name}] ${identity.id} (peer ${selfId}) on :${port}`));
