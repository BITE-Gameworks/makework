// Every workspace this client is connected to, each with its own ApiClient, and its channel list.
import { createEffect, createRoot, createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { userMessage, type ApiClient } from "../api/client";
import { canEditIn, canSee } from "../p2p/visibility";
import { channelPermissions, standing, type Permission } from "../p2p/permissions";
import { memberList, myId } from "./members";
import { can, roleTablesOf, rolesLoaded, workspaceOwner, standingOf } from "./roles";
import { isNode } from "./nodes";
import { isPopout } from "./popout";
import type { Row } from "../api/types";
import { setWorkspaceOrderSource } from "./navigation";
import { readJson, writeJson } from "./storage";
import { startBots, stopBots } from "./bots";
import { reorderIds } from "./order";
import { mergeWorkspaceOrder, saveWorkspaceOrder, savedWorkspaceOrder } from "./workspaceOrder";
import { barEntries, flattenedOrder, workspaceGroups } from "./workspaceGroups";

export interface WorkspaceInfo {
  name: string;
  short: string;
  color: string;
  icon: string;
  welcomeChannelId: number | null;
  // Joined, but no member who has the workspace's data was reached yet.
  pending?: boolean;
}

export interface Category {
  id: number;
  name: string;
  position: number;
}

export interface Channel {
  id: number;
  categoryId: number;
  name: string;
  type: string;
  position: number;
  // Seconds a member must wait between messages; 0 is off (chat channels).
  slowMode: number;
}

export interface WorkspaceData {
  id: string;
  status: "loading" | "ready" | "error";
  error?: string;
  info: WorkspaceInfo;
  // What the signed-in member sees (channels_visibility rules applied), and everything, for the visibility editor.
  categories: Category[];
  channels: Channel[];
  allCategories: Category[];
  allChannels: Channel[];
  visibility: Row[];
}

// A new object each time: the store changes info objects in place (reconcile), so a shared one would make every
// workspace that started out joining show the same name and icon.
const joining = (): WorkspaceInfo => ({ name: "Joining...", short: "", color: "", icon: "", welcomeChannelId: null, pending: true });

const clients = new Map<string, ApiClient>();
const [workspaces, setWorkspaces] = createStore<{ order: string[]; byId: Record<string, WorkspaceData> }>({ order: [], byId: {} });
// The connected workspaces in the order they joined. The bar's order comes from the saved order and the groups
// on top of it; this is only what to append when neither mentions a workspace yet.
const [connected, setConnected] = createSignal<string[]>([]);

export { workspaces };
setWorkspaceOrderSource(() => workspaces.order);

// The bar's flat order: groups' members sit where their group tile sits (core/workspaceGroups.ts).
function refreshOrder(): void {
  const entries = barEntries(savedWorkspaceOrder(), workspaceGroups(), connected());
  const next = flattenedOrder(entries);
  const previous = workspaces.order;
  if (previous.length === next.length && previous.every((id, index) => id === next[index])) return;
  setWorkspaces("order", next);
}
createRoot(() => {
  createEffect(refreshOrder);
});

export function workspaceList(): WorkspaceData[] {
  return workspaces.order.map((id) => workspaces.byId[id]).filter((workspace): workspace is WorkspaceData => !!workspace);
}

// The order the member arranged, including workspaces that are not connected now; saved on this device and in the
// account's preferences (core/syncedPrefs.ts). It reads the signal, so the preference diff sees a move.
export function setWorkspaceOrder(ids: string[]): void {
  saveWorkspaceOrder(ids);
}

// Moves a workspace before `beforeId` among the top-level workspaces, or to the end. Closed workspaces keep their
// slots in the saved order, so a later rejoin comes back to its old place.
export function moveWorkspace(id: string, beforeId: string | null): void {
  const topLevel = barEntries(savedWorkspaceOrder(), workspaceGroups(), connected())
    .flatMap((entry) => (entry.kind === "workspace" ? [entry.id] : []));
  const next = reorderIds(topLevel, id, beforeId);
  if (next !== topLevel) setWorkspaceOrder(mergeWorkspaceOrder(savedWorkspaceOrder(), next));
}

export function workspaceApi(workspaceId: string): ApiClient {
  const client = clients.get(workspaceId);
  if (!client) throw new Error(`Not connected to workspace '${workspaceId}'.`);
  return client;
}

// Adding a workspace that is already connected replaces its connection.
export function addWorkspace(id: string, client: ApiClient): void {
  const previous = clients.get(id);
  if (previous && previous !== client) previous.close();
  clients.set(id, client);
  if (!workspaces.byId[id])
    setWorkspaces("byId", id, {
      id, status: "loading", categories: [], channels: [], allCategories: [], allChannels: [], visibility: [], info: joining(),
    });
  if (!visibilityFilters.has(id))
    visibilityFilters.set(id, createRoot((dispose) => {
      createEffect(() => applyVisibility(id));
      return dispose;
    }));
  if (!connected().includes(id)) setConnected((ids) => [...ids, id]);
  client.plugin("channels").onEvent(() => void load(id));
  void load(id);
  // Bots run once per account: the main window runs them, a view window showing the same workspace does not.
  if (!isPopout()) startBots(id, client);
}

// While a workspace is closed and opened again (moved to another folder): its channels go, so open views close
// and come back on the new connection once `addWorkspace` loads them again. It keeps its place and tabs.
export function suspendWorkspace(id: string): void {
  stopBots(id);
  hasInfo.delete(id);
  if (workspaces.byId[id]) setWorkspaces("byId", id, { status: "loading", channels: [], allChannels: [] });
}

export function removeWorkspace(id: string): void {
  stopBots(id);
  clients.get(id)?.close();
  clients.delete(id);
  visibilityFilters.get(id)?.();
  visibilityFilters.delete(id);
  hasInfo.delete(id);
  // The order first, the data after: the order follows `connected` through an effect, and views listing workspaces
  // (the workspace bar's buttons) follow the order. Removed in one batch, a button read the workspace's data before
  // the order dropped it and threw; Solid then dropped every effect still queued, this order's own too, so the bar
  // and workspaceList() stayed as they were until a reload. The bar also shows a button only while its
  // data is there, for a call from inside a batch or an effect, where both writes would land together again.
  setConnected((ids) => ids.filter((workspaceId) => workspaceId !== id));
  setWorkspaces("byId", id, undefined!);
}

const visibilityFilters = new Map<string, () => void>();
// Workspaces whose data (name, channels) arrived; they are ready once their roles are read too.
const hasInfo = new Set<string>();

// Keeps `channels` and `categories` to what the member may see, also when roles or rules change.
function applyVisibility(id: string): void {
  const workspace = workspaces.byId[id];
  if (!workspace) return;
  const shown = visibleTo(id, workspace.allCategories, workspace.allChannels, workspace.visibility);
  // Loaded before the roles were: ready now that they are.
  if (workspace.status === "loading" && hasInfo.has(id) && rolesLoaded(id)) setWorkspaces("byId", id, "status", "ready");
  setWorkspaces("byId", id, "channels", reconcile(shown.channels.map((c) => ({ ...c })), { key: "id" }));
  setWorkspaces("byId", id, "categories", reconcile(shown.categories.map((c) => ({ ...c })), { key: "id" }));
}

// Nothing until the roles are read: before that, rules for @everyone or a role match nobody and hidden channels
// would show for a moment (and open in restored tabs). Until the member's id is known, only what everyone may
// see. Empty categories show if the member sees the category itself and the category is really empty, or the
// member manages channels (to add some).
function visibleTo(id: string, categories: Category[], channels: Channel[], rules: Row[]) {
  if (!rolesLoaded(id)) return { channels: [], categories: [] };
  const me = myId(id) ?? -1;
  const roles = roleTablesOf(id);
  const owner = workspaceOwner(id);
  const shown = channels.filter((c) => canSee(rules, roles, owner, me, { channelId: c.id, categoryId: c.categoryId }));
  const manager = can(id, "manage_channels");
  return {
    channels: shown,
    categories: categories.filter((cat) => shown.some((c) => c.categoryId === cat.id)
      || (canSee(rules, roles, owner, me, { categoryId: cat.id }) && (manager || !channels.some((c) => c.categoryId === cat.id)))),
  };
}

async function load(id: string): Promise<void> {
  const ext = workspaceApi(id).plugin("channels");
  try {
    const [info, categories, channels, visibility] = await Promise.all([
      ext.read("channels_workspace"), ext.read("channels_categories"), ext.read("channels_channels"), ext.read("channels_visibility"),
    ]);
    if (info[0]) hasInfo.add(id);
    rememberTypes(id, channels);
    const all = { categories: categories.map(toCategory).sort(byPosition), channels: channels.map(toChannel).sort(byPosition) };
    // A workspace just joined has no data until a member who has it comes online.
    setWorkspaces("byId", id, reconcile({
      id,
      status: info[0] && rolesLoaded(id) ? "ready" : "loading",
      info: info[0] ? toInfo(info[0]) : joining(),
      ...visibleTo(id, all.categories, all.channels, visibility),
      allCategories: all.categories,
      allChannels: all.channels,
      visibility,
    } satisfies WorkspaceData));
  } catch (e) {
    setWorkspaces("byId", id, { status: "error", error: userMessage(e) });
  }
}

// Each channel's type, kept on this device, so the view starting up before the channel list loads (app start,
// joining) can already show the right loading shape.
const typesKey = "mw.channelTypes";
const knownTypes: Record<string, Record<number, string>> = readJson(typesKey, {});

function rememberTypes(workspaceId: string, channels: Row[]) {
  const types = Object.fromEntries(channels.map((c) => [c.id, String(c.type ?? "")]));
  if (JSON.stringify(types) === JSON.stringify(knownTypes[workspaceId] ?? {})) return;
  knownTypes[workspaceId] = types;
  writeJson(typesKey, knownTypes);
}

export function channelTypeOf(workspaceId: string, channelId: number | null): string | undefined {
  if (channelId === null) return undefined;
  return workspaces.byId[workspaceId]?.allChannels.find((c) => c.id === channelId)?.type ?? knownTypes[workspaceId]?.[channelId];
}

export async function addChannel(workspaceId: string, categoryId: number, name: string, type: string): Promise<number> {
  const { id } = await workspaceApi(workspaceId).plugin("channels")
    .call<{ id: number }>("add-channel", { category_id: categoryId, name, type });
  return id;
}

export async function addCategory(workspaceId: string, name: string): Promise<number> {
  const { id } = await workspaceApi(workspaceId).plugin("channels").call<{ id: number }>("add-category", { name });
  return id;
}

export async function deleteChannel(workspaceId: string, channelId: number): Promise<void> {
  await workspaceApi(workspaceId).plugin("channels").call("delete-channel", { channel_id: channelId });
}

// Moves a channel before `beforeId` in a category, or to its end.
export async function moveChannel(workspaceId: string, channelId: number, categoryId: number, beforeId: number | null): Promise<void> {
  await workspaceApi(workspaceId).plugin("channels").call("move-channel", { channel_id: channelId, category_id: categoryId, before_id: beforeId });
}

export async function renameChannel(workspaceId: string, channelId: number, name: string): Promise<void> {
  await workspaceApi(workspaceId).plugin("channels").call("rename-channel", { channel_id: channelId, name });
}

export async function setSlowMode(workspaceId: string, channelId: number, seconds: number): Promise<void> {
  await workspaceApi(workspaceId).plugin("channels").call("set-slow-mode", { channel_id: channelId, seconds });
}

export async function renameCategory(workspaceId: string, categoryId: number, name: string): Promise<void> {
  await workspaceApi(workspaceId).plugin("channels").call("rename-category", { category_id: categoryId, name });
}

export async function deleteCategory(workspaceId: string, categoryId: number): Promise<void> {
  await workspaceApi(workspaceId).plugin("channels").call("delete-category", { category_id: categoryId });
}

export function findChannel(workspaceId: string, channelId: number | null): Channel | undefined {
  return channelId === null ? undefined : workspaces.byId[workspaceId]?.channels.find((c) => c.id === channelId);
}

export function findCategory(workspaceId: string, categoryId: number): Category | undefined {
  return workspaces.byId[workspaceId]?.categories.find((c) => c.id === categoryId);
}

function byPosition(a: { position: number; id: number }, b: { position: number; id: number }) {
  return a.position - b.position || a.id - b.id;
}

// The workspace's picture: `icon` holds an uploaded image as a data URL (ui/avatarImage), or a built-in icon's name.
const imageUrl = /^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i;
export function workspaceImage(info: WorkspaceInfo): string | null {
  return imageUrl.test(info.icon) ? info.icon : null;
}

function toInfo(row: Row): WorkspaceInfo {
  return {
    name: String(row.name ?? ""), short: String(row.short ?? ""), color: String(row.color ?? ""), icon: String(row.icon ?? ""),
    welcomeChannelId: row.welcome_channel_id ? Number(row.welcome_channel_id) : null, pending: false,
  };
}

function toCategory(row: Row): Category {
  return { id: row.id, name: String(row.name ?? ""), position: Number(row.position ?? 0) };
}

function toChannel(row: Row): Channel {
  return {
    id: row.id, categoryId: Number(row.category_id), name: String(row.name ?? ""),
    type: String(row.type ?? ""), position: Number(row.position ?? 0), slowMode: Number(row.slow_mode ?? 0),
  };
}

// How a channel is named in lists: #name, or category/name when another channel has the same name.
export function channelLabel(workspaceId: string, channel: Channel): string {
  const all = workspaces.byId[workspaceId]?.allChannels ?? [];
  const shared = all.some((c) => c.id !== channel.id && c.name === channel.name);
  return shared ? `${findCategory(workspaceId, channel.categoryId)?.name ?? ""}/${channel.name}` : `#${channel.name}`;
}

// A workspace permission in one channel: its edit rules (p2p/visibility.ts) give or take the ones that change
// things there, like the policy does.
// Whether a member (the signed-in user by default) has a permission inside a channel.
export function canInChannel(workspaceId: string, channelId: number, permission: Permission, userId = myId(workspaceId)): boolean {
  if (userId === null) return false;
  const anywhere = () => standingOf(workspaceId, userId).permissions.has(permission);
  const channel = workspaces.byId[workspaceId]?.allChannels.find((c) => c.id === channelId);
  if (!channel || !channelPermissions.includes(permission)) return anywhere();
  const edit = canEditIn(workspaces.byId[workspaceId].visibility, roleTablesOf(workspaceId), workspaceOwner(workspaceId), userId,
    { channelId, categoryId: channel.categoryId });
  return edit ?? anywhere();
}

// Whether a member (a bot, say) sees a channel by the visibility rules.
export function canSeeChannel(workspaceId: string, channelId: number, userId: number): boolean {
  const workspace = workspaces.byId[workspaceId];
  const channel = workspace?.allChannels.find((c) => c.id === channelId);
  if (!workspace || !channel) return false;
  return canSee(workspace.visibility, roleTablesOf(workspaceId), workspaceOwner(workspaceId), userId, { channelId, categoryId: channel.categoryId });
}

// How many members see a channel (channelId) or a category (no channelId), by the visibility rules.
export function seenBy(workspaceId: string, target: { channelId?: number; categoryId: number | null }): { seeing: number; total: number } {
  const list = memberList(workspaceId).filter((m) => !m.bot && !isNode(workspaceId, m.id));
  const rules = workspaces.byId[workspaceId]?.visibility ?? [];
  const roles = roleTablesOf(workspaceId);
  const owner = workspaceOwner(workspaceId);
  return { seeing: list.filter((m) => canSee(rules, roles, owner, m.id, target)).length, total: list.length };
}

// How many members may change things in a channel or category: they see it, and its edit rules or their
// server permissions let them.
export function editableBy(workspaceId: string, target: { channelId?: number; categoryId: number | null }): { editing: number; total: number } {
  const list = memberList(workspaceId).filter((m) => !m.bot && !isNode(workspaceId, m.id));
  const rules = workspaces.byId[workspaceId]?.visibility ?? [];
  const roles = roleTablesOf(workspaceId);
  const owner = workspaceOwner(workspaceId);
  const editing = list.filter((m) => canSee(rules, roles, owner, m.id, target)
    && (canEditIn(rules, roles, owner, m.id, target) ?? standing(roles, m.id, owner).permissions.has("edit_content"))).length;
  return { editing, total: list.length };
}
