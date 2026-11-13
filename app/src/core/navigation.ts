// Where the user is: open tabs, each showing a workspace + channel with its own back/forward history.
// Tabs are kept on this device; history is not. A tab can also live in its own window (core/popout.ts): that
// window holds one tab, and what it shows is decided here, the same way as any other tab.
import { batch, createSignal } from "solid-js";
import type { ChannelTypeInfo } from "../plugins/types";
import { closeWindow, isPopout, openInMain, openInWindow, popoutPlace, type WindowPlace } from "./popout";
import { markRead } from "./sidebar";
import { readJson, writeJson } from "./storage";

// Private messages show in place of a workspace: `peer` is the account the conversation is with.
export const messagesHome = "@messages";

export interface Location {
  workspaceId: string;
  channelId: number | null;
  peer?: string;
  // An object in the channel that a followed link points at; a new object each time.
  target?: { kind: string; id: number | string };
}

export interface Tab {
  id: number;
  stack: Location[];
  index: number;
}

const tabsKey = "mw.tabs";
let nextTabId = 1;
const [tabs, setTabs] = createSignal<Tab[]>([]);
const [activeTabId, setActiveTabId] = createSignal(0);
const lastChannel = new Map<string, number | null>();

const recentKey = "mw.recentPlaces";
const recentLimit = 8;
const closedLimit = 20;
const [recent, setRecent] = createSignal<Location[]>(readJson<Location[]>(recentKey, []));
const [closedTabs, setClosedTabs] = createSignal<Location[]>([]);
// Where the member went last, the current place left out (the quick switcher lists them).
export const recentPlaces = () => recent().filter((l) => l.workspaceId !== current()?.workspaceId || l.channelId !== current()?.channelId);
export const closedTabCount = () => closedTabs().length;

export { tabs, activeTabId };

const newTab = (location?: Location): Tab => ({ id: nextTabId++, stack: location ? [location] : [], index: location ? 0 : -1 });
const activeTab = () => tabs().find((t) => t.id === activeTabId());

export function tabLocation(tab: Tab): Location | undefined {
  return tab.stack[tab.index];
}

export function current(): Location | undefined {
  const tab = activeTab();
  return tab && tabLocation(tab);
}

export const canGoBack = () => (activeTab()?.index ?? 0) > 0;
export const canGoForward = () => {
  const tab = activeTab();
  return !!tab && tab.index < tab.stack.length - 1;
};

function updateActive(change: (tab: Tab) => Tab) {
  batch(() => {
    if (!activeTab()) {
      const tab = newTab();
      setTabs([...tabs(), tab]);
      setActiveTabId(tab.id);
    }
    setTabs((list) => list.map((t) => (t.id === activeTabId() ? change(t) : t)));
    arrive();
  });
}

export function openChannel(workspaceId: string, channelId: number | null, target?: { kind: string; id: number | string }): void {
  const here = current();
  // A view window shows one workspace: a link or action pointing at another one opens as a tab in the main window.
  if (isPopout() && here && here.workspaceId !== workspaceId) {
    openInMain({ workspaceId, channelId, ...(target && { target: { ...target } }) });
    return;
  }
  if (here?.workspaceId === workspaceId && here.channelId === channelId) {
    // Same channel: only point it at the new object.
    if (target) updateActive((t) => ({ ...t, stack: t.stack.map((l, i) => (i === t.index ? { ...l, target: { ...target } } : l)) }));
    return;
  }
  const location: Location = { workspaceId, channelId, ...(target && { target: { ...target } }) };
  updateActive((t) => ({ ...t, stack: [...t.stack.slice(0, t.index + 1), location], index: t.index + 1 }));
}

// Returns to the channel last open on that server.
export function openWorkspace(workspaceId: string): void {
  openChannel(workspaceId, lastChannel.get(workspaceId) ?? null);
}

let lastPeer: string | undefined;

// A conversation, or with no peer private messages as last left (a conversation or the friends page).
export function openConversation(peer?: string): void {
  if (isPopout()) {
    openInMain({ workspaceId: messagesHome, channelId: null, ...(peer && { peer }) });
    return;
  }
  const next = peer ?? lastPeer;
  const here = current();
  if (here?.workspaceId === messagesHome && here.peer === next) return;
  const location: Location = { workspaceId: messagesHome, channelId: null, ...(next && { peer: next }) };
  updateActive((t) => ({ ...t, stack: [...t.stack.slice(0, t.index + 1), location], index: t.index + 1 }));
}

