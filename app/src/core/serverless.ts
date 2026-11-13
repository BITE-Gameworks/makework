// The serverless workspaces this account is in, connected to the rest of the app like any other workspace. Their invite
// codes are also kept in the account's vault on the user server (core/vault.ts), so the account's other computers
// join them too; only the codes, the data comes from the members as usual.
import { watchMessages } from "../plugins/builtin/chat/mentions";
import { createSignal } from "solid-js";
import type { HistoryNotice, Ledger } from "../p2p/ledger";
import { userNumberOf } from "../p2p/log";
import {
  adoptNewerSecret, createWorkspace, importWorkspace, joinWorkspace, joinWorkspaceEntry, joinedWorkspaces, leaveWorkspace, moveWorkspace, openWorkspace, postMemberNote, type ExistingFolder,
  type Folder, type OpenWorkspace, type Removal, type WorkspaceEntry,
} from "../p2p/workspaces";
import { inviteCode } from "../p2p/invite";
import { pairRoom, pairWithNode, parseNodeCode } from "../p2p/pair";
import { pagePathRule, validPagePath } from "../system/nodes";
import { currentTurn, loadTurn } from "../p2p/ice";
import { joinRoom } from "trystero";
import { call, leaveVoice, watchVoice } from "../voice/state";
import { account, accountAgreementKey, accountKey, accountPublished, accountSync } from "./account";
import { updateVault } from "./vault";
import { loadMembers, member } from "./members";
import { forgetCustomEmoji } from "./customEmoji";
import { notify } from "./notifier";
import { showNotice } from "./notices";
import { forgetNodes, loadNodes } from "./nodes";
import { isPopout } from "./popout";
import { forgetRoles, loadRoles } from "./roles";
import { closeTabs, openWorkspace as showServer, tabLocation, tabs } from "./navigation";
import { addWorkspace, channelLabel, removeWorkspace, workspaces, suspendWorkspace } from "./workspaces";
import { applyWorkspaceCommitAgain } from "./workspaceHistoryActions";
import { showOverlay, workspacePage } from "./ui";

const open = new Map<string, OpenWorkspace>();
const historyNoticeStops = new Map<string, () => void>();
const listVault = "servers";

// A workspace left on some computer stays in the list without its secret, so other computers don't add it back.
interface SavedServer {
  id: string;
  secret: string;
  v?: 2 | 3;
  generation?: number;
  recoverySecrets?: string[];
  at: number;
  left?: true;
}
type SavedServers = { v: 1; servers: SavedServer[] };
const [version, setVersion] = createSignal(0);

function me() {
  const signedIn = account();
  if (!signedIn) throw new Error("Not signed in.");
  return signedIn;
}

export function attach(server: OpenWorkspace) {
  const id = server.entry.id;
  historyNoticeStops.get(id)?.();
  historyNoticeStops.set(id, server.ledger.subscribeNotices((notices) => showHistoryNotices(id, notices)));
  open.set(id, server);
  setVersion((v) => v + 1);
  server.onRemoved((why) => void removedFrom(id, why).catch((e) => console.warn(`Leaving ${id} after the removal failed:`, e)));
  server.onSecretChange(() => recordServer(server.entry, false));
  addWorkspace(id, server.api);
  void loadMembers(id, server.api);
  void loadRoles(id, server.api, () => server.ledger.owner);
  void loadNodes(id, server.api);
  // Calls and mention pings belong to the main window; a view window only needs the data it shows.
  if (!isPopout()) {
    void watchVoice(id, server.api);
    watchMessages(id, server.api);
  }
}

const maxNoticeLines = 8;
// The same line many times (a hundred changes refused for one reason) is one line with a count.
function grouped(lines: string[]): string[] {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  const result = [...counts].map(([line, count]) => (count > 1 ? `${line} (${count} times)` : line));
  return result.length > maxNoticeLines ? [...result.slice(0, maxNoticeLines), `and ${result.length - maxNoticeLines} more`] : result;
}

// Data from a newer version (a table this one doesn't know): not the member's mistake, so one plain explanation.
const newerData = /^Unknown (table|plugin)/;

