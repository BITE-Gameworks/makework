import type { PluginClient } from "../../../api/client";
import type { ApiValue } from "../../../api/types";
import { decodeEmoji, encodeEmoji } from "../../../markdown/emoji";
import { createLive } from "../../live";

export interface DocPage {
  id: number;
  parentId: number | null;
  title: string;
  z: number;
  updatedBy: number;
  updatedAt: string;
}

const toPage = (row: Record<string, ApiValue>): DocPage => ({
  id: Number(row.id),
  parentId: row.parent_id == null ? null : Number(row.parent_id),
  title: decodeEmoji(String(row.title ?? "")),
  z: Number(row.z) || 0,
  updatedBy: Number(row.updated_by ?? row.author_id ?? 0),
  updatedAt: String(row.updated_at ?? row.created_at ?? ""),
});

export async function listPages(api: PluginClient, channelId: number): Promise<DocPage[]> {
  const { rows } = await api.call<{ rows: Record<string, ApiValue>[] }>("list-pages", { channel_id: channelId });
  return rows.map(toPage);
}

export const createPages = (api: PluginClient, channelId: number) =>
  createLive<DocPage[]>(api, [], () => channelId, () => listPages(api, channelId));

export async function addPage(api: PluginClient, channelId: number, parentId: number | null, title: string, body = ""): Promise<number> {
  const { id } = await api.call<{ id: number }>("add-page", { channel_id: channelId, parent_id: parentId, title: encodeEmoji(title), body: encodeEmoji(body) });
  return id;
}

export const updatePage = (api: PluginClient, id: number, change: { title?: string; body?: string }) =>
  api.call("update-page", {
    page_id: id,
    ...(change.title !== undefined ? { title: encodeEmoji(change.title) } : {}),
    ...(change.body !== undefined ? { body: encodeEmoji(change.body) } : {}),
  });

export const movePage = (api: PluginClient, id: number, parentId: number | null, z: number) =>
  api.call("move-page", { page_id: id, parent_id: parentId, z });

export const removePages = (api: PluginClient, ids: number[]) => api.call("remove-pages", { ids: JSON.stringify(ids) });
export const restorePages = (api: PluginClient, ids: number[]) => api.call("restore-pages", { ids: JSON.stringify(ids) });

// Every page with its text, for exports.
export async function allBodies(api: PluginClient, channelId: number): Promise<Map<number, string>> {
  const rows = await api.read("docs_pages", { channel_id: channelId });
  return new Map(rows.map((r) => [Number(r.id), decodeEmoji(String(r.body ?? ""))]));
}
