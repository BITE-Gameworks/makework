// A workspace's readable folder: channels/<category>/<channel>/..., each channel written by its type's disk layout
// (plugin `disk`). Paths are relative to the workspace's folder; the desktop app writes them (electron/main.js
// applyMirror). Every name is already unique in its folder, ignoring case, so text files can refer to each other.
import { refHash } from "../core/content";
import { numberedName, safeName } from "../core/fileNames";
import { decodeEmoji } from "../markdown/emoji";
import type { DiskChange, DiskContext, DiskEntry, DiskLayout } from "../plugins/types";
import type { JsonRow } from "../system/data";

export const channelsFolder = "channels";

export interface DiskChannel {
  id: number;
  name: string;
  type: string;
  categoryId: number;
  position: number;
}

export interface DiskCategory {
  id: number;
  name: string;
  position: number;
}

export interface DiskSource {
  categories: DiskCategory[];
  channels: DiskChannel[];
  layoutFor(type: string): DiskLayout | undefined;
  rows(plugin: string, table: string): JsonRow[];
  // Whether this device keeps the content.
  kept(hash: string): boolean;
  // See DiskContext.fileExtension.
  fileExtension(hash: string): string;
  exportFile?(url: string, format: string): Promise<{ name: string; blob: Blob } | null>;
  // Channels forgotten on this device: nothing of theirs is placed in the readable folder, and files already
  // placed there are removed again by the mirror's next pass (unchanged ones only; see electron/mirror.js).
  forgotten?(channelId: number): boolean;
}

export type Namer = (folder: string[], key: string, wanted: string) => string;

// Names (emoji shortcodes shown as emoji) that stay the same for the same key, numbered ("name (2).png") when another key in that folder took it.
export function createNamer(): Namer {
  const folders = new Map<string, { taken: Set<string>; byKey: Map<string, string> }>();
  return (folder, key, wanted) => {
    const id = folder.join("/").toLowerCase();
    let names = folders.get(id);
    if (!names) folders.set(id, (names = { taken: new Set(), byKey: new Map() }));
    let name = names.byKey.get(key);
    if (name === undefined) {
      const base = safeName(decodeEmoji(wanted));
      name = base;
      for (let n = 2; names.taken.has(name.toLowerCase()); n++) name = numberedName(base, n);
      names.taken.add(name.toLowerCase());
      names.byKey.set(key, name);
    }
    return name;
  };
}

export interface DiskChannelView {
  channel: DiskChannel;
  layout: DiskLayout;
  // The channel's folder, from the workspace's readable folder.
  base: string[];
  context: DiskContext;
}

// Every channel with a disk layout, its folder and the context its layout runs in (one namer for the workspace).
export function diskChannels(source: DiskSource): DiskChannelView[] {
  const name = createNamer();
  const byPosition = <T extends { position: number; id: number }>(a: T, b: T) => a.position - b.position || a.id - b.id;
  const categories = new Map(source.categories.map((c) => [c.id, c]));
  const categoryFolder = (id: number): string[] => {
    const category = categories.get(id);
    return category ? [channelsFolder, name([channelsFolder], `category:${id}`, category.name)] : [channelsFolder];
  };
  for (const category of [...source.categories].sort(byPosition)) categoryFolder(category.id);

  // Rows grouped by channel (or another column) once per table, not filtered again for every channel.
  const grouped = new Map<string, Map<number, JsonRow[]>>();
  const rowsBy = (plugin: string, table: string, column: string, id: number) => {
    const key = `${plugin}/${table}/${column}`;
    let byValue = grouped.get(key);
    if (!byValue) {
      byValue = new Map();
      for (const row of source.rows(plugin, table)) {
        const value = Number(row[column]);
        (byValue.get(value) ?? byValue.set(value, []).get(value)!).push(row);
      }
      grouped.set(key, byValue);
    }
    return byValue.get(id) ?? [];
  };

  const views: DiskChannelView[] = [];
  for (const channel of [...source.channels].sort(byPosition)) {
    const layout = source.layoutFor(channel.type);
    if (!layout || source.forgotten?.(channel.id)) continue;
    const parent = categoryFolder(channel.categoryId);
    const base = [...parent, name(parent, `channel:${channel.id}`, channel.name)];
    views.push({
      channel, layout, base,
      context: {
        channel: { id: channel.id, name: channel.name },
        rows: (plugin, table, by) => by
          ? [...by.ids].flatMap((id) => rowsBy(plugin, table, by.column, id))
          : rowsBy(plugin, table, "channel_id", channel.id),
        kept: (url) => {
          const hash = refHash(typeof url === "string" ? url : null);
          return hash && source.kept(hash) ? hash : null;
        },
        fileExtension: source.fileExtension,
        name: (folder, key, wanted) => name([...base, ...folder], key, wanted),
        exportFile: source.exportFile,
      },
    });
  }
  return views;
}

