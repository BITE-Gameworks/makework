// Runs the plugins' data side in this app: answers ApiClient's requests (api/types.ts) from the plugins' tables and
// functions.
import type { ApiValue, ColumnType, FunctionInfo, ServerEvent, TableInfo } from "../api/types";
import { MockPluginData, type PluginStore, type MockManifest } from "./data";
import { mockUserId } from "./members";
import { AccessDenied, Failed, InvalidRequest } from "./errors";
import { convert, type StoredValue } from "./values";
import { compareText } from "../core/text";

export interface MockParameter {
  name: string;
  type: ColumnType;
  required?: boolean;
  description?: string;
}

export interface MockRequest {
  plugin: string;
  action: string;
  table: string;
  values: Record<string, ApiValue>;
  where: Record<string, ApiValue>;
  args: Record<string, StoredValue>;
  // The signed-in user the request acts as.
  userId: number;
}

type Handler = (request: MockRequest) => unknown;

interface MockFunction {
  name: string;
  description: string;
  parameters: MockParameter[];
  handler: Handler;
}

// What this device lends the data plugins: chat's keys (ADR 0021), absent on nodes and in tests.
export interface Services {
  chat?: ChatSealer;
}

// Seals and opens chat text with the channel's keys this device holds.
export interface ChatSealer {
  // Throws when this device has no current key for the channel (`ensure` makes one before posting).
  seal(channelId: number, authorId: number, text: string): string;
  // The text, plain text as it is, or null when this device has no key for it.
  open(channelId: number, authorId: number, text: string): string | null;
  // When a guest joined (ms); null for full members.
  guestSince(userId: number): number | null;
}

// What a mock plugin gets in register, like ExtensionContext.
export interface MockContext {
  data: PluginStore;
  services: Services;
  onApi(name: string, description: string, parameters: MockParameter[], handler: Handler): void;
  onApiRead(handler: Handler): void;
  onApiInsert(handler: Handler): void;
  onApiUpdate(handler: Handler): void;
  onApiDelete(handler: Handler): void;
}

export interface MockPlugin {
  manifest: MockManifest;
  register(context: MockContext): void;
}

export interface BackendOptions {
  userId?: number;
  store?: (manifest: MockManifest, emit: (event: ServerEvent) => void) => PluginStore;
  // Runs one request's writes as a unit (one commit, events after it). `action` is "<plugin>.<function>".
  transact?: <T>(run: () => T, action: string, as?: number) => T;
  services?: Services;
}

const functionName = /^[a-z][a-z0-9-]{0,62}$/;

export class MockBackend {
  private readonly plugins = new Map<string, { manifest: MockManifest; functions: Map<string, MockFunction>; data: PluginStore }>();
  private readonly listeners = new Set<(event: ServerEvent) => void>();
  private readonly userId: number;
  private readonly store: NonNullable<BackendOptions["store"]>;
  private readonly transact: NonNullable<BackendOptions["transact"]>;
  private readonly services: Services;

  constructor(options: BackendOptions = {}) {
    this.userId = options.userId ?? mockUserId;
    this.store = options.store ?? ((manifest, emit) => new MockPluginData(manifest, emit));
    this.transact = options.transact ?? ((run) => run());
    this.services = options.services ?? {};
  }

  // Tells listeners something changed that isn't a row (chat keys opened), so views read again.
  emit(event: ServerEvent): void {
    this.listeners.forEach((l) => l(event));
  }

