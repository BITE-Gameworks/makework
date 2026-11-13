// Desktop notifications (the system's own, through the web Notification API; Electron passes them to the
// desktop). Android's WebView has no Notification API, so the Android app shows them through Capacitor. Used for
// @mentions. Silent: the app plays its own sounds.
import { createSignal } from "solid-js";
import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { desktop } from "./desktop";
import { current } from "./navigation";
import { isPopout } from "./popout";
import { readJson, writeJson } from "./storage";
import { onlineStatus } from "./onlineStatus";

const key = "mw.notifications";
const [on, setOn] = createSignal(readJson(key, true));
export const notificationsOn = on;

type Permission = NotificationPermission | "unsupported";
const phone = Capacitor.isNativePlatform();
const supported = () => phone || typeof Notification !== "undefined";
const [permission, setPermission] = createSignal<Permission>(phone ? "default" : supported() ? Notification.permission : "unsupported");
export const notificationPermission = permission;

const phonePermission = (state: string): Permission => (state === "granted" ? "granted" : state === "denied" ? "denied" : "default");

async function askPhone(): Promise<void> {
  const { display } = await LocalNotifications.checkPermissions();
  setPermission(phonePermission(display === "granted" || display === "denied" ? display : (await LocalNotifications.requestPermissions()).display));
}

const phoneClicks = new Map<number, () => void>();
if (phone) {
  // The phone app may ask without a click, so it asks at start while notifications are on.
  if (readJson(key, true)) void askPhone();
  void LocalNotifications.addListener("localNotificationActionPerformed", ({ notification }) => phoneClicks.get(notification.id)?.());
}

// A tag as the whole-number id the phone's notifications use; the same tag replaces the older one.
function phoneId(tag: string): number {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = (Math.imul(hash, 31) + tag.charCodeAt(i)) | 0;
  return hash & 0x7fffffff;
}

// Sets the switch without asking the browser, for another computer's choice arriving over the account.
export function setNotificationsOn(value: boolean): void {
  setOn(value);
  writeJson(key, value);
}

// Switching them on by hand asks the browser for permission; call it from a click, browsers ignore the request otherwise.
export async function enableNotifications(value: boolean): Promise<void> {
  setNotificationsOn(value);
  if (!value) return;
  if (phone) await askPhone();
  else if (supported() && Notification.permission === "default") setPermission(await Notification.requestPermission());
}

// Per workspace on this device: whether @everyone/@here and role mentions notify. Mentions of you always do.
export interface GroupMentions {
  everyone: boolean;
  roles: boolean;
}
const groupsKey = "mw.notifications.groups";
const [groups, setGroups] = createSignal<Record<string, Partial<GroupMentions>>>(readJson(groupsKey, {}));

export function groupMentionsOn(workspaceId: string): GroupMentions {
  const saved = groups()[workspaceId];
  return { everyone: saved?.everyone ?? true, roles: saved?.roles ?? true };
}

export function setGroupMentionsOn(workspaceId: string, change: Partial<GroupMentions>): void {
  setGroups((all) => ({ ...all, [workspaceId]: { ...groupMentionsOn(workspaceId), ...change } }));
  writeJson(groupsKey, groups());
}

export interface Notice {
  // A newer notice with the same tag replaces the older one.
  tag: string;
  title: string;
  body: string;
  icon?: string;
  onClick?: () => void;
}

export function notify(notice: Notice): void {
  // Notifications belong to the main window; a view window showing the same workspace would double them.
  if (isPopout()) return;
  if (onlineStatus() === "dnd" || !on()) return;
  if (phone) {
    if (permission() !== "granted") return;
    const id = phoneId(notice.tag);
    phoneClicks.set(id, () => notice.onClick?.());
    void LocalNotifications.schedule({ notifications: [{ id, title: notice.title, body: notice.body, silent: true }] });
    return;
  }
  if (!supported() || Notification.permission !== "granted") return;
  const shown = new Notification(notice.title, { body: notice.body, tag: notice.tag, icon: notice.icon, silent: true });
  shown.onclick = () => {
    if (desktop?.focus) desktop.focus();
    else window.focus();
    notice.onClick?.();
    shown.close();
  };
}

// Whether the user is already looking at that channel: the window has focus and its active tab shows it.
export function isLooking(workspaceId: string, channelId: number): boolean {
  const here = current();
  return document.hasFocus() && here?.workspaceId === workspaceId && here.channelId === channelId;
}
