import { contentBlob, contentRef, refHash } from "../../../core/content";
import { openLiveText } from "../../../core/liveText";
import { isTextBlob, textChange } from "./data";
import { livingRows, treePaths } from "../../../p2p/diskView";
import type { JsonRow } from "../../../system/data";
import type { DiskContext, DiskEntry, DiskLayout } from "../../types";

const key = (path: string[]) => path.join("/").toLowerCase();
function tree(context: DiskContext) {
  const files = livingRows(context.rows("code", "code_files"));
  const paths = treePaths(files, context.name, (file) => String(file.name));
  return { files, paths, byPath: new Map(files.map((file) => [key(paths.get(file.id)!), file])) };
}
export const codeDisk: DiskLayout = {
  async entries(context) {
    const { files, paths } = tree(context);
    const entries: DiskEntry[] = [];
    for (const file of files) {
      if (file.kind !== "file") continue;
      const path = paths.get(file.id)!;
      const hash = refHash(String(file.hash ?? ""));
      if (!hash) {
        entries.push({ path, text: "" });
        continue;
      }
      if (!context.kept(file.hash)) continue;
      try {
        const blob = await contentBlob(String(file.hash), "text/plain");
        if (blob.size <= 1024 * 1024 && (await isTextBlob(blob))) { entries.push({ path, text: await blob.text() }); continue; }
      } catch {
        // The hash entry below still mirrors a file whose content isn't text or isn't available.
      }
      entries.push({ path, hash });
    }
    return entries;
  },
  async apply(changes, context) {
    const api = context.api("code");
    const { byPath } = tree(context);
    const folder = async (segments: string[]) => {
      let parent: number | null = null;
      for (let i = 1; i <= segments.length; i++) {
        const known = byPath.get(key(segments.slice(0, i)));
        if (known?.kind === "folder") parent = known.id;
        else {
          const result: { id: number } = await api.call("add-folder", { channel_id: context.channel.id, parent_id: parent, name: segments[i - 1] });
          const id = result.id;
          byPath.set(key(segments.slice(0, i)), { id, kind: "folder" });
          parent = id;
        }
      }
      return parent;
    };
    for (const change of changes) try {
      if (!change.hash) continue;
      const old = byPath.get(key(change.kind === "moved" ? change.from! : change.path));
      const parent = await folder(change.path.slice(0, -1));
      const name = change.path.at(-1)!;
      if (!old) await api.call("add-file", { channel_id: context.channel.id, parent_id: parent, name, hash: contentRef(change.hash), size: change.size ?? 0 });
      else if (change.kind === "moved") {
        if (Number(old.parent_id) !== parent) await api.call("move", { file_id: old.id, parent_id: parent });
        if (name !== String(old.name)) await api.call("rename", { file_id: old.id, name });
      } else if (!change.base || change.base === String(old.hash ?? "").replace("mwc:", "") || change.base.startsWith("text:")) {
        if (change.text !== undefined) {
          const live = openLiveText({
            list: async () => {
              const { rows } = await api.call<{ rows: { id: number; data: string }[] }>("list-updates", { file_id: old.id });
              return rows;
            },
            add: async (data, replaces) => {
              const { id } = await api.call<{ id: number }>("add-update", { file_id: old.id, data, ...(replaces.length ? { replaces: JSON.stringify(replaces) } : {}) });
              return id;
            },
            seed: async () => {
              if (!old.hash) return "";
              try { return await (await contentBlob(String(old.hash), "text/plain")).text(); } catch { return ""; }
            },
          });
          await live.ready;
          const before = live.ytext.toString();
          if (before !== change.text) {
            const edit = textChange(before, change.text);
            live.doc.transact(() => {
              if (edit.remove) live.ytext.delete(edit.start, edit.remove);
              if (edit.insert) live.ytext.insert(edit.start, edit.insert);
            }, "local");
          }
          await live.close();
        } else await api.call("set-content", { file_id: old.id, hash: contentRef(change.hash), size: change.size ?? 0 });
      } else {
        context.problem(change, "This file changed in MakeWork too, so the disk version was not applied.");
        continue;
      }
      await context.adopt(change, undefined, !!change.text);
    } catch (error) { context.problem(change, (error as Error).message); }
  },
  removal(changes, context) {
    const { byPath } = tree(context);
    const ids = changes.map((change) => byPath.get(key(change.path))).filter((file): file is JsonRow => file?.kind === "file").map((file) => file.id);
    return ids.length ? { what: ids.length === 1 ? "1 file was" : `${ids.length} files were`, remove: async () => { for (const id of ids) await context.api("code").call("remove", { file_id: id }); } } : null;
  },
};
