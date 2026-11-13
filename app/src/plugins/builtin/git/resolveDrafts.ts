// The choices made while resolving a merge's conflicts, kept on this device until the merge is made or the member
// discards them: closing the resolver, leaving the channel or restarting the app keeps them. One entry per conflicted
// file and its three versions, so a file whose versions changed (new commits) starts over; old entries are dropped.
import type { GitConflictFile } from "../../../core/desktop";
import { readJson, writeJson } from "../../../core/storage";
import type { ConflictChoice } from "./merge";

// A text file's choices, one per conflict (null: undecided), or one side's version of the file as it is (no file if
// that side has none).
export type FileDecision = { kind: "lines"; choices: (ConflictChoice | null)[] } | { kind: "whole"; side: "receiving" | "incoming" };

const storageKey = "mw.git.resolving";
const keepMs = 30 * 24 * 60 * 60 * 1000;
// What goes into storage at most (the newest first): results written by hand can be big, and storage is shared with
// every other setting. Beyond it, choices last until the app closes.
const storedChars = 1_000_000;
type Entry = { at: number; decision: FileDecision };
type Stored = Record<string, Entry>;

export const draftKey = (folder: string, file: GitConflictFile) =>
  [folder, file.path, file.base?.oid ?? "", file.receiving?.oid ?? "", file.incoming?.oid ?? ""].join("\0");

const fresh = (): Stored => {
  const since = Date.now() - keepMs;
  return Object.fromEntries(Object.entries(readJson<Stored>(storageKey, {})).filter(([, entry]) => entry?.at > since));
};
// This window's copy, and the keys it changed since it last wrote (another window, a popped-out tab, writes its own).
let stored: Stored | null = null;
const changed = new Set<string>();
const all = (): Stored => (stored ??= fresh());

let timer: ReturnType<typeof setTimeout> | null = null;
const flush = () => {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!changed.size) return;
  const now = fresh();
  for (const key of changed) {
    const entry = stored?.[key];
    if (entry) now[key] = entry;
    else delete now[key];
  }
  changed.clear();
  let size = 0;
  const kept = Object.entries(now).sort(([, a], [, b]) => b.at - a.at).filter(([, entry]) => (size += JSON.stringify(entry).length) <= storedChars);
  writeJson(storageKey, Object.fromEntries(kept));
};
// Written a moment after the last change (typing in a result), and before the page goes away.
const save = () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, 300);
};
if (typeof window !== "undefined") window.addEventListener("pagehide", flush);

// Reading the conflicts again starts from what is stored, with this window's unsaved changes on top.
export function reloadDrafts() {
  const mine = Object.fromEntries([...changed].map((key) => [key, stored?.[key]]));
  stored = fresh();
  for (const [key, entry] of Object.entries(mine)) {
    if (entry) stored[key] = entry;
    else delete stored[key];
  }
}

// Copies: what is read is put into a store and what is written may come from one.
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export const readDraft = (key: string): FileDecision | null => {
  const entry = all()[key];
  return entry ? copy(entry.decision) : null;
};

export function writeDraft(key: string, decision: FileDecision | null) {
  if (decision) all()[key] = { at: Date.now(), decision: copy(decision) };
  else delete all()[key];
  changed.add(key);
  save();
}

export function dropDrafts(keys: string[]) {
  for (const key of keys) {
    delete all()[key];
    changed.add(key);
  }
  save();
}
