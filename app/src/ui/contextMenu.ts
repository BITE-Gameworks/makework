// The one open right-click menu. Shown by ui/ContextMenuHost, which the shell mounts once.
import { createSignal, type JSX } from "solid-js";

export interface MenuItem {
  label: string;
  icon?: string;
  // A color dot before the label, e.g. a tag's color.
  swatch?: string;
  action: () => void;
  disabled?: boolean;
  danger?: boolean;
}

// Content that isn't a command, like a slider; clicking it keeps the menu open.
export interface MenuContent {
  render: () => JSX.Element;
}

// An entry that opens its own list of entries below it, like a dropdown.
export interface MenuSubmenu {
  label: string;
  icon?: string;
  items: MenuEntry[];
  disabled?: boolean;
}

export type MenuEntry = MenuItem | MenuContent | MenuSubmenu | "separator";

export interface OpenMenu {
  x: number;
  y: number;
  entries: MenuEntry[];
}

const [contextMenu, setContextMenu] = createSignal<OpenMenu | null>(null);
export { contextMenu };

export function openContextMenu(event: MouseEvent, entries: MenuEntry[]): void {
  event.preventDefault();
  event.stopPropagation();
  // A click made with Enter or Space has no pointer position: the menu opens under the element instead.
  const fromKeys = event.detail === 0 && event.clientX === 0 && event.clientY === 0 && event.currentTarget instanceof Element;
  const box = fromKeys ? (event.currentTarget as Element).getBoundingClientRect() : null;
  setContextMenu({ x: box ? box.left : event.clientX, y: box ? box.bottom : event.clientY, entries });
}

export function closeContextMenu(): void {
  setContextMenu(null);
}
