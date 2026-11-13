// What a test does with one client: app actions and state reads through the live app modules (Vite dev serves
// them by path, so `import("/src/...")` in the page returns the app's own module instances), plus a few UI-driven
// steps for the smoke test. Every function runs in the page via client.eval.
import { sleep, withTimeout } from "./util.mjs";

export const PASSWORD = "mwt-password-1";

// Signs in (session, saved account or a new one) and waits for the app's start-up to finish.
export async function ensureAccount(client, username) {
  const result = await client.eval(
    async ({ username, password }) => {
      const a = await import("/src/core/account.ts");
      const ui = await import("/src/core/ui.ts");
      let how = "session";
      if (!a.account()) {
        const saved = (await a.listAccounts()).find((x) => x.username === username);
        if (saved) {
          await a.signIn(saved.id, password, true);
          how = "sign-in";
        } else {
          // `register` needs the user server (email code, publish), which the test LANs don't have: an account file
          // made here and imported (the "Import account" path) gives the same local account without it.
          const id = await import("/src/core/identity.ts");
          const identity = await id.createIdentity(true);
          const pkcs8 = await id.exportPkcs8(identity.privateKey);
          const file = {
            makework: "account", v: 1, id: identity.id, username, displayName: username, color: a.avatarColors[0],
            avatarSeed: crypto.randomUUID(), publicKey: identity.publicKey, createdAt: new Date().toISOString(),
            locked: await id.lockPkcs8(pkcs8, password),
          };
          await a.importAccount(JSON.stringify(file), password, true);
          how = "import";
        }
      }
      const until = Date.now() + 60_000;
      while (ui.bootStatus() !== null && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      const me = a.account();
      return { id: me?.id ?? null, username: me?.username ?? null, how, booted: ui.bootStatus() === null };
    },
    { username, password: PASSWORD },
    150_000,
    "ensureAccount",
  );
  client.username = result.username;
  client.accountId = result.id;
  return result;
}

export async function createServer(client, name) {
  return client.eval(
    async ({ name }) => {
      const s = await import("/src/core/serverless.ts");
      const { workspaces: servers } = await import("/src/core/workspaces.ts");
      const before = new Set(servers.order);
      const t0 = Date.now();
      await s.createServerless(name);
      const id = servers.order.find((x) => !before.has(x)) ?? null;
      return { id, at: t0, ms: Date.now() - t0 };
    },
    { name },
    90_000,
    "createServer",
  ).then(async (created) => {
    if (created.id) {
      await seedChannels(client, created.id);
      created.invite = await invite(client, created.id);
    }
    return created;
  });
}

// The channels a server used to start with, which the scenarios use: a "general" category with welcome (the welcome
// channel, for join notes), general, voice, files and tasks. New workspaces start empty since the workspaces rework
// (p2p/servers.ts seedServer), and every scenario stopped at "'channel_id' is required". Made through the channels
// plugin's own functions, like a member adding them. Nothing is added to a workspace that has a chat channel.
export async function seedChannels(client, serverId) {
  return client.eval(
    async ({ serverId }) => {
      const { workspaceApi: serverApi } = await import("/src/core/workspaces.ts");
      const ext = serverApi(serverId).plugin("channels");
      if ((await ext.read("channels_channels")).some((c) => c.type === "chat")) return false;
      const { id: categoryId } = await ext.call("add-category", { name: "general" });
      const ids = {};
      for (const [channel, type] of [["welcome", "chat"], ["general", "chat"], ["voice", "voice"], ["files", "files"], ["tasks", "tasks"]])
        ids[channel] = (await ext.call("add-channel", { category_id: categoryId, name: channel, type })).id;
      const [server] = await ext.read("channels_workspace");
      if (server) await ext.update("channels_workspace", { welcome_channel_id: ids.welcome }, { id: server.id });
      return true;
    },
    { serverId },
    30_000,
    "seedChannels",
  );
}

// Returns once the server is open on this client; its data arrives later (see probe().hasData).
export async function joinServer(client, code) {
  return client.eval(
    async ({ code }) => {
      const s = await import("/src/core/serverless.ts");
      const t0 = Date.now();
      await s.joinServerless(code);
      return { id: code.trim().split(".")[1], at: t0, ms: Date.now() - t0 };
    },
    { code },
    90_000,
    "joinServer",
  );
}

export async function leaveServer(client, serverId) {
  return client.eval(
    async ({ serverId }) => {
      const s = await import("/src/core/serverless.ts");
      const t0 = Date.now();
      await s.leaveServerless(serverId, false);
      return { at: t0, ms: Date.now() - t0 };
    },
    { serverId },
    60_000,
    "leaveServer",
  );
}

// A new invite code (`mw3.<id>.<room secret>.<token>`), made like Workspace settings > Invite does: a token signed into
// the workspace (members plugin `create-invite`, its copy sealed for the inviter), no expiry, no use limit. Since
// 2026-10-15 a code without a token admits nobody.
export async function invite(client, serverId) {
  return client.eval(
    async ({ serverId }) => {
      const s = await import("/src/core/serverless.ts");
      const { workspaceApi } = await import("/src/core/workspaces.ts");
      const { account, accountAgreementKey } = await import("/src/core/account.ts");
      const { newInviteToken } = await import("/src/p2p/invite.ts");
      const { pairKeys, seal } = await import("/src/dm/crypto.ts");
      const identity = account();
      const agreement = accountAgreementKey();
      if (!identity || !agreement) throw new Error("not signed in with a key that can seal the invite");
      const token = newInviteToken();
      const keys = await pairKeys(agreement, identity.id, { id: identity.id, publicKey: identity.publicKey });
      const sealed = await seal(keys, { id: crypto.randomUUID(), from: identity.id, to: identity.id, at: Date.now() }, { text: token, attachments: [] });
      const created = await workspaceApi(serverId).plugin("members").call("create-invite", {
        token, sealed_token: JSON.stringify(sealed), label: "mwt", expires_at: null, max_uses: null,
      });
      return s.workspaceInvite(serverId, created.token);
    },
    { serverId },
    30_000,
    "invite",
  );
}

// Ids of the serverless servers open on this client.
export async function openServers(client) {
  return client.eval(
    async () => {
      const s = await import("/src/core/serverless.ts");
      const { workspaces: servers } = await import("/src/core/workspaces.ts");
      return servers.order.filter((id) => s.isServerless(id));
    },
    undefined,
    15_000,
    "openServers",
  );
}

// Leaves every server (clean slate before a scenario). Returns the ids left.
export async function leaveAll(client) {
  const ids = await openServers(client);
  for (const id of ids) await leaveServer(client, id);
  return ids;
}

// The #general chat channel's id, or null while the server has no data yet.
export async function chatChannel(client, serverId) {
  return client.eval(
    async ({ serverId }) => {
      const { workspaceApi: serverApi } = await import("/src/core/workspaces.ts");
      const rows = await serverApi(serverId).plugin("channels").read("channels_channels");
      const chat = rows.filter((r) => r.type === "chat");
      return (chat.find((r) => r.name === "general") ?? chat[0])?.id ?? null;
    },
    { serverId },
    15_000,
    "chatChannel",
  );
}

// Posts `tags.length` messages, `gapMs` apart; each body is "<tag>|<sent ms>" so receivers can time it.
// Returns [{ tag, t, ok, error }] where `tag` is the full tag as it appears in the body.
export async function postTagged(client, serverId, channelId, tags, gapMs = 0) {
  return client.eval(
    async ({ serverId, channelId, tags, gapMs }) => {
      const { workspaceApi: serverApi } = await import("/src/core/workspaces.ts");
      const chat = serverApi(serverId).plugin("chat");
      const out = [];
      for (let i = 0; i < tags.length; i++) {
        if (i > 0 && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
        const t = Date.now();
        const tag = `${tags[i]}|${t}`;
        try {
          const res = await chat.call("post-message", { channel_id: channelId, body: tag });
          out.push({ tag, t, ok: true, id: res?.id ?? null });
        } catch (e) {
          out.push({ tag, t, ok: false, error: String(e?.message ?? e) });
        }
      }
      return out;
    },
    { serverId, channelId, tags, gapMs },
    Math.max(60_000, tags.length * (gapMs + 3000)),
    "postTagged",
  );
}

// Posts later from inside the page (setTimeout), so a client that is cut off from the network (and from CDP)
// still writes while offline. Results land in window.__mwt.scheduled; read them with scheduledPosts().
export async function schedulePosts(client, serverId, channelId, tags, delaysMs) {
  return client.eval(
    async ({ serverId, channelId, tags, delaysMs }) => {
      const W = window.__mwt;
      W.scheduled ??= {};
      const { workspaceApi: serverApi } = await import("/src/core/workspaces.ts");
      tags.forEach((base, i) => {
        setTimeout(async () => {
          const t = Date.now();
          const tag = `${base}|${t}`;
          try {
            await serverApi(serverId).plugin("chat").call("post-message", { channel_id: channelId, body: tag });
            W.scheduled[base] = { tag, t, ok: true };
          } catch (e) {
            W.scheduled[base] = { tag, t, ok: false, error: String(e?.message ?? e) };
          }
        }, delaysMs[i] ?? 0);
      });
      return tags.length;
    },
    { serverId, channelId, tags, delaysMs },
    15_000,
    "schedulePosts",
  );
}

export async function scheduledPosts(client) {
  return client.eval(() => Object.values(window.__mwt?.scheduled ?? {}), undefined, 15_000, "scheduledPosts");
}

// Tags (mwt|...) of #channel's messages in display order, plus the total row count.
export async function messageTags(client, serverId, channelId) {
  return client.eval(
    async ({ serverId, channelId }) => {
      const { workspaceApi: serverApi } = await import("/src/core/workspaces.ts");
      const { rows } = await serverApi(serverId).plugin("chat").call("list-messages", { channel_id: channelId });
      const tags = [];
      for (const r of rows) {
        const m = typeof r.body === "string" ? r.body.match(/mwt\|[A-Za-z0-9_.:|-]+/) : null;
        if (m) tags.push(m[0]);
      }
      return { total: rows.length, tags };
    },
    { serverId, channelId },
    30_000,
    "messageTags",
  );
}

// Profile rows (raw, duplicates visible), what the UI's member list shows (nodes left out since 2026-10-12, they
// appear only on the Nodes page), and every known member nodes included.
export async function members(client, serverId) {
  return client.eval(
    async ({ serverId }) => {
      const { workspaceApi: serverApi } = await import("/src/core/workspaces.ts");
      const m = await import("/src/core/members.ts");
      const { isNode } = await import("/src/core/nodes.ts");
      const rows = await serverApi(serverId).plugin("members").read("members_profiles");
      const entry = (x) => ({ id: x.id, username: x.username, node: isNode(serverId, x.id) });
      return {
        rows: rows.map((r) => ({ user_id: r.user_id, username: r.username })),
        ui: m.memberListVisible(serverId).map(entry),
        all: m.memberList(serverId).map(entry),
      };
    },
    { serverId },
    20_000,
    "members",
  );
}

// The ledger: commit count, digests of the commit set and of the total order, vector, replica/seq collisions.
export async function ledgerInfo(client, serverId, { full = false } = {}) {
  return client.eval(
    async ({ serverId, full }) => {
      const s = await import("/src/core/serverless.ts");
      const { compareText } = await import("/src/core/text.ts");
      const ledger = s.workspaceLedger(serverId);
      if (!ledger) return null;
      const entries = ledger.log();
      const hashes = entries.map((e) => e.commit.hash);
      const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const digest = async (list) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(list.join(","))));
      const bySeq = new Map();
      for (const { commit } of entries) {
        const key = `${commit.replica}:${commit.seq}`;
        (bySeq.get(key) ?? bySeq.set(key, new Set()).get(key)).add(commit.hash);
      }
      const collisions = [...bySeq.entries()].filter(([, set]) => set.size > 1).map(([key, set]) => ({ key, hashes: set.size }));
      return {
        count: hashes.length,
        rejected: entries.filter((e) => e.rejected).length,
        setDigest: await digest([...hashes].sort(compareText)),
        orderDigest: await digest(hashes),
        vector: ledger.vector(),
        me: ledger.me,
        owner: ledger.owner,
        collisions,
        hashes: full ? hashes : undefined,
      };
    },
    { serverId, full },
    60_000,
    "ledgerInfo",
  );
}

