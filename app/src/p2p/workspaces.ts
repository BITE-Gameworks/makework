// Serverless workspaces: each member's client runs the workspace's plugins on its own copy of the data, a log of
// signed commits kept in IndexedDB or the workspace's own folder (commits.ts) and synced with the other members
// (sync.ts). Which servers an account has joined is kept per device and account.
import { ApiClient } from "../api/client";
import { accountAgreementKey, accountKey, freshProfile, type Account } from "../core/account";
import { shareLocation } from "../core/locationSharing";
import { sharedPresenceStatus } from "../core/onlineStatus";
import { dbGet, dbPut } from "../core/db";
import { desktop } from "../core/desktop";
import { storedBlob } from "../core/content";
import { snapshotLoader } from "../core/workspaceSnapshots";
import { notify } from "../core/notifier";
import { isPopout } from "../core/popout";
import { replacedPeer } from "../core/lastRun";
import { base64url } from "../core/identity";
import { readJson, removeKey } from "../core/storage";
import { MockTransport } from "../mock/transport";
import { ChatKeyring, KeyedTransport, setKeyring } from "./chatKeyring";
import { plugins, localPlugins } from "./plugins";
import { inviteTokenKey, parseInvite } from "./invite";
import { clearCommits, commitStoreFor, indexedCommits } from "./commits";
import { ContentLink, wantedEverywhere } from "./content";
import { Ledger, createLedgerBackend, type Signer } from "./ledger";
import { currentTurn, loadTurn } from "./ice";
import { opusDtxConnection } from "./dtx";
import { WorkspaceSync } from "./sync";
import { userNumberOf } from "./log";
import { secretRecipients } from "./memberKeys";
import { workspacePolicy } from "./policy";
import { kickedBy } from "./permissions";
import { MapLink, ownPlace } from "./memberMap";
import { NodeLink, groupsFor } from "./nodes";
import { BotHostChannel } from "./botHosts";
import { PresenceChannel } from "./presence";
import { VoiceLink } from "./voice";
import { loadDeclared } from "../system/declared";
import { pairKeys, seal, unseal, isSealed } from "../dm/crypto";

export { inviteCode } from "./invite";
export { parseInvite };

export interface WorkspaceEntry {
  id: string;
  // The room secret; "" while a joiner with an mw4 code waits for a member to hand it over (p2p/invite.ts).
  secret: string;
  v: 2 | 3;
  // The invite this account joins with, kept until its profile is in the workspace: a join the app was closed during
  // goes on with it. Without it, the next start had no invite to show, so no member let it in, and the code gave
  // "already in that workspace".
  inviteToken?: string;
  generation?: number;
  recoverySecrets?: string[];
  // This device's replica in the workspace, new with every join, so a member who left and joined again never signs a
  // seq its peers already have. Entries from before it use the `mw.p2p.replica.*` key.
  replica?: string;
}

// A folder picked for a server (`desktop.storage.pick`); without one the server lives in the app's storage.
export interface Folder {
  token: string;
  folder: string;
}

export interface OpenWorkspace {
  entry: WorkspaceEntry;
  api: ApiClient;
  sync: WorkspaceSync;
  ledger: Ledger;
  // Called once if this account turns out to be kicked or banned: found so on opening, or while open.
  onRemoved(handler: (removal: Removal) => void): void;
  onSecretChange(handler: () => void): void;
  // Resolves with how many members couldn't be given the new secret.
  rotateSecret(): Promise<{ missed: number }>;
  close(): Promise<void>;
}

export interface Removal {
  by: number | null;
  banned: boolean;
}


const listKey = (account: Account) => `mw.p2p.servers.${account.id}`;
const replicaKey = (account: Account, workspaceId: string) => `mw.p2p.replica.${account.id}.${workspaceId}`;

