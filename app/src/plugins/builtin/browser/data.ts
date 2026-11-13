import type { PluginClient } from "../../../api/client";
import type { ApiValue } from "../../../api/types";
import { createLive } from "../../live";

export interface Bookmark {
  id: number;
  url: string;
  title: string;
  z: number;
}
export interface Visit {
  id: number;
  url: string;
  title: string;
  authorId: number;
  visitedAt: string;
}
export interface BrowserExtension {
  id: number;
  extensionId: string;
  name: string;
  version: string;
}
export interface ChannelExtension {
  id: number;
  extensionId: string;
  enabled: boolean;
}

const toBookmark = (row: Record<string, ApiValue>): Bookmark => ({
  id: Number(row.id), url: String(row.url), title: String(row.title ?? ""), z: Number(row.z),
});

export const createBookmarks = (api: PluginClient, channelId: number) =>
  createLive<Bookmark[]>(api, [], () => channelId, async () =>
    (await api.call<{ rows: Record<string, ApiValue>[] }>("list-bookmarks", { channel_id: channelId })).rows.map(toBookmark));

export async function storedPage(api: PluginClient, channelId: number): Promise<string | null> {
  const page = await api.call<{ url: string | null }>("get-page", { channel_id: channelId });
  return page.url;
}

export const savePage = (api: PluginClient, channelId: number, url: string, title: string) =>
  api.call("set-page", { channel_id: channelId, url, title });

export const clearPage = (api: PluginClient, channelId: number) => api.call("clear-page", { channel_id: channelId });

const toVisit = (row: Record<string, ApiValue>): Visit => ({
  id: Number(row.id), url: String(row.url), title: String(row.title ?? ""), authorId: Number(row.author_id), visitedAt: String(row.visited_at),
});

export const createHistory = (api: PluginClient, channelId: number) =>
  createLive<Visit[]>(api, [], () => channelId, async () =>
    (await api.call<{ rows: Record<string, ApiValue>[] }>("list-history", { channel_id: channelId })).rows.map(toVisit));

export const clearHistory = (api: PluginClient, channelId: number) => api.call("clear-history", { channel_id: channelId });

export const addBookmark = (api: PluginClient, channelId: number, url: string, title: string) =>
  api.call<{ id: number }>("add-bookmark", { channel_id: channelId, url, title });

export const renameBookmark = (api: PluginClient, id: number, title: string) =>
  api.call("rename-bookmark", { bookmark_id: id, title });

export const removeBookmark = (api: PluginClient, id: number) => api.call("remove-bookmark", { bookmark_id: id });
export const restoreBookmark = (api: PluginClient, id: number) => api.call("restore-bookmark", { bookmark_id: id });

const toExtension = (row: Record<string, ApiValue>): BrowserExtension => ({
  id: Number(row.id), extensionId: String(row.extension_id), name: String(row.name), version: String(row.version),
});
const toChannelExtension = (row: Record<string, ApiValue>): ChannelExtension => ({
  id: Number(row.id), extensionId: String(row.extension_id), enabled: row.enabled === true,
});

export const createExtensions = (api: PluginClient) =>
  createLive<BrowserExtension[]>(api, [], () => true, async () =>
    (await api.call<{ rows: Record<string, ApiValue>[] }>("list-extensions")).rows.map(toExtension));

export const createChannelExtensions = (api: PluginClient, channelId: number) =>
  createLive<ChannelExtension[]>(api, [], () => channelId, async () =>
    (await api.call<{ rows: Record<string, ApiValue>[] }>("list-channel-extensions", { channel_id: channelId })).rows.map(toChannelExtension));
