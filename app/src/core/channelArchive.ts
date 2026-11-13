// A channel as a .zip: `channel.json` (the channel, every row of its plugin that belongs to it, and the profiles
// of the people in it) and `content/<hash>` for each file whose content is on this device. Importing makes a new
// channel with new row ids; rows keep their authors, and content refs keep working because they name the bytes.
import { Unzip, UnzipInflate, Zip, ZipDeflate, ZipPassThrough, strFromU8, strToU8 } from "fflate";
import type { ApiValue } from "../api/types";
import { newRowId, type Ledger } from "../p2p/ledger";
import type { Op } from "../p2p/log";
import { personColumns } from "../p2p/people";
import { localPlugins } from "../p2p/plugins";
import { channelImportAction } from "../p2p/policy";
import { hasContent, refHash } from "./content";
import { workspaceLedger } from "./serverless";
import type { Channel } from "./workspaces";
import { chunkSize, contentSize, openWriter, readRange, type ContentWriter } from "./stream";

const format = "makework-channel";
const version = 1;
const opsPerCommit = 400;

interface Archive {
  format: string;
  version: number;
  exportedAt: string;
  channel: { name: string; type: string };
  tables: Record<string, Record<string, ApiValue>[]>;
  profiles: Record<string, ApiValue>[];
}

function ledgerOf(workspaceId: string): Ledger {
  const ledger = workspaceLedger(workspaceId);
  if (!ledger) throw new Error("Only serverless workspaces can export and import channels.");
  return ledger;
}

// The rows of the channel's plugin that belong to it: rows with its channel_id, then rows pointing at those.
function channelRows(ledger: Ledger, channel: Channel): Record<string, Record<string, ApiValue>[]> {
  // A voice channel keeps no synced rows: its archive is the channel alone.
  if (localPlugins.includes(channel.type)) return {};
  const manifest = ledger.manifest(channel.type);
  if (!manifest) throw new Error(`This app can't export ${channel.type} channels.`);
  const ids = new Set<number>();
  const tables: Record<string, Record<string, ApiValue>[]> = {};
  let grew = true;
  while (grew) {
    grew = false;
    for (const table of manifest.tables) {
      const refs = Object.keys(table.columns).filter((c) => c.endsWith("_id") && c !== "channel_id" && !personColumns.has(c));
      for (const row of ledger.select(channel.type, table.name, {})) {
        if (ids.has(row.id)) continue;
        const belongs = "channel_id" in table.columns
          ? row.channel_id === channel.id
          : refs.some((c) => row[c] !== null && ids.has(Number(row[c])));
        if (!belongs) continue;
        ids.add(row.id);
        (tables[table.name] ??= []).push(row);
        grew = true;
      }
    }
  }
  return tables;
}

export async function exportChannel(workspaceId: string, channel: Channel): Promise<{ blob: Blob; missing: number }> {
  const ledger = ledgerOf(workspaceId);
  const tables = channelRows(ledger, channel);
  const rows = Object.values(tables).flat();
  const people = new Set(rows.flatMap((row) => [...personColumns].map((c) => row[c]).filter((v) => v !== null && v !== undefined)));
  const profiles = ledger.select("members", "members_profiles", {}).filter((p) => people.has(p.user_id as number))
    .map(({ id: _, ...profile }) => profile);
  const archive: Archive = {
    format, version, exportedAt: new Date().toISOString(), channel: { name: channel.name, type: channel.type }, tables, profiles,
  };
  const hashes = new Set(rows.flatMap((row) => Object.values(row).map((v) => (typeof v === "string" ? refHash(v) : null))
    .filter((h): h is string => !!h)));

  const parts: Uint8Array[] = [];
  let failed: Error | null = null;
  const zip = new Zip((error, chunk) => {
    if (error) failed = error;
    else parts.push(chunk);
  });
  const json = new ZipDeflate("channel.json", { level: 6 });
  zip.add(json);
  json.push(strToU8(JSON.stringify(archive, null, 1)), true);
  let missing = 0;
  for (const hash of hashes) {
    const size = (await hasContent(hash)) ? await contentSize(hash) : null;
    if (size === null) {
      missing++;
      continue;
    }
    const file = new ZipPassThrough(`content/${hash}`);
    zip.add(file);
    if (size === 0) file.push(new Uint8Array(0), true);
    for (let offset = 0; offset < size; offset += chunkSize) {
      const end = Math.min(size, offset + chunkSize);
      const bytes = await readRange(hash, offset, end);
      if (!bytes) throw new Error("A file's content went missing while exporting.");
      file.push(bytes, end === size);
    }
  }
  zip.end();
  if (failed) throw failed;
  return { blob: new Blob(parts as BlobPart[], { type: "application/zip" }), missing };
}

