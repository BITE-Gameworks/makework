// The items of a widget that has one tab stop and moves the focus inside it with keys (the tabs of a tab list, the
// rows of a tree: ui/treeKeys.ts), found from one of them, in the order shown.
export function itemsAround(item: Element, container: string, items: string): HTMLElement[] {
  return [...(item.closest(container)?.querySelectorAll<HTMLElement>(items) ?? [])];
}

// Left/Right (or Up/Down with `vertical`), Home and End move the focus along the items; true when the key was one of
// them. For an item's onKeyDown: keys from something inside the item, and keys with Ctrl, Alt or Cmd, are left alone.
export function moveFocus(event: KeyboardEvent & { currentTarget: HTMLElement }, container: string, items: string, vertical = false): boolean {
  if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey || event.altKey) return false;
  const all = itemsAround(event.currentTarget, container, items);
  const at = all.indexOf(event.currentTarget);
  const [back, on] = vertical ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
  const to = event.key === back ? at - 1 : event.key === on ? at + 1 : event.key === "Home" ? 0 : event.key === "End" ? all.length - 1 : null;
  if (to === null) return false;
  event.preventDefault();
  event.stopPropagation();
  all[Math.max(0, Math.min(all.length - 1, to))]?.focus();
  return true;
}
