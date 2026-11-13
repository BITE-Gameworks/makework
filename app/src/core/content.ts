// File content kept on this device, by SHA-256. Server data only refers to it ("mwc:<hash>" in a url column),
// so a workspace's data stays small and every member decides what content they keep. Desktop keeps it in the
// app's data folder (electron/main.js), the browser in IndexedDB. Content is written and read in chunks
// (core/stream.ts), never as one whole file.
//
// What gets fetched from other members is decided per workspace by a ContentSync (p2p/content.ts): everything
// the user syncs (channel, folder, file, attachment), opened ghosts, and anything up to the auto-download size
// in synced channels and folders.
import { createStore } from "solid-js/store";
import { dbDelete, dbDeleteRange, dbGet, dbHas, prefixRange } from "./db";
import { desktop } from "./desktop";

const prefix = "mwc:";

export function contentRef(hash: string): string {
  return prefix + hash;
}

export function refHash(url: string | null | undefined): string | null {
  return url?.startsWith(prefix) ? url.slice(prefix.length) : null;
}

type Entry = { present: boolean; url?: string };
const [state, setState] = createStore<Record<string, Entry>>({});
const checking = new Set<string>();

export async function hasContent(hash: string): Promise<boolean> {
  if (state[hash]) return state[hash].present;
  const present = desktop?.content ? await desktop.content.has(hash) : await dbHas("content", hash);
  setState(hash, (e) => ({ ...e, present }));
  return present;
}

// Content that may have gone (its file was changed or deleted on disk): looked up again when next needed.
export function forgetPresent(hash: string): void {
  setState(hash, (e) => ({ ...e, present: undefined as unknown as boolean, url: undefined }));
}

// Called by core/stream.ts once content is complete in the store.
export function markPresent(hash: string): void {
  setState(hash, (e) => ({ ...e, present: true }));
}

export async function deleteContent(hash: string): Promise<void> {
  if (desktop?.content) await desktop.content.remove(hash);
  else {
    await dbDelete("content", hash);
    await dbDeleteRange("content-parts", prefixRange(hash));
  }
  const url = state[hash]?.url;
  if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
  setState(hash, { present: false, url: undefined });
}

// Whether the content behind a url is here. Plain URLs (data:, https:) always count as here.
export function isLocal(url: string | null | undefined): boolean {
  const hash = refHash(url);
  if (!hash) return !!url;
  check(hash);
  return state[hash]?.present === true;
}

// A URL the page can show for the content, or null while it isn't on this device.
export function contentUrl(url: string | null | undefined): string | null {
  const hash = refHash(url);
  if (!hash) return url ?? null;
  check(hash);
  const entry = state[hash];
  if (!entry?.present) return null;
  if (!entry.url) void load(hash);
  return entry.url ?? null;
}