function showHistoryNotices(id: string, notices: HistoryNotice[]): void {
  const unknown = notices.filter((notice) => notice.kind === "rejected" && newerData.test(notice.reason ?? ""));
  const rejected = notices.filter((notice) => notice.kind === "rejected" && !unknown.includes(notice));
  const name = workspaces.byId[id]?.info.name ?? "workspace";
  if (unknown.length) {
    const tables = [...new Set(unknown.map((notice) => /Unknown \w+ ([^.]+)/.exec(notice.reason ?? "")?.[1] ?? ""))].filter(Boolean);
    showNotice(
      "Another MakeWork is newer than this one",
      `${unknown.length === 1 ? "A change" : `${unknown.length} changes`} in ${name} use data this version doesn't know${tables.length ? ` (${tables.slice(0, 3).join(", ")}${tables.length > 3 ? ", ..." : ""})` : ""}. `
        + "A member or another copy of this app on your account runs a newer version. Update this app to read them.",
    );
  }
  if (!rejected.length) return;
  const channelName = (channelId: number) => {
    const channel = workspaces.byId[id]?.allChannels.find((item) => item.id === channelId);
    return channel ? channelLabel(id, channel) : `channel ${channelId}`;
  };
  const parts = grouped([
    ...rejected.map((notice) => `${notice.reason ?? "One of your changes was refused"} in ${notice.channelId === null ? name : channelName(notice.channelId)}`),
  ]);
  showNotice(
    "Some of your changes weren't applied",
    parts.join(". ") + ".",
    [
      { label: "Show in history", run: () => showOverlay(workspacePage(id, "history")) },
      {
        label: "Apply again",
        run: () => void (async () => {
          for (const notice of rejected) {
            const ledger = open.get(id)?.ledger;
            if (!ledger) {
              showNotice("Change not applied again", "This workspace is no longer open.");
              break;
            }
            try {
              await applyWorkspaceCommitAgain(ledger, notice.commit.hash);
            } catch (error) {
              showNotice("Change not applied again", error instanceof Error ? error.message : String(error));
            }
          }
        })(),
      },
    ],
  );
}

function stopHistoryNotices(id: string): void {
  historyNoticeStops.get(id)?.();
  historyNoticeStops.delete(id);
}

export async function startServerless(): Promise<string[]> {
  const entries = await joinedWorkspaces(me());
  const opened = await Promise.allSettled(entries.map((entry) => openWorkspace(entry, me())));
  opened.forEach((result, i) => {
    if (result.status === "fulfilled") attach(result.value);
    else console.warn(`Server ${entries[i].id} not opened:`, result.reason);
  });
  void syncServerList();
  return [...open.keys()];
}

// Opens one workspace on its own, for a view window. False when this computer hasn't joined it (the view window
// then shows the workspace as not connected).
export async function startWorkspace(id: string): Promise<boolean> {
  const entry = (await joinedWorkspaces(me())).find((server) => server.id === id);
  if (!entry) return false;
  try {
    attach(await openWorkspace(entry, me()));
    return true;
  } catch (error) {
    console.warn(`Server ${id} not opened:`, error);
    return false;
  }
}

// Turns sync on for the open workspaces after the offline account was registered: its id doesn't change, so the app
// doesn't reopen them on its own. Each is closed and opened again, now with the network.
export async function resumeSync(): Promise<void> {
  if (me().offline) return;
  await refreshWorkspaceConnections();
}

export async function refreshWorkspaceConnections(): Promise<void> {
  if (call()) await leaveVoice();
  for (const id of [...open.keys()]) {
    const server = open.get(id);
    if (!server) continue;
    await closeForReopen(id, server);
    await reopen(id, server.entry);
  }
  if (!me().offline && !me().offlineMode) void syncServerList();
}

