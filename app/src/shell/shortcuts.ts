// The app's keyboard shortcuts. A field or view that used a key itself (the editor's Ctrl+K link) has prevented its
// default by the time this runs. Browsers keep Ctrl+T, W and Tab for themselves, so those are desktop only.
import { desktop } from "../core/desktop";
import { activeTabId, closeTabs, current, goBack, goForward, openInNewTab, reopenClosedTab, selectTab, tabs } from "../core/navigation";
import { toggleQuickSwitcher } from "../core/quickSwitcher";
import { workspaces } from "../core/workspaces";

export const newBlankTab = () => {
  const here = current();
  openInNewTab({ workspaceId: here?.workspaceId ?? workspaces.order[0] ?? "", channelId: null });
};

const closeActiveTab = () => closeTabs([activeTabId()]);

function stepTab(by: number) {
  const list = tabs();
  if (list.length < 2) return;
  const at = list.findIndex((t) => t.id === activeTabId());
  selectTab(list[(at + by + list.length) % list.length].id);
}

export function onShortcut(e: KeyboardEvent): void {
  if (e.defaultPrevented) return;
  const run = shortcutFor(e);
  if (!run) return;
  e.preventDefault();
  run();
}

function shortcutFor(e: KeyboardEvent): (() => void) | null {
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    if (e.key === "ArrowLeft") return goBack;
    if (e.key === "ArrowRight") return goForward;
    return null;
  }
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (!e.shiftKey && (key === "k" || key === "p")) return toggleQuickSwitcher;
  if (e.key >= "1" && e.key <= "9" && !e.shiftKey) {
    const list = tabs();
    const tab = e.key === "9" ? list.at(-1) : list[Number(e.key) - 1];
    return tab ? () => selectTab(tab.id) : null;
  }
  if (!desktop) return null;
  if (key === "tab") return () => stepTab(e.shiftKey ? -1 : 1);
  if (key === "t") return e.shiftKey ? reopenClosedTab : newBlankTab;
  if (key === "w" && !e.shiftKey) return closeActiveTab;
  return null;
}
