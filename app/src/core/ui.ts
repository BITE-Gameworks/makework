// App-wide UI state: the overlay pages, the side panel, bar widths.
import { createSignal, type JSX } from "solid-js";
import { readJson, writeJson } from "./storage";

export interface SidePanelContent {
  title: string;
  render: () => JSX.Element;
  // Names the panel, so the button that opened it can show as active and close it again (toggleSidePanel).
  key?: string;
}

// What the app is doing while it starts (loading plugins, opening servers, ...); null once it is ready. The main
// view shows a placeholder until then.
export const [bootStatus, setBootStatus] = createSignal<string | null>("Starting...");

// The page over the workspace: the app's settings, or one workspace's settings (whose "profile" section is the
// Profile button's). Only one shows at a time, and every button for one toggles it the same way (toggleOverlay).
export type Overlay = { kind: "app"; section: string } | { kind: "workspace"; workspaceId: string; section: string };
const [overlay, setOverlay] = createSignal<Overlay | null>(null);
export { overlay };
let lastAppSection = "appearance";

export const appSettings = (section = lastAppSection): Overlay => ({ kind: "app", section });
export const workspacePage = (workspaceId: string, section = "overview"): Overlay => ({ kind: "workspace", workspaceId, section });

export function showOverlay(next: Overlay): void {
  if (next.kind === "app") lastAppSection = next.section;
  setOverlay(next);
}

export function closeOverlays(): void {
  setOverlay(null);
}

// The button an overlay belongs to: app settings, a workspace's profile, or a workspace's other sections.
function owner(o: Overlay | null): string | null {
  if (!o) return null;
  return o.kind === "app" ? "app" : `${o.section === "profile" ? "profile" : "workspace"}:${o.workspaceId}`;
}

// Whether the button for `target` should show as open.
export function overlayShowing(target: Overlay): boolean {
  return owner(overlay()) === owner(target);
}

// Opens `target`, or closes it when its button's overlay is what is showing.
export function toggleOverlay(target: Overlay): void {
  if (overlayShowing(target)) closeOverlays();
  else showOverlay(target);
}

export const openSettings = (section?: string) => showOverlay(appSettings(section));
export const settingsOpen = () => overlay()?.kind === "app";

// The bot (user id) the Bots page should show first, set by "Open in workspace settings" in a bot's profile.
export const [botFocus, setBotFocus] = createSignal<number | null>(null);
// Phones (also turned sideways) and small windows: one pane at a time, with the workspace and channel bars in a
// drawer (shell.css `.narrow`).
export const narrowWidth = 760;
export const shortHeight = 500;
const narrowQuery = typeof matchMedia === "function" ? matchMedia(`(max-width: ${narrowWidth}px), (max-height: ${shortHeight}px)`) : null;
const [narrow, setNarrow] = createSignal(narrowQuery?.matches ?? false);
narrowQuery?.addEventListener("change", (e) => setNarrow(e.matches));
export { narrow };
export const [drawerOpen, setDrawerOpen] = createSignal(false);

// While the window is being resized, and `quietMs` after its last step, the root has `window-resizing`: transitions
// pause then (theme/base.css), or widths that follow the window (the side panel) animated behind its edge and the
// layout wobbled, most of all on Windows.
export function markWhileResizing(target: EventTarget, root: { classList: { add(name: string): void; remove(name: string): void } }, quietMs = 150): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  target.addEventListener("resize", () => {
    root.classList.add("window-resizing");
    clearTimeout(timer);
    timer = setTimeout(() => root.classList.remove("window-resizing"), quietMs);
  });
}
if (typeof window !== "undefined") markWhileResizing(window, document.documentElement);

export const [sidePanel, setSidePanel] = createSignal<SidePanelContent | null>(null);

export const sidePanelShowing = (key: string) => sidePanel()?.key === key;

// Every button that opens a side panel uses this: it opens the panel, or closes it when it is the one showing.
export function toggleSidePanel(content: SidePanelContent & { key: string }): void {
  setSidePanel(sidePanelShowing(content.key) ? null : content);
}

const widthKey = "mw.sidePanel.width";
export const sidePanelLimits = { min: 260, max: 640 };
const defaultSidePanelWidth = 340;
const [sidePanelWidth, setWidth] = createSignal(readJson(widthKey, defaultSidePanelWidth));
export { sidePanelWidth };

// null goes back to the default width.
export function setSidePanelWidth(width: number | null): void {
  setWidth(Math.round(Math.min(sidePanelLimits.max, Math.max(sidePanelLimits.min, width ?? defaultSidePanelWidth))));
}

export function saveSidePanelWidth(): void {
  writeJson(widthKey, sidePanelWidth());
}

// The channel bar's width when the user dragged it; null follows the theme.
const channelBarKey = "mw.channelBar.width";
export const channelBarLimits = { min: 160, max: 480 };
const [channelBarWidth, setChannelBarWidthSignal] = createSignal<number | null>(readJson(channelBarKey, null));
export { channelBarWidth };

export function setChannelBarWidth(width: number | null): void {
  setChannelBarWidthSignal(width === null ? null : Math.round(Math.min(channelBarLimits.max, Math.max(channelBarLimits.min, width))));
}

export function saveChannelBarWidth(): void {
  writeJson(channelBarKey, channelBarWidth());
}

// Files above this size show as a placeholder until the user downloads or opens them.
const ghostKey = "mw.files.ghostThresholdMb";
const [ghostThresholdMb, setGhostMb] = createSignal(readJson(ghostKey, 25));
export { ghostThresholdMb };
export const ghostThresholdBytes = () => ghostThresholdMb() * 1024 * 1024;

export function setGhostThresholdMb(value: number): void {
  setGhostMb(Math.max(0, value));
  writeJson(ghostKey, ghostThresholdMb());
}
