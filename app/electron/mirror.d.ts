// Types for electron/mirror.js, which the main process runs as plain JavaScript.
export function checkHash(hash: string): string;

export interface MirrorRecord {
  hash: string;
  size: number;
  mtimeMs: number;
}
export interface Manifest {
  folder: string | null;
  files: Record<string, MirrorRecord>;
}
export type MirrorEntry = { path: string[]; hash: string } | { path: string[]; text: string };
export interface MirrorChange {
  kind: "added" | "changed" | "removed";
  path: string[];
  base?: string;
  hash?: string;
  text?: string;
  size?: number;
  mtimeMs?: number;
}

export interface Places {
  findContent(hash: string): Promise<string | null>;
  storedContent(hash: string): Promise<string | null>;
  placedCopy(hash: string, except?: string): Promise<string | null>;
  loadPlacements(): Promise<void>;
  applyMirror(key: string, workspaceName: string, entries: MirrorEntry[]): Promise<{ folder: string; skipped: string[] }>;
  readManifest(key: string): Promise<Manifest>;
  manifestPath(key: string): string;
  mirrorBase(key: string, workspaceName: string): string;
  unchanged(file: string, record: MirrorRecord | undefined): Promise<boolean>;
  isText(record: MirrorRecord): boolean;
  moveFile(from: string, to: string): Promise<void>;
  removeMirrorFiles(base: string, manifest: Manifest): Promise<void>;
  removeEmptyParents(dir: string, stop: string): Promise<void>;
  remember(hash: string, file: string): void;
  forget(hash?: string): void;
  removePlaced(hash: string): Promise<void>;
  scan(key: string): Promise<void>;
  adopt(key: string, relative: string, stats: { hash?: string; size: number; mtimeMs: number }, moveTo?: string): Promise<boolean>;
  unwatch(key: string): void;
}

export function createPlaces(options: {
  localDir(): string;
  mirrorRoot(): string;
  locations(): Record<string, string>;
  contentDir(workspaceId: string): string;
  sharedContentDir(): string;
  allContentDirs(): string[];
  trashLater(file: string): Promise<void>;
  onChanges?(key: string, changes: MirrorChange[]): void;
}): Places;
