import { onCleanup, onMount } from "solid-js";
import { goBack, goForward } from "../core/navigation";
import MainView from "./MainView";
import SidePanel from "./SidePanel";
import TabBar from "./TabBar";
import ContextMenu from "../ui/ContextMenuHost";
import ViewerOverlay from "./ViewerOverlay";
import WindowControls, { hasWindowControls } from "./WindowControls";
import Overlays from "./Overlays";
import ResetPrompt from "./ResetPrompt";
import Notices from "./Notices";
import { watchResets } from "../core/resets";
import { watchProfile } from "../core/account";
import { watchSyncedPrefs } from "../core/syncedPrefs";
import "./shell.css";

// A view window: the same app showing the one tab it was popped out for. No workspace or channel bars (the window
// is about that tab), no voice panel, no calls, no notifications of its own; the main window owns all of that.
// Links here that point at another workspace are handed to the main window (core/popout.ts).
export default function PopoutShell() {
  const onKey = (e: KeyboardEvent) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowLeft") goBack();
    else if (e.key === "ArrowRight") goForward();
    else return;
    e.preventDefault();
  };
  onMount(() => {
    document.addEventListener("keydown", onKey);
    onCleanup(watchResets());
    watchProfile();
    watchSyncedPrefs();
  });
  onCleanup(() => document.removeEventListener("keydown", onKey));

  return (
    <div class="shell" classList={{ "has-window-controls": hasWindowControls }}>
      <div class="workspace">
        <TabBar />
        <div class="workspace-body">
          <MainView />
          <SidePanel />
          <Overlays />
          <ViewerOverlay />
        </div>
      </div>
      <ContextMenu />
      <ResetPrompt />
      <Notices />
      <WindowControls />
    </div>
  );
}
