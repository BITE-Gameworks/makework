// Leaving well: when this app goes, every member it reaches hears it at once (p2p/mesh.ts `bye`), instead of seeing a
// connection that looks lost and waiting for it to come back.
// - A page going away (reload, sign-out, a browser tab or a view window closing) says it on the way out, as far as the
//   page still gets to send. A reload keeps the saved call, so it is rejoined.
// - A deliberate quit (tray Quit, Ctrl+Q, the window closing for good, shutdown) is asked for by the main process
//   before the window goes (electron/main.js), which waits for it a moment at most. It leaves the call like
//   Disconnect (not rejoined on the next start), says bye and closes every workspace cleanly.
// - A crash or a kill says nothing; the next run names its old connection instead (core/lastRun.ts).
import { leaveVoice, stopRejoining } from "../voice/state";
import { undeliveredUploads } from "./content";
import { desktop } from "./desktop";
import { leavingOnPurpose } from "./leaving";
import { endRunCleanly, startRun } from "./lastRun";
import { isPopout } from "./popout";
import { closeAllWorkspaces, sayGoodbyeEverywhere } from "./serverless";

// How long a quit waits for the call's "left" and the byes to go out before closing the workspaces.
const leaveWaitMs = 250;
const byeWaitMs = 400;

let quitting: Promise<void> | null = null;

// Says bye in every open workspace. Safe to call more than once: each workspace says it once.
export function sayGoodbye(): Promise<void> {
  endRunCleanly();
  return sayGoodbyeEverywhere();
}

// The app quits on purpose: the call is left as by Disconnect (older apps take the member out on its "left" at once),
// then the byes go, then the workspaces close (rooms left, checkpoints saved).
export function quitApp(): Promise<void> {
  return (quitting ??= (async () => {
    // At once, not after the leave: a join still on its way would hold the leave back past the wait.
    stopRejoining();
    await Promise.race([leaveVoice(false).catch(() => {}), wait(leaveWaitMs)]);
    await Promise.race([sayGoodbye(), wait(byeWaitMs)]);
    await closeAllWorkspaces();
  })());
}

// Once on start, before any room is joined: Trystero leaves its rooms on the same `beforeunload` once one is, and this
// listener must come first, while the links are still up.
// New uploads that no node has all of yet (p2p/deliveries.ts: the node pulls them from here after the post) make a
// quit ask first: the desktop app asks in the main process (electron/background.js, through `onQuitCheck`), a browser
// tab with its own "Leave site?". Trystero leaves its rooms on that same event without looking whether it was
// cancelled, which would cut off a page that stays: so its listener (after this one) is stopped, and the goodbye waits
// for `pagehide`, once the page really goes.
export function watchFarewell(): void {
  startRun();
  let asked = false;
  window.addEventListener("beforeunload", (event) => {
    // Not when the app reloads itself (signing out): that has already happened (core/leaving.ts).
    if (!desktop && !isPopout() && !leavingOnPurpose() && undeliveredUploads() > 0) {
      asked = true;
      event.preventDefault();
      event.returnValue = "";
      event.stopImmediatePropagation();
      return;
    }
    void sayGoodbye();
  });
  window.addEventListener("pagehide", () => {
    if (asked) void sayGoodbye();
  });
  if (isPopout()) return;
  desktop?.onFarewell?.(() => void quitApp().catch(() => {}).finally(() => desktop?.farewellDone?.()));
  desktop?.onQuitCheck?.(() => undeliveredUploads());
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