// Kept in IndexedDB, where a write is on disk once it resolves: localStorage, used before, reached the disk seconds
// later, so the app closing right after a join lost the workspace. The first read moves the list over (with each
// server's replica from its old key; the old keys stay for older versions of the app).
// Entries without `v: 2` are servers from before signed commits; they no longer open.
export async function joinedWorkspaces(account: Account): Promise<WorkspaceEntry[]> {
  const stored = await dbGet<WorkspaceEntry[]>("servers", account.id);
  if (stored) {
    if (!stored.some((e) => e.v !== 3)) return stored;
    const upgraded = stored.map(upgradeEntry);
    await dbPut("servers", upgraded, account.id);
    return upgraded;
  }
  const list = readJson<{ id: string; secret: string; v?: number; generation?: number; recoverySecrets?: string[]; replica?: string }[]>(listKey(account), [])
    .filter((e): e is WorkspaceEntry => e.v === 2 || e.v === 3)
    .map(upgradeEntry)
    .map((e) => ({
      ...e,
      recoverySecrets: [...new Set((e.recoverySecrets ?? []).filter((secret) => typeof secret === "string" && secret !== e.secret))],
      replica: e.replica ?? readJson<string | null>(replicaKey(account, e.id), null) ?? randomId(),
    }));
  await dbPut("servers", list, account.id);
  return list;
}

// Workspaces from before invites (`v: 2`) move to the new invite system by opening: the same room secret, now with
// members proving who they are to each other, so their old public code stops admitting anyone without an invite.
function upgradeEntry(entry: WorkspaceEntry): WorkspaceEntry {
  return entry.v === 3 ? entry : { ...entry, v: 3, generation: entry.generation ?? 0 };
}

// One change to the list at a time: two joins at once would otherwise each write the list without the other.
let updating: Promise<unknown> = Promise.resolve();
function updateJoined(account: Account, change: (list: WorkspaceEntry[]) => WorkspaceEntry[]): Promise<void> {
  const next = updating.then(async () => dbPut("servers", change(await joinedWorkspaces(account)), account.id));
  updating = next.catch(() => {});
  return next;
}

// A member's user id inside every workspace: the first 6 bytes of the account id, so it is the same everywhere.
export function userNumber(account: Account): number {
  return userNumberOf(account.id);
}

function signerFor(account: Account, entry: WorkspaceEntry): Signer {
  return { author: account.id, key: account.publicKey, privateKey: accountKey(), replica: entry.replica ?? randomId() };
}

// Every member's connections ask for silence suppression on calls (dtx.ts). Made once, where WebRTC exists.
let dtxClass: typeof RTCPeerConnection | undefined;
function dtxConnection(): typeof RTCPeerConnection | undefined {
  if (typeof RTCPeerConnection === "undefined") return undefined;
  return (dtxClass ??= opusDtxConnection(RTCPeerConnection));
}


// How the profile is sent once the workspace's data is here: "open" right away when this device has the account's
// profile, "join" (or "open" without a profile yet) once the data has stopped arriving and with a greeting if this
// account is new there, "none" leaves it to the caller (a new workspace sends it once its rows are in).
export type Arrival = "open" | "join" | "none";