// Closes an open workspace so it can be opened again (new secret, the network back, a moved folder). A close that
// fails is only logged: the workspace is out of `open` either way, and the caller goes on to open it again.
async function closeForReopen(id: string, server: OpenWorkspace): Promise<void> {
  suspendWorkspace(id);
  stopHistoryNotices(id);
  open.delete(id);
  setVersion((v) => v + 1);
  await server.close().catch((e) => console.warn(`Workspace ${id} didn't close cleanly:`, e));
}

// This app is going (core/farewell.ts): every open workspace's members hear it at once (p2p/mesh.ts `bye`).
export function sayGoodbyeEverywhere(): Promise<void> {
  return Promise.allSettled([...open.values()].map((workspace) => workspace.sync.mesh?.bye())).then(() => {});
}

// The app quits (core/farewell.ts): every workspace closes cleanly, leaving its rooms and saving its checkpoint.
export async function closeAllWorkspaces(): Promise<void> {
  await Promise.allSettled([...open].map(([id, workspace]) => closeForReopen(id, workspace)));
}

// Opens a workspace again after closeForReopen. A failure is logged and told, and never stops the caller's loop over
// the other workspaces.
async function reopen(id: string, entry: WorkspaceEntry): Promise<boolean> {
  try {
    attach(await openWorkspace(entry, me()));
    return true;
  } catch (e) {
    console.warn(`Workspace ${id} not opened again:`, e);
    return false;
  }
}

// Joins the workspaces this account joined on its other computers, and adds the ones joined only here to its list.
async function syncServerList(): Promise<void> {
  // An offline account isn't on the user server, so its workspaces stay only on this device.
  if (me().offline || me().offlineMode) return;
  try {
    await accountPublished();
    if (accountSync().state !== "ok") return;
    const here = await joinedWorkspaces(me());
    const saved = await updateVault<SavedServers>(listVault, (current) => {
      const servers = current?.servers ?? [];
      const known = new Set(servers.map((s) => s.id));
      // A join still waiting for the room secret (an mw4 code) isn't listed until it has it.
      const missing = here.filter((e) => !known.has(e.id) && e.secret);
      const local = new Map(here.map((entry) => [entry.id, entry]));
      const refreshed = servers.map((saved) => {
        const entry = local.get(saved.id);
        // A copy with an older secret must not overwrite the list's newer one; it takes the list's below.
        if (entry && ((saved.generation ?? 0) > (entry.generation ?? 0) || !entry.secret)) return saved;
        return !entry || saved.left ? saved : {
          ...saved, secret: entry.secret, v: entry.v, generation: entry.generation,
          recoverySecrets: entry.recoverySecrets, at: saved.at,
        };
      });
      const next = [
        ...refreshed,
        ...missing.map((entry) => ({
          id: entry.id, secret: entry.secret, v: entry.v, generation: entry.generation,
          recoverySecrets: entry.recoverySecrets, at: Date.now(),
        })),
      ];
      if (current && JSON.stringify(next) === JSON.stringify(servers)) return null;
      return {
        v: 1, servers: next,
      };
    });
    for (const s of saved?.servers ?? []) {
      if (!s.left && await adoptNewerSecret(me(), s.id, s)) {
        // Opened again with the list's secret, so it joins the room the other members are in.
        const server = open.get(s.id);
        if (server) {
          // The replacement has a new in-memory voice table and MediaLink. Clear the old call intent so watchVoice
          // can resume the saved call against that replacement rather than leaving an empty, apparently joined view.
          if (call()?.workspaceId === s.id) await leaveVoice(false);
          await closeForReopen(s.id, server);
          const entry = (await joinedWorkspaces(me())).find((item) => item.id === s.id);
          if (entry) await reopen(s.id, entry);
        }
      }
      if (s.left || !s.secret || open.has(s.id) || (await joinedWorkspaces(me())).some((e) => e.id === s.id)) continue;
      try {
        attach(await joinWorkspaceEntry(me(), {
          id: s.id, secret: s.secret, v: 3,
          generation: s.generation, recoverySecrets: s.recoverySecrets,
        }));
      } catch (e) {
        console.warn(`Server ${s.id} from the account's list not joined:`, e);
      }
    }
  } catch (e) {
    console.warn("The account's server list wasn't synced:", e);
  }
}

