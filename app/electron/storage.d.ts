// Types for electron/storage.js, which the main process runs as plain JavaScript.
export const dataDirName: string;
export function dataDir(folder: string): string;
export function contentDirOf(folder: string): string;
export function partialDirOf(folder: string): string;
export function commitsDirOf(folder: string): string;
export function commitFileName(commit: unknown): string;
export function splitOldHistory(folder: string): Promise<void>;
export function parseCommitLines(text: string): unknown[];
export function commitLines(commits: unknown[]): string;
export function folderState(folder: string, workspaceId: string | undefined): Promise<"empty" | "same" | "other" | "used">;
export interface ServerFile {
  id: string;
  name: string;
  secret?: string;
}
export function readServerFile(folder: string): Promise<ServerFile | null>;
export function describeFolder(folder: string, workspaceId: string, fields: { name?: string; secret?: string }): Promise<void>;
export function prepareFolder(folder: string, workspaceId: string, fields?: { name?: string; secret?: string }): Promise<void>;
export function loadCommits(folder: string): Promise<unknown[]>;
export function appendCommits(folder: string, commits: unknown[]): Promise<void>;
export function compactCommits(folder: string, hashes: string[]): Promise<void>;
export function loadCheckpoint(folder: string): Promise<unknown | null>;
export function saveCheckpoint(folder: string, checkpoint: unknown): Promise<void>;
export function deleteCheckpoint(folder: string): Promise<void>;
export function readRegistry(file: string): Promise<Record<string, string>>;
export function writeRegistry(file: string, registry: Record<string, string>): Promise<void>;
export function copyData(from: string, to: string): Promise<void>;