export async function openWorkspace(entry: WorkspaceEntry, account: Account, arrival: Arrival = "open", joinToken?: string): Promise<OpenWorkspace> {
  const opened = performance.now();
  const inviteToken = joinToken ?? entry.inviteToken;
  if (entry.v !== 3) {
    Object.assign(entry, upgradeEntry(entry));
    await updateJoined(account, (list) => list.map((item) => item.id === entry.id ? { ...item, ...entry } : item));
  }
  let ledger!: Ledger;
  const readSnapshot = snapshotLoader(() => ledger, async (hash) => (await storedBlob(hash))?.text() ?? null);
  ledger = new Ledger(entry.id, signerFor(account, entry), workspacePolicy, await commitStoreFor(entry.id), readSnapshot);
  const keyring = new ChatKeyring(ledger, account, accountAgreementKey());
  const backend = createLedgerBackend(ledger, localPlugins, { chat: keyring });
  for (const plugin of plugins) backend.load(plugin);
  await ledger.load();
  // The workspace's declared plugins (channels_plugins) get their tables and serve their data; a change to the
  // rows unloads and reloads them, then replays the log so their commits are re-checked and kept.
  const stopDeclared = loadDeclared(ledger, backend);
  const userId = ledger.me;
  // An offline account has no user server: its workspaces stay local, with only the other tabs of this browser.
  const online = account.offline !== true && account.offlineMode !== true;
  // TURN goes with every connection (sync.ts), so it is there before the first one; fetched once, at most 5 s.
  if (online) await loadTurn();
  // Before anything joins a room: a failure here then leaves nothing open behind it.
  const folderDescription = await describeFolder(entry, ledger);
  const sync = new WorkspaceSync(ledger, entry.id, entry.secret, {
    network: online, turn: { current: currentTurn, load: () => void loadTurn() }, rtcPolyfill: dtxConnection(),
    recoverySecrets: entry.recoverySecrets,
    peerAuth: {
      localAccess: isMember(ledger) ? "member" as const : "invite" as const,
      ...(inviteToken ? { inviteToken } : {}),
    },
    onIncompatible: (peer) => notify({
      tag: `update-required:${entry.id}`,
      title: "Update MakeWork",
      body: `Member ${peer} is using a version that cannot read this workspace's history.`,
    }),
  });
  // A view window is never in a call and says nothing about calls (ADR 0009). After a crash, the call presence names
  // the run's old connection for a minute, so the others drop it at once (core/lastRun.ts).
  const voiceLink = new VoiceLink(entry.id, backend, sync, userId, ledger, { presence: !isPopout(), replaces: replacedPeer });
  const presence = new PresenceChannel(entry.id, sync, userId, sharedPresenceStatus());
  const botHosts = new BotHostChannel(entry.id, sync);
  const nodeLink = new NodeLink(entry.id, ledger, sync);
  // A joiner's history comes from one peer, the closest node when there is one (sync.ts).
  sync.setSourceOrder((peers) => nodeLink.order(peers));
  // Members connect to the nodes, not to each other, while one is reachable (sync.ts).
  sync.setNodes({ known: () => nodeLink.hasNodes(), isNode: (peer) => nodeLink.nodeUser(peer) !== null });
  // With more than 3 nodes, a member connects to its nearest group of them (sync.ts).
  let place: { lat: number; lon: number } | null = null;
  void ownPlace().then((found) => (place = found)).catch(() => {});
  sync.setGroups(() => groupsFor(ledger, place, false));
  const mapLink = new MapLink(entry.id, ledger, sync, {
    privateKey: accountKey, shareLocation, closestNode: () => nodeLink.closest()?.user ?? null, nodeUser: (peer) => nodeLink.nodeUser(peer),
  });
  const contentLink = new ContentLink(entry.id, backend, sync, userId, `mw.sync.${account.id}.${entry.id}`, (peers, hash) => nodeLink.orderFor(hash, peers));
  const api = new ApiClient(new KeyedTransport(new MockTransport(backend), keyring));
  // Keys that arrive read chat again, so locked messages open.
  keyring.start(api.plugin("chat"), () => backend.emit({ plugin: "chat", table: "chat_keys", change: "update", ids: [] }));
  setKeyring(entry.id, keyring);
  let applyingSecrets = Promise.resolve();
  const applySecretRows = (): Promise<void> => {
    const apply = async () => {
      const ownId = ledger.me;
      const ownGeneration = entry.generation ?? 0;
      const rows = ledger.select("members", "members_secrets", { user_id: ownId })
        .filter((row) => Number(row.generation) > ownGeneration)
        .sort((a, b) => Number(a.generation) - Number(b.generation));
      if (rows.length === 0) return;
      const agreement = accountAgreementKey();
      if (!agreement) throw new Error("This account can't decrypt workspace secrets on this device.");
      for (const row of rows) {
        const sealed: unknown = JSON.parse(String(row.sealed));
        if (!isSealed(sealed) || sealed.to !== account.id) throw new Error("A workspace secret envelope is malformed.");
        const sender = ledger.log().find(({ commit }) => commit.author === sealed.from)?.commit;
        if (!sender) throw new Error("The sender of a workspace secret isn't in the signed history.");
        const keys = await pairKeys(agreement, account.id, { id: sealed.from, publicKey: sender.key });
        const payload = await unseal(keys, sealed);
        if (!payload?.text) throw new Error("A workspace secret could not be opened with this account.");
        await saveSecret(payload.text, Number(row.generation));
      }
    };
    applyingSecrets = applyingSecrets.then(apply, apply);
    return applyingSecrets;
  };
  const saveSecret = async (secret: string, generation: number): Promise<void> => {
    const previous = entry.secret;
    if (previous !== secret) await sync.rotateSecret(secret);
    entry.secret = secret;
    entry.generation = generation;
    entry.recoverySecrets = [...new Set([...(entry.recoverySecrets ?? []), previous])]
      .filter((value) => value && value !== secret);
    await updateJoined(account, (list) => list.map((item) => item.id === entry.id ? { ...item, ...entry } : item));
    folderDescription.write();
    secretChangeHandlers.forEach((handler) => handler());
  };
  const persistGeneration = async (generation: number): Promise<void> => {
    entry.generation = generation;
    await updateJoined(account, (list) => list.map((item) => item.id === entry.id ? { ...item, ...entry } : item));
    folderDescription.write();
  };
  const rotateSecret = async (): Promise<{ missed: number }> => {
    const agreement = accountAgreementKey();
    if (!agreement) throw new Error("This account can't encrypt workspace secrets on this device.");
    const generation = ledger.select("members", "members_rotations", {})
      .reduce((max, row) => Math.max(max, Number(row.generation)), 0) + 1;
    // Members out of reach must not keep the secret from changing for everyone else.
    const { recipients, unknown } = secretRecipients(ledger, { id: account.id, publicKey: account.publicKey });
    if (unknown.length) console.warn(`Room secret: no signed key on this device for members ${unknown.join(", ")}.`);
    const secret = randomId();
    const now = Date.now();
    const sealedRows: { user_id: number; sealed: string }[] = [];
    for (const [userId, recipient] of recipients) {
      const keys = await pairKeys(agreement, account.id, recipient);
      const sealed = await seal(keys, {
        id: `secret:${generation}:${userId}`, from: account.id, to: recipient.id, at: now,
      }, { text: secret, attachments: [] });
      sealedRows.push({ user_id: userId, sealed: JSON.stringify(sealed) });
    }
    if (!sealedRows.some((row) => row.user_id === ledger.me))
      throw new Error("The new workspace secret wasn't encrypted for this account.");
    await api.plugin("members").call("rotate-secret", { generation, secrets: JSON.stringify(sealedRows) });
    await ledger.flush();
    await applySecretRows();
    return { missed: unknown.length };
  };

  // Banned (always), or kicked: a kick row for this account and no profile. Joining again with an invite adds the
  // profile back after a kick, but not after a ban.
  const removal = (): Removal | null => {
    const [ban] = ledger.select("roles", "roles_bans", { user_id: ledger.me });
    if (ban) return { by: Number(ban.banned_by), banned: true };
    const kick = kickedBy((plugin, table, where) => ledger.select(plugin, table, where ?? {}), ledger.me);
    return kick ? { by: Number(kick.kicked_by), banned: false } : null;
  };
  const removedHandlers: ((removal: Removal) => void)[] = [];
  const secretChangeHandlers: (() => void)[] = [];
  let removed = false;
  const remove = (why: Removal) => {
    if (removed) return;
    removed = true;
    removedHandlers.forEach((handler) => handler(why));
  };
  let watching = false;
  // Joining with an invite (now, or before the app was closed): the profile goes with the token until it is in.
  const joining = arrival === "join" || !!entry.inviteToken;
  let joinSent = false;
  let joinRefusalShown = false;
  // Ends the join's waits when the workspace closes (nothing is sent then).
  const closing = new AbortController();
  const watchJoin = () => {
    if (!joinSent || !entry.inviteToken) return;
    if (ledger.select("members", "members_profiles", { user_id: ledger.me }).length > 0) {
      delete entry.inviteToken;
      void updateJoined(account, (list) => list.map((item) => {
        if (item.id !== entry.id) return item;
        const { inviteToken: _, ...rest } = { ...item, ...entry };
        return rest;
      })).catch((e) => console.warn("Joined workspace not saved:", e));
      return;
    }
    // Refused on every member: another join took the invite's last use at the same moment, say.
    const mine = ledger.log().findLast(({ commit }) => commit.author === account.id && commit.action === "members.set-profile");
    const reason = mine ? ledger.refusal(mine.commit) : null;
    if (!reason || joinRefusalShown) return;
    joinRefusalShown = true;
    notify({
      tag: `join-refused:${entry.id}`, title: "You couldn't join the workspace",
      body: `${reason} Leave it and join again with a new invite.`,
    });
  };
  const stopWatching = ledger.subscribe(() => {
    sync.setLocalMember(isMember(ledger));
    void applySecretRows().catch((e) => console.warn("Workspace secret update wasn't applied:", e));
    watchJoin();
    if (!watching) return;
    const why = removal();
    if (why) remove(why);
  });

  // A member who just joined has nothing until a peer sends the workspace's first commits.
  const waiting = ledger.owner === null;
  if (arrival !== "none") void ledger.ready().then(async () => {
    if (waiting) console.info(`[sync] ${entry.id.slice(0, 8)}: server data received after ${((performance.now() - opened) / 1000).toFixed(1)} s (${ledger.log().length} commits)`);
    // Without a profile here yet, this is a join, maybe one the app was closed during: wait for the data, then greet
    // if the account is really new there.
    const newHere = joining || ledger.select("members", "members_profiles", { user_id: ledger.me }).length === 0;
    if (newHere) await settled(ledger);
    // A join waits for its invite too: a catch-up that paused longer than `settled` before the invite (near the end of
    // the history) arrived had its profile refused here, and the join was given up (mesh-test node test).
    // An invite that never comes is sent for after `inviteWaitMs`, and refused as before.
    if (joining && inviteToken) await waitFor(ledger, () => hasInvite(ledger, inviteToken), inviteWaitMs, closing.signal);
    if (closing.signal.aborted) return;
    await applySecretRows();
    const currentSecret = sync.activeSecret();
    if (currentSecret !== entry.secret) {
      const previous = entry.secret;
      entry.secret = currentSecret;
      entry.recoverySecrets = [...new Set([...(entry.recoverySecrets ?? []), previous])]
        .filter((value) => value && value !== currentSecret);
      await updateJoined(account, (list) => list.map((item) => item.id === entry.id ? { ...item, ...entry } : item));
      folderDescription.write();
      secretChangeHandlers.forEach((handler) => handler());
    }
    const generation = ledger.select("members", "members_rotations", {})
      .reduce((max, row) => Math.max(max, Number(row.generation)), 0);
    if ((entry.generation ?? 0) < generation) await persistGeneration(generation);
    // Kicked while away: don't join again by sending the profile, unless this is a join with an invite. Banned: never.
    const why = removal();
    if (why && (why.banned || !joining)) return remove(why);
    // The profile as the user server has it now, not this device's copy from when the workspace opened: another
    // device of the account may have changed it, and the old copy would overwrite that here.
    const latest = await freshProfile();
    if (closing.signal.aborted) return;
    const { created } = await sendProfile(api, latest?.id === account.id ? latest : account, joining ? inviteToken : undefined);
    joinSent = true;
    watchJoin();
    watching = true;
    if (newHere && created) await greet(api, ledger);
    // Servers from before roles get their @everyone role from the owner.
    if (ledger.owner === ledger.me) await api.plugin("roles").call("ensure-everyone");
  }).catch((e) => {
    console.warn("Profile not sent:", e);
    // The invite stopped admitting before the join got this far (expired, deleted, used up): say so.
    if (joining && !isMember(ledger)) notify({
      tag: `join-refused:${entry.id}`, title: "You couldn't join the workspace",
      body: `${e instanceof Error ? e.message : String(e)} Leave it and join again with a new invite.`,
    });
  });

  return {
    entry, api, sync, ledger, rotateSecret,
    onRemoved(handler) {
      removedHandlers.push(handler);
    },
    onSecretChange(handler) {
      secretChangeHandlers.push(handler);
    },
    async close() {
      closing.abort();
      stopWatching();
      folderDescription.stop();
      stopDeclared();
      voiceLink.close();
      nodeLink.close();
      mapLink.close();
      contentLink.close();
      presence.close();
      botHosts.close();
      keyring.stop();
      setKeyring(entry.id, null);
      sync.close();
      api.close();
      await ledger.flushCheckpoint();
    },
  };
}