function recordServer(entry: WorkspaceEntry, left: boolean) {
  // An offline account has no user server to keep the list on.
  if (me().offline || me().offlineMode) return;
  // Joined with a code without the room secret: listed once a member handed it over (onSecretChange), so the account's
  // other computers never open it with none.
  if (!left && !entry.secret) return;
  void updateVault<SavedServers>(listVault, (current) => ({
    v: 1,
    servers: [
      ...(current?.servers ?? []).filter((s) => s.id !== entry.id),
      left
        ? { id: entry.id, secret: "", v: entry.v, at: Date.now(), left: true }
        : {
            id: entry.id, secret: entry.secret, v: entry.v, generation: entry.generation,
            recoverySecrets: entry.recoverySecrets, at: Date.now(),
          },
    ],
  })).catch((e) => console.warn("The account's server list wasn't updated:", e));
}

// `folder`: where on this computer the workspace is kept (desktop); the app's storage without one.
export async function createServerless(name: string, folder?: Folder): Promise<void> {
  const server = await createWorkspace(me(), name, folder);
  attach(server);
  recordServer(server.entry, false);
  showServer(server.entry.id);
}

export async function joinServerless(code: string, folder?: Folder): Promise<void> {
  const server = await joinWorkspace(me(), code, folder);
  attach(server);
  recordServer(server.entry, false);
  showServer(server.entry.id);
}

// From a folder that holds a workspace's data (`desktop.storage.pickExisting`); `code` when the folder has no secret.
export async function importServerless(folder: ExistingFolder, code?: string): Promise<void> {
  const server = await importWorkspace(me(), folder, code);
  attach(server);
  recordServer(server.entry, false);
  showServer(server.entry.id);
}

// `note`: post "<name> left" in the welcome channel first (not when the account was kicked).
export const leaveQuestion = (name: string, keepData: boolean) => keepData
  ? `Leave ${name}? Everything stays saved on this computer, so you can come back to it later.`
  : `Leave ${name} and delete it from this computer? Other members keep their copy.`;

export async function leaveServerless(id: string, keepData: boolean, note = true): Promise<void> {
  const server = open.get(id);
  if (!server) return;
  if (note) await postMemberNote(server, { kind: "leave" });
  if (call()?.workspaceId === id) await leaveVoice();
  closeTabs(tabs().filter((t) => tabLocation(t)?.workspaceId === id).map((t) => t.id));
  removeWorkspace(id);
  forgetRoles(id);
  forgetCustomEmoji(id);
  forgetNodes(id);
  stopHistoryNotices(id);
  open.delete(id);
  setVersion((v) => v + 1);
  const leaving = leaveWorkspace(me(), server, keepData);
  const next = workspaces.order[0];
  if (next) showServer(next);
  await leaving;
  recordServer(server.entry, true);
}

// Kicked or banned: this device leaves the workspace and forgets its invite (here and in the account's list, so its
// other computers leave too). After a kick, joining again needs an invite; after a ban it can't be joined.
async function removedFrom(id: string, why: Removal): Promise<void> {
  const name = workspaces.byId[id]?.info.name || "a workspace";
  const who = why.by === null ? null : member(id, why.by).displayName;
  await leaveServerless(id, false, false);
  const title = why.banned ? `You are banned from ${name}` : `You were removed from ${name}`;
  const text = why.banned
    ? `${who ? `${who} banned you` : "You were banned"}. Changes you make there are refused, so the workspace was removed from this app.`
    : `${who ? `${who} removed you` : "You were removed"}. You can join again with an invite.`;
  showNotice(title, text);
  notify({ tag: `removed:${id}`, title, body: text });
}

