import { createEffect, createRoot, createSignal } from "solid-js";
import { account, setOfflineMode } from "./account";
import { idle } from "./idle";
import { setMyPresenceStatus } from "./presence";
import { readJson, writeJson } from "./storage";

export type StatusPreference = "online" | "dnd" | "hidden";
export type PresenceStatus = StatusPreference | "away" | "offline";
export type SharedPresenceStatus = Exclude<PresenceStatus, "hidden" | "offline">;

const key = "mw.onlineStatus";
const legacyKey = "mw.showOnline";

function initialPreference(): StatusPreference {
  const saved = readJson<unknown>(key, null);
  if (saved === "online" || saved === "dnd" || saved === "hidden") return saved;
  const migrated: StatusPreference = readJson<boolean>(legacyKey, true) ? "online" : "hidden";
  writeJson(key, migrated);
  return migrated;
}

const [preference, setPreference] = createSignal<StatusPreference>(initialPreference());
export const onlineStatusPreference = preference;

export function resolvePresenceStatus(
  chosen: StatusPreference, isIdle: boolean, disconnected: boolean,
): PresenceStatus {
  if (disconnected) return "offline";
  if (chosen === "online" && isIdle) return "away";
  return chosen;
}

export function onlineStatus(): PresenceStatus {
  const me = account();
  return resolvePresenceStatus(preference(), idle(), !me || !!me.offline || !!me.offlineMode);
}

export function sharedPresenceStatus(): SharedPresenceStatus | null {
  const status = onlineStatus();
  return status === "online" || status === "away" || status === "dnd" ? status : null;
}

export async function setOnlineStatus(value: PresenceStatus): Promise<void> {
  if (value === "offline") {
    await setOfflineMode(true);
    return;
  }
  if (value === "away") throw new Error("Away is set automatically after 15 minutes without input.");
  setOnlineStatusPreference(value);
  await setOfflineMode(false);
}

export function setOnlineStatusPreference(value: StatusPreference): void {
  setPreference(value);
  writeJson(key, value);
}

const listeners = new Set<(status: PresenceStatus) => void>();

export function onOnlineStatusChange(listener: (status: PresenceStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let previous: PresenceStatus | undefined;
createRoot(() => createEffect(() => {
  const status = onlineStatus();
  if (status === previous) return;
  previous = status;
  setMyPresenceStatus(sharedPresenceStatus());
  listeners.forEach((listener) => listener(status));
}));
