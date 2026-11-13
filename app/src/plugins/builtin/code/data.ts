import type { PluginClient } from "../../../api/client";
import type { ApiValue } from "../../../api/types";
import { createLive } from "../../live";

export interface CodeFile {
  id: number;
  parentId: number | null;
  kind: "file" | "folder";
  name: string;
  hash: string | null;
  size: number;
  language: string | null;
}

const row = (value: Record<string, ApiValue>): CodeFile => ({
  id: Number(value.id), parentId: value.parent_id == null ? null : Number(value.parent_id),
  kind: value.kind === "folder" ? "folder" : "file", name: String(value.name ?? "Untitled"),
  hash: value.hash == null ? null : String(value.hash), size: Number(value.size ?? 0),
  language: value.language == null ? null : String(value.language),
});

export async function listFiles(api: PluginClient, channelId: number): Promise<CodeFile[]> {
  const { rows } = await api.call<{ rows: Record<string, ApiValue>[] }>("list-files", { channel_id: channelId });
  return rows.map(row);
}

export const createFiles = (api: PluginClient, channelId: number) =>
  createLive<CodeFile[]>(api, [], () => channelId, () => listFiles(api, channelId));

export const addFile = (api: PluginClient, channelId: number, parentId: number | null, name: string, hash?: string, size?: number) =>
  api.call<{ id: number }>("add-file", { channel_id: channelId, parent_id: parentId, name, ...(hash ? { hash, size: size ?? 0 } : {}) });
export const addFolder = (api: PluginClient, channelId: number, parentId: number | null, name: string) =>
  api.call<{ id: number }>("add-folder", { channel_id: channelId, parent_id: parentId, name });

export const removeFiles = (api: PluginClient, ids: number[]) => Promise.all(ids.map((id) => api.call("remove", { file_id: id })));
export const restoreFiles = (api: PluginClient, ids: number[]) => Promise.all(ids.map((id) => api.call("restore", { file_id: id })));
export const renameFile = (api: PluginClient, id: number, name: string) => api.call("rename", { file_id: id, name });
export const moveFile = (api: PluginClient, id: number, parentId: number | null) => api.call("move", { file_id: id, parent_id: parentId });
export const setLanguage = (api: PluginClient, id: number, language: string) => api.call("set-content", { file_id: id, language });

export const isTextBlob = async (blob: Blob) => !(await blob.slice(0, 8192).text()).includes("\0");

// The replaced middle of two texts, so applying it keeps edits others made outside that part.
export function textChange(before: string, after: string) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return { start, remove: before.length - start - end, insert: after.slice(start, after.length - end) };
}
