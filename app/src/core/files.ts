// The file open in the full-window viewer, if any.
import { createSignal } from "solid-js";
import type { FileContext } from "../plugins/types";
import { contentBlob, contentRef, deleteContent, expectDelivery, markFinished, refHash, uploadToNode } from "./content";
import { minStripeBytes } from "../p2p/pieces";
import { workspaceApi } from "./workspaces";
import { isAbort, storeFile, type StoreOptions } from "./stream";
import { startUpload } from "./uploads";

const [openedFile, setOpenedFile] = createSignal<FileContext | null>(null);
export { openedFile };

export function openFile(file: FileContext): void {
  setOpenedFile(file);
}

export function closeFile(): void {
  setOpenedFile(null);
}

// A file whose content is at a URL or in the content store; read() loads it once, again after a failure.
export function fileFromUrl(name: string, mimeType: string, size: number, url: string): FileContext {
  let content: Promise<Blob> | undefined;
  return {
    name,
    mimeType,
    size,
    read: () => (content ??= contentBlob(url, mimeType).catch((e) => {
      content = undefined;
      throw e;
    })),
  };
}

export interface Upload {
  file: File;
  url: string;
  thumb: string | null;
  width: number | null;
  height: number | null;
  // The store already had this content, so discarding the upload leaves it.
  existed: boolean;
  // A big file's piece list (mwc: ref), made while it was copied in (core/stream.ts).
  pieces?: string;
}

const thumbSize = 240;

// Puts the file's content into this device's content store; the workspace only gets its reference and, for
// images, the size and a small preview that shows while other members don't have the content. The file is
// copied in chunks, so its size doesn't matter; aborting `signal` stops it and deletes what was copied.
export async function prepareUpload(file: File, options: StoreOptions = {}): Promise<Upload> {
  const { hash, existed, pieces } = await storeFile(file, { pieceListFrom: minStripeBytes(), ...options });
  // A node pulls new content from here once its item is posted: counted until one has all of it, so quitting asks first
  // (p2p/deliveries.ts; content no item points at, such as an upload cancelled before its post, doesn't count). Content
  // this device had before (the same bytes again) may never have reached a node (its upload was cancelled), so it is
  // sent on too, and the nodes are asked about it at once: one that has it says so.
  if (options.workspaceId) {
    const send = existed ? uploadToNode : expectDelivery;
    send(options.workspaceId, contentRef(hash), file.size);
  }
  return { file, url: contentRef(hash), existed, ...(pieces ? { pieces: contentRef(pieces) } : {}), ...(await imageInfo(file)) };
}

// Size and a small preview of an image; nulls for other files.
export async function imageInfo(blob: Blob): Promise<{ thumb: string | null; width: number | null; height: number | null }> {
  const info = { thumb: null as string | null, width: null as number | null, height: null as number | null };
  if (!blob.type.startsWith("image/")) return info;
  try {
    const image = await decodeImage(blob);
    info.width = image.width;
    info.height = image.height;
    const scale = Math.min(1, thumbSize / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext("2d")!.drawImage(image.source, 0, 0, canvas.width, canvas.height);
    image.close();
    const webp = canvas.toDataURL("image/webp", 0.7);
    info.thumb = webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/jpeg", 0.75);
  } catch {
    // Not an image the browser can decode (HEIC, SVGs with outside references); no preview then.
  }
  return info;
}

// createImageBitmap can't decode SVG in Chromium; an <img> can.
async function decodeImage(blob: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (blob.type !== "image/svg+xml") {
    const bitmap = await createImageBitmap(blob);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  return { source: img, width: img.naturalWidth || 300, height: img.naturalHeight || 150, close: () => URL.revokeObjectURL(url) };
}

// Deletes a prepared upload's content again, unless the store had it before.
export async function discardUpload(upload: Upload): Promise<void> {
  const hash = refHash(upload.url);
  if (hash && !upload.existed) await deleteContent(hash);
  const list = upload.pieces ? refHash(upload.pieces) : null;
  if (list && !upload.existed) await deleteContent(list);
}

// Names a big file's piece list in its workspace, so nodes check each piece they take in (p2p/pieces.ts). Without it
// they keep the file all the same, checking only the whole file, so a failure is only logged.
async function recordPieceList(workspaceId: string, url: string, pieces: string): Promise<void> {
  try {
    await workspaceApi(workspaceId).plugin("nodes").call("add-pieces", { content: url, manifest: pieces });
  } catch (e) {
    console.warn("Piece list not recorded:", e);
  }
}

// Copies the file in, shown with its progress and a cancel button in `place` (core/uploads.ts), then hands it to
// `post`. Resolves with null when the user cancelled before it was posted; what was copied is deleted then.
// Places start with the workspace id ("<server>:<channel>..."), so the content lands in that workspace's store.
export async function uploadAndPost<T>(place: string, file: File, post: (upload: Upload) => Promise<T>): Promise<T | null> {
  const running = startUpload(place, file);
  try {
    const upload = await prepareUpload(file, { signal: running.signal, onProgress: running.setProgress, workspaceId: place.split(":")[0] });
    if (running.signal.aborted) {
      await discardUpload(upload);
      return null;
    }
    const posted = await post(upload);
    const hash = refHash(upload.url);
    if (hash) markFinished(hash, "uploaded");
    if (upload.pieces) void recordPieceList(place.split(":")[0], upload.url, upload.pieces);
    return posted;
  } catch (e) {
    if (isAbort(e)) return null;
    throw e;
  } finally {
    running.finish();
  }
}
