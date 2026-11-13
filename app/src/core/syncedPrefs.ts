// Preferences that follow the account: where a computer signed in to it is set up, every other computer signed in
// to it is too. Kept in the account's vault on the user server (core/vault.ts), so only this account can read them.
// Changes are written back two seconds after they stop, and the newest value of a setting wins. Per-device choices
// (input and output volumes, panel widths, the readable-folder setup) stay local on purpose.
import { createEffect, createRoot } from "solid-js";
import { account } from "./account";
import { categoryOrders, setCategoryOrders } from "./categoryOrder";
import { setNotificationsOn, notificationsOn } from "./notifier";
import { onlineStatusPreference, setOnlineStatusPreference } from "./onlineStatus";
import { sendTyping, setSendTyping } from "./typing";
import { UserServerError } from "./userServer";
import { readVaultDoc, updateVault } from "./vault";
import { setWorkspaceOrder } from "./workspaces";
import { setWorkspaceGroups, workspaceGroupsSnapshot } from "./workspaceGroups";
import { savedWorkspaceOrder } from "./workspaceOrder";
import { setMarkdownMode, markdownMode } from "../editor/mode";
import { iconPack, setIconPack, soundPack, setSoundPack } from "../theme/packs";
import { soundVolume, setSoundVolume } from "../theme/sounds";
import { replaceUserThemes, selectedThemeId, selectTheme, userThemes, defaultThemeId } from "../theme/store";

const vaultName = "prefs";

// What a remote document may hold, applied through the normal setters so the UI follows at once. The order matters:
// user themes before the selected id, which may name one of them.
const appliers: Record<string, (value: unknown) => void> = {
  "mw.themes.user": (value) => replaceUserThemes(value),
  "mw.themes.selected": (value) => selectTheme(typeof value === "string" && value ? value : defaultThemeId),
  "mw.iconPack": (value) => setIconPack(String(value)),
  "mw.soundPack": (value) => setSoundPack(String(value)),
  "mw.sounds.volume": (value) => setSoundVolume(Number(value)),
  "mw.editor.markdown": (value) => setMarkdownMode(!!value),
  "mw.notifications": (value) => setNotificationsOn(!!value),
  "mw.sendTyping": (value) => setSendTyping(!!value),
  "mw.onlineStatus": (value) => {
    if (value === "online" || value === "dnd" || value === "hidden") setOnlineStatusPreference(value);
  },
  "mw.workspaceOrder": (value) => {
    if (Array.isArray(value)) setWorkspaceOrder(value.filter((id): id is string => typeof id === "string"));
  },
  "mw.categoryOrder": (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const next: Record<string, number[]> = {};
    for (const [workspaceId, ids] of Object.entries(value as Record<string, unknown>))
      if (Array.isArray(ids)) next[workspaceId] = ids.filter((id): id is number => typeof id === "number");
    setCategoryOrders(next);
  },
  "mw.workspaceGroups": (value) => setWorkspaceGroups(value),
};

// The current local choices, under the storage keys they live at (the same names the vault uses).
function snapshot(): Record<string, unknown> {
  return {
    "mw.themes.user": userThemes(),
    "mw.themes.selected": selectedThemeId(),
    "mw.iconPack": iconPack(),
    "mw.soundPack": soundPack(),
    "mw.sounds.volume": soundVolume(),
    "mw.editor.markdown": markdownMode(),
    "mw.notifications": notificationsOn(),
    "mw.sendTyping": sendTyping(),
    "mw.onlineStatus": onlineStatusPreference(),
    "mw.workspaceOrder": savedWorkspaceOrder(),
    "mw.categoryOrder": categoryOrders(),
    "mw.workspaceGroups": workspaceGroupsSnapshot(),
  };
}

let ready = false;
let applying = false;
let lastKnown: Record<string, unknown> | null = null;
let pending: Record<string, unknown> = {};
let timer: ReturnType<typeof setTimeout> | undefined;

