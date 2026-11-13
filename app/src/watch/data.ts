// Watch parties on the client: the rows of system/watch.ts, and getting their videos onto this device.
import type { Accessor } from "solid-js";
import type { ApiValue } from "../api/types";
import { ensureLocal, isLocal } from "../core/content";
import { workspaceApi } from "../core/workspaces";
import { createLive } from "../plugins/live";

export interface PartyItem {
  id: number;
  fileId: number;
  name: string;
  url: string;
  mime: string;
  size: number;
}

export interface Party {
  id: number;
  channelId: number;
  chatChannelId: number;
  messageId: number | null;
  hostId: number;
  title: string;
  startsAt: string;
  ended: boolean;
  item: number;
  playing: boolean;
  position: number;
  changedAt: string;
  changedBy: number;
  items: PartyItem[];
  guests: number[];
}

export interface NewPartyItem {
  fileId: number;
  name: string;
  url: string;
  mime: string;
  size: number;
}

type Raw = Record<string, ApiValue> & { items: Record<string, ApiValue>[]; guests: number[] };

const toParty = (row: Raw): Party => ({
  id: Number(row.id),
  channelId: Number(row.channel_id),
  chatChannelId: Number(row.chat_channel_id),
  messageId: row.message_id == null ? null : Number(row.message_id),
  hostId: Number(row.host_id),
  title: String(row.title ?? ""),
  startsAt: String(row.starts_at),
  ended: row.ended === true,
  item: Number(row.item ?? 0),
  playing: row.playing === true,
  position: Number(row.position ?? 0),
  changedAt: String(row.changed_at),
  changedBy: Number(row.changed_by),
  items: (row.items ?? []).map((i) => ({
    id: Number(i.id), fileId: Number(i.file_id), name: String(i.name ?? ""), url: String(i.url ?? ""), mime: String(i.mime ?? ""), size: Number(i.size ?? 0),
  })),
  guests: (row.guests ?? []).map(Number),
});

export const watchApi = (workspaceId: string) => workspaceApi(workspaceId).plugin("watch");

export async function createParty(workspaceId: string, party: { channelId: number; chatChannelId: number; title: string; startsAt: string; items: NewPartyItem[] }) {
  const { id } = await watchApi(workspaceId).call<{ id: number }>("create-party", {
    channel_id: party.channelId, chat_channel_id: party.chatChannelId, title: party.title, starts_at: party.startsAt,
    items: JSON.stringify(party.items.map((i) => ({ file_id: i.fileId, name: i.name, url: i.url, mime: i.mime, size: i.size }))),
  });
  return id;
}

export const setPartyMessage = (workspaceId: string, partyId: number, messageId: number) =>
  watchApi(workspaceId).call("set-message", { party_id: partyId, message_id: messageId });
export const joinParty = (workspaceId: string, partyId: number, joined: boolean) =>
  watchApi(workspaceId).call("join-party", { party_id: partyId, joined });
export const startPartyNow = (workspaceId: string, partyId: number) => watchApi(workspaceId).call("start-now", { party_id: partyId });
export const endParty = (workspaceId: string, partyId: number) => watchApi(workspaceId).call("end-party", { party_id: partyId });

export interface Playback {
  item: number;
  playing: boolean;
  position: number;
}

export const savePlayback = (workspaceId: string, partyId: number, p: Playback) =>
  watchApi(workspaceId).call("set-playback", { party_id: partyId, item: p.item, playing: p.playing, position: p.position });

export function createPartyById(workspaceId: string, id: Accessor<number>) {
  return createLive<Party | null>(watchApi(workspaceId), null, id, async () => {
    const { party } = await watchApi(workspaceId).call<{ party: Raw }>("get-party", { party_id: id() });
    return toParty(party);
  });
}

// A voice channel's parties that haven't ended.
export function createParties(workspaceId: string, channelId: Accessor<number>) {
  return createLive<Party[]>(watchApi(workspaceId), [], channelId, async () => {
    const { rows } = await watchApi(workspaceId).call<{ rows: Raw[] }>("list-parties", { channel_id: channelId() });
    return rows.map(toParty);
  });
}

export const hasStarted = (party: Party, now = Date.now()) => Date.parse(party.startsAt) <= now;

// Where the last saved play, pause or seek puts the video now (by this device's clock, so only a first guess:
// the members playing it answer with where they are, watch/sync.ts).
export const estimatedPosition = (party: Party) =>
  party.position + (party.playing ? Math.max(0, (Date.now() - Date.parse(party.changedAt)) / 1000) : 0);

const fetching = new Map<string, Promise<void>>();

// Gets a party's videos onto this device one at a time, the one at `first` first; each stays synced like a file
// kept on this device. Resolves once all are here or one stopped arriving; never rejects (callers start it and go on).
export function fetchVideos(workspaceId: string, party: Party, first = party.item): Promise<void> {
  const key = `${workspaceId}:${party.id}:${first}`;
  const running = fetching.get(key);
  if (running) return running;
  const order = [...party.items.slice(first), ...party.items.slice(0, first)];
  const run = (async () => {
    for (const item of order) {
      if (isLocal(item.url)) continue;
      if (!(await ensureLocal(workspaceId, { kind: "file", id: item.fileId }, item.url))) break;
    }
  })().catch((e) => console.warn("Watch party videos not fetched:", e)).finally(() => fetching.delete(key));
  fetching.set(key, run);
  return run;
}

// The id in a link to a watch party (makework://<workspace>/<voice channel>/party/<id>).
export const partyLinkKind = "party";
