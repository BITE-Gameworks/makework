// Call media between members. A workspace that can carry media (serverless workspaces, over their peer connections)
// registers a MediaLink; the call hands it the local streams and it fills in the remote ones here.
import { createStore, reconcile } from "solid-js/store";
import type { ShareQuality, ShareStats } from "./shareQuality";

export type MediaKind = "mic" | "camera" | "screen";
export type LocalStreams = Record<MediaKind, MediaStream | null>;

export interface MediaLink {
  // The channel this client is in a call in (null when not), and what it sends there.
  setLocal(channelId: number | null, streams: LocalStreams): void;
  // A bot hosted on this device joins a call (null leaves it): its row, and the streams it sends there.
  setGuest?(userId: number, call: { channelId: number; streams: LocalStreams; row: Record<string, string | number | boolean | null> } | null): void;
  // This device's screen-share quality (voice/shareQuality.ts), for every sender carrying the share.
  setQuality?(quality: ShareQuality): void;
  // Connection details about a member, for call diagnostics.
  diagnose?(userId: number): Promise<Record<string, string | number | boolean>[]>;
  // This device's side of calls (connections), for call diagnostics.
  deviceInfo?(): Record<string, string | number>;
  // What happened to the call's links lately, newest first, for call diagnostics.
  callEvents?(): string[];
  // The share's live numbers for the quality control; null while no picture is shared.
  shareStats?(): Promise<ShareStats | null>;
  // This device views (or stops viewing) a member's shared picture or camera: over the mesh only its viewers get a
  // copy (ADR 0019).
  watch?(userId: number, picture: "screen" | "camera", on: boolean): void;
}

const links = new Map<string, MediaLink>();

export function registerMediaLink(workspaceId: string, link: MediaLink): () => void {
  links.set(workspaceId, link);
  return () => {
    if (links.get(workspaceId) === link) links.delete(workspaceId);
    setRemote(workspaceId, undefined!);
    setReported(workspaceId, undefined!);
  };
}

export function mediaLink(workspaceId: string): MediaLink | undefined {
  return links.get(workspaceId);
}

export function watchPicture(workspaceId: string, userId: number, picture: "screen" | "camera", on: boolean): void {
  links.get(workspaceId)?.watch?.(userId, picture, on);
}

export function canCarryMedia(workspaceId: string): boolean {
  return links.has(workspaceId);
}

type RemoteMedia = Partial<Record<MediaKind, MediaStream>>;
const [remote, setRemote] = createStore<Record<string, Record<number, RemoteMedia>>>({});
// A remote stream's tracks change under the same object (a sender placing it again): readers of the stream
// depend on this count too, so they pick its new tracks up.
const [trackChanges, setTrackChanges] = createStore<Record<string, number>>({});

export function setRemoteStream(workspaceId: string, userId: number, kind: MediaKind, stream: MediaStream | null): void {
  if (!remote[workspaceId]) setRemote(workspaceId, {});
  if (!remote[workspaceId][userId]) setRemote(workspaceId, userId, {});
  setRemote(workspaceId, userId, kind, stream ?? undefined);
}

// How many members the others count in each call (the largest count any of them reported lately, p2p/voice.ts
// `publishSeen`), by channel. More than this device shows means members it doesn't know of yet.
const [reported, setReported] = createStore<Record<string, Record<number, number>>>({});

export function setReportedSizes(workspaceId: string, sizes: Record<number, number>): void {
  setReported(workspaceId, reconcile(sizes));
}

export function reportedCallSize(workspaceId: string, channelId: number): number {
  return reported[workspaceId]?.[channelId] ?? 0;
}

export function remoteTracksChanged(workspaceId: string): void {
  setTrackChanges(workspaceId, (count) => (count ?? 0) + 1);
}

export function clearRemote(workspaceId: string, userId: number): void {
  if (remote[workspaceId]?.[userId]) setRemote(workspaceId, userId, undefined!);
}

export function remoteStream(workspaceId: string, userId: number, kind: MediaKind): MediaStream | undefined {
  void trackChanges[workspaceId];
  return remote[workspaceId]?.[userId]?.[kind];
}

export function remoteMics(workspaceId: string): { userId: number; stream: MediaStream }[] {
  void trackChanges[workspaceId];
  return Object.entries(remote[workspaceId] ?? {}).flatMap(([userId, media]) =>
    media.mic ? [{ userId: Number(userId), stream: media.mic }] : []);
}
