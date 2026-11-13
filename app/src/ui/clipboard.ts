// Copying text to the clipboard, the same way everywhere: a copy the browser refuses (the window not focused, no
// permission) tells the user instead of silently doing nothing. Buttons that show "Copied" use createCopied.
import { createSignal, onCleanup, type Accessor } from "solid-js";
import { writeClipboard } from "../core/clipboard";
import { showNotice } from "../core/notices";

// Resolves with whether the text is on the clipboard now.
export async function copyToClipboard(text: string): Promise<boolean> {
  if (await writeClipboard(text)) return true;
  showNotice("Not copied", "The clipboard refused it. Click in the app and try again.");
  return false;
}

// `copied` is true for a moment after a copy that worked (a check mark, "Copied ✓"); a newer copy restarts it, and
// `reset` ends it early (the thing to copy changed).
export function createCopied(ms = 1500): { copied: Accessor<boolean>; copy: (text: string) => Promise<boolean>; reset: () => void } {
  const [copied, setCopied] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const copy = async (text: string) => {
    if (!(await copyToClipboard(text))) return false;
    setCopied(true);
    clearTimeout(timer);
    timer = setTimeout(() => setCopied(false), ms);
    return true;
  };
  const reset = () => {
    clearTimeout(timer);
    setCopied(false);
  };
  return { copied, copy, reset };
}