// The mesh as this client sees it: its Trystero id, direct peers, relayed peers (and through whom), failures.
export async function meshInfo(client, serverId) {
  return client.eval(
    ({ serverId }) => {
      const sync = window.__mwt?.syncs?.get(serverId);
      const mesh = sync?.mesh;
      if (!mesh) return null;
      return {
        self: mesh.self,
        direct: [...mesh.direct],
        via: [...mesh.via.entries()],
        failed: [...mesh.failed.keys()],
        neighbors: Object.fromEntries([...mesh.neighbors.entries()].map(([k, v]) => [k, [...v]])),
        needsTurn: Boolean(mesh.turn),
      };
    },
    { serverId },
    10_000,
    "meshInfo",
  );
}

// Light state for the poller: per server (online count, mesh sizes, data, members, tagged messages seen with
// that server's current prefix) and the client's connections; also the console entries since `logCursor`.
export async function probe(client, serverIds, prefixes = {}) {
  return client.eval(
    async ({ serverIds, prefixes, logCursor }) => {
      const W = window.__mwt;
      const s = await import("/src/core/serverless.ts");
      const m = await import("/src/core/members.ts");
      const { workspaces: servers } = await import("/src/core/workspaces.ts");
      const out = { t: Date.now(), servers: {}, pcs: W?.pcSummary?.() ?? null, logs: W?.logsSince?.(logCursor) ?? null };
      out.dc = W ? { sentFrames: W.dc.sentFrames, recvFrames: W.dc.recvFrames, sentBytes: W.dc.sentBytes, recvBytes: W.dc.recvBytes } : null;
      for (const sid of serverIds) {
        const ledger = s.workspaceLedger(sid);
        const mesh = W?.syncs?.get(sid)?.mesh;
        out.servers[sid] = {
          open: s.isServerless(sid),
          status: servers.byId[sid]?.status ?? null,
          online: s.onlinePeers(sid),
          hasData: ledger ? ledger.owner !== null : false,
          commits: ledger ? ledger.log().length : null,
          // Every known member (nodes included), and what the member list shows (nodes left out).
          members: m.memberList(sid).length,
          membersVisible: m.memberListVisible(sid).length,
          direct: mesh ? mesh.direct.size : null,
          via: mesh ? mesh.via.size : null,
          failed: mesh ? mesh.failed.size : null,
          turn: mesh ? Boolean(mesh.turn) : null,
          seen: prefixes[sid] && W ? W.countSeen(sid, prefixes[sid]) : null,
          // The round `seen` counts, so a sample taken before a new round started isn't read as that round's.
          seenPrefix: prefixes[sid] ?? null,
        };
      }
      return out;
    },
    { serverIds, prefixes, logCursor: client.logCursor },
    8_000,
    "probe",
  );
}