function isMember(ledger: Ledger): boolean {
  const userId = ledger.me;
  if (ledger.select("roles", "roles_bans", { user_id: userId }).length > 0) return false;
  return ledger.owner === userId
    || ledger.select("members", "members_profiles", { user_id: userId }).length > 0
    || ledger.select("nodes", "nodes_nodes", { user_id: userId }).some((row) => row.status === "authorized");
}

// A workspace kept in a folder writes its name and invite secret into it (server.json), so the folder alone is
// enough to import the workspace again. The name is written again when it changes.
async function describeFolder(entry: WorkspaceEntry, ledger: Ledger): Promise<{ write(): void; stop(): void }> {
  const storage = desktop?.storage;
  if (!storage || !(await storage.location(entry.id))) return { write() {}, stop() {} };
  let written: string | null = null;
  const write = () => {
    const name = workspaceName(ledger);
    const state = JSON.stringify([name, entry.secret, entry.v, entry.generation, entry.recoverySecrets]);
    if (state === written) return;
    written = state;
    storage.describe(entry.id, {
      name, secret: entry.secret || undefined, v: entry.v, generation: entry.generation, recoverySecrets: entry.recoverySecrets,
    }).catch((e) => console.warn("Workspace folder not described:", e));
  };
  write();
  return { write, stop: ledger.subscribe(write) };
}

