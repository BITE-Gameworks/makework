// The request and answer shapes between the app and the plugins' data side (system/backend.ts), as JSON.

// Any function name a plugin offers ("read", "tag-note", ...), or "describe". See describe's functions list.
export type ApiAction = string;
export type ApiValue = string | number | boolean | null;

export interface ApiRequest {
  requestId?: string;
  plugin?: string;   // required except for "describe"
  action: ApiAction;
  table?: string;       // for read / insert / update
  where?: Record<string, ApiValue>;
  values?: Record<string, ApiValue>;
  args?: Record<string, ApiValue>;   // for plugin functions
  as?: number;   // act as this bot (serverless: a bot the signed-in member hosts)
}

export type ApiErrorCode =
  | "invalid_request"
  | "unknown_plugin"
  | "no_handler"
  | "access_denied"
  | "failed"
  | "internal_error";

export interface ApiError {
  code: ApiErrorCode;
  message: string;
}

export type Row = { id: number } & Record<string, ApiValue>;

export type ApiResponse<T> =
  | { requestId: string | null; ok: true; data: T }
  | { requestId: string | null; ok: false; error: ApiError };

export type ColumnType = "text" | "int" | "bigint" | "decimal" | "bool" | "timestamp";

export interface ColumnInfo {
  name: string;
  type: ColumnType;
  jsonType: "string" | "number" | "boolean";
  writable: boolean;
}

export interface TableInfo {
  name: string;
  parent: string | null;
  columns: ColumnInfo[];
}

export interface ArgInfo {
  name: string;
  type: ColumnType;
  jsonType: "string" | "number" | "boolean";
  required: boolean;
  description: string;
}

export interface FunctionInfo {
  name: string;
  description: string;
  args: ArgInfo[];
}

export interface PluginInfo {
  name: string;
  version: string;
  description: string;
  functions: FunctionInfo[];
  tables: TableInfo[];
}

// A change to a plugin's table, sent to every subscriber.
export interface ServerEvent {
  plugin: string;
  table: string;
  change: "insert" | "update" | "delete";
  ids: number[];
}
