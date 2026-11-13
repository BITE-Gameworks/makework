// Declared plugins: workspaces keep the data side of installed plugins without running their code during replay.
// A channels_plugins row names the plugin's channel type and its tables; one generic plugin in the backend serves
// them with the usual read/insert/update/delete. Every member loads the same tables from the same rows, so the
// policy (p2p/policy.ts) can check changes with the workspace's data alone.
import type { ColumnType } from "../api/types";
import type { MockManifest } from "./data";
import type { MockPlugin } from "./backend";
import type { ClientPlugin, DeclaredType } from "../plugins/types";
import { InvalidRequest } from "./errors";
import type { Ledger } from "../p2p/ledger";

// The tables a workspace row keeps (the data part of a plugin's manifest, resolved to workspace column types).
export interface DeclaredTable {
  name: string;
  parent: string | null;
  columns: Record<string, ColumnType>;
  channel?: boolean;
  authored?: string;
  owned?: boolean;
}

export interface DeclaredManifest {
  // The channel type this plugin backs (its data name), also the plugin's name in the backend.
  name: string;
  version: string;
  tables: DeclaredTable[];
}

const typeId = /^[a-z_][a-z0-9_]{0,62}$/;
const columnId = (name: string) => typeId.test(name) && !["__proto__", "constructor", "prototype"].includes(name);

// A plugin's declared table names start with its id, with '.' and '-' mapped to '_'.
export function dataNameOf(manifest: { id: string }): string {
  return manifest.id.replace(/[.-]/g, "_");
}

// The data plugin is also the channel type its client view serves. Plugins with several channel types choose one
// explicitly with data.type; otherwise their first contributed channel type is used.
export function declaredTypeOf(manifest: {
  id: string;
  data?: { type?: string } | null;
  contributes?: { channelTypes?: { id: string }[] };
}): string {
  return manifest.data?.type ?? manifest.contributes?.channelTypes?.[0]?.id ?? dataNameOf(manifest);
}

// Parses a channels_plugins row's manifest (JSON) tightly enough to serve tables and check the policy with.
// Throws InvalidRequest for anything unusable, so callers skip bad rows the same way everywhere.
export function parseDeclared(json: string): DeclaredManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new InvalidRequest("The plugin manifest is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new InvalidRequest("The plugin manifest must be an object.");
  const m = parsed as Partial<DeclaredManifest>;
  if (typeof m.name !== "string" || !typeId.test(m.name)) throw new InvalidRequest("The plugin manifest has no valid channel type name.");
  if (typeof m.version !== "string" || !m.version) throw new InvalidRequest("The plugin manifest has no version.");
  if (!Array.isArray(m.tables) || m.tables.length === 0)
    throw new InvalidRequest(`'${m.name}' declares no tables.`);
  const tables: DeclaredTable[] = [];
  const names = new Set<string>();
  for (const table of m.tables) {
    if (typeof table !== "object" || table === null) throw new InvalidRequest(`'${m.name}' has a table without a description.`);
    const t = table as Partial<DeclaredTable>;
    if (typeof t.name !== "string" || !typeId.test(t.name))
      throw new InvalidRequest(`'${m.name}' has a table with an invalid name.`);
    if (names.has(t.name)) throw new InvalidRequest(`'${m.name}' declares '${t.name}' more than once.`);
    names.add(t.name);
    if (typeof t.columns !== "object" || t.columns === null)
      throw new InvalidRequest(`'${m.name}'.${t.name} has no columns.`);
    if (t.parent !== undefined && t.parent !== null)
      throw new InvalidRequest(`'${m.name}'.${t.name} can't declare a parent table.`);
    const columns = Object.create(null) as Record<string, ColumnType>;
    for (const [column, type] of Object.entries(t.columns))
      if (columnId(column) && (typeof type === "string" ? isColumnType(type) : false)) columns[column] = type;
      else throw new InvalidRequest(`'${m.name}'.${t.name} column '${column}' has an unknown type.`);
    if (t.channel !== undefined && typeof t.channel !== "boolean")
      throw new InvalidRequest(`'${m.name}'.${t.name} channel must be true or false.`);
    if (t.owned !== undefined && typeof t.owned !== "boolean")
      throw new InvalidRequest(`'${m.name}'.${t.name} owned must be true or false.`);
    if (t.authored !== undefined && (typeof t.authored !== "string" || !Object.hasOwn(columns, t.authored)))
      throw new InvalidRequest(`'${m.name}'.${t.name} authored must name one of its columns.`);
    if (typeof t.authored === "string" && columns[t.authored] !== "bigint")
      throw new InvalidRequest(`'${m.name}'.${t.name} authored must be a user id column.`);
    if (t.channel && columns.channel_id !== "bigint")
      throw new InvalidRequest(`'${m.name}'.${t.name} channel tables need a bigint channel_id column.`);
    tables.push({
      name: t.name, parent: t.parent ?? null, columns,
      channel: t.channel, authored: t.authored, owned: t.owned,
    });
  }
  return { name: m.name, version: m.version, tables };
}

// The manifest a workspace row keeps for an installed plugin: the data tables resolved to workspace column types,
// with the channel's `channel_id` added to tables rows belong to. `name` is the channel type, so the API pins to
// it (`workspaceApi(workspaceId).plugin(type)`).
export function resolveDeclared(plugin: ClientPlugin, typeOverride?: string): DeclaredManifest {
  const data = plugin.manifest.data;
  if (!data || Object.keys(data.tables).length === 0)
    throw new InvalidRequest(`'${plugin.manifest.id}' declares no data tables.`);
  const name = typeOverride ?? declaredTypeOf(plugin.manifest);
  const tables: DeclaredTable[] = [];
  for (const [table, info] of Object.entries(data.tables)) {
    const prefix = `${dataNameOf(plugin.manifest)}_`;
    if (!table.startsWith(prefix)) throw new InvalidRequest(`Data table '${table}' must start with '${prefix}'.`);
    const columns = Object.fromEntries(Object.entries(info.columns).map(([c, t]) => [c, columnTypeOf(t)])) as Record<string, ColumnType>;
    if (info.channel && columns.channel_id === undefined) columns.channel_id = "bigint";
    tables.push({ name: table, parent: null, columns, channel: info.channel, authored: info.authored, owned: info.owned });
  }
  return { name, version: plugin.manifest.version, tables };
}

