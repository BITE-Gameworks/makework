// Code channels keep a tree of file metadata. File contents live in content storage; concurrent text edits are
// Yjs updates in the signed log, while hash is the latest plain copy for disk views and search.
import type { MockPlugin } from "./backend";
import type { JsonRow } from "./data";
import { idList, InvalidRequest } from "./errors";

export const code: MockPlugin = {
  manifest: {
    name: "code",
    version: "1.0.0",
    description: "Code: a tree of files with collaborative text updates.",
    tables: [
      {
        name: "code_files", parent: null,
        columns: {
          channel_id: "bigint", parent_id: "bigint", kind: "text", name: "text", hash: "text", size: "bigint", language: "text",
          author_id: "bigint", created_at: "timestamp", updated_by: "bigint", updated_at: "timestamp", deleted: "bool",
        },
      },
      {
        name: "code_updates", parent: null,
        columns: { channel_id: "bigint", file_id: "bigint", data: "text", author_id: "bigint", created_at: "timestamp" },
      },
      {
        // Run configurations: a shell command members run in their own copy of the channel's files (desktop).
        // Each device asks before running a command someone else wrote or changed.
        name: "code_runs", parent: null,
        columns: {
          channel_id: "bigint", name: "text", command: "text", author_id: "bigint", created_at: "timestamp",
          updated_by: "bigint", updated_at: "timestamp", deleted: "bool",
        },
      },
    ],
  },

  register({ data, onApi, onApiRead }) {
    const file = (id: unknown): JsonRow => {
      const [row] = data.select("code_files", { id: Number(id) });
      if (!row) throw new InvalidRequest(`Unknown code file ${id}`);
      return row;
    };
    const name = (value: unknown) => {
      const result = String(value ?? "").trim();
      if (!result || result.length > 255 || /[\\/\0]/.test(result)) throw new InvalidRequest("Names are 1 to 255 characters and can't contain path separators.");
      return result;
    };
    const parent = (channelId: number, parentId: unknown, fileId?: number) => {
      if (parentId == null) return null;
      const row = file(parentId);
      if (Number(row.channel_id) !== channelId) throw new InvalidRequest("A code file's parent must be in the same channel.");
      if (row.kind !== "folder") throw new InvalidRequest("A code file's parent must be a folder.");
      for (let ancestor: JsonRow | null = row; ancestor; ancestor = ancestor.parent_id == null ? null : file(ancestor.parent_id)) {
        if (ancestor.id === fileId) throw new InvalidRequest("A code file can't go inside itself.");
      }
      return row.id;
    };
    const uniqueName = (channelId: number, parentId: number | null, value: string, except?: number) => {
      const duplicate = data.select("code_files", { channel_id: channelId, parent_id: parentId })
        .some((row) => row.deleted !== true && row.id !== except && String(row.name).localeCompare(value, undefined, { sensitivity: "accent" }) === 0);
      if (duplicate) throw new InvalidRequest("Names must be unique in a folder, ignoring case.");
    };
    const touch = (id: number, userId: number) => data.update("code_files", { updated_by: userId, updated_at: new Date().toISOString() }, { id });
    const descendants = (rootId: number) => {
      const ids = [rootId];
      for (let index = 0; index < ids.length; index++) {
        for (const child of data.select("code_files", { parent_id: ids[index] })) ids.push(child.id);
      }
      return ids;
    };

    onApi("list-files", "Lists a channel's files without their content: { rows }.",
      [{ name: "channel_id", type: "bigint", description: "The code channel." }],
      (r) => ({ rows: data.select("code_files", { channel_id: Number(r.args.channel_id) }).filter((row) => row.deleted !== true) }));

    const add = (entryKind: "file" | "folder", action: string) => onApi(action, `Adds a code ${entryKind}; returns { id }.`,
      [
        { name: "channel_id", type: "bigint", description: "The code channel." },
        { name: "parent_id", type: "bigint", required: false, description: "The folder it goes in; none for the root." },
        { name: "name", type: "text", description: "The entry name." },
        { name: "hash", type: "text", required: false, description: "The initial content reference for a file." },
        { name: "size", type: "bigint", required: false, description: "The initial byte size for a file." },
        { name: "language", type: "text", required: false, description: "An optional language override for a file." },
      ],
      (r) => {
        const channelId = Number(r.args.channel_id);
        const parentId = parent(channelId, r.args.parent_id);
        const entryName = name(r.args.name);
        uniqueName(channelId, parentId, entryName);
        const now = new Date().toISOString();
        return {
          id: data.insert("code_files", {
            channel_id: channelId, parent_id: parentId, kind: entryKind, name: entryName,
            hash: entryKind === "file" ? r.args.hash ?? null : null, size: entryKind === "file" ? r.args.size ?? 0 : 0,
            language: entryKind === "file" ? r.args.language ?? null : null,
            author_id: r.userId, created_at: now, updated_by: r.userId, updated_at: now, deleted: false,
          }),
        };
      });
    add("file", "add-file");
    add("folder", "add-folder");

    onApi("rename", "Renames a code file or folder; returns { updated }.",
      [{ name: "file_id", type: "bigint", description: "The entry." }, { name: "name", type: "text", description: "The new name." }],
      (r) => {
        const row = file(r.args.file_id);
        const entryName = name(r.args.name);
        uniqueName(Number(row.channel_id), row.parent_id == null ? null : Number(row.parent_id), entryName, row.id);
        return { updated: data.update("code_files", { name: entryName, updated_by: r.userId, updated_at: new Date().toISOString() }, { id: row.id }) };
      });

    onApi("move", "Moves a code file or folder into a folder; returns { updated }.",
      [{ name: "file_id", type: "bigint", description: "The entry." }, { name: "parent_id", type: "bigint", required: false, description: "The destination folder; none for the root." }],
      (r) => {
        const row = file(r.args.file_id);
        const parentId = parent(Number(row.channel_id), r.args.parent_id, row.id);
        uniqueName(Number(row.channel_id), parentId, String(row.name), row.id);
        return { updated: data.update("code_files", { parent_id: parentId, updated_by: r.userId, updated_at: new Date().toISOString() }, { id: row.id }) };
      });

    onApi("remove", "Soft-deletes a code file or folder and its descendants; returns { deleted }.",
      [{ name: "file_id", type: "bigint", description: "The entry." }],
      (r) => ({ deleted: descendants(file(r.args.file_id).id).reduce((count, id) => count + data.update("code_files", { deleted: true }, { id }), 0) }));

    onApi("restore", "Restores a code file or folder and its descendants; returns { restored }.",
      [{ name: "file_id", type: "bigint", description: "The entry." }],
      (r) => {
        const ids = descendants(file(r.args.file_id).id);
        for (const id of ids) {
          const row = file(id);
          uniqueName(Number(row.channel_id), row.parent_id == null ? null : Number(row.parent_id), String(row.name), row.id);
        }
        return { restored: ids.reduce((count, id) => count + data.update("code_files", { deleted: false }, { id }), 0) };
      });

    onApi("list-updates", "A file's text updates, oldest first: { rows } (id, data).",
      [{ name: "file_id", type: "bigint", description: "The text file." }],
      (r) => ({ rows: data.select("code_updates", { file_id: file(r.args.file_id).id }).map((row) => ({ id: row.id, data: row.data })) }));

    onApi("add-update", "Adds a Yjs text update; may compact updates it replaces. Returns { id }.",
      [
        { name: "file_id", type: "bigint", description: "The text file." },
        { name: "data", type: "text", description: "A base64 Yjs update." },
        { name: "replaces", type: "text", required: false, description: "JSON list of update ids this update replaces." },
      ],
      (r) => {
        const row = file(r.args.file_id);
        if (row.kind !== "file") throw new InvalidRequest("Only files can have text updates.");
        if (!/^[A-Za-z0-9+/=]+$/.test(String(r.args.data))) throw new InvalidRequest("'data' must be base64.");
        const id = data.insert("code_updates", { channel_id: row.channel_id, file_id: row.id, data: r.args.data, author_id: r.userId, created_at: new Date().toISOString() });
        if (r.args.replaces != null)
          for (const old of idList(r.args.replaces, "replaces")) data.delete("code_updates", { id: old, file_id: row.id });
        touch(row.id, r.userId);
        return { id };
      });

    onApi("set-content", "Sets a file's latest content reference after text edits settle; returns { updated }.",
      [
        { name: "file_id", type: "bigint", description: "The file." },
        { name: "hash", type: "text", required: false, description: "The latest content reference." },
        { name: "size", type: "bigint", required: false, description: "The latest byte size." },
        { name: "language", type: "text", required: false, description: "An optional language override." },
      ],
      (r) => {
        const row = file(r.args.file_id);
        if (row.kind !== "file") throw new InvalidRequest("Only files can have content.");
        const values: Record<string, unknown> = { updated_by: r.userId, updated_at: new Date().toISOString() };
        if (r.args.hash !== undefined) values.hash = r.args.hash;
        if (r.args.size !== undefined) values.size = r.args.size;
        if (r.args.language !== undefined) values.language = r.args.language;
        return { updated: data.update("code_files", values, { id: row.id }) };
      });

    const run = (id: unknown): JsonRow => {
      const [row] = data.select("code_runs", { id: Number(id) });
      if (!row || row.deleted === true) throw new InvalidRequest(`Unknown run configuration ${id}`);
      return row;
    };
    const runFields = (r: { args: Record<string, unknown> }) => {
      const runName = String(r.args.name ?? "").trim();
      const command = String(r.args.command ?? "").trim();
      if (!runName || runName.length > 80) throw new InvalidRequest("A run configuration needs a name of up to 80 characters.");
      if (!command || command.length > 2000) throw new InvalidRequest("A run configuration needs a command of up to 2000 characters.");
      return { name: runName, command };
    };

    onApi("list-runs", "Lists a channel's run configurations: { rows }.",
      [{ name: "channel_id", type: "bigint", description: "The code channel." }],
      (r) => ({ rows: data.select("code_runs", { channel_id: Number(r.args.channel_id) }).filter((row) => row.deleted !== true) }));

    onApi("add-run", "Adds a run configuration; returns { id }.",
      [
        { name: "channel_id", type: "bigint", description: "The code channel." },
        { name: "name", type: "text", description: "What the Run menu shows." },
        { name: "command", type: "text", description: "The shell command, run in the channel's files." },
      ],
      (r) => {
        const now = new Date().toISOString();
        return { id: data.insert("code_runs", {
          channel_id: Number(r.args.channel_id), ...runFields(r), author_id: r.userId, created_at: now, updated_by: r.userId, updated_at: now, deleted: false,
        }) };
      });

    onApi("update-run", "Changes a run configuration's name and command; returns { updated }.",
      [
        { name: "run_id", type: "bigint", description: "The run configuration." },
        { name: "name", type: "text", description: "What the Run menu shows." },
        { name: "command", type: "text", description: "The shell command." },
      ],
      (r) => ({ updated: data.update("code_runs", { ...runFields(r), updated_by: r.userId, updated_at: new Date().toISOString() }, { id: run(r.args.run_id).id }) }));

    onApi("remove-run", "Removes a run configuration; returns { deleted }.",
      [{ name: "run_id", type: "bigint", description: "The run configuration." }],
      (r) => ({ deleted: data.update("code_runs", { deleted: true, updated_by: r.userId, updated_at: new Date().toISOString() }, { id: run(r.args.run_id).id }) }));

    onApiRead((r) => data.select(r.table, r.where));
  },
};