// Moves the workspace's data to another folder: it is closed (leaving a call in it), moved, and opened again from
// there. Its tabs stay; their views come back once it is open. If the move fails it reopens where it was.
export async function relocateServerless(id: string, folder: Folder): Promise<string> {
  const server = open.get(id);
  if (!server) throw new Error("That workspace isn't open.");
  if (call()?.workspaceId === id) await leaveVoice();
  const name = workspaces.byId[id]?.info.name ?? "";
  await closeForReopen(id, server);
  // The move's own result or error is what the caller gets; opening again is a separate step that is only told.
  let moved: string;
  try {
    moved = await moveWorkspace(server.entry, folder, name);
  } catch (e) {
    await reopen(id, server.entry);
    throw e;
  }
  if (!(await reopen(id, server.entry)))
    showNotice(`${name || "The workspace"} moved`, "Its data is in the new folder, but it didn't open again. Restart the app to open it.");
  return moved;
}

export function isServerless(id: string): boolean {
  version();
  return open.has(id);
}

// An invite's code: the workspace and the token, no room secret (it would go stale with the next kick or ban).
export function workspaceInvite(id: string, token?: string): string | null {
  return token ? inviteCode(id, token) : null;
}

// Adds a node to a workspace from the code it printed (Workspace settings > Nodes > Add a node; p2p/pair.ts): checks
// the node's key, adds its row authorized (with its invite page's path, "" for none) and sends it the workspace. The
// node needs no invite. `step` says what is happening, for the form.
export async function addNode(id: string, codeText: string, page: string, step: (text: string) => void = () => {}): Promise<void> {
  const server = open.get(id);
  if (!server) throw new Error("That workspace isn't open.");
  const code = parseNodeCode(codeText);
  if (!code) throw new Error("That isn't a node's code: it starts with mwn1 (run `node makework-node.mjs code` on the node).");
  if (!validPagePath(page)) throw new Error(pagePathRule);
  if (!server.entry.secret) throw new Error("This workspace isn't connected yet. Try again once it is.");
  const signedIn = me();
  const agreementKey = accountAgreementKey();
  if (!agreementKey || !signedIn.publicKey.x || !signedIn.publicKey.y)
    throw new Error("This account can't seal the workspace for the node on this device.");
  await loadTurn();
  const { roomId, config } = pairRoom(code);
  const room = joinRoom({ ...config, get turnConfig() { return currentTurn(); } }, roomId);
  try {
    step("Looking for the node…");
    await pairWithNode(room, code, {
      id: signedIn.id, publicKey: { x: signedIn.publicKey.x, y: signedIn.publicKey.y }, privateKey: accountKey(), agreementKey,
    }, {
      onKey: () => step("Adding the node…"),
      authorize: async (key) => {
        await server.api.plugin("nodes").call("add", { user_id: userNumberOf(code.id), key_x: key.x, key_y: key.y, page });
        await server.ledger.flush();
        step("Sending it the workspace…");
      },
      workspace: () => ({
        workspace: id, name: workspaces.byId[id]?.info.name ?? "", secret: server.entry.secret,
        generation: server.entry.generation ?? 0, recoverySecrets: server.entry.recoverySecrets ?? [],
      }),
    });
  } finally {
    void room.leave();
  }
}

export async function rotateWorkspaceSecret(id: string): Promise<{ missed: number }> {
  const server = open.get(id);
  if (!server) throw new Error("That workspace isn't open.");
  return server.rotateSecret();
}

// "<name> was kicked by <you>" in the workspace's welcome channel.
export async function postKickNote(id: string, userId: number, name: string, ban = false): Promise<void> {
  const server = open.get(id);
  if (server) await postMemberNote(server, { kind: "kick", userId, name, ban });
}

// Other members online right now.
export function onlinePeers(id: string): number {
  version();
  return open.get(id)?.sync.peers() ?? 0;
}

// A member's account id: the author of their signed changes (their user id is the account id's first 6 bytes).
// Null if they never changed anything here, which joining always does (their profile).
export function accountIdOf(id: string, userId: number): string | null {
  const log = open.get(id)?.ledger.log() ?? [];
  return log.find(({ commit }) => userNumberOf(commit.author) === userId)?.commit.author ?? null;
}

// The workspace's signed log, for features that work on its tables directly (channel export and import).
export function workspaceLedger(id: string): Ledger | null {
  return open.get(id)?.ledger ?? null;
}