export function openFriends(): void {
  if (isPopout()) {
    openInMain({ workspaceId: messagesHome, channelId: null });
    return;
  }
  const here = current();
  if (here?.workspaceId === messagesHome && !here.peer) return;
  const location: Location = { workspaceId: messagesHome, channelId: null };
  updateActive((t) => ({ ...t, stack: [...t.stack.slice(0, t.index + 1), location], index: t.index + 1 }));
}

export function goBack(): void {
  if (canGoBack()) updateActive((t) => ({ ...t, index: t.index - 1 }));
}

export function goForward(): void {
  if (canGoForward()) updateActive((t) => ({ ...t, index: t.index + 1 }));
}

// Opens next to the active tab.
export function openInNewTab(location: Location, activate = true): void {
  // A view window holds one tab: its "open in new tab" opens in the main window instead.
  if (isPopout()) {
    openInMain({ ...location });
    return;
  }
  openInNewTabAt(location, null, activate);
}

// Opens a tab handed over from another window: before the tab it was dropped on, or, with no place, next to the
// active tab.
export function openInNewTabAt(location: Location, index: number | null, activate = true): void {
  const tab = newTab({ ...location });
  batch(() => {
    const list = tabs();
    const at = index === null
      ? list.findIndex((t) => t.id === activeTabId()) + 1
      : Math.max(0, Math.min(list.length, index));
    setTabs([...list.slice(0, at), tab, ...list.slice(at)]);
    if (activate) {
      setActiveTabId(tab.id);
      arrive();
    }
  });
}

export function selectTab(id: number): void {
  if (id === activeTabId() || !tabs().some((t) => t.id === id)) return;
  batch(() => {
    setActiveTabId(id);
    arrive();
  });
}

export function closeTabs(ids: number[]): void {
  // A view window holds one tab: closing it closes the window, and the tab goes with it.
  if (isPopout()) {
    closeWindow();
    return;
  }
  const list = tabs();
  const remaining = list.filter((t) => !ids.includes(t.id));
  const closed = list.filter((t) => ids.includes(t.id)).map(tabLocation).filter((l): l is Location => !!l && (l.channelId !== null || !!l.peer));
  batch(() => {
    if (closed.length) setClosedTabs([...closedTabs(), ...closed].slice(-closedLimit));
    if (remaining.length === 0) {
      // The last tab stays, emptied, on its workspace.
      const here = current();
      const tab = newTab(here && { workspaceId: here.workspaceId, channelId: null });
      setTabs([tab]);
      setActiveTabId(tab.id);
    } else {
      setTabs(remaining);
      if (ids.includes(activeTabId())) {
        // Like browsers: the tab to the right, else the one to the left.
        const at = list.findIndex((t) => t.id === activeTabId());
        const next = list.slice(at + 1).find((t) => !ids.includes(t.id)) ?? list.slice(0, at).reverse().find((t) => !ids.includes(t.id));
        setActiveTabId(next!.id);
      }
    }
    arrive();
  });
}

export function reopenClosedTab(): void {
  const last = closedTabs().at(-1);
  if (!last) return;
  setClosedTabs(closedTabs().slice(0, -1));
  openInNewTab(last);
}

export function moveTab(id: number, toIndex: number): void {
  const list = tabs().filter((t) => t.id !== id);
  const tab = tabs().find((t) => t.id === id);
  if (!tab) return;
  list.splice(Math.max(0, Math.min(list.length, toIndex)), 0, tab);
  setTabs(list);
  save();
}

// Whether a tab can be given its own window: a channel, not private messages, not the empty tab an emptied
// workspace leaves behind, and not a type whose view only works in the main window (voice keeps its call there).
// The channel's type comes from the caller, which knows its plugin; without it the answer is no, so a channel
// whose data hasn't loaded yet can't slip out.
export function poppable(location: Location | undefined, channelTypeInfo: Pick<ChannelTypeInfo, "ownWindow"> | undefined): boolean {
  return !!location && location.workspaceId !== messagesHome && location.channelId !== null
    && !!channelTypeInfo && channelTypeInfo.ownWindow !== false;
}