export function sameDeclaredSchema(a: DeclaredManifest, b: DeclaredManifest): boolean {
  const schema = (manifest: DeclaredManifest) => JSON.stringify({
    name: manifest.name,
    tables: [...manifest.tables].sort((left, right) => left.name.localeCompare(right.name)).map((table) => ({
      name: table.name,
      parent: table.parent,
      columns: Object.fromEntries(Object.entries(table.columns).sort(([left], [right]) => left.localeCompare(right))),
      channel: table.channel ?? false,
      authored: table.authored ?? null,
      owned: table.owned ?? false,
    })),
  });
  return schema(a) === schema(b);
}

// The declared column types as the workspace stores them.
export function columnTypeOf(type: DeclaredType): ColumnType {
  return type === "integer" || type === "user" ? "bigint" : type === "real" ? "decimal" : type === "bool" ? "bool" : "text";
}

function isColumnType(type: string): type is ColumnType {
  return columnTypes.has(type as ColumnType);
}
const columnTypes = new Set<ColumnType>(["text", "int", "bigint", "decimal", "bool", "timestamp"]);

// The generic plugin serving one declared manifest: the usual data functions, and a table's authored column filled
// with the member who added the row (the policy requires it).
export function declaredPlugin(manifest: MockManifest): MockPlugin {
  return {
    manifest,
    register({ data, onApiRead, onApiInsert, onApiUpdate, onApiDelete }) {
      onApiRead((r) => data.select(r.table, r.where));
      onApiInsert((r) => {
        const table = manifest.tables.find((t) => t.name === r.table) as DeclaredTable | undefined;
        const authored = table?.authored;
        return data.insert(r.table, authored ? { ...r.values, [authored]: r.userId } : r.values);
      });
      onApiUpdate((r) => data.update(r.table, r.values, r.where));
      onApiDelete((r) => data.delete(r.table, r.where));
    },
  };
}

// The backend manifest for one channels_plugins row, or null when the row can't be served (it stays inert).
export function declaredManifestFromRow(row: { manifest?: unknown }): MockManifest | null {
  try {
    const parsed = parseDeclared(String(row.manifest ?? ""));
    return {
      name: parsed.name, version: parsed.version,
      description: `Data of the '${parsed.name}' plugin.`,
      tables: parsed.tables,
    };
  } catch {
    return null;
  }
}

// Snapshot tables arrive before channels_plugins can be replayed, so register their data schemas before decoding
// the snapshot. The plugin code itself is still loaded only after the signed rows are accepted.
export function declaredManifestsFromSnapshot(value: unknown): MockManifest[] {
  if (typeof value !== "object" || value === null || !("tables" in value) || !Array.isArray(value.tables)) return [];
  const entry = value.tables.find((table: unknown) =>
    Array.isArray(table) && table[0] === "channels/channels_plugins" && Array.isArray(table[1]));
  if (!Array.isArray(entry)) return [];
  const manifests = new Map<string, MockManifest>();
  for (const row of entry[1] as unknown[]) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[1] !== "object" || row[1] === null) continue;
    const state = row[1] as { values?: unknown };
    if (typeof state.values !== "object" || state.values === null || !("manifest" in state.values)) continue;
    const manifest = declaredManifestFromRow({ manifest: state.values.manifest });
    if (manifest) manifests.set(manifest.name, manifest);
  }
  return [...manifests.values()];
}

// Loads the workspace's declared plugins into the backend and keeps them in step with channels_plugins. Call
// after ledger.load(): the already-stored log replays once more so commits to these tables are re-checked and
// kept. Returns a function that stops watching.
export function loadDeclared(ledger: Ledger, backend: { has(name: string): boolean; load(plugin: MockPlugin): void; remove(name: string): void }): () => void {
  const loaded = new Set<string>();
  const signatures = new Map<string, string>();
  const sync = () => {
    // Everything the workspace wants, by name.
    const wanted = new Map<string, MockManifest>();
    for (const row of ledger.select("channels", "channels_plugins", {})) {
      const manifest = declaredManifestFromRow({ manifest: row.manifest });
      if (manifest) wanted.set(manifest.name, manifest);
    }
    let changed = false;
    // Unload what is gone or changed; a changed one is loaded again below with its new tables.
    for (const name of [...loaded]) {
      if (signatures.get(name) !== signaturesOf(wanted.get(name))) {
        backend.remove(name);
        loaded.delete(name);
        signatures.delete(name);
        changed = true;
      }
    }
    for (const [name, manifest] of wanted) {
      // Already serving it (unchanged), or a name a built-in plugin has: nothing to do.
      if (loaded.has(name) || backend.has(name)) continue;
      backend.load(declaredPlugin(manifest));
      loaded.add(name);
      signatures.set(name, signaturesOf(manifest));
      changed = true;
    }
    if (changed) ledger.reregister();
  };
  sync();
  return ledger.subscribe((event) => {
    if (event.plugin === "channels" && event.table === "channels_plugins") sync();
  });
}

const signaturesOf = (manifest: MockManifest | undefined) => (manifest ? JSON.stringify(manifest.tables) : "");