// The row id of each tagged message that arrived from peers, by full tag.
export async function rowIds(client, serverId, prefix) {
  return client.eval(({ serverId, prefix }) => window.__mwt?.rowIdsSince?.(serverId, prefix) ?? {}, { serverId, prefix }, 20_000, "rowIds");
}

// First-seen times (ms) of tagged messages that arrived from peers, by full tag.
export async function seenTimes(client, serverId, prefix) {
  return client.eval(({ serverId, prefix }) => window.__mwt?.seenSince?.(serverId, prefix) ?? {}, { serverId, prefix }, 20_000, "seenTimes");
}

// Everything the instrumentation knows (final dump for metrics.json).
export async function instrumentation(client, serverIds) {
  return client.eval(
    ({ serverIds }) => {
      const W = window.__mwt;
      if (!W) return null;
      return {
        early: W.early,
        patched: W.patched,
        patchInfo: W.patchInfo,
        pcs: W.pcSummary(),
        pcDetail: W.pcDetail(),
        ws: W.wsSummary(),
        wsNotices: Object.fromEntries(Object.entries(W.ws).map(([url, r]) => [url, r.notices])),
        dc: W.dc,
        acc: Object.fromEntries(serverIds.map((sid) => [sid, W.accSummary(sid)])),
      };
    },
    { serverIds },
    30_000,
    "instrumentation",
  );
}

// ---- Nodes (scenario s8) ----

