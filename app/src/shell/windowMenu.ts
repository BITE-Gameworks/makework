import { canPopOutWindows } from "../core/popout";
import type { MenuEntry } from "../ui/contextMenu";

// The entry that gives a tab or channel its own window. Callers hide it for a type that can't stand alone and
// disable it when the tab can't leave or the desktop build has no view windows.
export function newWindowEntry(label: string, action: () => void, enabled = true): MenuEntry {
  return { label, icon: "window-new", disabled: !enabled || !canPopOutWindows(), action };
}
