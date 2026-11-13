// Types for electron/lspInstall.js, which the main process runs as plain JavaScript.
type FetchLike = (url: string, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "url" | "json" | "arrayBuffer">>;
export function csharpLsVersion(sdkList: string): string | null;
export function createLspInstaller(deps: {
  baseDir: string;
  findCommand: (name: string) => string | null;
  run: (file: string, args: string[], env?: Record<string, string>) => Promise<string>;
  fetch?: FetchLike;
}): {
  installed(id: string): [string, string[], Record<string, string>] | null;
  list(): Promise<{ id: string; from: string; installing: boolean; size: number | null }[]>;
  uninstall(id: string): Promise<void>;
  source(id: string): string | null;
  install(id: string): Promise<void>;
};
