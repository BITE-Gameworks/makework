// The order a member arranges their workspaces in, kept on this device under the signed-in account and synced
// through the account's preferences (core/syncedPrefs.ts). Personal: never part of a workspace's signed data.
import { createSignal } from "solid-js";
import { account } from "./account";
import { readJson, writeJson } from "./storage";

const [order, setOrder] = createSignal<string[]>([]);
const keyFor = (accountId: string) => `mw.workspaceOrder.${accountId}`;
// null means "loaded", but for no account; undefined means not loaded yet.
let loadedFor: string | null | undefined = undefined;

// Loads the signed-in account's order once; called on every access, so it settles before anything else runs.
function loadedAccount(): string | null {
  const id = account()?.id ?? null;
  if (loadedFor === undefined || loadedFor !== id) {
    loadedFor = id;
    const stored = id === null ? [] : readJson<unknown>(keyFor(id), []);
    setOrder(Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string") : []);
  }
  return loadedFor;
}

export function savedWorkspaceOrder(): string[] {
  loadedAccount();
  return order();
}

export function saveWorkspaceOrder(ids: string[]): void {
  const id = loadedAccount();
  if (id === null) return; // not signed in: nothing to keep a personal order for
  setOrder(ids);
  writeJson(keyFor(id), ids);
}

// The saved order with the connected workspaces in `display` order. Closed workspaces keep their slots, so moving
// a connected workspace never loses the place a left workspace had (and gets back when it is rejoined).
export function mergeWorkspaceOrder(saved: string[], display: string[]): string[] {
  const connected = new Set(display);
  const next: string[] = [];
  const placed = new Set<string>();
  let at = 0;
  for (const id of saved) {
    if (!connected.has(id)) {
      next.push(id);
      continue;
    }
    if (placed.has(id)) continue;
    const replacement = display[at++];
    if (replacement === undefined) continue;
    next.push(replacement);
    placed.add(replacement);
  }
  for (; at < display.length; at++) next.push(display[at]);
  return next.length === saved.length && next.every((id, i) => id === saved[i]) ? saved : next;
}
