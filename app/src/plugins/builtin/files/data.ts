import type { Accessor } from "solid-js";
import type { PluginClient } from "../../../api/client";
import type { ApiValue } from "../../../api/types";
import { readJson, writeJson } from "../../../core/storage";
import { uploadAndPost } from "../../../core/files";
import type { UploadTree } from "./folders";
import { createLive } from "../../live";

export interface Entry {
  id: number;
  parentId: number | null;
  kind: "folder" | "file";
  name: string;
  mime: string;
  size: number;
  url: string | null;
  thumb: string | null;
  width: number | null;
  height: number | null;
  authorId: number;
  createdAt: string;
}

export interface Listing {
  entries: Entry[];
  path: { id: number; name: string }[];
}

export function toEntry(row: Record<string, ApiValue>): Entry {
  return {
    id: Number(row.id),
    parentId: row.parent_id === null ? null : Number(row.parent_id),
    kind: row.kind === "folder" ? "folder" : "file",
    name: String(row.name),
    mime: String(row.mime ?? ""),
    size: Number(row.size ?? 0),
    url: row.url ? String(row.url) : null,
    thumb: row.thumb ? String(row.thumb) : null,
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    authorId: Number(row.author_id),
    createdAt: String(row.created_at),
  };
}

const byName = (a: Entry, b: Entry) =>
  (a.kind === b.kind ? 0 : a.kind === "folder" ? -1 : 1) || a.name.localeCompare(b.name, undefined, { numeric: true });

export async function getEntry(api: PluginClient, id: number): Promise<Entry> {
  return toEntry((await api.call<{ entry: Record<string, ApiValue> }>("get-entry", { entry_id: id })).entry);
}

export async function searchEntries(api: PluginClient, channelId: number, text: string): Promise<Entry[]> {
  const { rows } = await api.call<{ rows: Record<string, ApiValue>[] }>("search", { channel_id: channelId, text });
  return rows.map(toEntry);
}

export function createListing(api: PluginClient, channelId: number, folderId: Accessor<number | null>) {
  return createLive<Listing>(api, { entries: [], path: [] }, folderId, async () => {
    const { rows, path } = await api.call<{ rows: Record<string, ApiValue>[]; path: { id: number; name: string }[] }>(
      "list", { channel_id: channelId, folder_id: folderId() });
    return { entries: rows.map(toEntry).sort(byName), path };
  });
}

// "name.png" -> "name (2).png" while the name is taken.
export function freeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; ; n++) if (!taken.has(`${base} (${n})${ext}`)) return `${base} (${n})${ext}`;
}

// Uploads files and folders (each folder becomes a folder entry with its contents) into `folderId`. Returns
// the new top-level entries' ids; files cancelled while copying in (shown in `place`) are left out.
export async function uploadTree(
  api: PluginClient, place: string, channelId: number, folderId: number | null, tree: UploadTree, taken: Set<string>,
): Promise<number[]> {
  const names = new Set(taken);
  const free = (name: string) => {
    const unique = freeName(name, names);
    names.add(unique);
    return unique;
  };
  const ids: number[] = [];
  for (const file of tree.files) {
    const id = await uploadAndPost(place, file, async (upload) => (await api.call<{ id: number }>("add-file", {
      channel_id: channelId, parent_id: folderId, name: free(file.name), mime: file.type || "application/octet-stream",
      size: file.size, url: upload.url, thumb: upload.thumb, width: upload.width, height: upload.height,
    })).id);
    if (id !== null) ids.push(id);
  }
  for (const folder of tree.folders) {
    const { id } = await api.call<{ id: number }>("add-folder", { channel_id: channelId, parent_id: folderId, name: free(folder.name) });
    ids.push(id);
    await uploadTree(api, place, channelId, id, folder, new Set());
  }
  return ids;
}

// Which folder each channel was showing, for this session.
const openFolders = new Map<string, number | null>();
export const lastFolder = (key: string) => openFolders.get(key) ?? null;
export const rememberFolder = (key: string, id: number | null) => openFolders.set(key, id);

const layoutKey = "mw.files.layout";
export type Layout = "grid" | "list";
export const savedLayout = (): Layout => (readJson<string>(layoutKey, "grid") === "list" ? "list" : "grid");
export const saveLayout = (layout: Layout) => writeJson(layoutKey, layout);