// Posts `count` plain messages as fast as the app signs them: a long history for joiners to catch up on.
export async function seedHistory(client, serverId, channelId, count) {
  return client.eval(
    async ({ serverId, channelId, count }) => {
      const { workspaceApi: serverApi } = await import("/src/core/workspaces.ts");
      const s = await import("/src/core/serverless.ts");
      const chat = serverApi(serverId).plugin("chat");
      const t0 = Date.now();
      for (let i = 0; i < count; i++) await chat.call("post-message", { channel_id: channelId, body: `seed ${i} lorem ipsum dolor sit amet ${Math.random().toString(36).slice(2)}` });
      await s.workspaceLedger(serverId)?.flush();
      return { ms: Date.now() - t0, commits: s.workspaceLedger(serverId)?.log().length ?? null };
    },
    { serverId, channelId, count },
    Math.max(120_000, count * 200),
    "seedHistory",
  );
}

// Uploads `count` files of random bytes (`mb` MiB each) as chat attachments, like the composer does (content
// stored first, then the message and its attachment). Returns their content hashes.
export async function uploadFiles(client, serverId, channelId, count, mb) {
  return client.eval(
    async ({ serverId, channelId, count, mb }) => {
      const { workspaceApi: serverApi } = await import("/src/core/workspaces.ts");
      const { uploadAndPost } = await import("/src/core/files.ts");
      const { refHash } = await import("/src/core/content.ts");
      const chat = serverApi(serverId).plugin("chat");
      const hashes = [];
      const t0 = Date.now();
      for (let i = 0; i < count; i++) {
        const bytes = new Uint8Array(mb * 1024 * 1024);
        for (let o = 0; o < bytes.length; o += 65536) crypto.getRandomValues(bytes.subarray(o, Math.min(o + 65536, bytes.length)));
        const file = new File([bytes], `stress-${i}.bin`, { type: "application/octet-stream" });
        // Like the chat composer: copied in, posted, and a big file's piece list named after the post.
        const upload = await uploadAndPost(`${serverId}:${channelId}`, file, async (prepared) => {
          const { id } = await chat.call("post-message", { channel_id: channelId, body: `file ${i}` });
          await chat.call("attach", { message_id: id, name: file.name, mime: file.type, size: file.size, url: prepared.url });
          return prepared;
        });
        hashes.push(refHash(upload.url));
      }
      return { hashes, ms: Date.now() - t0 };
    },
    { serverId, channelId, count, mb },
    Math.max(120_000, count * mb * 5000),
    "uploadFiles",
  );
}

// The server's node rows: [{ userId, name, status }].
export async function nodeRows(client, serverId) {
  return client.eval(
    async ({ serverId }) => {
      const { workspaceApi: serverApi } = await import("/src/core/workspaces.ts");
      const rows = await serverApi(serverId).plugin("nodes").read("nodes_nodes");
      return rows.map((r) => ({ userId: Number(r.user_id), name: r.name, status: r.status, address: r.address ?? null }));
    },
    { serverId },
    15_000,
    "nodeRows",
  );
}

// What a member sees of the workspace's nodes (node test): the authorized ones, which are online (user id → peer)
// and how far, its direct peers and whether it is in the member room (no node reachable).
export async function nodeView(client, serverId) {
  return client.eval(
    async ({ serverId }) => {
      const { nodeLinkOf } = await import("/src/p2p/nodes.ts");
      const sync = window.__mwt?.syncs?.get(serverId);
      const link = nodeLinkOf(serverId);
      const online = Object.fromEntries([...(link?.onlineNodes() ?? new Map())].map(([user, peer]) => [user, peer]));
      return {
        online, direct: sync?.mesh?.directPeers() ?? [], memberRoom: sync?.inMemberRoom?.() ?? null,
        reachable: sync?.mesh?.peers().length ?? 0,
      };
    },
    { serverId },
    10_000,
    "nodeView",
  );
}

// Why a node is or isn't online for this member (node test): its NodeLink (nodes online, hellos waiting for a row,
// silent ones), the node rows, each direct peer's rooms and whether members' messages pass with it, and the trace's
// node hellos and peer events (instrument.js).
export async function nodeDebug(client, serverId) {
  return client.eval(
    async ({ serverId }) => {
      const { nodeLinkOf } = await import("/src/p2p/nodes.ts");
      const { workspaceApi } = await import("/src/core/workspaces.ts");
      const W = window.__mwt;
      const sync = W?.syncs?.get(serverId);
      const link = nodeLinkOf(serverId);
      const room = sync?.room;
      const rows = await workspaceApi(serverId).plugin("nodes").read("nodes_nodes");
      const direct = sync?.mesh?.directPeers() ?? [];
      return {
        online: Object.fromEntries([...(link?.peers ?? [])].map(([peer, n]) => [peer, n])),
        waiting: Object.fromEntries([...(link?.waiting ?? [])].map(([peer, h]) => [peer, { user: h?.user, time: h?.time }])),
        silent: [...(link?.silent?.keys() ?? [])],
        rows: rows.map((r) => ({ userId: Number(r.user_id), name: r.name, status: r.status, hasKey: !!(r.key_x && r.key_y) })),
        direct: direct.map((peer) => ({ peer, member: room?.isMember?.(peer) ?? null, rooms: room?.peerRooms?.get(peer) ?? [] })),
        rooms: room ? [...room.rooms.keys()] : [],
        trace: (W?.voiceTrace ?? []).filter((e) => ["node-hello", "auth", "auth-challenge", "auth-in", "room-peer+", "room-peer-", "direct+", "direct-", "reach+", "reach-", "room+", "room-", "moved"].includes(e.e)).slice(-400),
        self: sync?.mesh?.self ?? null,
      };
    },
    { serverId },
    20_000,
    "nodeDebug",
  );
}

// The workspace's node settings row (copies, sfu_calls, sfu_min_members, sfu_capacity, sfu_forced), or {}.
export async function nodeSettings(client, serverId) {
  return client.eval(
    async ({ serverId }) => {
      const { workspaceApi } = await import("/src/core/workspaces.ts");
      const [row] = await workspaceApi(serverId).plugin("nodes").read("nodes_settings");
      return row ?? {};
    },
    { serverId },
    15_000,
    "nodeSettings",
  );
}