// Reads the archive one chunk at a time, storing content as it comes; returns the new channel's id. `ids` picks the
// new channel's id and the new ids of the archive's rows ahead of time (rows it leaves out get fresh ones), so
// links to them can be written before the import.
export async function importChannel(workspaceId: string, categoryId: number, file: Blob,
  ids?: { channel: number; rows: Map<number, number> }): Promise<number> {
  const ledger = ledgerOf(workspaceId);
  const archive = await readArchive(file, workspaceId);
  const manifest = ledger.manifest(archive.channel.type);
  if (!manifest && !localPlugins.includes(archive.channel.type)) throw new Error(`This workspace has no ${archive.channel.type} channels.`);

  const siblings = ledger.select("channels", "channels_channels", { category_id: categoryId });
  let name = archive.channel.name;
  for (let n = 2; siblings.some((c) => c.name === name); n++) name = `${archive.channel.name}-${n}`;
  const channelId = ids?.channel ?? newRowId();
  const position = Math.max(0, ...siblings.map((c) => Number(c.position))) + 1;

  const renamed = ids?.rows ?? new Map<number, number>();
  for (const rows of Object.values(archive.tables)) for (const row of rows)
    if (!renamed.has(Number(row.id))) renamed.set(Number(row.id), newRowId());
  const ops: Op[] = [{
    ext: "channels", table: "channels_channels", kind: "insert", id: channelId,
    values: { category_id: categoryId, name, type: archive.channel.type, position },
  }];
  const known = new Set(ledger.select("members", "members_profiles", {}).map((p) => p.user_id));
  for (const profile of archive.profiles) {
    if (known.has(profile.user_id)) continue;
    known.add(profile.user_id);
    const columns = ledger.manifest("members")!.tables.find((t) => t.name === "members_profiles")!.columns;
    ops.push({ ext: "members", table: "members_profiles", kind: "insert", id: newRowId(), values: pick(profile, columns) });
  }
  for (const table of manifest?.tables ?? []) {
    for (const row of archive.tables[table.name] ?? []) {
      const values = pick(row, table.columns);
      for (const column of Object.keys(values)) {
        if (column === "channel_id") values[column] = channelId;
        // Columns naming a person keep their value; other *_id columns point at rows and are renamed.
        else if (column.endsWith("_id") && !personColumns.has(column) && values[column] !== null)
          values[column] = renamed.get(Number(values[column])) ?? values[column];
      }
      ops.push({ ext: manifest!.name, table: table.name, kind: "insert", id: renamed.get(Number(row.id))!, values });
    }
  }
  for (let i = 0; i < ops.length; i += opsPerCommit)
    ledger.transact(channelImportAction, () => ops.slice(i, i + opsPerCommit).forEach((op) => ledger.write(op)));
  await ledger.flush();
  return channelId;
}

function pick(row: Record<string, ApiValue>, columns: Record<string, unknown>): Record<string, ApiValue> {
  return Object.fromEntries(Object.keys(columns).map((c) => [c, row[c] ?? null]));
}

async function readArchive(file: Blob, workspaceId: string): Promise<Archive> {
  let json = "";
  const jsonParts: Uint8Array[] = [];
  // fflate calls back synchronously; content writes are chained and awaited between input chunks.
  let pending: Promise<unknown> = Promise.resolve();
  let failed: unknown = null;
  const unzip = new Unzip((entry) => {
    if (entry.name === "channel.json") {
      entry.ondata = (error, data, final) => {
        if (error) failed = error;
        else jsonParts.push(data);
        if (final && !error) json = strFromU8(concat(jsonParts));
      };
      entry.start();
      return;
    }
    const hash = /^content\/([0-9a-f]{64})$/.exec(entry.name)?.[1];
    if (!hash) return;
    const writer: Promise<ContentWriter | null> = pending.then(async () => ((await hasContent(hash)) ? null : openWriter(undefined, workspaceId)));
    pending = writer;
    entry.ondata = (error, data, final) => {
      if (error) failed = error;
      pending = pending.then(async () => {
        const w = await writer;
        if (!w) return;
        if (data.length > 0) await w.append(new Uint8Array(data));
        if (final) await w.finish(hash);
      }).catch((e) => (failed = e));
    };
    entry.start();
  });
  unzip.register(UnzipInflate);

  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    unzip.push(value ?? new Uint8Array(0), done);
    await pending;
    if (failed) throw failed instanceof Error ? failed : new Error("The .zip could not be read.");
    if (done) break;
  }
  if (!json) throw new Error("This .zip is not an exported channel.");
  const archive = JSON.parse(json) as Archive;
  if (archive.format !== format || typeof archive.channel?.type !== "string" || typeof archive.tables !== "object")
    throw new Error("This .zip is not an exported channel.");
  if (archive.version > version) throw new Error("This channel was exported by a newer version of MakeWork.");
  if (archive.channel.type === "ref_sheet") {
    archive.channel.type = "artboard";
    archive.tables = Object.fromEntries(Object.entries(archive.tables).map(([table, rows]) => [
      table.startsWith("ref_sheet_") ? `artboard_${table.slice("ref_sheet_".length)}` : table,
      rows,
    ]));
  }
  archive.profiles ??= [];
  return archive;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
