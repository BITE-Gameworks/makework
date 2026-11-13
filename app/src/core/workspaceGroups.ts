// Workspace groups in the workspace bar: several workspaces folded under one tile. A group is a personal
// arrangement, not workspace data: it is kept on this device under the signed-in account and synced through the
// account's preferences (core/syncedPrefs.ts), never in a workspace's signed log (ADR 0014).
import { createSignal } from "solid-js";
import { account } from "./account";
import { reorderIds } from "./order";
import { readJson, writeJson } from "./storage";
import { mergeWorkspaceOrder, savedWorkspaceOrder, saveWorkspaceOrder } from "./workspaceOrder";

export interface WorkspaceGroup {
  id: string;
  name: string;
  // In the member's order. Workspaces that are left keep their place, like the top-level order (ADR 0013).
  workspaceIds: string[];
}

export type BarEntry =
  | { kind: "workspace"; id: string }
  // `id` is the group's `group:<id>` token, so both kinds keep their identity in the bar (solid's reconcile).
  | { kind: "group"; id: string; group: WorkspaceGroup; workspaceIds: string[] };

const groupPrefix = "group:";
const defaultName = "New group";
const maxName = 64;

export function groupToken(id: string): string {
  return `${groupPrefix}${id}`;
}

export function isGroupToken(token: string): boolean {
  return token.startsWith(groupPrefix);
}

export function groupIdOfToken(token: string): string | null {
  return token.startsWith(groupPrefix) ? token.slice(groupPrefix.length) : null;
}

// What a remote preference document may hold: well-formed groups only, one group per workspace, no group tokens
// as members, and no empty groups.
export function normalizeWorkspaceGroups(value: unknown): WorkspaceGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: WorkspaceGroup[] = [];
  const groupIds = new Set<string>();
  const used = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== "string" || !id || id.includes(":") || groupIds.has(id)) continue;
    if (!Array.isArray(record.workspaceIds)) continue;
    const members: string[] = [];
    for (const member of record.workspaceIds) {
      if (typeof member !== "string" || !member || member.startsWith(groupPrefix)) continue;
      if (used.has(member) || members.includes(member)) continue;
      members.push(member);
    }
    if (members.length === 0) continue;
    for (const member of members) used.add(member);
    groupIds.add(id);
    const name = typeof record.name === "string" ? record.name.trim().slice(0, maxName) : "";
    groups.push({ id, name: name || "Group", workspaceIds: members });
  }
  return groups;
}

const [groups, setGroups] = createSignal<WorkspaceGroup[]>([]);
const [open, setOpen] = createSignal<string[]>([]);
const keyFor = (accountId: string) => `mw.workspaceGroups.${accountId}`;
const openKeyFor = (accountId: string) => `mw.workspaceGroups.open.${accountId}`;
// null means "loaded", but for no account; undefined means not loaded yet.
let loadedFor: string | null | undefined = undefined;

// Loads the signed-in account's groups once; called on every access, so it settles before anything else runs.
function loadedAccount(): string | null {
  const id = account()?.id ?? null;
  if (loadedFor === undefined || loadedFor !== id) {
    loadedFor = id;
    setGroups(id === null ? [] : normalizeWorkspaceGroups(readJson(keyFor(id), [])));
  }
  return loadedFor;
}

let openLoadedFor: string | null | undefined = undefined;