  load(plugin: MockPlugin): void {
    const { manifest } = plugin;
    if (this.plugins.has(manifest.name)) throw new Error(`Plugin '${manifest.name}' is already loaded.`);
    const functions = new Map<string, MockFunction>();
    const data = this.store(manifest, (event) => this.listeners.forEach((l) => l(event)));
    this.plugins.set(manifest.name, { manifest, functions, data });

    const register = (fn: MockFunction) => {
      const name = fn.name.trim().toLowerCase();
      if (name === "describe") throw new Error("'describe' is answered by the API from the plugin's manifest.");
      if (!functionName.test(name)) throw new Error(`Invalid function name '${fn.name}'.`);
      if (functions.has(name)) throw new Error(`Plugin '${manifest.name}' already has a function '${name}'.`);
      functions.set(name, { ...fn, name });
    };
    const dataFunction = (name: string, description: string) => (handler: Handler) =>
      register({ name, description, parameters: [], handler: (r) => {
        if (r.table.length === 0) throw new InvalidRequest("'table' is required.");
        return handler(r);
      } });

    plugin.register({
      data,
      services: this.services,
      onApi: (name, description, parameters, handler) => register({ name, description, parameters, handler }),
      onApiRead: (h) => dataFunction("read", "Reads rows of one of the plugin's tables (table, optional where).")(
        (r) => ({ rows: h(r) })),
      onApiInsert: (h) => dataFunction("insert", "Inserts a row into one of the plugin's tables (table, values); returns its id.")(
        (r) => ({ id: h(r) })),
      onApiUpdate: (h) => dataFunction("update", "Updates rows of one of the plugin's tables (table, values, where); returns the count.")(
        (r) => ({ updated: h(r) })),
      onApiDelete: (h) => dataFunction("delete", "Deletes rows of one of the plugin's tables (table, where); returns the count.")(
        (r) => ({ deleted: h(r) })),
    });
  }

  // Direct table access for seeding mock data.
  data(plugin: string): PluginStore {
    const loaded = this.plugins.get(plugin);
    if (!loaded) throw new Error(`Plugin '${plugin}' is not loaded.`);
    return loaded.data;
  }

  // Whether a plugin is loaded (declared plugins load, and unload, as the workspace's rows change).
  has(name: string): boolean {
    return this.plugins.has(name);
  }