// Two seconds after the last change, write the changed settings only, so a change made elsewhere meanwhile to
// another setting isn't overwritten. `change` merges over a newer copy, retried on 409 (core/vault.ts).
function schedulePush(changes: Record<string, unknown>): void {
  pending = { ...pending, ...changes };
  if (networkDisabled()) {
    clearTimeout(timer);
    timer = undefined;
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(() => {
    const write = pending;
    pending = {};
    timer = undefined;
    if (networkDisabled()) {
      pending = { ...pending, ...write };
      return;
    }
    void updateVault<Record<string, unknown>>(vaultName, (current) => ({ ...current, ...write }))
      .then((saved) => {
        if (saved === null) pending = { ...write, ...pending };
      }, (e) => {
        pending = { ...write, ...pending };
        if (!(e instanceof UserServerError)) console.warn("Saving preferences failed:", e);
      });
  }, 2000);
}

// A local change, from the setters the settings pages call.
function onChanged(): void {
  const now = snapshot();
  if (applying) {
    lastKnown = now;
    return;
  }
  const before = lastKnown;
  lastKnown = now;
  if (!before) return;
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(now)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(value)) changes[key] = value;
  }
  if (Object.keys(changes).length) {
    if (!ready) pending = { ...pending, ...changes };
    else schedulePush(changes);
  }
}

// Takes what another computer wrote, through the setters; then the diff sees nothing to send back.
// A value another computer wrote that a setter refuses is skipped (and logged) on its own: the rest still apply, and
// `applying` always ends, or this device would stop sending its own changes.
function applyRemote(remote: Record<string, unknown>): void {
  applying = true;
  try {
    for (const [key, apply] of Object.entries(appliers)) {
      if (!(key in remote)) continue;
      try {
        apply(remote[key]);
      } catch (e) {
        console.warn(`Synced preference ${key} not applied:`, e);
      }
    }
    if (!("mw.onlineStatus" in remote) && "mw.showOnline" in remote)
      setOnlineStatusPreference(remote["mw.showOnline"] === true ? "online" : "hidden");
    lastKnown = snapshot();
  } finally {
    applying = false;
  }
}

// Reads the account's preferences, applies them, and puts up this device's choices for settings the vault lacks.
export async function pullPrefs(): Promise<void> {
  if (networkDisabled()) return;
  const remote = await readVaultDoc<Record<string, unknown>>(vaultName);
  if (remote) applyRemote(remote);
  const now = snapshot();
  const missing: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(now)) if (!remote || !(key in remote)) missing[key] = value;
  ready = true;
  lastKnown ??= now;
  if (Object.keys(missing).length) schedulePush(missing);
  else if (Object.keys(pending).length) schedulePush({});
}

let watching = false;
let lastPull = 0;
// Watches for local changes and picks up ones made on another computer: on start, and at most every 5 minutes when
// the window gets focus. Started once, from the shell (which is shown once signed in).
export function watchSyncedPrefs(): void {
  if (watching) return;
  watching = true;
  createRoot(() => createEffect(() => {
    void snapshot();
    onChanged();
  }));
  const pull = () => {
    if (networkDisabled()) return;
    if (Date.now() - lastPull < 5 * 60_000) return;
    lastPull = Date.now();
    void pullPrefs().catch((e) => {
      if (!(e instanceof UserServerError)) console.warn("Reading preferences failed:", e);
    });
  };
  void pull();
  window.addEventListener("focus", pull);
  let disabled = networkDisabled();
  createRoot(() => createEffect(() => {
    const nowDisabled = networkDisabled();
    if (nowDisabled) {
      disabled = true;
      return;
    }
    if (disabled) {
      disabled = false;
      lastPull = 0;
      pull();
    }
  }));
}

function networkDisabled(): boolean {
  return !!account()?.offline || !!account()?.offlineMode;
}
