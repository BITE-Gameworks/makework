// Keyboard for the rows of a tree, the same in every tree (a code channel's files, a docs channel's pages, the
// design view's layers), after the WAI-ARIA tree view: one row is the tab stop, Up and Down move the focus, Left
// and Right close and open, Enter or Space does what a click does, F2 renames.
//
// A tree writes role="tree" on its rows' container and, on each row, role="treeitem", aria-level (1 at the top),
// aria-expanded where the row can open, `tabIndex` from createTreeStop, `ref={treeRow}` and `onKeyDown={treeKeys(...)}`.
// The rows are read from the page in the order shown, so a tree keeps no second list for this. The roles are
// written out on the elements, never spread in: code checkers only see attributes that are there to read.
import { createMemo, createSelector, createSignal, onCleanup, type Accessor } from "solid-js";
import { itemsAround } from "./rovingFocus";

// A row as the keys see it: how deep it is, and whether it is open (`undefined` for a row that can't open).
export interface TreeRow { level: number; expanded?: boolean }
export type TreeStep = { focus: number } | { toggle: true } | { activate: true } | { rename: true };

// What `key` does on row `at` of the rows shown; null for a key that isn't the tree's. A move that has nowhere to
// go stays on the row, so the key still counts as the tree's (it must not reach the view's own shortcuts).
export function treeStep(rows: readonly TreeRow[], at: number, key: string): TreeStep | null {
  const row = rows[at];
  if (!row) return null;
  switch (key) {
    case "ArrowDown": return { focus: Math.min(at + 1, rows.length - 1) };
    case "ArrowUp": return { focus: Math.max(at - 1, 0) };
    case "Home": return { focus: 0 };
    case "End": return { focus: rows.length - 1 };
    case "ArrowRight":
      if (row.expanded === false) return { toggle: true };
      return { focus: row.expanded && rows[at + 1]?.level > row.level ? at + 1 : at };
    case "ArrowLeft": {
      if (row.expanded) return { toggle: true };
      for (let i = at - 1; i >= 0; i--) if (rows[i].level < row.level) return { focus: i };
      return { focus: at };
    }
    case "Enter":
    case " ": return { activate: true };
    case "F2": return { rename: true };
    default: return null;
  }
}

export interface TreeActions {
  // Enter or Space: what a click on the row does. The event carries Shift and Ctrl, for trees that select ranges.
  activate: (event: KeyboardEvent) => void;
  // Opens or closes the row; only asked of rows with aria-expanded.
  toggle?: () => void;
  rename?: () => void;
}

const rowSelector = '[role="treeitem"]';
// The row an element inside it (a rename field) belongs to. Taken before the field goes away, to focus the row after.
export const treeRowOf = (inside: Element) => inside.closest<HTMLElement>(rowSelector);

function describe(row: HTMLElement): TreeRow {
  const expanded = row.getAttribute("aria-expanded");
  return { level: Number(row.getAttribute("aria-level")) || 1, expanded: expanded === null ? undefined : expanded === "true" };
}

// A row's onKeyDown.
export function treeKeys(actions: TreeActions): (event: KeyboardEvent & { currentTarget: HTMLElement }) => void {
  return (event) => {
    // Keys typed in the row's rename field or on its buttons are theirs.
    if (event.target !== event.currentTarget || event.altKey) return;
    const presses = event.key === "Enter" || event.key === " ";
    if (!presses && (event.ctrlKey || event.metaKey)) return;
    const rows = itemsAround(event.currentTarget, '[role="tree"]', rowSelector);
    const step = treeStep(rows.map(describe), rows.indexOf(event.currentTarget), event.key);
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    if ("focus" in step) rows[step.focus]?.focus();
    else if ("toggle" in step) actions.toggle?.();
    else if ("rename" in step) actions.rename?.();
    else actions.activate(event);
  };
}

// One tab stop per tree: the row focused last while it is shown, else `preferred` (the open or selected row), else
// the first row. `shown` is the rows' ids in the order shown. A row sets `tabIndex={stop.tabIndex(id)}` and
// `onFocus={() => stop.focused(id)}`.
export function createTreeStop<Id>(shown: Accessor<readonly Id[]>, preferred: Accessor<Id | null | undefined>) {
  const [last, setLast] = createSignal<Id | null>(null);
  const stop = createMemo(() => {
    const ids = shown();
    const focused = last();
    if (focused !== null && ids.includes(focused)) return focused;
    const wanted = preferred();
    return wanted !== null && wanted !== undefined && ids.includes(wanted) ? wanted : ids[0];
  });
  const isStop = createSelector(stop);
  return {
    tabIndex: (id: Id): 0 | -1 => (isStop(id) ? 0 : -1),
    focused: (id: Id) => { setLast(() => id); },
  };
}

// A row's `ref`. A row that goes away while it has the focus (deleted, folded away, or redrawn) hands the focus to
// the tree's tab stop, so the keyboard doesn't go dead.
export function treeRow(row: HTMLElement): void {
  onCleanup(() => {
    if (document.activeElement !== row) return;
    const tree = row.closest('[role="tree"]');
    queueMicrotask(() => tree?.querySelector<HTMLElement>(`${rowSelector}[tabindex="0"]`)?.focus());
  });
}