// This member's user id and username in the workspace.
export async function selfInfo(client, serverId) {
  return client.eval(
    async ({ serverId }) => {
      const { myId } = await import("/src/core/members.ts");
      const { account } = await import("/src/core/account.ts");
      return { userId: myId(serverId), username: account()?.username ?? null };
    },
    { serverId },
    10_000,
    "selfInfo",
  );
}

// Leaves the workspace without the "<name> left" note in its welcome channel (node test: a real workspace).
export async function leaveQuietly(client, serverId) {
  return client.eval(
    async ({ serverId }) => (await import("/src/core/serverless.ts")).leaveServerless(serverId, false, false),
    { serverId },
    60_000,
    "leaveQuietly",
  );
}

// Adds a node from the code it printed, as Workspace settings > Nodes > Add a node does (p2p/pair.ts): authorized at
// once, and it gets the workspace with no invite.
export async function addNode(client, serverId, code, page = "") {
  return client.eval(
    async ({ serverId, code, page }) => {
      const s = await import("/src/core/serverless.ts");
      await s.addNode(serverId, code, page);
      return true;
    },
    { serverId, code, page },
    120_000,
    "addNode",
  );
}

// Authorizes every node still waiting, as Server settings > Nodes does (nodes hosted before pairing). Returns the
// names authorized.
export async function authorizeNodes(client, serverId) {
  return client.eval(
    async ({ serverId }) => {
      const { workspaceApi: serverApi } = await import("/src/core/workspaces.ts");
      const { decideNode } = await import("/src/core/nodes.ts");
      const api = serverApi(serverId);
      const rows = await api.plugin("nodes").read("nodes_nodes");
      const done = [];
      for (const r of rows.filter((r) => r.status === "pending")) {
        await decideNode(api, Number(r.user_id), "authorized");
        done.push(r.name);
      }
      return done;
    },
    { serverId },
    30_000,
    "authorizeNodes",
  );
}

// Syncs a channel (its attachments download up to the auto-download size), like the channel's sync switch.
export async function syncChannel(client, serverId, channelId) {
  return client.eval(
    async ({ serverId, channelId }) => {
      const { setSynced } = await import("/src/core/content.ts");
      setSynced(serverId, { kind: "channel", id: channelId }, true);
      return true;
    },
    { serverId, channelId },
    15_000,
    "syncChannel",
  );
}

// How many of `hashes` this client holds.
export async function contentHeld(client, hashes) {
  return client.eval(
    async ({ hashes }) => {
      const { hasContent } = await import("/src/core/content.ts");
      let held = 0;
      for (const hash of hashes) if (await hasContent(hash)) held++;
      return held;
    },
    { hashes },
    20_000,
    "contentHeld",
  );
}

// How many nodes keep each file (Server settings > Nodes).
export async function setCopies(client, serverId, copies) {
  return client.eval(
    async ({ serverId, copies }) => {
      const { workspaceApi: serverApi } = await import("/src/core/workspaces.ts");
      return serverApi(serverId).plugin("nodes").call("set-copies", { copies });
    },
    { serverId, copies },
    15_000,
    "setCopies",
  );
}

// Lowers the size from which files are split into pieces (20 GB in real use) in this app, so set-storage takes a test
// threshold and uploads of that size get a piece list (p2p/pieces.ts `setMinStripeBytes`). Nodes get it from up.sh.
export async function setTestMinStripe(client, mb) {
  return client.eval(
    async ({ mb }) => {
      const { setMinStripeBytes } = await import("/src/p2p/pieces.ts");
      setMinStripeBytes(mb * 1024 * 1024);
      return true;
    },
    { mb },
    15_000,
    "setTestMinStripe",
  );
}

// How nodes store files (Server settings > Nodes): { copies, stripe_mb, parity }, each optional.
export async function setStorage(client, serverId, storage) {
  return client.eval(
    async ({ serverId, storage }) => {
      const { workspaceApi: serverApi } = await import("/src/core/workspaces.ts");
      return serverApi(serverId).plugin("nodes").call("set-storage", storage);
    },
    { serverId, storage },
    15_000,
    "setStorage",
  );
}

// Joins the server's first voice channel (fake media devices) and opens its view, as a member joining from it does:
// over the mesh only the callers whose call view shows a picture get it (ADR 0019). Returns the channel's id.
export async function joinCall(client, serverId) {
  return client.eval(
    async ({ serverId }) => {
      const { workspaceApi: serverApi } = await import("/src/core/workspaces.ts");
      const voice = await import("/src/voice/state.ts");
      const { openChannel } = await import("/src/core/navigation.ts");
      const rows = await serverApi(serverId).plugin("channels").read("channels_channels");
      const channel = rows.find((r) => r.type === "voice");
      if (!channel) return null;
      await voice.joinVoice(serverId, channel.id);
      openChannel(serverId, channel.id);
      return channel.id;
    },
    { serverId },
    30_000,
    "joinCall",
  );
}

// Shows another channel than the call's (the member stays in the call): it no longer views the call's pictures.
export async function viewElsewhere(client, serverId) {
  return client.eval(
    async ({ serverId }) => {
      const { workspaceApi: serverApi } = await import("/src/core/workspaces.ts");
      const { openChannel } = await import("/src/core/navigation.ts");
      const rows = await serverApi(serverId).plugin("channels").read("channels_channels");
      const channel = rows.find((r) => r.type !== "voice");
      if (!channel) return null;
      openChannel(serverId, channel.id);
      return channel.id;
    },
    { serverId },
    15_000,
    "viewElsewhere",
  );
}

