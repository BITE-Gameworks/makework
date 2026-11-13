// Types for electron/codeTools.js, which the main process runs as plain JavaScript (only what tests use).
export function toolFailure(output: string): string;
export function cmdArg(arg: string): string;

// A window's page as far as terminals need it (Electron's WebContents).
interface Page {
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
  once(event: "destroyed", handler: () => void): void;
}

export interface TerminalState {
  workspaceId: string;
  channelId: number;
  title: string;
  command: string | null;
  running: boolean;
  exitCode: number | null;
  backlog: string;
}

export function createCodeTools(deps: {
  baseDir: string;
  serversDir: string;
  findContent: (...args: never[]) => unknown;
  spawn: (...args: never[]) => unknown;
  loadPty: () => Promise<unknown>;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}): {
  startTerminal(sender: Page, options: { workspaceId: string; channelId: number; command?: string; shell?: string; title?: string; cols: number; rows: number }): Promise<number>;
  adoptTerminal(sender: Page, id: number): TerminalState;
  restartTerminal(id: number): Promise<void>;
  killTerminal(id: number): void;
  closeTerminal(id: number): void;
  terminalOwner(id: number): Page | null;
  terminalOrigin(id: number): Page | null;
  writeTerminal(id: number, data: string): void;
  resizeTerminal(id: number, cols: number, rows: number): void;
};
