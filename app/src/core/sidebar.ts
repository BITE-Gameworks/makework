// Per-user sidebar state, kept on this device: starred channels, collapsed categories, unread markers and
// unread mention counts. Unread and mentions are not persisted; they will come from the workspace once there are
// live events. New chat messages mark them (chat/mentions.ts `watchMessages`), opening a channel clears them.
import { createSignal } from "solid-js";
import { readJson, writeJson } from "./storage";

type PerServer = Record<string, number[]>;

const starredKey = "mw.sidebar.starred";
const collapsedKey = "mw.sidebar.collapsed";

const [starred, setStarred] = createSignal<PerServer>(readJson(starredKey, {}));
const [collapsed, setCollapsed] = createSignal<PerServer>(readJson(collapsedKey, {}));
const [unread, setUnread] = createSignal<PerServer>({});
// Unread mentions of the signed-in user, per workspace and channel.
const [mentions, setMentions] = createSignal<Record<string, Record<number, number>>>({});

export function starredIds(workspaceId: string): number[] {
  return starred()[workspaceId] ?? [];
}

export function isStarred(workspaceId: string, channelId: number): boolean {
  return starredIds(workspaceId).includes(channelId);
}

export function toggleStar(workspaceId: string, channelId: number): void {
  setStarred((all) => ({ ...all, [workspaceId]: toggle(all[workspaceId] ?? [], channelId) }));
  writeJson(starredKey, starred());
}

export function isCollapsed(workspaceId: string, categoryId: number): boolean {
  return (collapsed()[workspaceId] ?? []).includes(categoryId);
}

export function toggleCollapsed(workspaceId: string, categoryId: number): void {
  setCollapsed((all) => ({ ...all, [workspaceId]: toggle(all[workspaceId] ?? [], categoryId) }));
  writeJson(collapsedKey, collapsed());
}

export function isUnread(workspaceId: string, channelId: number): boolean {
  return (unread()[workspaceId] ?? []).includes(channelId);
}

export function hasUnread(workspaceId: string): boolean {
  return (unread()[workspaceId] ?? []).length > 0;
}

export function markUnread(workspaceId: string, channelId: number, mentioned: boolean): void {
  if (!isUnread(workspaceId, channelId)) setUnread((all) => ({ ...all, [workspaceId]: [...(all[workspaceId] ?? []), channelId] }));
  if (mentioned) setMentions((all) => ({ ...all, [workspaceId]: { ...all[workspaceId], [channelId]: mentionCount(workspaceId, channelId) + 1 } }));
}

export function mentionCount(workspaceId: string, channelId: number): number {
  return mentions()[workspaceId]?.[channelId] ?? 0;
}

export function serverMentions(workspaceId: string): number {
  return Object.values(mentions()[workspaceId] ?? {}).reduce((sum, n) => sum + n, 0);
}

export function totalMentions(): number {
  return Object.keys(mentions()).reduce((sum, id) => sum + serverMentions(id), 0);
}

export function markRead(workspaceId: string, channelId: number): void {
  if (isUnread(workspaceId, channelId)) setUnread((all) => ({ ...all, [workspaceId]: (all[workspaceId] ?? []).filter((id) => id !== channelId) }));
  if (mentionCount(workspaceId, channelId)) {
    setMentions((all) => {
      const { [channelId]: _cleared, ...rest } = all[workspaceId] ?? {};
      return { ...all, [workspaceId]: rest };
    });
  }
}

function toggle(list: number[], id: number): number[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}
