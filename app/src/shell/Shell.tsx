import { Show, createEffect, on, onCleanup, onMount } from "solid-js";
import { current } from "../core/navigation";
import { drawerOpen, narrow, overlay, setDrawerOpen, sidePanel } from "../core/ui";
import ChannelBar from "./ChannelBar";
import MainView from "./MainView";
import WorkspaceBar from "./WorkspaceBar";
import SidePanel from "./SidePanel";
import TabBar from "./TabBar";
import ContextMenu from "../ui/ContextMenuHost";
import { watchLongPress } from "../ui/longPress";
import { createPresence } from "../ui/presence";
import ViewerOverlay from "./ViewerOverlay";
import WindowControls, { hasWindowControls } from "./WindowControls";
import VoicePanel from "../voice/VoicePanel";
import Overlays from "./Overlays";
import ResetPrompt from "./ResetPrompt";
import FeedbackDialog from "./FeedbackDialog";
import Notices from "./Notices";
import QuickSwitcher from "./QuickSwitcher";
import { onShortcut } from "./shortcuts";
import { watchResets } from "../core/resets";
import { watchProfile } from "../core/account";
import { watchOwnProfile } from "../core/members";
import { watchSyncedPrefs } from "../core/syncedPrefs";
import "./shell.css";

// A swipe from the screen's left edge opens the drawer; one to the left on the open drawer closes it.
const edgePx = 24;
const swipePx = 60;

export default function Shell() {
  // Narrow: the drawer starts open while nothing is open, and closes once a channel or conversation is picked
  // (switching workspaces keeps it open on the new channel list), or a page or panel opens over the view.
  let where = current();
  createEffect(on(current, (now) => {
    const before = where;
    where = now;
    if (!narrow()) return;
    if (!now) return void setDrawerOpen(true);
    if (before && before.workspaceId !== now.workspaceId) return;
    setDrawerOpen(false);
  }));
  createEffect(on([overlay, sidePanel], ([o, p]) => (o || p) && setDrawerOpen(false), { defer: true }));
  createEffect(on(narrow, (n) => setDrawerOpen(n && !current()?.channelId && !current()?.peer)));
  const backdrop = createPresence(() => narrow() && drawerOpen());

  let swipe: { x: number; y: number; opening: boolean } | null = null;
  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    if (!narrow() || e.touches.length !== 1) return;
    if (!drawerOpen() && t.clientX > edgePx) return;
    swipe = { x: t.clientX, y: t.clientY, opening: !drawerOpen() };
  };
  const onTouchEnd = (e: TouchEvent) => {
    const t = e.changedTouches[0];
    if (!swipe || !t) return;
    const dx = t.clientX - swipe.x;
    const sideways = Math.abs(dx) > Math.abs(t.clientY - swipe.y) * 1.5;
    if (sideways && swipe.opening && dx > swipePx) setDrawerOpen(true);
    if (sideways && !swipe.opening && dx < -swipePx) setDrawerOpen(false);
    swipe = null;
  };

  onMount(() => {
    document.addEventListener("keydown", onShortcut);
    onCleanup(watchResets());
    watchProfile();
    watchOwnProfile();
    watchSyncedPrefs();
    onCleanup(watchLongPress());
  });
  onCleanup(() => document.removeEventListener("keydown", onShortcut));

  return (
    <div class="shell" classList={{ "has-window-controls": hasWindowControls, narrow: narrow(), "drawer-open": narrow() && drawerOpen() }}
      onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} onTouchCancel={() => (swipe = null)}>
      <div class="sidebars" inert={narrow() && !drawerOpen()}>
        <div class="sidebars-top">
          <WorkspaceBar />
          <ChannelBar />
        </div>
        <VoicePanel />
      </div>
      <div class="workspace">
        <TabBar />
        <div class="workspace-body">
          <MainView />
          <SidePanel />
          <Overlays />
          <ViewerOverlay />
        </div>
      </div>
      <Show when={backdrop.mounted()}>
        <div class="drawer-backdrop" classList={{ visible: backdrop.visible() }} aria-hidden="true" onClick={() => setDrawerOpen(false)} />
      </Show>
      <ContextMenu />
      <ResetPrompt />
      <Notices />
      <FeedbackDialog />
      <QuickSwitcher />
      <WindowControls />
    </div>
  );
}
