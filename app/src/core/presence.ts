// Short-lived state members share about a channel they have open (virtual cursors, selections, "editing"
// markers). Never stored: a workspace that can reach other members (serverless workspaces) registers a
// PresenceLink, and entries vanish when a member stops sending or disconnects.
import { createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
export type PresenceState = string | number | boolean | null | PresenceState[] | { [key: string]: PresenceState };
export type SharedPresenceStatus = "online" | "away" | "dnd";

export interface PresenceLink {
  set(channelId: number, state: PresenceState | null): void;
  setStatus?(status: SharedPresenceStatus | null): void;
  // A bot this device hosts is in a channel (a cursor, "typing"); null when it leaves.
  setAs?(botUserId: number, channelId: number, state: PresenceState | null): void;
  // Sent at once to every member viewing the channel (or only to `to`), never repeated or stored.
  send(channelId: number, message: PresenceState, to?: number): void;
  // This member's media for the members viewing a channel (one at a time; null stops it).
  shareStream?(channelId: number, stream: MediaStream | null): void;
}

export interface PeerPresence {
  userId: number;
  state: PresenceState;
}

const links = new Map<string, PresenceLink>();
const [others, setOthers] = createStore<Record<string, Record<number, PeerPresence[]>>>({});
const [statuses, setStatuses] = createStore<Record<string, Record<number, SharedPresenceStatus>>>({});
const [versions, setVersions] = createStore<Record<string, Record<number, string>>>({});

export function registerPresenceLink(workspaceId: string, link: PresenceLink): () => void {
  links.set(workspaceId, link);
  return () => {
    if (links.get(workspaceId) === link) links.delete(workspaceId);
    setOthers(workspaceId, undefined!);
    setStatuses(workspaceId, undefined!);
    setVersions(workspaceId, undefined!);
  };
}

export function setMyPresenceStatus(status: SharedPresenceStatus | null): void {
  for (const link of links.values()) link.setStatus?.(status);
}

export function setPeerStatuses(workspaceId: string, byUser: Record<number, SharedPresenceStatus>): void {
  setStatuses(workspaceId, reconcile(byUser));
}

export function peerStatusOf(workspaceId: string, userId: number): SharedPresenceStatus | null {
  return statuses[workspaceId]?.[userId] ?? null;
}

export function setPeerVersions(workspaceId: string, byUser: Record<number, string>): void {
  setVersions(workspaceId, reconcile(byUser));
}

// The app version of a visible member; a member on several devices has them joined ("1.0.0, 1.1.0").
export function peerVersionOf(workspaceId: string, userId: number): string | null {
  return versions[workspaceId]?.[userId] ?? null;
}

export function peerVersions(workspaceId: string): Record<number, string> {
  return versions[workspaceId] ?? {};
}

export function setPresence(workspaceId: string, channelId: number, state: PresenceState | null): void {
  links.get(workspaceId)?.set(channelId, state);
}

export function setBotPresence(workspaceId: string, botUserId: number, channelId: number, state: PresenceState | null): void {
  links.get(workspaceId)?.setAs?.(botUserId, channelId, state);
}

type EventHandler = (userId: number, message: PresenceState) => void;
const handlers = new Map<string, Set<EventHandler>>();

// Short messages between the members who have a channel open (a click in a shared browser), in order per member.
export function sendChannelEvent(workspaceId: string, channelId: number, message: PresenceState, to?: number): void {
  links.get(workspaceId)?.send(channelId, message, to);
}

export function onChannelEvent(workspaceId: string, channelId: number, handler: EventHandler): () => void {
  const key = `${workspaceId}:${channelId}`;
  let set = handlers.get(key);
  if (!set) handlers.set(key, (set = new Set()));
  set.add(handler);
  return () => {
    set.delete(handler);
    if (!set.size) handlers.delete(key);
  };
}

export function receiveChannelEvent(workspaceId: string, channelId: number, userId: number, message: PresenceState): void {
  handlers.get(`${workspaceId}:${channelId}`)?.forEach((handler) => handler(userId, message));
}

// Media members share with a channel's viewers (a shared browser's video), kept out of stores: MediaStreams must
// not be proxied.
type ChannelStream = { workspaceId: string; channelId: number; userId: number; stream: MediaStream };
const [channelStreamList, setChannelStreamList] = createSignal<ChannelStream[]>([]);

export function shareChannelStream(workspaceId: string, channelId: number, stream: MediaStream | null): void {
  links.get(workspaceId)?.shareStream?.(channelId, stream);
}

export function receiveChannelStream(workspaceId: string, channelId: number, userId: number, stream: MediaStream | null): void {
  setChannelStreamList((list) => [
    ...list.filter((s) => !(s.workspaceId === workspaceId && s.userId === userId)),
    ...(stream ? [{ workspaceId, channelId, userId, stream }] : []),
  ]);
}

export function channelStreams(workspaceId: string, channelId: number): { userId: number; stream: MediaStream }[] {
  return channelStreamList().filter((s) => s.workspaceId === workspaceId && s.channelId === channelId);
}

export function presenceOf(workspaceId: string, channelId: number): PeerPresence[] {
  return others[workspaceId]?.[channelId] ?? [];
}

export function setPeerPresence(workspaceId: string, byChannel: Record<number, PeerPresence[]>): void {
  setOthers(workspaceId, reconcile(byChannel, { key: "userId" }));
}

// A pointer in a view's own coordinates (board or page units, whatever the view maps to its screen).
export interface CursorPoint {
  x: number;
  y: number;
  // The view's own reference for the point (the element under it on a shared page), when x and y alone can differ
  // between members' layouts. Views that don't set it never see it.
  anchor?: { id: number; fx: number; fy: number };
}

const anchorOf = (value: unknown): CursorPoint["anchor"] => {
  const a = value as Record<string, unknown> | null;
  return a && typeof a === "object" && typeof a.id === "number" && Number.isFinite(a.fx) && Number.isFinite(a.fy)
    ? { id: a.id, fx: a.fx as number, fy: a.fy as number } : undefined;
};
const copyCursor = (at: CursorPoint): CursorPoint => {
  const anchor = anchorOf(at.anchor);
  return anchor ? { x: at.x, y: at.y, anchor } : { x: at.x, y: at.y };
};

// What a channel view shares: its own state plus the pointer under the reserved `cursor` key, sent as one entry.
// Anything that can join a channel (members, later bots) moves its cursor by sending `cursor: { x, y }`.
export interface ChannelPresence {
  set(state: { [key: string]: PresenceState } | null): void;
  others(): PeerPresence[];
  moveCursor(at: CursorPoint | null): void;
  cursorOf(userId: number): CursorPoint | null;
  cursorUsers(): number[];
}

const shared = new Map<string, { state: { [key: string]: PresenceState } | null; cursor: CursorPoint | null }>();

function cursorIn(state: PresenceState): CursorPoint | null {
  const cursor = state && typeof state === "object" && !Array.isArray(state) ? state.cursor : null;
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return null;
  return typeof cursor.x === "number" && typeof cursor.y === "number" ? copyCursor(cursor as unknown as CursorPoint) : null;
}

export function channelPresence(workspaceId: string, channelId: number): ChannelPresence {
  const key = `${workspaceId}:${channelId}`;
  const mine = () => {
    let entry = shared.get(key);
    if (!entry) shared.set(key, (entry = { state: null, cursor: null }));
    return entry;
  };
  const send = () => {
    const { state, cursor } = mine();
    if (!state && !cursor) {
      shared.delete(key);
      setPresence(workspaceId, channelId, null);
    } else {
      setPresence(workspaceId, channelId, cursor ? { ...state, cursor: { ...copyCursor(cursor) } } : state);
    }
  };
  const others = () => presenceOf(workspaceId, channelId);
  return {
    set: (state) => {
      mine().state = state;
      send();
    },
    others,
    moveCursor: (at) => {
      mine().cursor = at && copyCursor(at);
      send();
    },
    cursorOf: (userId) => {
      const peer = others().find((o) => o.userId === userId);
      return peer ? cursorIn(peer.state) : null;
    },
    cursorUsers: () => others().filter((o) => cursorIn(o.state)).map((o) => o.userId),
  };
}
