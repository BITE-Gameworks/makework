// Password resets started on another device that this one, still signed in, may approve. Checked every 30 seconds
// and when the window gets focus, for accounts kept on a user server (GitHub-only ones have no email).
import { createSignal } from "solid-js";
import { account, accountKey } from "./account";
import { pendingResets, UserServerError, type ResetRequest } from "./userServer";

const [resets, setResets] = createSignal<ResetRequest[]>([]);
export { resets };

let holders = 0;
let stopWatching: (() => void) | null = null;

// Starts checking (once, however many shells ask); each caller gets its own release, and checking stops when the
// last one lets go.
export function watchResets(): () => void {
  holders++;
  stopWatching ??= startWatching();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holders === 0) {
      stopWatching?.();
      stopWatching = null;
    }
  };
}

function startWatching(): () => void {
  const check = async () => {
    const me = account();
    if (!me?.publishedTo) return;
    try {
      setResets(await pendingResets({ id: me.id, key: accountKey() }));
    } catch (e) {
      if (!(e instanceof UserServerError)) console.warn("Checking for password resets failed:", e);
    }
  };
  void check();
  const timer = setInterval(() => void check(), 30_000);
  const onFocus = () => void check();
  window.addEventListener("focus", onFocus);
  return () => {
    clearInterval(timer);
    window.removeEventListener("focus", onFocus);
  };
}

export function dismissReset(id: string): void {
  setResets(resets().filter((r) => r.id !== id));
}