function loadedOpenAccount(): string | null {
  const id = account()?.id ?? null;
  if (openLoadedFor === undefined || openLoadedFor !== id) {
    openLoadedFor = id;
    const stored = id === null ? [] : readJson<unknown>(openKeyFor(id), []);
    setOpen(Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string") : []);
  }
  return openLoadedFor;
}

export function workspaceGroups(): WorkspaceGroup[] {
  loadedAccount();
  return groups();
}

export function workspaceGroupsSnapshot(): WorkspaceGroup[] {
  return workspaceGroups();
}

function saveGroups(next: WorkspaceGroup[]): void {
  const id = loadedAccount();
  if (id === null) return; // not signed in: nothing to keep a personal grouping for
  setGroups(next);
  writeJson(keyFor(id), next);
}

// A whole set from another computer, through the local store so the UI follows at once.
export function setWorkspaceGroups(next: unknown): void {
  if (loadedAccount() === null) return;
  saveGroups(normalizeWorkspaceGroups(next));
}

export function groupOfWorkspace(workspaceId: string): WorkspaceGroup | undefined {
  return workspaceGroups().find((group) => group.workspaceIds.includes(workspaceId));
}

export function isGroupOpen(id: string): boolean {
  loadedOpenAccount();
  return open().includes(id);
}

export function toggleGroupOpen(id: string): void {
  const accountId = loadedOpenAccount();
  if (accountId === null) return;
  const next = isGroupOpen(id) ? open().filter((item) => item !== id) : [...open(), id];
  setOpen(next);
  writeJson(openKeyFor(accountId), next);
}

export function openGroup(id: string): void {
  if (isGroupOpen(id)) return;
  const accountId = loadedOpenAccount();
  if (accountId === null) return;
  const next = [...open(), id];
  setOpen(next);
  writeJson(openKeyFor(accountId), next);
}

const cloneGroups = () => workspaceGroups().map((group) => ({ ...group, workspaceIds: [...group.workspaceIds] }));

// Where a group made from `ids` belongs: the next top-level entry after the earliest member's current place that
// the move itself does not take away.
function anchorAfter(order: string[], groups: WorkspaceGroup[], ids: string[]): string | null {
  const removing = new Set(ids);
  let start = -1;
  for (const id of ids) {
    const at = order.indexOf(id);
    const owner = at < 0 ? groups.find((group) => group.workspaceIds.includes(id)) : undefined;
    const tokenAt = owner ? order.indexOf(groupToken(owner.id)) : -1;
    const place = at >= 0 ? at : tokenAt;
    if (place >= 0 && (start < 0 || place < start)) start = place;
  }
  if (start < 0) return null;
  for (let i = start + 1; i < order.length; i++) if (!removing.has(order[i])) return order[i];
  return null;
}

// Takes the workspaces out of the top level and out of every group; groups left empty go with their tile.
function detach(order: string[], groups: WorkspaceGroup[], ids: string[]): void {
  const removing = new Set(ids);
  for (let i = order.length - 1; i >= 0; i--) if (removing.has(order[i])) order.splice(i, 1);
  for (const group of groups) group.workspaceIds = group.workspaceIds.filter((id) => !removing.has(id));
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i].workspaceIds.length > 0) continue;
    const at = order.indexOf(groupToken(groups[i].id));
    if (at >= 0) order.splice(at, 1);
    groups.splice(i, 1);
  }
}

function insertBefore(order: string[], token: string, before: string | null): void {
  const at = before === null ? -1 : order.indexOf(before);
  order.splice(at < 0 ? order.length : at, 0, token);
}

function commit(order: string[], groups: WorkspaceGroup[]): void {
  const beforeOrder = savedWorkspaceOrder();
  if (JSON.stringify(beforeOrder) !== JSON.stringify(order)) saveWorkspaceOrder(order);
  if (JSON.stringify(workspaceGroupsSnapshot()) !== JSON.stringify(groups)) saveGroups(groups);
}

const newGroupId = () => crypto.randomUUID();

export function createGroup(workspaceIds: string[]): WorkspaceGroup {
  const ids = [...new Set(workspaceIds.filter((id) => id && !id.startsWith(groupPrefix)))];
  if (ids.length === 0) throw new Error("A group needs a workspace.");
  const order = [...savedWorkspaceOrder()];
  const groups = cloneGroups();
  const before = anchorAfter(order, groups, ids);
  detach(order, groups, ids);
  const group: WorkspaceGroup = { id: newGroupId(), name: defaultName, workspaceIds: ids };
  groups.push(group);
  insertBefore(order, groupToken(group.id), before);
  commit(order, groups);
  openGroup(group.id);
  return group;
}

export function addToGroup(groupId: string, workspaceIds: string[], beforeId: string | null = null): void {
  const ids = [...new Set(workspaceIds.filter((id) => id && !id.startsWith(groupPrefix)))];
  if (ids.length === 0) return;
  const order = [...savedWorkspaceOrder()];
  const groups = cloneGroups();
  const target = groups.find((group) => group.id === groupId);
  if (!target) return;
  const adding = ids.filter((id) => !target.workspaceIds.includes(id));
  if (adding.length === 0) return;
  detach(order, groups, adding);
  const group = groups.find((item) => item.id === groupId);
  if (!group) return;
  const at = beforeId === null ? -1 : group.workspaceIds.indexOf(beforeId);
  group.workspaceIds.splice(at < 0 ? group.workspaceIds.length : at, 0, ...adding);
  commit(order, groups);
}

