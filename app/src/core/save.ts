// Saving content to a place the user picks on their computer: a folder (written into, nothing overwritten: a
// taken name becomes "name (2)") or a single file. Desktop goes through dialogs in electron/main.js; browsers
// with the File System Access API (Chrome, Edge) write through its handles; others can only save single files,
// as a download.
import { ShownError } from "../api/client";
import { storedBlob } from "./content";
import { desktop, type DesktopBridge } from "./desktop";
import { safeName } from "./fileNames";

export interface SaveTarget {
  // Where it goes, for messages.
  readonly where: string;
  // Creates a folder at `segments` (made free with `free`); returns the names it got.
  folder(segments: string[], free?: boolean): Promise<string[]>;
  // Writes content to `segments` in the folder; a single-file target ignores them.
  write(segments: string[], hash: string): Promise<void>;
  done(): void;
}

// Asks for a folder; null when the user cancelled.
export async function chooseFolder(): Promise<SaveTarget | null> {
  if (desktop?.save) return desktopTarget(desktop.save, await desktop.save.choose("folder", ""));
  const picker = (window as FileSystemWindow).showDirectoryPicker;
  if (!picker) throw new ShownError("Saving folders needs the desktop app, Chrome or Edge.");
  const root = await pick(() => picker({ mode: "readwrite" }));
  return root && browserFolder(root);
}

// Asks where to save one file; null when the user cancelled.
export async function chooseFile(name: string): Promise<SaveTarget | null> {
  if (desktop?.save) return desktopTarget(desktop.save, await desktop.save.choose("file", name));
  const picker = (window as FileSystemWindow).showSaveFilePicker;
  if (!picker) return downloadTarget(name);
  const handle = await pick(() => picker({ suggestedName: safeName(name) }));
  return handle && {
    where: handle.name,
    folder: async (segments) => segments,
    write: (_segments, hash) => writeBlob(handle, hash),
    done: () => {},
  };
}

function desktopTarget(save: NonNullable<DesktopBridge["save"]>, chosen: { id: string; where: string } | null): SaveTarget | null {
  return chosen && {
    where: chosen.where,
    folder: (segments, free = false) => save.mkdir(chosen.id, segments, free),
    write: async (segments, hash) => void (await save.write(chosen.id, segments, hash)),
    done: () => void save.done(chosen.id),
  };
}

function browserFolder(root: FileSystemDirectoryHandle): SaveTarget {
  const dirOf = async (segments: string[]) => {
    let dir = root;
    for (const name of segments) dir = await dir.getDirectoryHandle(safeName(name), { create: true });
    return dir;
  };
  return {
    where: root.name,
    async folder(segments, free = false) {
      const parent = await dirOf(segments.slice(0, -1));
      const name = free ? await freeName(parent, safeName(segments.at(-1)!)) : safeName(segments.at(-1)!);
      await parent.getDirectoryHandle(name, { create: true });
      return [...segments.slice(0, -1), name];
    },
    async write(segments, hash) {
      const dir = await dirOf(segments.slice(0, -1));
      await writeBlob(await dir.getFileHandle(await freeName(dir, safeName(segments.at(-1)!)), { create: true }), hash);
    },
    done: () => {},
  };
}

// Without the File System Access API: the browser's own download of one file.
function downloadTarget(name: string): SaveTarget {
  return {
    where: "Downloads",
    folder: async (segments) => segments,
    async write(_segments, hash) {
      const blob = await storedBlob(hash);
      if (!blob) throw new ShownError(`"${name}" isn't on this device.`);
      const url = URL.createObjectURL(blob);
      Object.assign(document.createElement("a"), { href: url, download: name }).click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    done: () => {},
  };
}

// Streams the stored content into the file, never holding it whole.
async function writeBlob(handle: FileSystemFileHandle, hash: string) {
  const blob = await storedBlob(hash);
  if (!blob) throw new ShownError("That file isn't on this device.");
  await blob.stream().pipeTo(await handle.createWritable());
}

async function taken(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  for (const get of [() => dir.getFileHandle(name), () => dir.getDirectoryHandle(name)]) {
    try {
      await get();
      return true;
    } catch {
      // Not there as this kind.
    }
  }
  return false;
}

// "a.txt" -> "a (2).txt" while the name is taken in the folder.
async function freeName(dir: FileSystemDirectoryHandle, name: string): Promise<string> {
  if (!(await taken(dir, name))) return name;
  const dot = name.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; ; n++) if (!(await taken(dir, `${base} (${n})${ext}`))) return `${base} (${n})${ext}`;
}

// The picker throws AbortError when the user closes it.
async function pick<T>(open: () => Promise<T>): Promise<T | null> {
  try {
    return await open();
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return null;
    throw e;
  }
}

// The File System Access API pickers (Chromium only, not in TypeScript's DOM types).
type FileSystemWindow = Window & {
  showDirectoryPicker?: (options: { mode: "readwrite" }) => Promise<FileSystemDirectoryHandle>;
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<FileSystemFileHandle>;
};