function workspaceName(ledger: Ledger): string {
  return String(ledger.select("channels", "channels_workspace", {})[0]?.name ?? "");
}

// Commits come in batches after the first; a member who was here before (another device, a rejoin) has a profile
// somewhere in them. Done once nothing new arrived for a while, or after a minute at most.
const inviteWaitMs = 10 * 60_000;

// Whether the invite of this token is in the workspace's data (an unreadable token has nothing to wait for).
function hasInvite(ledger: Ledger, token: string): boolean {
  const key = inviteTokenKey(token);
  return !key || ledger.select("members", "members_invites", { token_key: key }).length > 0;
}

// Resolves once `check` holds, looked at again on every change of the ledger, after `maxMs`, or when `signal` aborts.
function waitFor(ledger: Ledger, check: () => boolean, maxMs: number, signal: AbortSignal): Promise<void> {
  if (check() || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const cap = setTimeout(done, maxMs);
    const stop = ledger.subscribe(() => {
      if (check()) done();
    });
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(cap);
      stop();
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

function settled(ledger: Ledger, quietMs = 3000, maxMs = 60_000): Promise<void> {
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

// The workspace's welcome channel, if it has one and it is a chat channel.
export function welcomeChannel(ledger: Ledger): number | null {
  const channelId = Number(ledger.select("channels", "channels_workspace", {})[0]?.welcome_channel_id ?? 0);
  const channel = channelId ? ledger.select("channels", "channels_channels", { id: channelId })[0] : undefined;
  return channel?.type === "chat" ? channelId : null;
}

// "<name> joined" in the workspace's welcome channel, when it has one.
async function greet(api: ApiClient, ledger: Ledger) {
  const channelId = welcomeChannel(ledger);
  if (channelId === null) return;
  await api.plugin("chat").call("post-join", { channel_id: channelId })
    .catch((e) => console.warn("Join message not posted:", e));
}

// "<name> left" or "<name> was kicked by <you>" in the welcome channel. Waits until the note is signed and, if
// members are online, a moment for it to reach them.
export async function postMemberNote(
  server: OpenWorkspace, note: { kind: "leave" } | { kind: "kick"; userId: number; name: string; ban?: boolean },
) {
  const channelId = welcomeChannel(server.ledger);
  if (channelId === null) return;
  const chat = server.api.plugin("chat");
  try {
    if (note.kind === "leave") await chat.call("post-leave", { channel_id: channelId });
    else await chat.call("post-kick", { channel_id: channelId, user_id: note.userId, name: note.name, ban: note.ban ?? false });
    await server.ledger.flush();
    if (note.kind === "leave" && server.sync.peers() > 0) await new Promise((resolve) => setTimeout(resolve, 1500));
  } catch (e) {
    console.warn(`The ${note.kind} note wasn't posted:`, e);
  }
}

function sendProfile(api: ApiClient, account: Account, inviteToken?: string) {
  return api.plugin("members").call<{ created: boolean }>("set-profile", {
    username: account.username, display_name: account.displayName, color: account.color, avatar: account.avatar,
    key_x: account.publicKey.x, key_y: account.publicKey.y,
    ...(inviteToken ? { invite_token: inviteToken } : {}),
  });
}

// The folder becomes the workspace's before anything is written, so all of it lands there.
async function startWorkspace(account: Account, name: string, folder?: Folder): Promise<OpenWorkspace> {
  const signer: Signer = { author: account.id, key: account.publicKey, privateKey: accountKey(), replica: randomId() };
  const { workspaceId, genesis } = await Ledger.createGenesis(signer);
  const entry: WorkspaceEntry = { id: workspaceId, secret: randomId(), v: 3, generation: 0, recoverySecrets: [], replica: signer.replica };
  if (folder) await storage().assign(folder.token, workspaceId, {
    name, secret: entry.secret, v: entry.v, generation: entry.generation, recoverySecrets: entry.recoverySecrets,
  });
  const server = await openWorkspace(entry, account, "none");
  await server.ledger.adopt(genesis);
  return server;
}

export async function createWorkspace(account: Account, name: string, folder?: Folder): Promise<OpenWorkspace> {
  const server = await startWorkspace(account, name, folder);
  await sendProfile(server.api, account);
  await seedWorkspace(server.api, name);
  await updateJoined(account, (list) => [...list, server.entry]);
  return server;
}

// A folder that already holds this server (a copy brought back) is opened with what it has.
export async function joinWorkspace(account: Account, code: string, folder?: Folder): Promise<OpenWorkspace> {
  const invite = parseInvite(code);
  if (!invite) throw new Error("That is not an invite code.");
  if (invite.v === 2) throw new Error("That invite code is from an older version of MakeWork and no longer admits anyone. Ask a member for a new invite.");
  if ((await joinedWorkspaces(account)).some((s) => s.id === invite.id)) throw new Error("You are already in that workspace.");
  return joinWorkspaceEntry(account, { id: invite.id, secret: invite.secret, v: 3, generation: 0, recoverySecrets: [] }, folder, invite.token);
}

// Takes a newer room secret from the account's server list when another copy of this account (another computer, an
// older or newer build) rotated it, so this copy stops looking in a room nobody is in. True when the entry changed.
export async function adoptNewerSecret(
  account: Account, id: string, saved: { secret: string; generation?: number; recoverySecrets?: string[] },
): Promise<boolean> {
  const entry = (await joinedWorkspaces(account)).find((item) => item.id === id);
  // Also when this copy has no secret yet (joined with an mw4 code) and the list has one.
  if (!entry || !saved.secret || (entry.secret && (saved.generation ?? 0) <= (entry.generation ?? 0))) return false;
  const recoverySecrets = [...new Set([...(entry.recoverySecrets ?? []), ...(saved.recoverySecrets ?? []), entry.secret])]
    .filter((secret) => secret && secret !== saved.secret);
  await updateJoined(account, (list) => list.map((item) => item.id === id
    ? { ...item, secret: saved.secret, generation: saved.generation, recoverySecrets }
    : item));
  return true;
}

export async function joinWorkspaceEntry(account: Account, entry: WorkspaceEntry, folder?: Folder, inviteToken?: string): Promise<OpenWorkspace> {
  if ((await joinedWorkspaces(account)).some((s) => s.id === entry.id)) throw new Error("You are already in that workspace.");
  const joined: WorkspaceEntry = { ...entry, replica: randomId(), ...(inviteToken ? { inviteToken } : {}) };
  if (folder) await storage().assign(folder.token, joined.id, {
    secret: joined.secret || undefined, v: joined.v, generation: joined.generation, recoverySecrets: joined.recoverySecrets,
  });
  const server = await openWorkspace(joined, account, "join", inviteToken);
  await updateJoined(account, (list) => [...list, joined]);
  return server;
}

// A folder picked with `desktop.storage.pickExisting`. Its own secret is used, else the invite code's.
export type ExistingFolder = Folder & {
  id: string; name: string; secret: string | null; v?: 2 | 3; generation?: number; recoverySecrets?: string[];
};

// A new replica as with a join: the folder's history may hold this device's commits from before under the old one.
export async function importWorkspace(account: Account, folder: ExistingFolder, code?: string): Promise<OpenWorkspace> {
  const invite = code?.trim() ? parseInvite(code) : null;
  if (code?.trim() && !invite) throw new Error("That is not an invite code.");
  if (invite && invite.id !== folder.id) throw new Error("That invite code is for another workspace than the folder's.");
  // An mw4 code has no room secret: the invite's room hands over the current one.
  const secret = folder.secret || invite?.secret || "";
  if (!secret && !invite?.token) throw new Error("This folder has no invite secret saved; enter the workspace's invite code to import it.");
  if ((await joinedWorkspaces(account)).some((s) => s.id === folder.id)) throw new Error("You are already in that workspace.");
  const entry: WorkspaceEntry = {
    id: folder.id, secret, v: 3, generation: folder.generation ?? 0,
    recoverySecrets: folder.recoverySecrets, replica: randomId(), ...(invite?.token ? { inviteToken: invite.token } : {}),
  };
  await storage().assign(folder.token, entry.id, {
    name: folder.name, secret: secret || undefined, v: entry.v, generation: entry.generation, recoverySecrets: entry.recoverySecrets,
  });
  const server = await openWorkspace(entry, account, invite?.token ? "join" : "open", invite?.token);
  await updateJoined(account, (list) => [...list, entry]);
  return server;
}

// Leaves the workspace. Without `keepData` this device's copy of its data is deleted; with it the history stays (in
// its folder, which can be imported again, or in the app's storage, used again when joining it again). The other
// members keep theirs either way. The replica goes in both cases: joining again starts a new one.
export async function leaveWorkspace(account: Account, server: OpenWorkspace, keepData: boolean): Promise<void> {
  await updateJoined(account, (list) => list.filter((s) => s.id !== server.entry.id));
  removeKey(replicaKey(account, server.entry.id));
  await server.close();
  if (keepData) {
    await desktop?.storage?.release(server.entry.id);
    return;
  }
  await clearCommits(server.entry.id);
  await desktop?.storage?.forget(server.entry.id);
}

function storage() {
  if (!desktop?.storage) throw new Error("Workspaces can only be stored in a folder in the desktop app.");
  return desktop.storage;
}

// Moves a closed server's data to a picked folder (electron/main.js copies, checks, then switches). From the app's
// storage its commits leave IndexedDB, and the file contents it used leave the shared store unless another workspace
// still keeps them.
export async function moveWorkspace(entry: WorkspaceEntry, folder: Folder, name: string): Promise<string> {
  const workspaceId = entry.id;
  if (await storage().location(workspaceId)) return storage().move(workspaceId, folder.token, {
    name, secret: entry.secret, v: entry.v, generation: entry.generation, recoverySecrets: entry.recoverySecrets,
  });
  const commits = await indexedCommits.load(workspaceId);
  const hashes = [...new Set(JSON.stringify(commits).match(/mwc:[0-9a-f]{64}/g) ?? [])].map((ref) => ref.slice(4));
  const moved = await storage().move(workspaceId, folder.token, {
    name, secret: entry.secret, v: entry.v, generation: entry.generation, recoverySecrets: entry.recoverySecrets, commits, hashes,
  });
  await clearCommits(workspaceId);
  const kept = wantedEverywhere();
  for (const hash of hashes) if (!kept.has(hash)) await desktop!.content?.removeShared(hash);
  return moved;
}

async function seedWorkspace(api: ApiClient, name: string) {
  await api.plugin("roles").call("ensure-everyone");
  const ext = api.plugin("channels");
  await ext.insert("channels_workspace", { name, short: "", color: "", icon: "" });
}

function randomId() {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}
