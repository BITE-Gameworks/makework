// Types for electron/files.js, which the main process runs as plain JavaScript.
export function safeSegment(name: string): string;
export function isInside(dir: string, file: string, paths?: typeof import("node:path")): boolean;
export function caseFreePaths(paths: string[][]): string[][];
export function removeOrDefer(file: string, how: {
  rm: (file: string, options: { force: boolean; maxRetries: number; retryDelay: number }) => Promise<void>;
  later: (file: string) => Promise<void>;
}): Promise<void>;
