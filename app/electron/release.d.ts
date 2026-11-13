// Types for electron/release.js (the main process runs it as plain JavaScript).
export type Collect = { kind: "binaries" | "installers" | "zip" } | { kind: "pattern"; pattern: string };
export interface BuildPlan { project: string; steps: string[]; output: string; collect: Collect }
type Host = { platform?: string; wine?: boolean };
type Entry = { name: string; isDir: boolean };

export function isBinary(name: string): boolean;
export function detectBuild(root: string, options?: Host & { readText?: (file: string) => Promise<string>; entries?: (dir: string) => Promise<Entry[]> }):
  Promise<{ label: string; tools: string[]; note: string | null; plan: BuildPlan } | null>;
export function chooseFiles(entries: { path: string; isFile: boolean; mtimeMs: number; mode: number }[], collect: Collect,
  options?: { platform?: string; before?: Map<string, number> }): string[];
export function checkPlan(plan: unknown): BuildPlan;
export function defaultCommand(pkg: unknown, host?: Host): string;
export function buildNote(host?: Host): string;
export function uploadAsset(options: {
  target: { method: "POST" | "PUT"; url: string; headers: Record<string, string> }; file: string; name: string;
  onProgress?: (done: number) => void; base?: string;
}): Promise<unknown>;
export function build(options: {
  folder: string; branch: string; plan: unknown; host?: Host; onLog: (line: string) => void; signal?: AbortSignal;
  git: (cwd: string, args: string[]) => Promise<unknown>;
}): Promise<{ path: string; name: string; size: number }[]>;