export async function leaveCall(client) {
  return client.eval(async () => (await import("/src/voice/state.ts")).leaveVoice(false), undefined, 15_000, "leaveCall");
}

// ---- Calls (Chromium's fake devices: a beeping mic and a test-pattern camera; the screen is Xvfb's) ----

// The call as this client has it: the channel, how its media goes ("mesh", or "sfu" through the node `nodeUser`,
// whose peer id is `node`), the node transports' states, and per other participant whether their mic, camera and
// screen arrive (a live track that isn't muted, or for audio one whose receiver counted bytes, so packets come in).
export async function callState(client, serverId) {
  return client.eval(
    async ({ serverId }) => {
      const voice = await import("/src/voice/state.ts");
      const media = await import("/src/voice/media.ts");
      const { myId } = await import("/src/core/members.ts");
      const { nodeLinkOf } = await import("/src/p2p/nodes.ts");
      const here = voice.call();
      if (!here || here.workspaceId !== serverId) return null;
      const link = media.mediaLink(serverId);
      const sfu = link?.sfu;
      const me = myId(serverId);
      // Bytes received for a track: from its mesh connection's receiver, or its node consumer.
      const bytesIn = async (track) => {
        const sum = (report) => {
          let n = 0;
          report?.forEach((s) => { if (s.type === "inbound-rtp") n += s.bytesReceived ?? 0; });
          return n;
        };
        for (const pc of Object.values(link?.sync?.room?.getPeers?.() ?? {})) {
          for (const r of pc.getReceivers()) if (r.track === track) return sum(await r.getStats());
        }
        for (const { consumer } of sfu?.consumed?.values() ?? []) if (consumer.track === track) return sum(await consumer.getStats());
        return 0;
      };
      // Chromium leaves a remote audio track flagged `muted` after the sender's gate went silent, while its packets
      // still arrive and play (s10, 2026-10-13): for audio the receiver's byte count decides.
      const live = async (stream, kind) => {
        for (const t of stream ? (kind === "audio" ? stream.getAudioTracks() : stream.getVideoTracks()) : []) {
          if (t.readyState !== "live") continue;
          if (!t.muted || (kind === "audio" && (await bytesIn(t)) > 0)) return true;
        }
        return false;
      };
      const others = voice.participants(serverId, here.channelId).filter((p) => p.userId !== me);
      const remotes = Object.fromEntries(await Promise.all(others.map(async (p) => {
        const screen = media.remoteStream(serverId, p.userId, "screen");
        return [p.userId, {
          mic: await live(media.remoteStream(serverId, p.userId, "mic"), "audio"),
          camera: await live(media.remoteStream(serverId, p.userId, "camera"), "video"),
          screen: await live(screen, "video"), screenSound: await live(screen, "audio"), sharing: p.sharing, cameraOn: p.camera,
        }];
      })));
      const online = nodeLinkOf(serverId)?.onlineNodes() ?? new Map();
      const node = sfu?.joined ?? null;
      return {
        channelId: here.channelId, me, participants: others.length + 1, mode: sfu?.modeOf(here.channelId) ?? "mesh", node,
        nodeUser: [...online].find(([, peer]) => peer === node)?.[0] ?? null, nodesOnline: online.size,
        send: sfu?.send?.connectionState ?? null, recv: sfu?.recv?.connectionState ?? null, remotes,
      };
    },
    { serverId },
    10_000,
    "callState",
  );
}

// Who this client lists in a call (s13), and everything that decides it: the participant list the UI shows per voice
// channel, the voice table, the VoiceLink's view of each peer, the mesh (direct, relayed, each direct peer's
// neighbors), the rooms, and the presence trace since `cursor` (W.voiceTrace, instrument.js).
export async function callPresence(client, serverId, { cursor = 0, full = false } = {}) {
  return client.eval(
    async ({ serverId, cursor, full }) => {
      const W = window.__mwt;
      await W?.traceVoice?.();
      const voice = await import("/src/voice/state.ts");
      const media = await import("/src/voice/media.ts");
      const { myId } = await import("/src/core/members.ts");
      const here = voice.call();
      const me = myId(serverId);
      const link = media.mediaLink(serverId);
      const sync = W?.syncs?.get(serverId);
      const mesh = sync?.mesh;
      const channel = here?.workspaceId === serverId ? here.channelId : null;
      const listed = channel === null ? [] : voice.participants(serverId, channel).map((p) => p.userId).filter((u) => u !== me);
      const trace = (W?.voiceTrace ?? []).filter((e) => e.t >= cursor);
      const out = { me, channel, listed, self: mesh?.self ?? null };
      if (!full) return { ...out, traceCount: trace.length };
      const rows = link?.backend?.data("voice").select("voice_participants", {}) ?? [];
      const peers = Object.fromEntries([...(link?.peerUsers ?? [])].map(([peer, user]) => [peer, {
        user, row: link.peerRows.get(peer) ? Number(link.peerRows.get(peer).channel_id) : link.peerRows.has(peer) ? null : "none",
        heardAgoMs: link.heard.get(peer) ? Date.now() - link.heard.get(peer).at : null, onNode: link.peerOnNode.get(peer) ?? null,
        direct: !!mesh?.direct?.has(peer), via: mesh?.via?.get(peer) ?? null,
      }]));
      const room = sync?.room;
      return {
        ...out,
        rows: rows.map((r) => ({ user: Number(r.user_id), ch: Number(r.channel_id) })),
        peers,
        reachable: mesh?.peers() ?? [], direct: mesh?.directPeers() ?? [], via: Object.fromEntries(mesh?.via ?? []),
        neighbors: Object.fromEntries([...(mesh?.neighbors ?? [])].map(([p, s]) => [p, [...s]])),
        rooms: room ? [...room.rooms.keys()] : [], peerRooms: room ? Object.fromEntries(room.peerRooms) : {},
        call: sync?.call ?? null, secret: String(sync?.currentSecret ?? "").slice(0, 6), memberMode: sync?.memberMode ?? null,
        trace,
      };
    },
    { serverId, cursor, full },
    20_000,
    "callPresence",
  );
}