export function removeFromGroup(groupId: string, workspaceId: string): void {
  const order = [...savedWorkspaceOrder()];
  const groups = cloneGroups();
  const group = groups.find((item) => item.id === groupId);
  if (!group) return;
  const at = group.workspaceIds.indexOf(workspaceId);
  if (at < 0) return;
  group.workspaceIds.splice(at, 1);
  const tokenAt = order.indexOf(groupToken(groupId));
  if (group.workspaceIds.length === 0) {
    groups.splice(groups.indexOf(group), 1);
    if (tokenAt >= 0) {
      order.splice(tokenAt, 1);
      order.splice(tokenAt, 0, workspaceId);
    } else order.push(workspaceId);
  } else {
    order.splice(tokenAt >= 0 ? tokenAt + 1 : order.length, 0, workspaceId);
  }
  commit(order, groups);
}

export function dissolveGroup(groupId: string): void {
  const order = [...savedWorkspaceOrder()];
  const groups = cloneGroups();
  const at = groups.findIndex((group) => group.id === groupId);
  if (at < 0) return;
  const [group] = groups.splice(at, 1);
  const tokenAt = order.indexOf(groupToken(groupId));
  if (tokenAt >= 0) order.splice(tokenAt, 1, ...group.workspaceIds);
  else order.push(...group.workspaceIds);
  commit(order, groups);
}

export function renameGroup(groupId: string, name: string): void {
  const clean = name.trim().slice(0, maxName);
  if (!clean) return;
  const groups = cloneGroups();
  const group = groups.find((item) => item.id === groupId);
  if (!group || group.name === clean) return;
  group.name = clean;
  commit([...savedWorkspaceOrder()], groups);
}

export function reorderGroupMembers(groupId: string, workspaceId: string, beforeId: string | null): void {
  const groups = cloneGroups();
  const group = groups.find((item) => item.id === groupId);
  if (!group) return;
  const next = reorderIds(group.workspaceIds, workspaceId, beforeId);
  if (next === group.workspaceIds) return;
  group.workspaceIds = next;
  commit([...savedWorkspaceOrder()], groups);
}

// A group tile is a top-level entry like a workspace; `before` is the entry it goes before (null: the end).
// Moves a workspace id or group token before another one (null: the end) among the bar's top-level entries
// (`shown`, as the bar lists them). Closed workspaces keep their slots in the saved order.
export function moveTopLevel(token: string, before: string | null, shown: readonly BarEntry[]): void {
  const display = shown.map((entry) => entry.id);
  const next = reorderIds(display, token, before);
  if (next === display) return;
  commit(mergeWorkspaceOrder(savedWorkspaceOrder(), next), cloneGroups());
}

// The bar's top-level entries in order: workspace ids and group tiles, with each group's connected members.
export function barEntries(order: readonly string[], groups: readonly WorkspaceGroup[], connected: readonly string[]): BarEntry[] {
  const online = new Set(connected);
  const members = new Set(groups.flatMap((group) => group.workspaceIds));
  const byId = new Map(groups.map((group) => [group.id, group]));
  const entries: BarEntry[] = [];
  const placed = new Set<string>();
  const seenGroups = new Set<string>();

  const placeGroup = (group: WorkspaceGroup) => {
    const workspaceIds = group.workspaceIds.filter((id) => online.has(id) && !placed.has(id));
    for (const id of workspaceIds) placed.add(id);
    if (workspaceIds.length > 0) entries.push({ kind: "group", id: groupToken(group.id), group, workspaceIds });
  };

  for (const token of order) {
    if (isGroupToken(token)) {
      const id = groupIdOfToken(token);
      const group = id === null ? undefined : byId.get(id);
      if (!group || seenGroups.has(group.id)) continue;
      seenGroups.add(group.id);
      placeGroup(group);
      continue;
    }
    if (!online.has(token) || placed.has(token) || members.has(token)) continue;
    placed.add(token);
    entries.push({ kind: "workspace", id: token });
  }

  for (const id of connected) {
    if (placed.has(id) || members.has(id)) continue;
    placed.add(id);
    entries.push({ kind: "workspace", id });
  }

  // A group the order does not mention (an older order copy reached this computer first) is still shown.
  for (const group of groups) {
    if (seenGroups.has(group.id)) continue;
    seenGroups.add(group.id);
    placeGroup(group);
  }
  return entries;
}

// The workspaces in the order the bar shows them, with a group's members at the group tile's place.
export function flattenedOrder(entries: readonly BarEntry[]): string[] {
  return entries.flatMap((entry) => (entry.kind === "workspace" ? [entry.id] : entry.workspaceIds));
}
