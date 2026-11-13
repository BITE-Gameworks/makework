import type { Transport } from "./transport";
import type {
  ApiErrorCode,
  ApiRequest,
  ApiResponse,
  ApiValue,
  PluginInfo,
  Row,
  ServerEvent,
} from "./types";

export class ApiRequestError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

// Text for users, by error code. error.message is for developers only, except policy refusals (below).
const userMessages: Record<ApiErrorCode, string> = {
  invalid_request: "That request was not valid.",
  unknown_plugin: "This feature is not available on this server.",
  no_handler: "This server does not support that action.",
  access_denied: "You don't have access to that.",
  failed: "The server could not complete that.",
  internal_error: "Something went wrong on the server.",
};

// An error raised on this device whose message is written for the user (a file that can't be read, ...).
export class ShownError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ShownError";
  }
}

export function userMessage(error: unknown): string {
  if (error instanceof ShownError) return error.message;
  // Serverless policy refusals (p2p/policy.ts) are written for users.
  if (error instanceof ApiRequestError) return error.code === "access_denied" && error.message ? error.message : userMessages[error.code];
  return "Could not reach the server.";
}

// For actions that run on this device as well: what went wrong there says more than the fallback above.
export function detailedMessage(error: unknown): string {
  const known = error instanceof ShownError || error instanceof ApiRequestError;
  return !known && error instanceof Error && error.message ? error.message : userMessage(error);
}

type Args = Record<string, ApiValue>;

// The typed client for one workspace connection.
export class ApiClient {
  private nextRequestId = 1;
  private describeCache: Promise<PluginInfo[]> | undefined;

  constructor(private readonly transport: Transport, private readonly actingAs?: number) {}

  // The same connection, with every request made as a bot the signed-in member hosts.
  forBot(botUserId: number): ApiClient {
    return new ApiClient(this.transport, botUserId);
  }

  async request<T>(request: Omit<ApiRequest, "requestId">): Promise<T> {
    const requestId = String(this.nextRequestId++);
    const raw = await this.transport.send(JSON.stringify({ requestId, ...(this.actingAs ? { as: this.actingAs } : {}), ...request }));
    const response = JSON.parse(raw) as ApiResponse<T>;
    if (!response.ok)
      throw new ApiRequestError(response.error.code, response.error.message, response.requestId);
    return response.data;
  }

  // Cached after the first call; plugins can add functions at runtime, so pass refresh to reload.
  describe(refresh = false): Promise<PluginInfo[]> {
    if (refresh || !this.describeCache) {
      this.describeCache = this.request<{ plugins: PluginInfo[] }>({ action: "describe" })
        .then((data) => data.plugins);
      this.describeCache.catch(() => (this.describeCache = undefined));
    }
    return this.describeCache;
  }

  // `active` tells the client whether the view it serves is currently shown: a hidden kept view's live stores
  // stay quiet (plugins/live.ts), so a client handed to a channel view is made with the host's accessor.
  plugin(name: string, active?: () => boolean): PluginClient {
    return new PluginClient(this, name, active);
  }

  onEvent(handler: (event: ServerEvent) => void): () => void {
    return this.transport.subscribe(handler);
  }

  close(): void {
    this.transport.close();
  }
}

// A client pinned to one plugin, the only API a channel UI or plugin gets.
export class PluginClient {
  constructor(
    private readonly api: ApiClient,
    readonly name: string,
    // Whether the view this client serves is shown; absent means yes (everything outside a channel view).
    readonly active?: () => boolean,
  ) {}

  call<T>(action: string, args?: Args): Promise<T> {
    return this.api.request<T>({ plugin: this.name, action, args });
  }

  async read(table: string, where?: Args): Promise<Row[]> {
    const data = await this.api.request<{ rows: Row[] }>({ plugin: this.name, action: "read", table, where });
    return data.rows;
  }

  async insert(table: string, values: Args): Promise<number> {
    const data = await this.api.request<{ id: number }>({ plugin: this.name, action: "insert", table, values });
    return data.id;
  }

  async update(table: string, values: Args, where: Args): Promise<number> {
    const data = await this.api.request<{ updated: number }>({
      plugin: this.name, action: "update", table, values, where,
    });
    return data.updated;
  }

  async delete(table: string, where: Args): Promise<number> {
    const data = await this.api.request<{ deleted: number }>({ plugin: this.name, action: "delete", table, where });
    return data.deleted;
  }

  async describe(): Promise<PluginInfo | undefined> {
    return (await this.api.describe()).find((e) => e.name === this.name);
  }

  onEvent(handler: (event: ServerEvent) => void): () => void {
    return this.api.onEvent((event) => {
      if (event.plugin === this.name) handler(event);
    });
  }
}