// The network and page load of this client (s14): byte and packet totals over every open RTCPeerConnection (members',
// nodes' and the node call's transports: instrument.js tracks them all), apart for audio media and data channels;
// how many audio streams go out and come in (with bytes flowing); the streams it passes on for others; and the page
// counters since W.loadStart(). Totals, so a phase takes two samples.
export async function callLoad(client, serverId) {
  return client.eval(
    async ({ serverId }) => {
      const W = window.__mwt;
      // Counters per open connection (by the instrumentation's id), so a reader takes differences connection by
      // connection: summed, a connection closing between two samples took its bytes out of the total.
      const totals = { audioOut: 0, audioIn: 0, connections: 0 };
      const byPc = {};
      for (const rec of W?.pcs ?? []) {
        const pc = rec.pc;
        if (!pc || pc.connectionState === "closed") continue;
        totals.connections++;
        const c = (byPc[rec.id] = { bytesSent: 0, bytesReceived: 0, packetsSent: 0, packetsReceived: 0, audioSent: 0, audioReceived: 0, dataSent: 0, dataReceived: 0 });
        const report = await pc.getStats().catch(() => null);
        report?.forEach((s) => {
          if (s.type === "transport") {
            c.bytesSent += s.bytesSent ?? 0;
            c.bytesReceived += s.bytesReceived ?? 0;
            c.packetsSent += s.packetsSent ?? 0;
            c.packetsReceived += s.packetsReceived ?? 0;
          } else if (s.type === "outbound-rtp" && s.kind === "audio") {
            c.audioSent += s.bytesSent ?? 0;
            if ((s.bytesSent ?? 0) > 0) totals.audioOut++;
          } else if (s.type === "inbound-rtp" && s.kind === "audio") {
            c.audioReceived += s.bytesReceived ?? 0;
            if ((s.bytesReceived ?? 0) > 0) totals.audioIn++;
          } else if (s.type === "data-channel") {
            c.dataSent += s.bytesSent ?? 0;
            c.dataReceived += s.bytesReceived ?? 0;
          }
        });
      }
      const sync = W?.syncs?.get(serverId);
      return { t: Date.now(), ...totals, byPc, forwarded: sync?.mesh?.forwarded?.size ?? 0, page: W?.loadRead?.() ?? null };
    },
    { serverId },
    30_000,
    "callLoad",
  );
}

export async function loadStart(client) {
  return client.eval(() => window.__mwt?.loadStart?.() ?? false, undefined, 10_000, "loadStart");
}