  remove(name: string): void {
    this.plugins.delete(name);
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  handle(json: string): string {
    let requestId: string | null = null;
    try {
      const raw = parseObject(json);
      requestId = readRequestId(raw);
      return respond(requestId, this.route(raw));
    } catch (e) {
      return respondError(requestId, e);
    }
  }

  private route(raw: Record<string, unknown>): unknown {
    const action = requiredString(raw, "action").trim().toLowerCase();
    if (action.length === 0) throw new InvalidRequest("'action' is required.");
    const plugin = action === "describe" ? optionalString(raw, "plugin") : requiredString(raw, "plugin");
    const acting = raw.as === undefined || raw.as === null ? undefined : Number(raw.as);
    if (acting !== undefined && !Number.isSafeInteger(acting)) throw new InvalidRequest("'as' must be a user id.");
    const request = {
      plugin, action,
      table: optionalString(raw, "table"),
      values: scalars(raw, "values"),
      where: scalars(raw, "where"),
      args: scalars(raw, "args"),
      userId: acting ?? this.userId,
    };

    if (action === "describe") return this.describe(request.plugin, request.table.trim().toLowerCase());

    const loaded = this.plugins.get(plugin);
    if (!loaded) throw new UnknownPlugin(plugin);
    const fn = loaded.functions.get(action);
    if (!fn) throw new NoHandler(`Plugin '${plugin}' does not handle '${action}'.`);
    const args = convertArgs(fn, request.args);
    return this.transact(() => fn.handler({ ...request, args }), `${plugin}.${action}`, acting);
  }

  private describe(plugin: string, table: string) {
    if (plugin.length === 0 && table.length > 0) throw new InvalidRequest("'table' needs an 'plugin'.");
    let selected;
    if (plugin.length === 0) selected = [...this.plugins.values()].sort((a, b) => compareText(a.manifest.name, b.manifest.name));
    else if (this.plugins.has(plugin)) selected = [this.plugins.get(plugin)!];
    else throw new UnknownPlugin(plugin);

    if (table.length > 0 && !selected[0].manifest.tables.some((t) => t.name === table))
      throw new InvalidRequest(`Plugin '${plugin}' has no table '${table}'.`);

    return {
      plugins: selected.map(({ manifest, functions }) => ({
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        functions: [...functions.values()].sort((a, b) => compareText(a.name, b.name)).map(describeFunction),
        tables: manifest.tables.filter((t) => table.length === 0 || t.name === table).map(describeTable),
      })),
    };
  }
}

class UnknownPlugin extends Error {
  constructor(name: string) {
    super(`No plugin '${name}' is loaded.`);
  }
}

class NoHandler extends Error {}

function jsonType(type: ColumnType): "string" | "number" | "boolean" {
  return type === "int" || type === "bigint" || type === "decimal" ? "number" : type === "bool" ? "boolean" : "string";
}

function describeFunction(fn: MockFunction): FunctionInfo {
  return {
    name: fn.name,
    description: fn.description,
    args: fn.parameters.map((p) => ({
      name: p.name, type: p.type, jsonType: jsonType(p.type), required: p.required ?? true, description: p.description ?? "",
    })),
  };
}

function describeTable(table: MockManifest["tables"][number]): TableInfo {
  const column = (name: string, type: ColumnType, writable: boolean) => ({ name, type, jsonType: jsonType(type), writable });
  return {
    name: table.name,
    parent: table.parent,
    columns: [column("id", "bigint", false), ...Object.entries(table.columns).map(([n, t]) => column(n, t, true))],
  };
}

function convertArgs(fn: MockFunction, args: Record<string, ApiValue>): Record<string, StoredValue> {
  for (const name of Object.keys(args))
    if (!fn.parameters.some((p) => p.name === name))
      throw new InvalidRequest(`Unknown argument '${name}' for '${fn.name}' ` + (fn.parameters.length === 0
        ? "(takes no arguments)."
        : `(takes ${fn.parameters.map((p) => p.name).join(", ")}).`));

  const converted: Record<string, StoredValue> = {};
  for (const p of fn.parameters) {
    const value = convert(p.name, p.type, args[p.name], () => new InvalidRequest(`'${p.name}' must be of type ${p.type}.`));
    if (value === null && (p.required ?? true)) throw new InvalidRequest(`'${p.name}' is required.`);
    converted[p.name] = value;
  }
  return converted;
}

function parseObject(json: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new InvalidRequest(`The request is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new InvalidRequest("The request must be a JSON object.");
  return parsed as Record<string, unknown>;
}

function readRequestId(raw: Record<string, unknown>): string | null {
  const id = raw.requestId;
  if (id === undefined || id === null) return null;
  if (typeof id !== "string") throw new InvalidRequest("'requestId' must be a string.");
  return id;
}

function requiredString(raw: Record<string, unknown>, name: string): string {
  const value = raw[name];
  if (value === undefined || value === null) throw new InvalidRequest(`'${name}' is required.`);
  if (typeof value !== "string") throw new InvalidRequest(`'${name}' must be a string.`);
  return value;
}

function optionalString(raw: Record<string, unknown>, name: string): string {
  return raw[name] === undefined || raw[name] === null ? "" : requiredString(raw, name);
}

function scalars(raw: Record<string, unknown>, name: string): Record<string, ApiValue> {
  const value = raw[name];
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new InvalidRequest(`'${name}' must be an object.`);
  for (const [key, v] of Object.entries(value))
    if (v !== null && typeof v === "object")
      throw new InvalidRequest(`'${name}.${key}' must be a string, number, boolean or null.`);
  return value as Record<string, ApiValue>;
}

function respond(requestId: string | null, data: unknown): string {
  return JSON.stringify({ requestId, ok: true, data });
}

function respondError(requestId: string | null, e: unknown): string {
  const [code, message] =
    e instanceof InvalidRequest ? ["invalid_request", e.message]
    : e instanceof UnknownPlugin ? ["unknown_plugin", e.message]
    : e instanceof NoHandler ? ["no_handler", e.message]
    : e instanceof AccessDenied ? ["access_denied", e.message]
    : e instanceof Failed ? ["failed", e.message]
    : ["internal_error", "Internal error."];
  if (code === "internal_error") console.error("Mock API:", e);
  return JSON.stringify({ requestId, ok: false, error: { code, message } });
}
