// Channel views kept mounted, hidden, after the user leaves them: coming back shows them as they were instead of
// loading again. Every channel type is kept (`keepAlive: false` opts a type out); a number is how long a hidden
// view is kept after it was last shown. At most `maxKept` views that are not exempt are held; the shown view and
// views whose channel has an open tab are exempt, so a type's timeout never lets an exempt view go. The sweep
// below keeps the cache current while the app runs.
import { createEffect, createRoot, createSignal } from "solid-js";
import { channelType } from "./channelTypes";
import { current, tabLocation, tabs } from "./navigation";
import { findChannel } from "./workspaces";

export interface KeptView {
  workspaceId: string;
  channelId: number;
  key: string;
}

export const viewKey = (workspaceId: string, channelId: number) => `${workspaceId}:${channelId}`;

const maxKept = 8;
const [kept, setKept] = createSignal<KeptView[]>([]);
const timers = new Map<string, ReturnType<typeof setTimeout>>();
// While a view is hidden, when it was last shown: with its type's timeout, that is when it is let go.
const hiddenSince = new Map<string, number>();
export { kept };

// The kept views in the order they were first kept, for drawing them. `kept` is ordered by when each was last shown
// (the least recent is let go first), and a keyed list following that order moved views' elements on every switch,
// which makes the browser drop the scroll positions inside them: a chat came back at its oldest shown messages, and
// older ones loaded each time as the top came into reach.
const placed = new WeakMap<KeptView, number>();
let placing = 0;
export function keptInPlace(): KeptView[] {
  const list = kept();
  for (const view of list) if (!placed.has(view)) placed.set(view, placing++);
  return [...list].sort((a, b) => placed.get(a)! - placed.get(b)!);
}

// Whether a channel type's views stay loaded while hidden; a type opts out with `keepAlive: false`.
export const keepsAlive = (type: string) => channelType(type).keepAlive !== false;

// The channel now shown: kept from now on, its timeout stopped and the most recent (past the bound the least
// recently shown view that is not exempt is the one let go).
export function showKept(workspaceId: string, channelId: number, type: string): void {
  if (!keepsAlive(type)) return;
  const key = viewKey(workspaceId, channelId);
  forget(key);
  setKept((list) => {
    const view = list.find((v) => v.key === key) ?? { workspaceId, channelId, key };
    return [...list.filter((v) => v !== view), view];
  });
}

// Hidden until shown again: a type with a timeout lets its view go that many seconds after it was last shown.
// An exempt view is never let go by its timeout; the sweep arms it when the exemption (its tab) ends.
export function leaveKept(view: KeptView, type: string): void {
  if (hiddenSince.has(view.key)) return;
  hiddenSince.set(view.key, Date.now());
  if (!isExempt(view)) armTimeout(view.key, type);
}

export function dropKept(key: string): void {
  forget(key);
  setKept((list) => list.filter((v) => v.key !== key));
}

// A view is exempt while it is the shown one or its channel has an open tab: it never counts toward the bound
// and never lets go by its type's timeout.
function isExempt(view: KeptView): boolean {
  const here = current();
  if (here?.workspaceId === view.workspaceId && here.channelId === view.channelId) return true;
  return tabs().some((tab) => {
    const at = tabLocation(tab);
    return !!at && at.workspaceId === view.workspaceId && at.channelId === view.channelId;
  });
}

// Arms a hidden view's timeout for what is left of its type's keepAlive since it was last shown; a view past
// its timeout is let go now. The sweep arms it again when an exemption ends (its tab closes).
function armTimeout(key: string, type: string): void {
  const seconds = channelType(type).keepAlive;
  const since = hiddenSince.get(key);
  if (typeof seconds !== "number" || since === undefined || timers.has(key)) return;
  const left = since + seconds * 1000 - Date.now();
  if (left <= 0) {
    dropKept(key);
    return;
  }
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    const view = kept().find((v) => v.key === key);
    if (!view || !isExempt(view)) dropKept(key);
  }, left));
}

// One view's timeout is stopped; a view whose exemption only paused its timeout keeps when it was last shown.
function stopTimeout(key: string): void {
  clearTimeout(timers.get(key));
  timers.delete(key);
}

// The view is let go: its timeout is stopped and it is forgotten as hidden.
function forget(key: string): void {
  stopTimeout(key);
  hiddenSince.delete(key);
}

// Views whose channel no longer exists are let go, and only the maxKept least recently shown views that are not
// exempt are held. Watching here lets go of them while the app runs: a workspace suspended or removed, a channel
// disappearing or a tab closing, not only when the shown channel changes.
createRoot(() => {
  createEffect(() => sweep());
});

function sweep(): void {
  const list = kept();
  if (list.length === 0) return;
  const gone = new Set<string>();
  const free: { view: KeptView; type: string }[] = [];
  for (const view of list) {
    const channel = findChannel(view.workspaceId, view.channelId);
    if (!channel) {
      gone.add(view.key);
      continue;
    }
    if (isExempt(view)) {
      stopTimeout(view.key);
      continue;
    }
    free.push({ view, type: channel.type });
  }
  for (const { view } of free.slice(0, Math.max(0, free.length - maxKept))) gone.add(view.key);
  for (const { view, type } of free) if (!gone.has(view.key)) armTimeout(view.key, type);
  if (gone.size === 0) return;
  for (const key of gone) forget(key);
  setKept((views) => views.filter((v) => !gone.has(v.key)));
}
