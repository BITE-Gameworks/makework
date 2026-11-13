// Saving a file or a whole folder from a files channel to the computer, as a copy (the app keeps it synced) or a
// move (once everything is written, the app lets go of what it only kept for this: those files go back to being
// pointers; own uploads stay). Files that are still pointers are downloaded first.
import { createStore, produce } from "solid-js/store";
import { ensureLocal, hasContent, isSynced, refHash, setSynced, type SyncMark } from "../../../core/content";
import { chooseFile, chooseFolder, type SaveTarget } from "../../../core/save";
import type { PluginClient } from "../../../api/client";
import type { ApiValue } from "../../../api/types";
import { toEntry, type Entry } from "./data";

export type SaveMode = "copy" | "move";

export interface SaveJob {
  id: number;
  place: string;
  name: string;
  done: number;
  total: number;
  bytes: number;
  totalBytes: number;
  // The file being downloaded or written now (not in `bytes` yet), so the bar can follow its download.
  currentUrl: string | null;
  currentSize: number;
  // Set once finished: where it went.
  savedTo: string | null;
}

const [jobs, setJobs] = createStore<SaveJob[]>([]);
const controllers = new Map<number, AbortController>();
let nextId = 1;

export const savesIn = (place: string) => jobs.filter((j) => j.place === place);

export function cancelSave(id: number): void {
  controllers.get(id)?.abort();
}

// What saving needs from the app; tests pass fakes.
export interface SaveDeps {
  list(folderId: number): Promise<Entry[]>;
  // Downloads the file if it isn't here; false when it didn't arrive or `signal` was aborted (which stops the wait).
  ensureLocal(entry: Entry, signal?: AbortSignal): Promise<boolean>;
  unmark(mark: SyncMark): void;
}

export interface Collected {
  files: { path: string[]; entry: Entry }[];
  // Every folder, also empty ones, as paths from the saved one (included).
  folders: string[][];
}

// Everything under `entry` (a folder, or just the file), with paths starting at its own name.
export async function collect(list: SaveDeps["list"], entry: Entry, path: string[] = [entry.name]): Promise<Collected> {
  if (entry.kind === "file") return { files: [{ path, entry }], folders: [] };
  const found: Collected = { files: [], folders: [path] };
  for (const child of await list(entry.id)) {
    const inner = await collect(list, child, [...path, child.name]);
    found.files.push(...inner.files);
    found.folders.push(...inner.folders);
  }
  return found;
}

export type SaveProgress = Pick<SaveJob, "done" | "total" | "bytes" | "totalBytes" | "currentUrl" | "currentSize">;

// Writes `entry` into the target and, for a move, turns off the sync marks it covered.
export async function saveTo(target: SaveTarget, entry: Entry, mode: SaveMode, deps: SaveDeps,
  onProgress: (progress: SaveProgress) => void, signal?: AbortSignal): Promise<Collected> {
  const found = await collect(deps.list, entry);
  const total = found.files.length;
  // Files sent without their content are skipped, so they don't count toward the bar.
  const totalBytes = found.files.reduce((sum, f) => sum + (refHash(f.entry.url) ? f.entry.size : 0), 0);
  const idle = { currentUrl: null, currentSize: 0 };
  onProgress({ done: 0, total, bytes: 0, totalBytes, ...idle });
  // The top folder gets a free name in the target ("photos (2)"); everything under it is new.
  let rename = (path: string[]) => path;
  if (entry.kind === "folder") {
    const [top] = await target.folder([entry.name], true);
    rename = (path) => [top, ...path.slice(1)];
    for (const folder of found.folders.slice(1)) await target.folder(rename(folder));
  }
  let bytes = 0;
  for (const [i, { path, entry: file }] of found.files.entries()) {
    signal?.throwIfAborted();
    const hash = refHash(file.url);
    if (!hash) continue;
    onProgress({ done: i, total, bytes, totalBytes, currentUrl: file.url, currentSize: file.size });
    const here = await deps.ensureLocal(file, signal);
    // A cancel ends the save as cancelled, not as a file nobody had.
    signal?.throwIfAborted();
    if (!here) throw new Error(`"${file.name}" couldn't be downloaded: nobody online has it.`);
    await target.write(rename(path), hash);
    bytes += file.size;
    onProgress({ done: i + 1, total, bytes, totalBytes, ...idle });
  }
  if (mode === "move") {
    if (entry.kind === "folder") deps.unmark({ kind: "folder", id: entry.id });
    for (const { entry: file } of found.files) deps.unmark({ kind: "file", id: file.id });
  }
  return found;
}

// Asks where to save, then runs the save, shown as a card in `place` with its progress and cancel.
export async function startSave(api: PluginClient, workspaceId: string, channelId: number, place: string, entry: Entry, mode: SaveMode) {
  const target = entry.kind === "folder" ? await chooseFolder() : await chooseFile(entry.name);
  if (!target) return;
  const deps: SaveDeps = {
    list: async (folderId) => {
      const { rows } = await api.call<{ rows: Record<string, ApiValue>[] }>("list", { channel_id: channelId, folder_id: folderId });
      return rows.map(toEntry);
    },
    // Cancelling stops a download this save started: its sync mark goes off again, which stops the transfer and
    // deletes what arrived unless something else keeps the file (a synced channel or folder downloads it anyway).
    ensureLocal: async (file, signal) => {
      const mark: SyncMark = { kind: "file", id: file.id };
      const hash = refHash(file.url);
      const started = !!hash && !isSynced(workspaceId, mark) && !(await hasContent(hash));
      const stop = () => started && setSynced(workspaceId, mark, false);
      signal?.addEventListener("abort", stop, { once: true });
      try {
        // Cancelled while looking: nothing was started yet.
        if (signal?.aborted) return false;
        return await ensureLocal(workspaceId, mark, file.url!, signal);
      } finally {
        signal?.removeEventListener("abort", stop);
      }
    },
    unmark: (mark) => setSynced(workspaceId, mark, false),
  };
  const id = nextId++;
  const controller = new AbortController();
  controllers.set(id, controller);
  setJobs(jobs.length, {
    id, place, name: entry.name, done: 0, total: 0, bytes: 0, totalBytes: 0, currentUrl: null, currentSize: 0, savedTo: null,
  });
  const update = (change: Partial<SaveJob>) => setJobs((j) => j.id === id, change);
  const remove = () => {
    controllers.delete(id);
    setJobs(produce((list) => {
      const i = list.findIndex((j) => j.id === id);
      if (i >= 0) list.splice(i, 1);
    }));
  };
  try {
    await saveTo(target, entry, mode, deps, update, controller.signal);
    update({ savedTo: target.where });
    setTimeout(remove, 4000);
  } catch (e) {
    remove();
    if (!(e instanceof DOMException && e.name === "AbortError")) throw e;
  } finally {
    target.done();
  }
}
