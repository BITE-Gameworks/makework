// The category order is a personal choice: kept on this device under the account and synced through the account's
// preferences (core/syncedPrefs.ts), never in the signed log.
import { createSignal } from "solid-js";
import { account } from "./account";
import { orderedBy, reorderIds } from "./order";
import { readJson, writeJson } from "./storage";
import type { Category } from "./workspaces";

const [orders, setOrders] = createSignal<Record<string, number[]>>({});
const keyFor = (accountId: string) => `mw.categoryOrder.${accountId}`;
// null means "loaded", but for no account; undefined means not loaded yet.
let loadedFor: string | null | undefined = undefined;

// Loads the signed-in account's orders once; called on every access, so it settles before anything else runs.
function loadedAccount(): string | null {
  const id = account()?.id ?? null;
  if (loadedFor === undefined || loadedFor !== id) {
    loadedFor = id;
    setOrders(id === null ? {} : readJson(keyFor(id), {}));
  }
  return loadedFor;
}

export function categoryOrder(workspaceId: string): number[] | undefined {
  loadedAccount();
  return orders()[workspaceId];
}

export function setCategoryOrder(workspaceId: string, categoryIds: number[]): void {
  const id = loadedAccount();
  if (id === null) return; // not signed in: nothing to keep a personal order for
  const next = { ...orders(), [workspaceId]: categoryIds };
  setOrders(next);
  writeJson(keyFor(id), next);
}

// Every workspace's order, for the account-synced preferences (core/syncedPrefs.ts). Reads the signal, so a change
// made through `setCategoryOrder` is picked up by the preference diff.
export function categoryOrders(): Record<string, number[]> {
  loadedAccount();
  return orders();
}

// The whole map from another computer, through the local store so the UI follows at once.
export function setCategoryOrders(next: Record<string, number[]>): void {
  const id = loadedAccount();
  if (id === null) return;
  setOrders(next);
  writeJson(keyFor(id), next);
}

// Stored order first, then categories the list does not know yet, in the workspace's order.
export function orderedCategories(categories: Category[], order: number[] | undefined): Category[] {
  return orderedBy(categories, order, (category) => category.id);
}

// The category ids after moving `id` before `beforeId` (null: the end). Untouched by the move returns `ids`.
export function reorderCategories(ids: number[], id: number, beforeId: number | null): number[] {
  return reorderIds(ids, id, beforeId);
}