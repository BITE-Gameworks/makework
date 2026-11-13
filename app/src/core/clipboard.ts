import { showToast } from "./notices";

// The one place that writes the clipboard: resolves with whether the text is on it now. A refusal (the window not
// focused, no permission) is the caller's to tell the user: `copyText` with a toast, `copyToClipboard`
// (ui/clipboard.ts) with a notice.
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) throw new Error("This browser gives no clipboard here.");
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    console.warn("Not copied:", e);
    return false;
  }
}

export async function copyText(text: string, done = "Copied"): Promise<void> {
  showToast((await writeClipboard(text)) ? done : "That couldn't be copied.");
}
