// A files channel on disk: its folder tree as it is. Files added, changed, moved or renamed there become the same
// changes in the channel; a file changed both on disk and in the app becomes "name (conflict).ext".
import { refHash } from "../../../core/content";
import { mimeOfName, numberedName, suffixedName } from "../../../core/fileNames";
import { livingRows, treePaths } from "../../../p2p/diskView";
import type { JsonRow } from "../../../system/data";
import type { DiskChange, DiskContext, DiskEntry, DiskLayout } from "../../types";

function tree(context: DiskContext) {
  const entries = livingRows(context.rows("files", "files_entries"));
  const paths = treePaths(entries, context.name, (e) => String(e.name));
  const byPath = new Map<string, JsonRow>();
  for (const entry of entries) byPath.set(paths.get(entry.id)!.join("/").toLowerCase(), entry);
  return { entries, paths, byPath };
}

const key = (path: string[]) => path.join("/").toLowerCase();

// Files this device added from the folder, by channel and path, until the file there is adopted: reported again (it
// changed before it could be adopted), it is the same file, not a conflict with someone else's.
const addedHere = new Map<string, number>();

export const filesDisk: DiskLayout = {
  entries(context) {
    const { entries, paths } = tree(context);
    const result: DiskEntry[] = [];
    for (const entry of entries) {
      const hash = entry.kind === "file" ? context.kept(entry.url) : null;
      if (hash) result.push({ path: paths.get(entry.id)!, hash });
    }
    return result;
  },

  async apply(changes, context) {
    const api = context.api("files");
    const channelId = context.channel.id;
    const { entries, byPath } = tree(context);
    const left = new Set<number>();

    // The folder a path is in, made (with its parents) when it isn't there yet; null for the channel's root.
    const folderOf = async (folder: string[]): Promise<number | null> => {
      let parent: number | null = null;
      for (let i = 1; i <= folder.length; i++) {
        const found = byPath.get(key(folder.slice(0, i)));
        if (found?.kind === "folder") parent = found.id;
        else {
          const { id }: { id: number } = await api.call("add-folder", { channel_id: channelId, parent_id: parent, name: folder[i - 1] });
          byPath.set(key(folder.slice(0, i)), { id, kind: "folder", parent_id: parent, name: folder[i - 1] });
          parent = id;
        }
      }
      return parent;
    };
    const content = async (change: DiskChange, name: string) => {
      const mime = mimeOfName(name);
      const info = mime.startsWith("image/") ? await context.imageInfo(change.hash!, mime) : { thumb: null, width: null, height: null };
      return { mime, size: change.size ?? 0, url: `mwc:${change.hash}`, ...info };
    };
    // "name (conflict).ext", numbered when that is taken too.
    const addConflict = async (change: DiskChange, parent: number | null, name: string) => {
      const taken = new Set(entries.filter((e) => (e.parent_id ?? null) === parent).map((e) => String(e.name).toLowerCase()));
      let wanted = suffixedName(name, "conflict");
      for (let n = 2; taken.has(wanted.toLowerCase()); n++) wanted = numberedName(suffixedName(name, "conflict"), n);
      const { id } = await api.call<{ id: number }>("add-file", { channel_id: channelId, parent_id: parent, name: wanted, ...(await content(change, wanted)) });
      return { id, name: wanted };
    };

    for (const change of changes) {
      const folder = change.path.slice(0, -1);
      const name = change.path.at(-1)!;
      try {
        if (!change.hash) continue;
        const existing = byPath.get(key(change.kind === "moved" ? change.from! : change.path));
        const here = `${channelId}:${key(change.path)}`;
        // Both versions stay: this computer's file is added next to the one in the app.
        const keepBoth = async (file: NonNullable<typeof existing>) => {
          const parent = file.parent_id == null ? null : Number(file.parent_id);
          const added = await addConflict(change, parent, String(file.name));
          await context.adopt(change, [...folder, context.name(folder, `row:${added.id}`, added.name)]);
        };
        if (existing?.kind !== "file") {
          const parent = await folderOf(folder);
          const { id } = await api.call<{ id: number }>("add-file", { channel_id: channelId, parent_id: parent, name, ...(await content(change, name)) });
          if (await context.adopt(change)) addedHere.delete(here);
          else addedHere.set(here, id);
        } else if (change.kind === "added" && addedHere.get(here) === existing.id) {
          if (refHash(String(existing.url ?? "")) !== change.hash)
            await api.call("set-content", { entry_id: existing.id, ...(await content(change, String(existing.name))) });
          if (await context.adopt(change)) addedHere.delete(here);
        } else if (change.kind === "added" && refHash(String(existing.url ?? "")) !== change.hash) {
          // Over a file this computer hadn't downloaded: both stay.
          await keepBoth(existing);
        } else if (change.kind === "moved") {
          const parent = await folderOf(folder);
          if (parent !== (existing.parent_id ?? null)) {
            if (existing.parent_id != null) left.add(Number(existing.parent_id));
            await api.call("move", { entry_id: existing.id, parent_id: parent });
          }
          if (name !== change.from!.at(-1)) await api.call("rename", { entry_id: existing.id, name });
          await context.adopt(change);
        } else if (refHash(String(existing.url ?? "")) === change.hash) {
          // Already that content (the same file put back).
          await context.adopt(change);
        } else if (change.base && refHash(String(existing.url ?? "")) !== change.base) {
          // Changed in the app too since it was written here: both versions stay.
          await keepBoth(existing);
        } else {
          await api.call("set-content", { entry_id: existing.id, ...(await content(change, String(existing.name))) });
          await context.adopt(change);
        }
      } catch (e) {
        context.problem(change, (e as Error).message);
      }
    }
    // Folders everything was moved out of on disk.
    for (const id of left) {
      const fresh = livingRows(context.rows("files", "files_entries"));
      if (!fresh.some((e) => Number(e.parent_id) === id)) await api.call("remove", { entry_id: id }).catch(() => {});
    }
  },

  removal(changes, context) {
    const { entries, byPath } = tree(context);
    const gone = new Set(changes.map((c) => byPath.get(key(c.path))).filter((e): e is JsonRow => e?.kind === "file").map((e) => e.id));
    if (!gone.size) return null;
    // A folder whose files were all deleted on disk goes as a whole.
    const children = new Map<number | null, JsonRow[]>();
    for (const entry of entries) {
      const parent = entry.parent_id == null ? null : Number(entry.parent_id);
      (children.get(parent) ?? children.set(parent, []).get(parent)!).push(entry);
    }
    const emptied = new Map<number, boolean>();
    const allGone = (folder: JsonRow): boolean => {
      let result = emptied.get(folder.id);
      if (result === undefined) {
        const inside = children.get(folder.id) ?? [];
        result = inside.length > 0 && inside.every((e) => (e.kind === "folder" ? allGone(e) : gone.has(e.id)));
        emptied.set(folder.id, result);
      }
      return result;
    };
    const byId = new Map(entries.map((e) => [e.id, e]));
    const underGone = (entry: JsonRow): boolean => {
      const parent = entry.parent_id == null ? undefined : byId.get(Number(entry.parent_id));
      return !!parent && (allGone(parent) || underGone(parent));
    };
    const targets = entries.filter((e) => (e.kind === "folder" ? allGone(e) : gone.has(e.id)) && !underGone(e));
    const api = context.api("files");
    return {
      what: gone.size === 1 ? "1 file was" : `${gone.size} files were`,
      remove: async () => {
        for (const entry of targets) await api.call("remove", { entry_id: entry.id });
      },
    };
  },
};
