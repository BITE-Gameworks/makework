// Undo/redo per channel: views record what this user did as entries that can be done and undone again.
// Kept for the session per channel, so switching tabs or channels keeps it. Steps run one at a time.
import { createRoot, createSignal } from "solid-js";

export interface HistoryEntry {
  label: string;
  icon?: string;
  undo(): Promise<unknown>;
  redo(): Promise<unknown>;
}

export interface History {
  entries(): (HistoryEntry & { at: number })[];
  // How many entries are applied; entries after it can be redone.
  position(): number;
  busy(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  // Records something that was just done.
  push(entry: HistoryEntry): void;
  undo(): Promise<void>;
  redo(): Promise<void>;
  // Undoes or redoes until `position` entries are applied.
  goTo(position: number): Promise<void>;
}

const limit = 100;
const histories = new Map<string, History>();

export function historyFor(key: string): History {
  let history = histories.get(key);
  if (!history) {
    history = createRoot(createHistory);
    histories.set(key, history);
  }
  return history;
}

function createHistory(): History {
  const [entries, setEntries] = createSignal<(HistoryEntry & { at: number })[]>([]);
  const [position, setPosition] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  let queue = Promise.resolve();

  // A failed step stays where it was, so it can be tried again; the error goes to the caller.
  const step = (direction: -1 | 1) => {
    const run = queue.then(async () => {
      const index = direction < 0 ? position() - 1 : position();
      const entry = entries()[index];
      if (!entry) return;
      setBusy(true);
      try {
        await (direction < 0 ? entry.undo() : entry.redo());
        setPosition(position() + direction);
      } finally {
        setBusy(false);
      }
    });
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    entries,
    position,
    busy,
    canUndo: () => position() > 0,
    canRedo: () => position() < entries().length,
    push(entry) {
      const kept = [...entries().slice(0, position()), { ...entry, at: Date.now() }].slice(-limit);
      setEntries(kept);
      setPosition(kept.length);
    },
    undo: () => step(-1),
    redo: () => step(1),
    async goTo(target) {
      while (position() > target) await step(-1);
      while (position() < target && position() < entries().length) await step(1);
    },
  };
}

// Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y, except while typing, where text fields keep their own undo.
export function historyKeys(history: History, onError: (e: unknown) => void) {
  return (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (!(e.ctrlKey || e.metaKey) || e.altKey || target.closest("input, textarea, select, [contenteditable='true']")) return;
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey) history.undo().catch(onError);
    else if ((key === "z" && e.shiftKey) || key === "y") history.redo().catch(onError);
    else return;
    e.preventDefault();
  };
}