export async function diskEntries(source: DiskSource): Promise<DiskEntry[]> {
  const entries = await Promise.all(diskChannels(source).map(async ({ layout, base, context }) =>
    (await layout.entries(context)).map((entry) => ({ ...entry, path: [...base, ...entry.path] }))));
  return entries.flat();
}

// The channel a path in the readable folder is in, and the path inside its folder.
export function channelOfPath(views: DiskChannelView[], path: string[]): { view: DiskChannelView; inner: string[] } | null {
  const lower = path.map((s) => s.toLowerCase());
  const view = views.find((v) => v.base.length < path.length && v.base.every((s, i) => s.toLowerCase() === lower[i]));
  return view ? { view, inner: path.slice(view.base.length) } : null;
}

// A file moved on disk shows as removed at one path and added at another with the same content: one "moved".
export function pairMoves(changes: DiskChange[]): DiskChange[] {
  const removed = changes.filter((c) => c.kind === "removed");
  const used = new Set<DiskChange>();
  const result: DiskChange[] = [];
  for (const change of changes) {
    if (change.kind !== "added" || !change.hash) continue;
    const from = removed.find((r) => !used.has(r) && (r.base === change.hash || r.base === `text:${change.hash}`));
    if (from) {
      used.add(from);
      result.push({ ...change, kind: "moved", from: from.path, base: from.base });
    }
  }
  const moved = new Set(result.map((c) => c.path.join("/")));
  for (const change of changes)
    if (!used.has(change) && !(change.kind === "added" && moved.has(change.path.join("/")))) result.push(change);
  return result;
}

// Rows that aren't deleted and whose parents (by `parent_id`, rows of the same list) aren't either. Big trees are
// walked once: each row's answer is kept.
export function livingRows(rows: JsonRow[]): JsonRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const living = new Map<number, boolean>();
  const alive = (row: JsonRow): boolean => {
    let result = living.get(row.id);
    if (result === undefined) {
      living.set(row.id, false);
      const parent = row.parent_id == null ? undefined : byId.get(Number(row.parent_id));
      result = row.deleted !== true && (row.parent_id == null || (!!parent && alive(parent)));
      living.set(row.id, result);
    }
    return result;
  };
  return rows.filter(alive);
}

// The folder path of a row in a tree, by `parent_id`: each parent's name from `nameOf`, unique in its folder.
export function treePaths(rows: JsonRow[], name: (folder: string[], key: string, wanted: string) => string,
  nameOf: (row: JsonRow) => string, root: string[] = []): Map<number, string[]> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const paths = new Map<number, string[]>();
  const pathOf = (row: JsonRow): string[] => {
    let result = paths.get(row.id);
    if (!result) {
      const parent = row.parent_id == null ? undefined : byId.get(Number(row.parent_id));
      const folder = parent ? pathOf(parent) : root;
      result = [...folder, name(folder, `row:${row.id}`, nameOf(row))];
      paths.set(row.id, result);
    }
    return result;
  };
  for (const row of rows) pathOf(row);
  return paths;
}

// "text:" records hash a file's text with SHA-256 (electron/mirror.js), as hex.
export async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
