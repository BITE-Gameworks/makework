// A folder tree per files channel. An entry's `url` is its content (a `mwc:` ref, core/content.ts); entries without
// one are metadata only.
import type { MockPlugin } from "./backend";
import { groupRows, type JsonRow } from "./data";
import { InvalidRequest } from "./errors";

const fileArgs = [
  { name: "mime", type: "text", description: "Media type." },
  { name: "size", type: "bigint", description: "Size in bytes." },
  { name: "url", type: "text", required: false, description: "Where the content can be downloaded." },
  { name: "width", type: "int", required: false, description: "Image width in px." },
  { name: "height", type: "int", required: false, description: "Image height in px." },
  { name: "thumb", type: "text", required: false, description: "A small preview image (data URL) for images." },
] as const;

export const files: MockPlugin = {
  manifest: {
    name: "files",
    version: "1.0.0",
    description: "Shared folders and files.",
    tables: [
      {
        name: "files_entries", parent: null, tree: "parent_id",
        columns: {
          channel_id: "bigint", parent_id: "bigint", kind: "text", name: "text", mime: "text", size: "bigint", url: "text",
          thumb: "text", width: "int", height: "int", author_id: "bigint", created_at: "timestamp", deleted: "bool",
        },
      },
    ],
  },

  // Deleting only hides an entry (and so everything in a deleted folder), so undo can bring it back. `purge` removes
  // the rows themselves: nothing brings those back, and nodes and members' devices let the content go (node/host.ts
  // `purge`, p2p/content.ts). Rows are removed, not marked in a new column: a member or node on an older version
  // refuses a commit that writes a column it doesn't know.
  register({ data, onApi, onApiRead }) {
    const live = (row: JsonRow) => row.deleted !== true;
    const children = (channelId: unknown, parentId: unknown) =>
      data.select("files_entries", { channel_id: channelId as number, parent_id: parentId as number | null }).filter(live);
    // Not deleted, and not inside a deleted folder.
    const visible = (row: JsonRow): boolean => live(row) && (row.parent_id === null || visible(entry(row.parent_id)));
    const entry = (id: unknown) => {
      const [row] = data.select("files_entries", { id: id as number });
      // Deleted for good (`purge`), maybe by someone else: an undo step or a link from before still names it.
      if (!row) throw new InvalidRequest("That file no longer exists.");
      return row;
    };
    const folder = (channelId: unknown, id: unknown) => {
      if (id === null) return;
      const row = entry(id);
      if (row.kind !== "folder" || row.channel_id !== channelId || !visible(row)) throw new InvalidRequest(`${id} is not a folder in this channel.`);
    };
    const checkName = (channelId: unknown, parentId: unknown, name: unknown, except?: number) => {
      const n = String(name);
      if (!n || /[/\\]/.test(n) || n === "." || n === "..") throw new InvalidRequest(`'${n}' is not a valid name.`);
      const taken = children(channelId, parentId).some((e) => e.name === n && e.id !== except);
      if (taken) throw new InvalidRequest(`'${n}' already exists here.`);
    };
    const add = (userId: number, values: Record<string, unknown>) =>
      data.insert("files_entries", { ...values, author_id: userId, created_at: new Date().toISOString(), deleted: false });

    onApi("list", "Lists a folder (the channel's root without folder_id): { rows, path }. path is the folders from the root down.",
      [
        { name: "channel_id", type: "bigint", description: "The files channel." },
        { name: "folder_id", type: "bigint", required: false, description: "The folder to list." },
      ],
      (r) => {
        folder(r.args.channel_id, r.args.folder_id);
        const path: JsonRow[] = [];
        for (let id = r.args.folder_id; id !== null; ) {
          const row = entry(id);
          path.unshift(row);
          id = row.parent_id as number | null;
        }
        return {
          rows: children(r.args.channel_id, r.args.folder_id),
          path: path.map((p) => ({ id: p.id, name: p.name })),
        };
      });

    onApi("get-entry", "One file or folder: { entry }.",
      [{ name: "entry_id", type: "bigint", description: "The file or folder." }],
      (r) => ({ entry: entry(r.args.entry_id) }));

    onApi("search", "Files and folders of a channel whose names contain the text: { rows }, at most 20.",
      [
        { name: "channel_id", type: "bigint", description: "The files channel." },
        { name: "text", type: "text", description: "Part of a name, any case." },
      ],
      (r) => {
        // One pass over the channel: big channels have tens of thousands of entries, so each one must not look its
        // folders up in the whole table again.
        const rows = data.select("files_entries", { channel_id: r.args.channel_id });
        const byId = new Map(rows.map((e) => [e.id, e]));
        const shown = new Map<number, boolean>();
        const isShown = (e: JsonRow): boolean => {
          const known = shown.get(e.id);
          if (known !== undefined) return known;
          const parent = e.parent_id === null ? null : byId.get(Number(e.parent_id));
          const result = live(e) && (e.parent_id === null || (parent !== undefined && parent !== null && isShown(parent)));
          shown.set(e.id, result);
          return result;
        };
        const text = String(r.args.text).toLowerCase();
        const found: JsonRow[] = [];
        for (const e of rows) {
          if (String(e.name).toLowerCase().includes(text) && isShown(e)) found.push(e);
          if (found.length === 20) break;
        }
        return { rows: found };
      });

    onApi("add-folder", "Creates a folder; returns its id.",
      [
        { name: "channel_id", type: "bigint", description: "The files channel." },
        { name: "parent_id", type: "bigint", required: false, description: "The folder to create it in, or the root." },
        { name: "name", type: "text", description: "Folder name." },
      ],
      (r) => {
        folder(r.args.channel_id, r.args.parent_id);
        checkName(r.args.channel_id, r.args.parent_id, r.args.name);
        return { id: add(r.userId, { ...r.args, kind: "folder", size: 0 }) };
      });

    onApi("add-file", "Adds a file; returns its id.",
      [
        { name: "channel_id", type: "bigint", description: "The files channel." },
        { name: "parent_id", type: "bigint", required: false, description: "The folder to add it to, or the root." },
        { name: "name", type: "text", description: "File name." },
        ...fileArgs,
      ],
      (r) => {
        folder(r.args.channel_id, r.args.parent_id);
        checkName(r.args.channel_id, r.args.parent_id, r.args.name);
        return { id: add(r.userId, { ...r.args, kind: "file" }) };
      });

    onApi("set-content", "Gives a file new content (a new version); returns { updated }.",
      [{ name: "entry_id", type: "bigint", description: "The file." }, ...fileArgs],
      (r) => {
        const row = entry(r.args.entry_id);
        if (row.kind !== "file") throw new InvalidRequest("Only files have content.");
        const { entry_id, ...values } = r.args;
        return { updated: data.update("files_entries", { width: null, height: null, thumb: null, ...values }, { id: row.id }) };
      });

    onApi("rename", "Renames a file or folder; returns { updated }.",
      [
        { name: "entry_id", type: "bigint", description: "The file or folder." },
        { name: "name", type: "text", description: "The new name." },
      ],
      (r) => {
        const row = entry(r.args.entry_id);
        checkName(row.channel_id, row.parent_id, r.args.name, row.id);
        return { updated: data.update("files_entries", { name: r.args.name }, { id: row.id }) };
      });

    onApi("move", "Moves a file or folder to another folder of the same channel; returns { updated }.",
      [
        { name: "entry_id", type: "bigint", description: "The file or folder." },
        { name: "parent_id", type: "bigint", required: false, description: "The target folder, or the root." },
      ],
      (r) => {
        const row = entry(r.args.entry_id);
        folder(row.channel_id, r.args.parent_id);
        for (let id = r.args.parent_id; id !== null; id = entry(id).parent_id as number | null)
          if (id === row.id) throw new InvalidRequest("A folder can't be moved into itself.");
        checkName(row.channel_id, r.args.parent_id, row.name, row.id);
        return { updated: data.update("files_entries", { parent_id: r.args.parent_id }, { id: row.id }) };
      });

    onApi("remove", "Deletes a file, or a folder with everything in it (restore undoes it); returns { deleted }.",
      [{ name: "entry_id", type: "bigint", description: "The file or folder." }],
      (r) => ({ deleted: data.update("files_entries", { deleted: true }, { id: entry(r.args.entry_id).id }) }));

    onApi("restore", "Brings back a deleted file or folder; renamed with \" (restored)\" if its name is taken. Returns { name }.",
      [{ name: "entry_id", type: "bigint", description: "The file or folder." }],
      (r) => {
        const row = entry(r.args.entry_id);
        const taken = new Set(children(row.channel_id, row.parent_id).map((e) => String(e.name)));
        let name = String(row.name);
        for (let n = 1; taken.has(name); n++) name = `${row.name} (restored${n > 1 ? ` ${n}` : ""})`;
        data.update("files_entries", { deleted: false, name }, { id: row.id });
        return { name };
      });

    // Who may is the workspace's policy (p2p/policy.ts): your own uploads, anyone's with "Manage workspace".
    onApi("purge", "Deletes a file, or a folder with everything in it, for good: it can't be restored, and the nodes and members' devices let its content go. Returns { deleted }, the rows removed.",
      [{ name: "entry_id", type: "bigint", description: "The file or folder." }],
      (r) => {
        const row = entry(r.args.entry_id);
        let deleted = 0;
        if (row.kind === "folder") {
          // Everything under it, hidden entries too. One delete per folder (its children), not per file: each delete
          // reads the whole table, and a folder can hold thousands of files.
          const byParent = groupRows(data.select("files_entries", { channel_id: row.channel_id as number }), "parent_id");
          const folders = [row.id];
          const seen = new Set(folders);
          for (let i = 0; i < folders.length; i++) {
            const children = byParent.get(folders[i]) ?? [];
            for (const child of children) {
              if (child.kind !== "folder" || seen.has(child.id)) continue;
              seen.add(child.id);
              folders.push(child.id);
            }
            if (children.length) deleted += data.delete("files_entries", { parent_id: folders[i] });
          }
        }
        return { deleted: deleted + data.delete("files_entries", { id: row.id }) };
      });

    onApiRead((r) => data.select(r.table, r.where));
  },
};
