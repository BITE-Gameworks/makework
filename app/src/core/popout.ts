// Tabs in their own window: popping a tab out, dragging one between windows, and handing one back.
//
// A view window is this same app on the same session (same account, same content), started with `?popout=<place>`.
// It shows that one tab and nothing account-wide: notifications, sounds, the icon badge, calls and private
// messages stay in the main window (ADR 0009). Places here are
// WindowPlace (core/desktop.ts), the shape of navigation's Location, repeated so this module doesn't have to
// import the tab list.
import { desktop, type WindowPlace } from "./desktop";

export type { WindowPlace };

export type WindowMode = "main" | "popout";
// What the cursor is over while a tab is dragged: the window that owns the tab, the main window, another view
// window, or nothing (the desktop).
export type DragRegion = "self" | "main" | "popout" | "desktop";
export type DragEnd = "none" | "created" | "returned";
// A tab handed to a window: the place, where to put it (null: after the active tab) and whether to show it.
export interface HandedOverTab {
  location: WindowPlace;
  index?: number | null;
  activate?: boolean;
}

function param(name: string): string | null {
  return typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get(name);
}

// The window this page is: the one with the bars and tabs, or one showing a single tab (its URL says which).
export function modeOf(raw: string | null): WindowMode {
  return raw === null ? "main" : "popout";
}

const mode: WindowMode = modeOf(param("popout"));
// A terminal window (`?terminal=<id>`, electron/main.js createTerminalWindow): the id of the code channel terminal it
// shows, else null. Such a window isn't a view window and starts none of the app (plugins/builtin/code/TerminalWindow).
export const terminalWindowId: number | null = Number(param("terminal")) || null;
export const isPopout = () => mode === "popout";

// The place this view window was started for. Undefined when its URL doesn't say (a plain page reload in the
// browser, a hand-typed URL).
export function parsePlace(raw: string | null): WindowPlace | undefined {
  if (!raw) return undefined;
  try {
    const place = JSON.parse(raw) as WindowPlace;
    return typeof place?.workspaceId === "string" && (place.channelId === null || typeof place.channelId === "number")
      ? place : undefined;
  } catch {
    return undefined;
  }
}

export function popoutPlace(): WindowPlace | undefined {
  return parsePlace(param("popout"));
}

// A tab handed over by another window (main.js `window:tab-received`); undefined when the message is malformed.
export function parseHandedOver(tab: unknown): HandedOverTab | undefined {
  const { location, index, activate } = (tab ?? {}) as HandedOverTab;
  if (!location || typeof location.workspaceId !== "string") return undefined;
  return { location, index: typeof index === "number" ? index : null, activate: activate !== false };
}

// This client can give a tab its own window (the desktop shell's bridge; not the browser build).
export const canPopOutWindows = () => !!desktop?.popout;

// Closes this window. A view window is closed, never hidden, and its tab goes with it.
export function closeWindow(): void {
  desktop?.close();
}

// Opens the place in its own window, or brings forward the view window already showing it.
export function openInWindow(place: WindowPlace): void {
  void desktop?.popout?.open(place);
}

// Asks the main window to take a place this window can't show (a link that points at another workspace).
export function openInMain(place: WindowPlace): void {
  void desktop?.popout?.openInMain(place);
}

// Hands the tab this window holds back to the main window, then closes this window (a view window is never empty).
export async function returnToMain(place: WindowPlace): Promise<void> {
  const moved = await desktop?.popout?.returnTab(place);
  if (moved !== false) desktop?.close();
}
// A tab dragged between windows. The page starts the drag, reports the cursor's screen position while it moves
// (the main process decides what the cursor is over then) and ends it with what became of the tab, so the page can
// close its tab or put it back.
export function startTabDrag(place: WindowPlace): void {
  desktop?.popout?.dragStart(place);
}

export function moveTabDrag(x: number, y: number): void {
  desktop?.popout?.dragMove(x, y);
}

export function endTabDrag(place: WindowPlace, x: number, y: number): Promise<DragEnd> {
  return desktop?.popout?.dragEnd(place, x, y) ?? Promise.resolve("none");
}

export function cancelTabDrag(): void {
  desktop?.popout?.dragCancel();
}

const nothing = () => {};

// The listeners below report what happens while a tab is dragged and all return their own unsubscribe.
export function onDragRegion(handler: (region: DragRegion) => void): () => void {
  return desktop?.popout?.onDragState(handler) ?? nothing;
}

export function onTabDraggedOver(handler: (x: number) => void): () => void {
  return desktop?.popout?.onTabDragOver(({ x }) => handler(x)) ?? nothing;
}

export function onTabDraggedAway(handler: () => void): () => void {
  return desktop?.popout?.onTabDragLeave(handler) ?? nothing;
}

export function onTabHandedOver(handler: (tab: HandedOverTab) => void): () => void {
  return desktop?.popout?.onTabReceived((tab) => {
    const parsed = parseHandedOver(tab);
    if (parsed) handler(parsed);
  }) ?? nothing;
}
