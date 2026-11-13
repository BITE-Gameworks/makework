// Shared list-order rules for personal orders (categories, workspaces): a saved order first, items it does not
// know after it, and moves that never copy a list that did not change.
export type OrderId = string | number;

// Items in the saved order, then items the order does not know yet in their current order. The same array comes
// back when nothing moves, so a reactive render does not run again for no change.
export function orderedBy<T>(items: T[], order: readonly OrderId[] | undefined, idOf: (item: T) => OrderId): T[] {
  if (!order || order.length === 0) return items;
  const byId = new Map(items.map((item) => [idOf(item), item]));
  const shown: T[] = [];
  const used = new Set<OrderId>();
  for (const id of order) {
    const item = byId.get(id);
    if (item && !used.has(id)) {
      shown.push(item);
      used.add(id);
    }
  }
  for (const item of items) if (!used.has(idOf(item))) shown.push(item);
  return shown.length === items.length && shown.every((item, i) => item === items[i]) ? items : shown;
}

// `id` moved before `beforeId` (null: the end). The same array comes back for an unknown id, a move onto itself,
// or a move that leaves the order as it was.
export function reorderIds<T extends OrderId>(ids: T[], id: T, beforeId: T | null): T[] {
  if (!ids.includes(id) || beforeId === id) return ids;
  const next = ids.filter((x) => x !== id);
  const at = beforeId == null ? next.length : next.indexOf(beforeId);
  next.splice(at < 0 ? next.length : at, 0, id);
  return next.length === ids.length && next.every((x, i) => x === ids[i]) ? ids : next;
}