// Gives a channel its own window. A tab showing it here leaves, since popping out moves a tab and never copies it.
export function moveToWindow(workspaceId: string, channelId: number, channelTypeInfo: Pick<ChannelTypeInfo, "ownWindow"> | undefined): void {
  if (isPopout() || !poppable({ workspaceId, channelId }, channelTypeInfo)) return;
  const open = tabs().find((tab) => {
    const place = tabLocation(tab);
    return place?.workspaceId === workspaceId && place.channelId === channelId;
  });
  if (open) closeTabs([open.id]);
  openInWindow({ workspaceId, channelId });
}

// A view window starts with the one tab it was opened for, from its URL.
export function seedPopoutTab(place: WindowPlace): void {
  const location: Location = {
    workspaceId: place.workspaceId,
    channelId: place.channelId ?? null,
    ...(place.peer && { peer: place.peer }),
    ...(place.target && { target: { ...place.target } }),
  };
  const tab = newTab(location);
  batch(() => {
    setTabs([tab]);
    setActiveTabId(tab.id);
    arrive();
  });
}

// Where the last session's active tab was, before tabs are restored (the startup placeholder's shape). A view
// window hasn't restored anything: the tab it will show is the place in its own URL.
export function savedLocation(): Location | undefined {
  if (isPopout()) return popoutPlace();
  const saved = readJson<{ tabs: Location[]; active: number }>(tabsKey, { tabs: [], active: 0 });
  return saved.tabs[Math.min(saved.active, saved.tabs.length - 1)] ?? undefined;
}

// Reopens the tabs of the last session on the workspaces that are connected; false if there were none.
export function restoreTabs(connected: string[]): boolean {
  const saved = readJson<{ tabs: Location[]; active: number }>(tabsKey, { tabs: [], active: 0 });
  const list = saved.tabs.filter((l) => l?.workspaceId === messagesHome || connected.includes(l?.workspaceId)).map((l) => newTab(l));
  if (list.length === 0) return false;
  batch(() => {
    setTabs(list);
    setActiveTabId(list[Math.min(saved.active, list.length - 1)].id);
    arrive();
  });
  return true;
}

function save() {
  // Only the main window's tabs are the session's tabs; a view window's single tab is in its own URL.
  if (isPopout()) return;
  const list = tabs();
  writeJson(tabsKey, {
    tabs: list.map(tabLocation).filter((l): l is Location => !!l)
      .map(({ workspaceId, channelId, peer }) => ({ workspaceId, channelId, ...(peer && { peer }) })),
    active: Math.max(0, list.findIndex((t) => t.id === activeTabId())),
  });
}

// 1 when the last move went to a workspace further down the workspace bar, -1 up, 0 within the same workspace.
const [workspaceDirection, setServerDirection] = createSignal(0);
export { workspaceDirection };
let serverOrder: () => string[] = () => [];
export function setWorkspaceOrderSource(order: () => string[]): void {
  serverOrder = order;
}
let lastServer: string | undefined;

function arrive() {
  save();
  const here = current();
  if (!here) return;
  if (lastServer !== here.workspaceId) {
    const order = serverOrder();
    setServerDirection(lastServer === undefined ? 0 : Math.sign(order.indexOf(here.workspaceId) - order.indexOf(lastServer)));
    lastServer = here.workspaceId;
  } else setServerDirection(0);
  lastChannel.set(here.workspaceId, here.channelId);
  if (here.workspaceId === messagesHome) lastPeer = here.peer;
  if (here.channelId !== null) {
    markRead(here.workspaceId, here.channelId);
    const others = recent().filter((l) => l.workspaceId !== here.workspaceId || l.channelId !== here.channelId);
    setRecent([{ workspaceId: here.workspaceId, channelId: here.channelId }, ...others].slice(0, recentLimit));
    writeJson(recentKey, recent());
  }
}

// Coming back to the window counts as reading the channel it shows (messages may have come in meanwhile).
if (typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    const here = current();
    if (here && here.channelId !== null) markRead(here.workspaceId, here.channelId);
  });
}
