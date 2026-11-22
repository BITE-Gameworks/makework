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
  // The button whose click opened it, if any: clicking that button again closes the menu.
  opener?: Element | null;
}

// Gap kept between a right-click menu and the window's edges, in px.
export const menuEdge = 4;

const [contextMenu, setContextMenu] = createSignal<OpenMenu | null>(null);
export { contextMenu };

// Whether the open menu holding `el` can grow `height` px taller and still end inside the window.
export function menuHasRoom(el: Element, height: number): boolean {
  const menu = el.closest(".mw-context-menu");
  return !menu || menu.getBoundingClientRect().bottom + height <= innerHeight - menuEdge;
}

// Only a button's click counts: a right click or long press on the same element opens the menu again where it was made.
function openerOf(event: MouseEvent): Element | null {
  const target = event.currentTarget as Element | null;
  return event.type === "click" && target?.tagName === "BUTTON" ? target : null;
}

// Whether a press on `target` lands on the open menu's opener. The menu then stays open for that button's click to
// close it, instead of closing on the press and opening again on the click.
export function pressOnOpener(target: Node): boolean {
  return !!contextMenu()?.opener?.contains(target);
}

export function openContextMenu(event: MouseEvent, entries: MenuEntry[]): void {
  event.preventDefault();
  event.stopPropagation();
  const opener = openerOf(event);
  if (opener && contextMenu()?.opener === opener) return closeContextMenu();
  // A click made with Enter or Space has no pointer position: the menu opens under the element instead.
  const fromKeys = event.detail === 0 && event.clientX === 0 && event.clientY === 0 && event.currentTarget instanceof Element;
  const box = fromKeys ? (event.currentTarget as Element).getBoundingClientRect() : null;
  setContextMenu({ x: box ? box.left : event.clientX, y: box ? box.bottom : event.clientY, entries, opener });
}

export function closeContextMenu(): void {
  setContextMenu(null);
}
