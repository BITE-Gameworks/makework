// Content moving in and out of the store one chunk at a time, so no file is ever held whole in memory or sent
// through IPC in one piece (Chromium kills the page for IPC messages over about 128 MB).
//
// Uploads and downloads are written to a temporary part (desktop: a file in the app's data folder, browser:
// chunk Blobs in IndexedDB) and only moved into the store once complete and matching their SHA-256.
// A download's part is kept under its hash when it stops early, so the next try resumes where it stopped.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ShownError } from "../api/client";
import { markPresent } from "./content";
import { dbDeleteRange, dbGet, dbGetRange, dbPut, prefixRange } from "./db";
import { desktop, type DesktopBridge } from "./desktop";

export const chunkSize = 4 * 1024 * 1024;

// `existed`: the store already had this content (another file with the same bytes), so a cancelled upload
// must leave it there. `pieces`: the hash of the file's piece list, when one was made (`StoreOptions.pieceListFrom`).
export type Stored = { hash: string; existed: boolean; pieces?: string };

export interface ContentWriter {
  // Bytes written so far, including what a resumed download already had.
  readonly size: number;
  append(bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  // Moves the content into the store. Content that doesn't match `expected` is discarded.
  finish(expected?: string): Promise<Stored>;
  // Stops writing. A download's part is kept to resume from unless `discard`; an upload's is always removed.
  close(discard?: boolean): Promise<void>;
}

// A new upload, or with `resumeHash` the download of that content, continuing what arrived before. On desktop the
// content goes to `workspaceId`'s store (its folder, when it has one).
export function openWriter(resumeHash?: string, workspaceId?: string): Promise<ContentWriter> {
  return desktop?.content ? openDesktopWriter(desktop.content, resumeHash, workspaceId) : openBrowserWriter(resumeHash);
}

export interface StoreOptions {
  signal?: AbortSignal;
  onProgress?: (done: number) => void;
  // The workspace the file is for.
  workspaceId?: string;
  // Files of this size and more also get a piece list: the SHA-256 of each chunk, one after the other, stored as
  // content of its own. Nodes split such files into pieces of one chunk and check each against it (p2p/pieces.ts).
  pieceListFrom?: number;
}

// Copies a picked or pasted file into the store. Aborting `signal` stops it and deletes what was copied.
export async function storeFile(file: Blob, options: StoreOptions = {}): Promise<Stored> {
  const { signal, onProgress } = options;
  signal?.throwIfAborted();
  const writer = await openWriter(undefined, options.workspaceId);
  const list = options.pieceListFrom !== undefined && file.size >= options.pieceListFrom
    ? new Uint8Array(new ArrayBuffer(Math.ceil(file.size / chunkSize) * digestBytes))
    : null;
  let stored: Stored;
  try {
    // An empty file reads fine; a folder (often size 0) doesn't.
    if (file.size === 0) await readSlice(file, 0, 1);
    for (let offset = 0, i = 0; offset < file.size; offset += chunkSize, i++) {
      signal?.throwIfAborted();
      const bytes = await readSlice(file, offset, offset + chunkSize);
      // The digest copies the bytes when it starts, so it runs beside the write (which may hand the buffer on).
      const digest = list ? crypto.subtle.digest("SHA-256", bytes) : null;
      await writer.append(bytes);
      if (digest && list) list.set(new Uint8Array(await digest), i * digestBytes);
      onProgress?.(writer.size / file.size);
    }
    signal?.throwIfAborted();
    stored = await writer.finish();
  } catch (e) {
    await writer.close(true).catch(() => {});
    throw e;
  }
  if (!list) return stored;
  const listWriter = await openWriter(undefined, options.workspaceId);
  try {
    for (let offset = 0; offset < list.length; offset += chunkSize) await listWriter.append(list.slice(offset, offset + chunkSize));
    return { ...stored, pieces: (await listWriter.finish()).hash };
  } catch (e) {
    await listWriter.close(true).catch(() => {});
    console.warn("Piece list not stored:", e);
    return stored;
  }
}

const digestBytes = 32;

// A dropped or pasted folder is a File that can't be read (so is a file deleted or moved since it was picked).
async function readSlice(file: Blob, start: number, end: number): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  } catch (e) {
    const name = file instanceof File ? file.name : "the file";
    throw new ShownError(`Couldn't read "${name}". Folders can only be uploaded to a files channel.`, { cause: e });
  }
}

// Bytes [start, end) of stored content, or null when it isn't here.
export async function readRange(hash: string, start: number, end: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (desktop?.content) return desktop.content.readRange(hash, start, end);
  const blob = await dbGet<Blob>("content", hash);
  return blob ? new Uint8Array(await blob.slice(start, end).arrayBuffer()) : null;
}

export async function contentSize(hash: string): Promise<number | null> {
  if (desktop?.content) return desktop.content.size(hash);
  return (await dbGet<Blob>("content", hash))?.size ?? null;
}

async function openDesktopWriter(content: NonNullable<DesktopBridge["content"]>, resumeHash?: string, workspaceId?: string): Promise<ContentWriter> {
  const part = await content.partOpen(resumeHash ?? null, workspaceId);
  let size = part.size;
  return {
    get size() {
      return size;
    },
    async append(bytes) {
      size = await content.partAppend(part.id, bytes);
    },
    async finish(expected) {
      const stored = await content.partFinish(part.id, expected ?? null);
      markPresent(stored.hash);
      return stored;
    },
    close: (discard = false) => content.partClose(part.id, discard),
  };
}

// Uploads that never finished (page closed mid-way) are cleared once per session.
let tempCleared: Promise<void> | null = null;
const tempPrefix = "upload-";

async function openBrowserWriter(resumeHash?: string): Promise<ContentWriter> {
  tempCleared ??= dbDeleteRange("content-parts", IDBKeyRange.bound(tempPrefix, `${tempPrefix}￿`)).catch(() => {});
  await tempCleared;
  const key = resumeHash ?? `${tempPrefix}${crypto.randomUUID()}`;
  const hasher = sha256.create();
  let size = 0;
  let index = 0;
  if (resumeHash) {
    for (const part of await dbGetRange<Blob>("content-parts", prefixRange(key))) {
      hasher.update(new Uint8Array(await part.arrayBuffer()));
      size += part.size;
      index++;
    }
  }
  const discard = () => dbDeleteRange("content-parts", prefixRange(key));
  return {
    get size() {
      return size;
    },
    async append(bytes) {
      await dbPut("content-parts", new Blob([bytes]), `${key}:${String(index).padStart(8, "0")}`);
      hasher.update(bytes);
      size += bytes.byteLength;
      index++;
    },
    async finish(expected) {
      const hash = bytesToHex(hasher.digest());
      if (expected && hash !== expected) {
        await discard();
        throw new Error("Content does not match its hash.");
      }
      const existed = !!(await dbGet<Blob>("content", hash));
      if (!existed) await dbPut("content", new Blob(await dbGetRange<Blob>("content-parts", prefixRange(key))), hash);
      await discard();
      markPresent(hash);
      return { hash, existed };
    },
    async close(discardPart = false) {
      if (discardPart || !resumeHash) await discard();
    },
  };
}

// Whether an error only means the user cancelled.
export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}