// The loudest each other participant's sound got here (dBFS of the playing stream's analyser) over `ms`; null for
// one nothing played for. The fake mic beeps, so a working path peaks well above silence.
export async function audioLevels(client, serverId, ms = 3000) {
  return client.eval(
    async ({ serverId, ms }) => {
      const voice = await import("/src/voice/state.ts");
      const remote = await import("/src/voice/remote.ts");
      const { myId } = await import("/src/core/members.ts");
      const here = voice.call();
      if (!here || here.workspaceId !== serverId) return null;
      const me = myId(serverId);
      const users = voice.participants(serverId, here.channelId).map((p) => p.userId).filter((u) => u !== me);
      const peak = Object.fromEntries(users.map((u) => [u, null]));
      const until = Date.now() + ms;
      while (Date.now() < until) {
        for (const u of users) {
          const analyser = remote.remoteAnalyser(`${serverId}:${u}`);
          if (!analyser) continue;
          const data = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(data);
          const rms = Math.sqrt(data.reduce((sum, x) => sum + x * x, 0) / data.length);
          const db = rms > 0 ? 20 * Math.log10(rms) : -120;
          peak[u] = peak[u] === null ? db : Math.max(peak[u], db);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return Object.fromEntries(Object.entries(peak).map(([u, db]) => [u, db === null ? null : Math.round(db)]));
    },
    { serverId, ms },
    ms + 15_000,
    "audioLevels",
  );
}

// The beep is a steady tone, which noise suppression may take for noise; tests that listen for it turn it off.
export async function setNoiseSuppression(client, value) {
  return client.eval(
    async ({ value }) => (await import("/src/voice/micSettings.ts")).setNoiseSuppression(value),
    { value },
    10_000,
    "setNoiseSuppression",
  );
}

export async function setCamera(client, on) {
  return client.eval(
    async ({ on }) => {
      const voice = await import("/src/voice/state.ts");
      if (!!voice.cameraStream() !== on) await voice.toggleCamera();
      return { on: !!voice.cameraStream(), error: voice.voiceError() || null };
    },
    { on },
    30_000,
    "setCamera",
  );
}

// Shares the screen (in Electron the first `screen:` source, Xvfb's display); returns the captured track's settings.
export async function sharePicture(client) {
  return client.eval(
    async () => {
      const voice = await import("/src/voice/state.ts");
      if (!voice.sharedPicture()) await voice.togglePicture();
      const track = voice.sharedPicture()?.getVideoTracks()[0];
      return track ? { label: track.label, settings: track.getSettings(), error: null } : { error: voice.voiceError() || "no picture" };
    },
    undefined,
    60_000,
    "sharePicture",
  );
}

export async function stopPicture(client) {
  return client.eval(
    async () => {
      const voice = await import("/src/voice/state.ts");
      if (voice.sharedPicture()) await voice.togglePicture();
      return !voice.sharedPicture();
    },
    undefined,
    15_000,
    "stopPicture",
  );
}

// The share's quality on this client (voice/shareQuality.ts):
// { resolution: 720|1080|1440, frameRate: 30|60, favour: motion|balanced|detail, bitrate: "auto"|Mbit/s }.
export async function setShareQuality(client, quality) {
  return client.eval(
    async ({ quality }) => (await import("/src/voice/state.ts")).setShareQuality(quality),
    { quality },
    10_000,
    "setShareQuality",
  );
}

// The share's live numbers: { width, height, fps, bitrate, limitation, copies, viaNode, cap, soundRefused } or null.
export async function shareStats(client) {
  return client.eval(async () => (await import("/src/voice/state.ts")).shareStats(), undefined, 15_000, "shareStats");
}

// What the senders carrying this client's screen share are set to: every mesh copy, and the node's producer.
export async function screenSenderParams(client, serverId) {
  return client.eval(
    async ({ serverId }) => {
      const link = (await import("/src/voice/media.ts")).mediaLink(serverId);
      if (!link) return null;
      const read = (sender) => {
        const p = sender.getParameters();
        return {
          encodings: p.encodings.map((e) => ({ maxBitrate: e.maxBitrate ?? null, maxFramerate: e.maxFramerate ?? null, priority: e.priority ?? null })),
          degradationPreference: p.degradationPreference ?? null,
        };
      };
      const mesh = link.screenSenders?.() ?? { video: [], audio: [] };
      const node = link.sfu?.producers?.get("screen")?.rtpSender ?? null;
      return { mesh: mesh.video.map(read), meshSound: mesh.audio.map(read), node: node ? read(node) : null };
    },
    { serverId },
    10_000,
    "screenSenderParams",
  );
}

// Whom this client is connected to for the server, and whether it is in the member room (no node reachable).
export async function rooms(client, serverId) {
  return client.eval(
    ({ serverId }) => {
      const sync = window.__mwt?.syncs?.get(serverId);
      if (!sync?.mesh) return null;
      return { self: sync.mesh.self, direct: sync.mesh.directPeers(), memberRoom: sync.inMemberRoom() };
    },
    { serverId },
    10_000,
    "rooms",
  );
}

// ---- UI-driven steps (smoke test) ----

export async function uiRegister(client, username) {
  const page = client.page;
  await page.getByRole("heading", { name: "Create an account" }).waitFor({ timeout: 30_000 });
  await page.getByLabel("Display name").fill(username);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.locator('[aria-label="Add a workspace"]').waitFor({ timeout: 120_000 });
  client.username = username;
}

// Through the "Add a workspace" popover (servers are "workspaces" in the app since the rework, AddServer.tsx). Its fields
// are looked up inside it: the welcome view (no workspace yet) has its own name and invite code fields, so a page-wide
// lookup found two and failed (s0, 2026-10-14).
export async function uiCreateServer(client, name) {
  const page = client.page;
  await page.locator('[aria-label="Add a workspace"]').click();
  const dialog = page.getByRole("dialog", { name: "Add a workspace" });
  await dialog.getByPlaceholder("Workspace name").fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.locator(`.server-button[aria-label="${name}"]`).waitFor({ timeout: 60_000 });
  // The newest workspace is the last one (as s0 reads it).
  const id = await client.eval(async () => {
    const { workspaces } = await import("/src/core/workspaces.ts");
    return workspaces.order.at(-1) ?? null;
  }, {}, 15_000, "uiCreatedServer");
  if (id) await seedChannels(client, id);
}

export async function uiJoin(client, code) {
  const page = client.page;
  await page.locator('[aria-label="Add a workspace"]').click();
  const dialog = page.getByRole("dialog", { name: "Add a workspace" });
  await dialog.getByPlaceholder("Invite code").fill(code);
  await dialog.getByRole("button", { name: "Join", exact: true }).click();
  await dialog.getByPlaceholder("Invite code").waitFor({ state: "hidden", timeout: 60_000 });
}

// The server button's tooltip, e.g. "mesh (2 online)".
export async function uiServerTitle(client, name) {
  return client.page.locator(`.server-button[aria-label="${name}"]`).getAttribute("title", { timeout: 10_000 });
}

// Right-click menu entry exists (the copy itself needs clipboard-read to check, which the app doesn't grant).
export async function uiInviteMenu(client, name) {
  const page = client.page;
  await page.locator(`.server-button[aria-label="${name}"]`).click({ button: "right" });
  const item = page.getByText("Copy invite code", { exact: true });
  await item.waitFor({ timeout: 10_000 });
  await item.click();
  return true;
}

export async function uiOpenChannel(client, serverName, channel) {
  const page = client.page;
  await page.locator(`.server-button[aria-label="${serverName}"]`).click();
  await page.locator(`button.channel-open[title$=": ${channel}"]`).first().click({ timeout: 60_000 });
}

export async function uiPost(client, text) {
  // The formatted editor (contenteditable div); its markdown-mode textarea shares the class but is hidden.
  const editor = client.page.locator(".chat-composer .mw-editor-input:visible").first();
  await editor.click({ timeout: 30_000 });
  await editor.pressSequentially(text, { delay: 5 });
  await editor.press("Enter");
}

export async function uiSees(client, text, timeoutMs = 60_000) {
  const t0 = Date.now();
  await client.page.getByText(text, { exact: false }).first().waitFor({ timeout: timeoutMs });
  return Date.now() - t0;
}

export async function waitFor(fn, { timeoutMs = 60_000, everyMs = 500 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const v = await withTimeout(Promise.resolve(fn()), Math.min(15_000, timeoutMs), "waitFor step");
      if (v) return v;
    } catch {}
    await sleep(everyMs);
  }
  return null;
}
