import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { account } from "../core/account";
import { closeFile, openedFile } from "../core/files";
import { current } from "../core/navigation";
import { closeOverlays, drawerOpen, narrow, overlay, setDrawerOpen, setSidePanel, sidePanel } from "../core/ui";
import { closeContextMenu, contextMenu } from "../ui/contextMenu";
import { dialogOpen } from "../ui/Dialog";

// Android's Back (the button, or the swipe from a screen edge) closes the top layer, then shows the channel list, then
// leaves the app. With @capacitor/app installed, Back does nothing unless a listener handles it, so this is set up at
// startup, before anyone signs in.
export function watchBackButton(): () => void {
  if (Capacitor.getPlatform() !== "android") return () => {};
  const listener = App.addListener("backButton", stepBack);
  return () => void listener.then((handle) => handle.remove());
}

function stepBack(): void {
  if (contextMenu()) return closeContextMenu();
  // A dialog closes the way Escape closes it; the layers under it leave Escape to it.
  if (dialogOpen()) return void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
  if (openedFile()) return closeFile();
  if (overlay()) return closeOverlays();
  if (sidePanel()) return void setSidePanel(null);
  if (narrow() && !drawerOpen() && account() && current()) return void setDrawerOpen(true);
  // Like Android's own Back on an app's first screen: to the background, not closed.
  void App.minimizeApp();
}
