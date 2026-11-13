// This run's peer id, kept on the device so the next run knows it. A run that ended without saying bye (core/farewell.ts:
// a crash, a kill, the power going) left its connections to time out on the other members' side, which looks like a
// member reconnecting. The next run names that peer in its call presence for its first minute (p2p/voice.ts
// `replaces`), so they drop it at once.
// Desktop app only: it runs once per device (single-instance lock), so the record in localStorage is this app's alone.
// Browser tabs keep none: a tab's own storage is copied when the tab is duplicated, and the copy named the original
// tab's live connection as the one it replaces, taking the member out of the call.
import { selfId } from "trystero";
import { desktop } from "./desktop";
import { isPopout } from "./popout";
import { readJson, writeJson } from "./storage";

type Run = { peer: string; clean: boolean };
const key = "mw.run";
const replacesForMs = 60_000;

let replaced: string | null = null;
let startedAt = 0;

// Called once on start, in the desktop app's main window only: a view window is a peer of its own and never in a call.
export function startRun(): void {
  if (startedAt || !desktop || isPopout()) return;
  startedAt = Date.now();
  const before = readJson<Partial<Run> | null>(key, null);
  if (typeof before?.peer === "string" && before.peer !== selfId && before.clean !== true) replaced = before.peer;
  writeJson(key, { peer: selfId, clean: false } satisfies Run);
}

// The peer id of the run before, while it should still be named: only when that run didn't say bye, and only for this
// run's first minute (the others' links to it have timed out by then).
export function replacedPeer(): string | null {
  return replaced && Date.now() - startedAt < replacesForMs ? replaced : null;
}

// This run said bye: the next one has nothing to replace.
export function endRunCleanly(): void {
  if (startedAt) writeJson(key, { peer: selfId, clean: true } satisfies Run);
}
