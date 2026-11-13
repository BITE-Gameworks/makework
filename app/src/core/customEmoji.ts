// A workspace's custom emoji, loaded once per connection and kept current by the emoji plugin's events. The image
// content is synced with the workspace (p2p/content.ts); a row's small preview shows until it arrives.
import { createStore } from "solid-js/store";
import type { Row } from "../p2p/permissions";
import { emojiNameProblem } from "../markdown/emoji";
import { contentUrl, markFinished, refHash } from "./content";
import { discardUpload, prepareUpload, type Upload } from "./files";
import { isAbort } from "./stream";
import { startUpload } from "./uploads";
import { workspaceApi } from "./workspaces";

export interface CustomEmoji {
  id: number;
  name: string;
  url: string;
  thumb: string;
  mime: string;
  size: number;
  width: number;
  height: number;
  authorId: number;
  createdAt: string;
  deleted: boolean;
}

const [rowsByWorkspace, setRows] = createStore<Record<string, CustomEmoji[] | undefined>>({});
const subscriptions = new Map<string, () => void>();
const loading = new Map<string, Promise<void>>();

function toEmoji(row: Row): CustomEmoji {
  return {
    id: Number(row.id), name: String(row.name ?? ""), url: String(row.url ?? ""), thumb: String(row.thumb ?? ""),
    mime: String(row.mime ?? ""), size: Number(row.size ?? 0), width: Number(row.width ?? 0), height: Number(row.height ?? 0),
    authorId: Number(row.author_id ?? 0), createdAt: String(row.created_at ?? ""), deleted: row.deleted === true,
  };
}

async function reload(workspaceId: string): Promise<void> {
  try {
    const rows = await workspaceApi(workspaceId).plugin("emoji").read("emoji_emojis");
    setRows(workspaceId, rows.map(toEmoji));
  } catch (e) {
    // A workspace from before the plugin was built, or one still connecting: no custom emoji, no error banner.
    console.warn(`Custom emoji of '${workspaceId}' not loaded:`, e);
    setRows(workspaceId, []);
  }
}

// Loads once and subscribes; safe to call from every view that shows the picker.
export function loadCustomEmoji(workspaceId: string): Promise<void> {
  if (!workspaceId || rowsByWorkspace[workspaceId] !== undefined) return Promise.resolve();
  const running = loading.get(workspaceId);
  if (running) return running;
  const task = (async () => {
    const client = workspaceApi(workspaceId).plugin("emoji");
    if (!subscriptions.has(workspaceId)) {
      const stop = client.onEvent((event) => {
        if (event.table === "emoji_emojis") void reload(workspaceId);
      });
      subscriptions.set(workspaceId, stop);
    }
    await reload(workspaceId);
  })().finally(() => loading.delete(workspaceId));
  loading.set(workspaceId, task);
  return task;
}

export function forgetCustomEmoji(workspaceId: string): void {
  subscriptions.get(workspaceId)?.();
  subscriptions.delete(workspaceId);
  setRows(workspaceId, undefined!);
}

export function customEmojiList(workspaceId: string): CustomEmoji[] {
  return (rowsByWorkspace[workspaceId] ?? []).filter((row) => !row.deleted).sort((a, b) => a.name.localeCompare(b.name));
}

// Includes removed ones: messages and reactions from before the removal still show them.
export function customEmojiByName(workspaceId: string, name: string): CustomEmoji | undefined {
  return rowsByWorkspace[workspaceId]?.find((row) => row.name === name);
}

// The image to draw: the local copy while it is here, else the small preview that came with the row.
export function customEmojiSrc(row: CustomEmoji): string | null {
  return contentUrl(row.url) ?? (row.thumb || null);
}

// Copies the image in (with progress in `place`), then adds its row. A failed add discards the new content.
export async function addCustomEmoji(workspaceId: string, file: File, name: string, place = `${workspaceId}:emoji`): Promise<CustomEmoji | null> {
  await loadCustomEmoji(workspaceId);
  const problem = emojiNameProblem(name);
  if (problem) throw new Error(problem);
  if (customEmojiByName(workspaceId, name)) throw new Error(`An emoji named :${name}: already exists, or its name is still reserved.`);
  const typed = emojiFile(file);
  const running = startUpload(place, typed);
  let upload: Upload | null = null;
  try {
    upload = await prepareUpload(typed, { signal: running.signal, onProgress: running.setProgress, workspaceId });
    if (running.signal.aborted) {
      await discardUpload(upload);
      return null;
    }
    await workspaceApi(workspaceId).plugin("emoji").call("add-emoji", {
      name, url: upload.url, thumb: upload.thumb ?? "", mime: typed.type,
      size: typed.size, width: upload.width ?? 0, height: upload.height ?? 0,
    });
    const hash = refHash(upload.url);
    if (hash) markFinished(hash, "uploaded");
    await reload(workspaceId);
    return customEmojiByName(workspaceId, name) ?? null;
  } catch (e) {
    if (isAbort(e)) return null;
    if (upload) await discardUpload(upload);
    throw e;
  } finally {
    running.finish();
  }
}

export async function removeCustomEmoji(workspaceId: string, id: number): Promise<void> {
  await workspaceApi(workspaceId).plugin("emoji").call("remove-emoji", { id });
  await reload(workspaceId);
}

// Some systems leave a picked file's type empty; the extension still says which allowed image it is.
function emojiFile(file: File): File {
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  const byName = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" }[extension];
  const mime = file.type === "image/jpg" ? "image/jpeg" : byName ?? file.type;
  if (!mime || file.type === mime) return file;
  return new File([file], file.name, { type: mime, lastModified: file.lastModified });
}
