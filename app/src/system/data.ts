// In-memory stand-in for a plugin's context.Data (Extensions/ExtensionData.cs).
import type { ApiValue, ColumnType, ServerEvent } from "../api/types";
import { AccessDenied, Failed, InvalidRequest } from "./errors";
import { convert, identifier, toJson, type StoredValue } from "./values";

export interface MockTable {
  name: string;
  parent: string | null;
  columns: Record<string, ColumnType>;
  // The column naming a row's parent row in this same table (a folder tree): a row under a deleted row is deleted
  // too, though only the parent is marked. Nodes read it to tell what is still pointed at (node/host.ts `rows`).
  tree?: string;
}

export interface MockManifest {
  name: string;
  version: string;
  description: string;
  tables: MockTable[];
}

type StoredRow = { id: number } & Record<string, StoredValue>;
export type JsonRow = { id: number } & Record<string, ApiValue>;
export type Values = Record<string, unknown>;

// A plugin's tables, like context.Data: in memory here, or a synced document for serverless workspaces.
export interface PluginStore {
  insert(table: string, values: Values): number;
  select(table: string, where?: Values): JsonRow[];
  update(table: string, values: Values, where: Values): number;
  delete(table: string, where: Values): number;
}

// Rows grouped by one column's value, read once: for lists that need other tables per row (a channel's messages with
// their reactions, a board's tasks with their tags). Looked up per row, every lookup scanned a whole table (mesh-test
// s15: listing a 3,000-message channel took about 0.4 s).
export function groupRows(rows: JsonRow[], column: string): Map<unknown, JsonRow[]> {
  const groups = new Map<unknown, JsonRow[]>();
  for (const row of rows) {
    const list = groups.get(row[column]);
    if (list) list.push(row);
    else groups.set(row[column], [row]);
  }
  return groups;
}

export class MockPluginData implements PluginStore {
  private readonly tables = new Map<string, { columns: Record<string, ColumnType>; rows: StoredRow[]; nextId: number }>();

  constructor(
    private readonly manifest: MockManifest,
    private readonly emit: (event: ServerEvent) => void,
  ) {
    for (const table of manifest.tables) this.tables.set(table.name, { columns: table.columns, rows: [], nextId: 1 });
  }

  insert(table: string, values: Values): number {
    const [name, store] = this.own(table);
    const row = { id: store.nextId, ...convertValues(name, store.columns, values) } as StoredRow;
    for (const column of Object.keys(store.columns)) row[column] ??= null;
    store.nextId++;
    store.rows.push(row);
    this.emit({ plugin: this.manifest.name, table: name, change: "insert", ids: [row.id] });
    return row.id;
  }

  select(table: string, where: Values = {}): JsonRow[] {
    const [name, store] = this.own(table);
    return this.matching(name, store, where).map(
      (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, toJson(v)])) as JsonRow);
  }

  update(table: string, values: Values, where: Values): number {
    const [name, store] = this.own(table);
    requireWhere(where);
    const changes = convertValues(name, store.columns, values);
    const rows = this.matching(name, store, where);
    for (const row of rows) Object.assign(row, changes);
    if (rows.length > 0)
      this.emit({ plugin: this.manifest.name, table: name, change: "update", ids: rows.map((r) => r.id) });
    return rows.length;
  }

  delete(table: string, where: Values): number {
    const [name, store] = this.own(table);
    requireWhere(where);
    const doomed = this.matching(name, store, where);
    store.rows = store.rows.filter((row) => !doomed.includes(row));
    if (doomed.length > 0)
      this.emit({ plugin: this.manifest.name, table: name, change: "delete", ids: doomed.map((r) => r.id) });
    return doomed.length;
  }

  private matching(name: string, store: { columns: Record<string, ColumnType>; rows: StoredRow[] }, where: Values) {
    const conditions = Object.entries(convertValues(name, { id: "bigint", ...store.columns }, where));
    return store.rows.filter((row) => conditions.every(([column, value]) => same(row[column], value)));
  }

  private own(table: string) {
    const name = identifier(table);
    const store = this.tables.get(name);
    if (!store) throw notOwned(this.manifest, name);
    return [name, store] as const;
  }
}

// Converts written values to their column types, rejecting unknown columns like PostgreSQL does.
export function convertValues(table: string, columns: Record<string, ColumnType>, values: Values): Record<string, StoredValue> {
  const converted: Record<string, StoredValue> = {};
  for (const [key, value] of Object.entries(values)) {
    const column = identifier(key);
    const type = Object.hasOwn(columns, column) ? columns[column] : undefined;
    if (!type) throw new Failed(`42703: column "${column}" of relation "${table}" does not exist`);
    converted[column] = convert(column, type, value,
      () => new Failed(`42804: column "${column}" is of type ${type} but expression is of type ${typeof value}`));
  }
  return converted;
}

export function notOwned(manifest: MockManifest, table: string): AccessDenied {
  const names = manifest.tables.map((t) => t.name);
  return new AccessDenied(`Plugin '${manifest.name}' can't access table '${table}'; ` +
    (names.length === 0 ? "it declares no tables." : `it can only use ${names.join(", ")}.`));
}

export function requireWhere(where: Values) {
  if (Object.keys(where).length === 0) throw new InvalidRequest("A where condition is required to choose the rows.");
}

function same(a: StoredValue | undefined, b: StoredValue): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return (a ?? null) === b;
}
