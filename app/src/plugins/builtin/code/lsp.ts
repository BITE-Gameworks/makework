// A small Language Server Protocol client: the server runs in the desktop process (electron/codeTools.js) in the
// channel's run folder; this side keeps documents in step and asks for completion, hover and definitions.
import { desktop } from "../../../core/desktop";

export interface LspPosition { line: number; character: number }
export interface LspRange { start: LspPosition; end: LspPosition }
export interface LspDiagnostic { range: LspRange; severity?: number; message: string; source?: string; code?: string | number }

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type Listener = (event: { text?: string; exit?: number | null; errors?: string }) => void;

const listeners = new Map<number, Listener>();
let unsubscribe: (() => void) | undefined;
function listen(id: number, listener: Listener) {
  unsubscribe ??= desktop?.code?.onServer((serverId, event) => listeners.get(serverId)?.(event));
  listeners.set(id, listener);
  return () => listeners.delete(id);
}

export interface LspSession {
  open(uri: string, languageId: string, text: string): void;
  change(uri: string, text: string): void;
  close(uri: string): void;
  request<T>(method: string, params: unknown): Promise<T>;
  // False once the server stopped; the editor's own keywords and snippets come back then.
  running(): boolean;
  // Trigger characters for completion, from the server's capabilities.
  triggers: string[];
  stop(): void;
}

export async function startLsp(options: {
  serverId: string; workspaceId: string; channelId: number; folder: string; override?: string;
  onDiagnostics(uri: string, diagnostics: LspDiagnostic[]): void;
  onExit(message: string): void;
}): Promise<LspSession | { missing: string[]; install: string | null }> {
  const bridge = desktop!.code!;
  const started = await bridge.startServer(options.serverId, options.workspaceId, options.channelId, options.override);
  if (!started.ok) return { missing: started.missing, install: started.install };
  const id = started.id;
  let next = 1;
  let stopped = false;
  const pending = new Map<number, Pending>();
  const versions = new Map<string, number>();
  const send = (message: object) => !stopped && bridge.sendServer(id, JSON.stringify({ jsonrpc: "2.0", ...message }));
  const reply = (requestId: unknown, result: unknown) => send({ id: requestId, result });

  const stopListening = listen(id, (event) => {
    if (event.exit !== undefined) {
      stopped = true;
      stopListening();
      pending.forEach((p) => p.reject(new Error("The language server stopped.")));
      pending.clear();
      const last = event.errors?.trim().split("\n").at(-1);
      options.onExit(last ? `The language server stopped: ${last}` : "The language server stopped.");
      return;
    }
    let message: { id?: number | string; method?: string; params?: any; result?: unknown; error?: { message: string } };
    try {
      message = JSON.parse(event.text ?? "");
    } catch {
      return;
    }
    if (message.method && message.id !== undefined) {
      // Requests from the server: answer what a plain editor can.
      if (message.method === "workspace/configuration") reply(message.id, (message.params?.items ?? []).map(() => null));
      else if (message.method === "workspace/workspaceFolders") reply(message.id, [{ uri: fileUri(options.folder), name: "project" }]);
      else reply(message.id, null);
    } else if (message.method === "textDocument/publishDiagnostics") {
      options.onDiagnostics(String(message.params?.uri ?? ""), message.params?.diagnostics ?? []);
    } else if (typeof message.id === "number") {
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiting?.reject(new Error(message.error.message));
      else waiting?.resolve(message.result);
    }
  });

  const request = <T>(method: string, params: unknown) => new Promise<T>((resolve, reject) => {
    if (stopped) return reject(new Error("The language server stopped."));
    const requestId = next++;
    pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject });
    send({ id: requestId, method, params });
  });
  const notify = (method: string, params: unknown) => send({ method, params });

  const root = fileUri(options.folder);
  const init = await request<{ capabilities?: { completionProvider?: { triggerCharacters?: string[] } } }>("initialize", {
    processId: null, rootUri: root, rootPath: options.folder, workspaceFolders: [{ uri: root, name: "project" }],
    clientInfo: { name: "MakeWork" },
    capabilities: {
      textDocument: {
        synchronization: { dynamicRegistration: false, didSave: false },
        completion: { completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"] } },
        hover: { contentFormat: ["markdown", "plaintext"] },
        definition: {},
        publishDiagnostics: { relatedInformation: false },
      },
      workspace: { configuration: true, workspaceFolders: true },
    },
  });
  notify("initialized", {});

  return {
    triggers: init?.capabilities?.completionProvider?.triggerCharacters ?? [],
    request,
    running: () => !stopped,
    open(uri, languageId, text) {
      versions.set(uri, 1);
      notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } });
    },
    change(uri, text) {
      const version = (versions.get(uri) ?? 1) + 1;
      versions.set(uri, version);
      notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
    },
    close(uri) {
      versions.delete(uri);
      notify("textDocument/didClose", { textDocument: { uri } });
    },
    stop() {
      if (stopped) return;
      void request("shutdown", null).catch(() => {}).finally(() => {
        notify("exit", null);
        stopped = true;
        bridge.stopServer(id);
      });
    },
  };
}

// file:// address of a local path, the way language servers write them (percent-encoded, forward slashes).
export function fileUri(path: string): string {
  const slashed = path.replaceAll("\\", "/");
  const absolute = slashed.startsWith("/") ? slashed : `/${slashed}`;
  return `file://${absolute.split("/").map((part, i) => (i === 1 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part))).join("/")}`;
}