export async function contentBlob(url: string, mime: string): Promise<Blob> {
  const hash = refHash(url);
  if (!hash) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed (${response.status}).`);
    return response.blob();
  }
  const blob = await storedBlob(hash);
  if (!blob) throw new Error("This file isn't on this device yet.");
  return blob.slice(0, blob.size, mime);
}

// The stored content as a Blob, without reading it into memory first: desktop streams it from mwc://, the
// browser's IndexedDB Blob stays on disk until read.
export async function storedBlob(hash: string): Promise<Blob | null> {
  if (desktop?.content) {
    const response = await fetch(desktopUrl(hash));
    return response.ok ? response.blob() : null;
  }
  return (await dbGet<Blob>("content", hash)) ?? null;
}

const desktopUrl = (hash: string) => `mwc://content/${hash}`;

function check(hash: string) {
  if (state[hash] || checking.has(hash)) return;
  checking.add(hash);
  void hasContent(hash).finally(() => checking.delete(hash));
}

const loading = new Set<string>();
// Browsers sniff every image type but SVG, which only shows with its type; content from other members has none.
const svgStart = /^\uFEFF?\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i;
async function withSvgType(blob: Blob): Promise<Blob> {
  if (blob.type) return blob;
  return svgStart.test(await blob.slice(0, 1024).text()) ? blob.slice(0, blob.size, "image/svg+xml") : blob;
}

async function load(hash: string) {
  if (desktop?.content) {
    setState(hash, "url", desktopUrl(hash));
    return;
  }
  if (loading.has(hash)) return;
  loading.add(hash);
  try {
    const blob = await dbGet<Blob>("content", hash);
    if (blob) setState(hash, "url", URL.createObjectURL(await withSvgType(blob)));
  } finally {
    loading.delete(hash);
  }
}

// Sync choices and transfers of one workspace, registered by servers that can fetch content from members.
export type SyncMark = { kind: "channel" | "folder" | "file" | "attachment" | "forgotten" | "archive"; id: number };

export interface ContentSync {
  isMarked(mark: SyncMark): boolean;
  setMark(mark: SyncMark, on: boolean): void;
  // Forgets a channel on this device: stops fetching its content and frees what only it kept. The signed rows
  // stay; only this device's copy is gone. restoreChannel brings the channel back (and syncs it again).
  forgetChannel(channelId: number): void;
  restoreChannel(channelId: number): void;
  // "fetching" while it is being downloaded, "unavailable" when no member online has it.
  status(hash: string): "fetching" | "unavailable" | undefined;
  ensureContent?(hash: string): Promise<boolean>;
  retain?(hashes: Iterable<string>): () => void;
  // How much of a download has arrived, 0 to 1, while it is running.
  progress(hash: string): number | undefined;
  // How much of this device's content another member has received, 0 to 1, while it is being sent.
  sending(hash: string): number | undefined;
  // Stops downloading it and deletes what arrived; it stays a pointer until opened or synced again.
  cancelDownload(hash: string, mark: SyncMark): Promise<void>;
  // The user cancelled content going out from here; its item and this device's copy stay. A send to a member ends. An
  // upload to a node (running, or waiting for one) is held back: no node gets it from here until `uploadToNode`.
  cancelSend?(hash: string): void;
  // Sends one of this device's files on to the nodes (a held back upload, or any own file); asks them about it at once.
  uploadToNode?(hash: string, size: number): void;
  // Whether that makes sense: nodes keep it whole, it isn't on its way or held back, and none is known to have it.
  canUploadToNode?(hash: string, size: number): boolean;
  // The readable folder, or a channel's folder in it (desktop).
  openFolder?(channelId?: number): void;
  // A new upload from this device, counted until a node received all of it (p2p/deliveries.ts).
  expectDelivery?(hash: string, size: number): void;
  // New uploads from this device that no node reached now has all of yet.
  undelivered?(): number;
  // Where a new upload from here stands while no node has all of it (reactive): "uploading" while a node is reached,
  // "waiting" while none is; undefined for anything else. "held": the user cancelled it on its way (`cancelSend`).
  delivery?(hash: string): "uploading" | "waiting" | "held" | undefined;
  // How much of such an upload a node took in so far, 0 to 1 (reactive): kept while the pull pauses, undefined before a
  // node started.
  deliveryProgress?(hash: string): number | undefined;
  // Whether the content being sent goes to a node, not to a member. Read after `sending`.
  sendingToNode?(hash: string): boolean;
}

const syncs = new Map<string, ContentSync>();
const [syncVersion, setSyncVersion] = createStore({ n: 0 });

export function registerContentSync(workspaceId: string, sync: ContentSync): () => void {
  syncs.set(workspaceId, sync);
  setSyncVersion("n", (n) => n + 1);
  return () => {
    if (syncs.get(workspaceId) === sync) syncs.delete(workspaceId);
    setSyncVersion("n", (n) => n + 1);
  };
}

export function contentSync(workspaceId: string): ContentSync | undefined {
  void syncVersion.n;
  return syncs.get(workspaceId);
}

// A new upload from this device: a node pulls it from here after the post, so until one has all of it, quitting asks
// first (core/farewell.ts, electron/background.js).
export function expectDelivery(workspaceId: string, url: string, size: number): void {
  const hash = refHash(url);
  if (hash) syncs.get(workspaceId)?.expectDelivery?.(hash, size);
}

// New uploads from this device, in every workspace, that no node reached now has all of yet.
export function undeliveredUploads(): number {
  let count = 0;
  for (const sync of syncs.values()) count += sync.undelivered?.() ?? 0;
  return count;
}

export function isSynced(workspaceId: string, mark: SyncMark): boolean {
  return contentSync(workspaceId)?.isMarked(mark) ?? false;
}

export function setSynced(workspaceId: string, mark: SyncMark, on: boolean): void {
  contentSync(workspaceId)?.setMark(mark, on);
}

export function isForgotten(workspaceId: string, channelId: number): boolean {
  return contentSync(workspaceId)?.isMarked({ kind: "forgotten", id: channelId }) ?? false;
}

export function forgetChannel(workspaceId: string, channelId: number): void {
  contentSync(workspaceId)?.forgetChannel(channelId);
}

// Brings a forgotten channel back and syncs it: a channel that was forgotten stayed a ghost for everything
// (a default join would fetch almost nothing on a files channel), so it is marked synced again here.
export function restoreChannel(workspaceId: string, channelId: number): void {
  contentSync(workspaceId)?.restoreChannel(channelId);
  setSynced(workspaceId, { kind: "channel", id: channelId }, true);
}

// "fetching" while its download runs, "unavailable" when no member online has it.
export function transferStatus(workspaceId: string, url: string | null | undefined): "fetching" | "unavailable" | undefined {
  const hash = refHash(url);
  return hash ? contentSync(workspaceId)?.status(hash) : undefined;
}

function transferProgress(workspaceId: string, url: string | null | undefined): number | undefined {
  const hash = refHash(url);
  return hash ? contentSync(workspaceId)?.progress(hash) : undefined;
}

function transferSending(workspaceId: string, url: string | null | undefined): number | undefined {
  const hash = refHash(url);
  return hash ? contentSync(workspaceId)?.sending(hash) : undefined;
}

// How much of a running download here has arrived, 0 to 1 (undefined while none runs or before its size is known).
export function downloadProgress(workspaceId: string, url: string | null | undefined): number | undefined {
  return transferStatus(workspaceId, url) === "fetching" ? transferProgress(workspaceId, url) : undefined;
}

// Which way content is moving right now, if at all; both can be cancelled.
export function transferKind(workspaceId: string, url: string | null | undefined): "downloading" | "sending" | undefined {
  if (transferStatus(workspaceId, url) === "fetching") return "downloading";
  return transferSending(workspaceId, url) === undefined ? undefined : "sending";
}

// Transfers that just finished, by hash, shown as done for a few seconds so even fast ones are noticed.
// "delivered": a new upload a node now has all of (p2p/deliveries.ts).
export type Finished = "uploaded" | "sent" | "downloaded" | "delivered";
const finishedText: Record<Finished, string> = { uploaded: "Uploaded", sent: "Sent", downloaded: "Downloaded", delivered: "On the node" };
const [finished, setFinished] = createStore<Record<string, Finished | undefined>>({});
const finishedTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function markFinished(hash: string, kind: Finished): void {
  clearTimeout(finishedTimers.get(hash));
  setFinished(hash, kind);
  finishedTimers.set(hash, setTimeout(() => {
    finishedTimers.delete(hash);
    setFinished(hash, undefined);
  }, 4000));
}

export interface TransferBar {
  value: number;
  label: string;
  done: boolean;
}

const uploadingToNode = "Uploading to the node";

// The bar under a file while its content moves: downloading here, going to a node or a member, or just finished.
// A new upload from here has its bar from the post on while a node is reached (quitting would cut it off): empty until
// the node starts on it (nodes take one file at a time from a member), then as far as a node got, also while the pull
// pauses. "Uploaded" only says this device's copy is stored, so it doesn't show meanwhile.
export function transferBar(workspaceId: string, url: string | null | undefined): TransferBar | undefined {
  const hash = refHash(url);
  if (!hash) return undefined;
  if (transferStatus(workspaceId, url) === "fetching") {
    const progress = transferProgress(workspaceId, url);
    return { value: progress ?? 0, label: progress === undefined ? "Downloading..." : `Downloading ${percent(progress)}`, done: false };
  }
  const sync = contentSync(workspaceId);
  const sending = transferSending(workspaceId, url);
  const toNode = sending !== undefined && !!sync?.sendingToNode?.(hash);
  if (sending !== undefined && !toNode) return { value: sending, label: `Sending ${percent(sending)}`, done: false };
  const uploading = sync?.delivery?.(hash) === "uploading";
  if (toNode || uploading) {
    const reached = uploading ? sync?.deliveryProgress?.(hash) : undefined;
    const value = sending === undefined ? reached : Math.max(sending, reached ?? 0);
    return { value: value ?? 0, label: value === undefined ? uploadingToNode : `${uploadingToNode} ${percent(value)}`, done: false };
  }
  const kind = finished[hash];
  return kind && { value: 1, label: finishedText[kind], done: true };
}

const percent = (value: number) => `${Math.floor(value * 100)}%`;

// The transfer's text ("Downloading 42%", "Sending 42%", "Uploading to the node 42%", "Uploaded", ...) and "Nobody
// online has it" when no member has it. A new upload from here no node has all of yet says "Waiting for the node"
// while none is reached, and "Not on the node" while the user holds it back (no bar: nothing moves). Else undefined.
export function transferLabel(workspaceId: string, url: string | null | undefined): string | undefined {
  if (transferStatus(workspaceId, url) === "unavailable") return "Nobody online has it";
  const label = transferBar(workspaceId, url)?.label;
  if (label) return label;
  const hash = refHash(url);
  const delivery = hash ? contentSync(workspaceId)?.delivery?.(hash) : undefined;
  if (delivery === "held") return "Not on the node";
  return delivery === "waiting" ? "Waiting for the node" : undefined;
}

// What the user can do about content going out from here: "cancel" while it is sent (to a node or a member) or waits
// for a node, "resume" while its upload to the nodes is held back. Views offer it on the user's own items.
export function uploadAction(workspaceId: string, url: string | null | undefined): "cancel" | "resume" | undefined {
  const hash = refHash(url);
  if (!hash) return undefined;
  if (transferSending(workspaceId, url) !== undefined) return "cancel";
  const delivery = contentSync(workspaceId)?.delivery?.(hash);
  if (delivery === "held") return "resume";
  return delivery ? "cancel" : undefined;
}

// Cancels content going out from here. Nothing is removed: the item and this device's copy stay, and an upload to a
// node is held back until `uploadToNode` (deleting is the user's own act).
export function cancelSend(workspaceId: string, url: string | null | undefined): void {
  const hash = refHash(url);
  if (hash) contentSync(workspaceId)?.cancelSend?.(hash);
}

// Sends this device's file on to the nodes: a held back upload, the same bytes uploaded again, or any own file the user
// picks it on. A node that has it already says so ("On the node").
export function uploadToNode(workspaceId: string, url: string | null | undefined, size: number): void {
  const hash = refHash(url);
  if (hash) contentSync(workspaceId)?.uploadToNode?.(hash, size);
}

// Whether to offer "Upload to the node" on an own file that isn't on its way or held back: its content is on this
// device and no node is known to have it.
export function canUploadToNode(workspaceId: string, url: string | null | undefined, size: number): boolean {
  const hash = refHash(url);
  return !!hash && isLocal(url) && !!contentSync(workspaceId)?.canUploadToNode?.(hash, size);
}

export async function ensureContent(workspaceId: string, hash: string): Promise<boolean> {
  if (await hasContent(hash)) return true;
  return contentSync(workspaceId)?.ensureContent?.(hash) ?? false;
}

export function retainContent(workspaceId: string, hashes: Iterable<string>): () => void {
  return contentSync(workspaceId)?.retain?.(hashes) ?? (() => {});
}

export async function cancelDownload(workspaceId: string, mark: SyncMark, url: string | null | undefined): Promise<void> {
  const hash = refHash(url);
  if (hash) await contentSync(workspaceId)?.cancelDownload(hash, mark);
}

// Resolves once the content is on this device (true), or false when nothing arrived for `idleMs` or `signal` was
// aborted (at once, not at the next look). Large files take as long as they take while they keep coming.
async function whenLocal(workspaceId: string, url: string, idleMs = 120_000, signal?: AbortSignal): Promise<boolean> {
  const hash = refHash(url);
  if (!hash) return true;
  let last = transferProgress(workspaceId, url);
  let since = Date.now();
  while (Date.now() - since < idleMs && !signal?.aborted) {
    if (state[hash]?.present ?? (await hasContent(hash))) return true;
    await pause(400, signal);
    const progress = transferProgress(workspaceId, url);
    if (progress !== last) {
      last = progress;
      since = Date.now();
    }
  }
  return false;
}

// Waits `ms`, or less when `signal` is aborted meanwhile.
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

// Syncs a ghost and resolves once it has arrived (true), or false when it stopped arriving or `signal` was aborted.
export async function ensureLocal(workspaceId: string, mark: SyncMark, url: string, signal?: AbortSignal): Promise<boolean> {
  const hash = refHash(url);
  if (hash && !(await hasContent(hash))) setSynced(workspaceId, mark, true);
  return whenLocal(workspaceId, url, undefined, signal);
}

// Syncs a ghost and opens it once it has arrived.
export async function getAndOpen(workspaceId: string, mark: SyncMark, url: string, open: () => void): Promise<void> {
  if (await ensureLocal(workspaceId, mark, url)) open();
}
