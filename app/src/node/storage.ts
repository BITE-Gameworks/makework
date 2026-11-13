// What a node keeps on disk, under its data folder:
//   servers/<id>/commits.jsonl   each hosted server's signed log, one commit per line
//   content/<hash>               file content by SHA-256 (hex), shared by every hosted server
//   parts/<hash>.part            downloads on their way, resumed after a restart
//   pieces/<hash>/<n>, p<g>      pieces of big files this node keeps (p2p/pieces.ts): data piece n, parity piece g
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContentWriter } from "../core/stream";
import type { CommitStore } from "../p2p/ledger";
import { compareCommits, type Commit } from "../p2p/log";
import type { StreamStore } from "../p2p/stream";

const hashPattern = /^[0-9a-f]{64}$/;

export function fileCommits(dataDir: string): CommitStore & { forget(workspaceId: string): Promise<void> } {
  const file = (workspaceId: string) => join(dataDir, "servers", safe(workspaceId), "commits.jsonl");
  return {
    async load(workspaceId) {
      const text = await readFile(file(workspaceId), "utf8").catch(() => "");
      const commits: Commit[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          commits.push(JSON.parse(line) as Commit);
        } catch {
          // A line cut off by a crash; the commit comes again from the members.
        }
      }
      return commits.sort(compareCommits);
    },
    async add(workspaceId, commits) {
      await mkdir(join(dataDir, "servers", safe(workspaceId)), { recursive: true });
      await appendFile(file(workspaceId), commits.map((c) => `${JSON.stringify(c)}\n`).join(""));
    },
    async forget(workspaceId) {
      await rm(join(dataDir, "servers", safe(workspaceId)), { recursive: true, force: true });
    },
  };
}

export interface NodeContent extends StreamStore {
  has(hash: string): Promise<boolean>;
  // Every whole file here, by hash: one read of the folder, for passes over every file (not a stat each).
  hashes(): Promise<Set<string>>;
  remove(hash: string): Promise<void>;
  // Pieces by key ("<hash>:<n>" or "<hash>:p<g>").
  readPiece(key: string): Promise<Uint8Array<ArrayBuffer> | null>;
  writePiece(key: string, bytes: Uint8Array): Promise<void>;
  removePiece(key: string): Promise<void>;
  // Every piece kept, by file.
  pieces(): Promise<Map<string, string[]>>;
  // The pieces kept of one file.
  piecesOf(hash: string): Promise<string[]>;
}

const pieceKeyPattern = /^([0-9a-f]{64}):(p?\d+)$/;

export function fileContent(dataDir: string): NodeContent {
  const contentDir = join(dataDir, "content");
  const partsDir = join(dataDir, "parts");
  const piecesDir = join(dataDir, "pieces");
  const path = (hash: string) => join(contentDir, checked(hash));
  const size = async (hash: string) => {
    try {
      return (await stat(path(hash))).size;
    } catch {
      return null;
    }
  };
  return {
    size,
    has: async (hash) => (await size(hash)) !== null,
    hashes: async () => new Set((await readdir(contentDir).catch(() => [] as string[])).filter((name) => hashPattern.test(name))),
    async readRange(hash, start, end) {
      const handle = await open(path(hash), "r").catch(() => null);
      if (!handle) return null;
      try {
        const bytes = new Uint8Array(new ArrayBuffer(Math.max(0, end - start)));
        const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, start);
        return bytes.subarray(0, bytesRead) as Uint8Array<ArrayBuffer>;
      } finally {
        await handle.close();
      }
    },
    async openWriter(hash) {
      await mkdir(partsDir, { recursive: true });
      await mkdir(contentDir, { recursive: true });
      const part = join(partsDir, `${checked(hash)}.part`);
      const handle = await open(part, "a");
      let written = (await handle.stat()).size;
      const writer: ContentWriter = {
        get size() {
          return written;
        },
        async append(bytes) {
          await handle.write(bytes);
          written += bytes.byteLength;
        },
        async finish(expected) {
          await handle.close();
          const actual = await hashFile(part);
          if (actual !== (expected ?? hash)) {
            await rm(part, { force: true });
            throw new Error(`Content ${hash.slice(0, 8)} doesn't match its hash.`);
          }
          const existed = (await size(actual)) !== null;
          if (existed) await rm(part, { force: true });
          else await rename(part, path(actual));
          return { hash: actual, existed };
        },
        async close(discard) {
          await handle.close().catch(() => {});
          if (discard) await rm(part, { force: true });
        },
      };
      return writer;
    },
    async remove(hash) {
      await rm(path(hash), { force: true });
      await rm(join(partsDir, `${checked(hash)}.part`), { force: true });
    },
    async readPiece(key) {
      return readFile(piecePath(key)).then((b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength) as Uint8Array<ArrayBuffer>, () => null);
    },
    async writePiece(key, bytes) {
      const file = piecePath(key);
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(`${file}.tmp`, bytes);
      await rename(`${file}.tmp`, file);
    },
    async removePiece(key) {
      await rm(piecePath(key), { force: true });
    },
    async pieces() {
      const out = new Map<string, string[]>();
      for (const hash of await readdir(piecesDir).catch(() => [] as string[])) {
        if (!hashPattern.test(hash)) continue;
        const names = (await readdir(join(piecesDir, hash)).catch(() => [] as string[])).filter((n) => /^p?\d+$/.test(n));
        if (names.length) out.set(hash, names.map((n) => `${hash}:${n}`));
      }
      return out;
    },
    async piecesOf(hash) {
      if (!hashPattern.test(hash)) return [];
      const names = await readdir(join(piecesDir, hash)).catch(() => [] as string[]);
      return names.filter((n) => /^p?\d+$/.test(n)).map((n) => `${hash}:${n}`);
    },
  };

  function piecePath(key: string) {
    const match = pieceKeyPattern.exec(key);
    if (!match) throw new Error("Not a piece key.");
    return join(piecesDir, match[1], match[2]);
  }
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
  });
}

function checked(hash: string): string {
  if (!hashPattern.test(hash)) throw new Error("Not a content hash.");
  return hash;
}

// Server ids are base64url; anything else can't become a path.
function safe(workspaceId: string): string {
  if (!/^[A-Za-z0-9_-]{16,}$/.test(workspaceId)) throw new Error("Not a workspace id.");
  return workspaceId;
}
