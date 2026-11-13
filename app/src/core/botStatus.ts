// How each bot looks right now, by bot user id (unique across workspaces):
//   off      switched off in the Bots tab: closed grey eyes
//   waiting  enabled, but its host isn't online or no device runs it: blinking eyes
//   on       otherwise
import { createStore } from "solid-js/store";
import type { Row } from "../p2p/permissions";
import { botAssignable } from "./botConfig";
import { peerStatusOf } from "./presence";

type Entry = { workspaceId: string; host: number; off: boolean; me: number | null; assignable: boolean };
const [bots, setBots] = createStore<Record<number, Entry>>({});
// Bot rows (ids) a device of this account runs, by workspace.
const [running, setRunning] = createStore<Record<string, Record<number, true>>>({});

export type BotState = "on" | "off" | "waiting";

export function botState(userId: number | undefined): BotState {
  const entry = userId === undefined ? undefined : bots[userId];
  if (!entry) return "on";
  if (entry.off) return "off";
  const mine = entry.me !== null && entry.host === entry.me;
  const active = mine ? running[entry.workspaceId]?.[userId!] === true : peerStatusOf(entry.workspaceId, entry.host) !== null;
  return active ? "on" : "waiting";
}

export function setBotRows(workspaceId: string, rows: Row[], me: number | null): void {
  const seen = new Set<number>();
  for (const row of rows) {
    const id = Number(row.user_id);
    seen.add(id);
    setBots(id, { workspaceId, host: Number(row.host), off: row.enabled !== true || row.status !== "enabled", me, assignable: botAssignable(row) });
  }
  for (const key of Object.keys(bots).map(Number))
    if (bots[key].workspaceId === workspaceId && !seen.has(key)) setBots(key, undefined as never);
}

// Whether this bot user can be given tasks and issues.
export const isAssignableBot = (userId: number): boolean => bots[userId]?.assignable === true;

// Bot user ids (not row ids) some device of this account runs.
export function setBotsRunning(workspaceId: string, userIds: number[]): void {
  setRunning(workspaceId, Object.fromEntries(userIds.map((id) => [id, true as const])));
}
