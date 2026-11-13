// A long list shown in pieces: the end the reader sees first at once, then more a step per frame up to `limit`, then
// more as the reader scrolls toward the hidden end (`more`, with `watchNear` on an element at that end). Opening a big
// channel never renders thousands of items in one task, and leaving it never tears down thousands (mesh-test s15: a
// 3,000-message chat took 3.2 s to open and 0.6 s to leave). This later part is the fill. Each step aims at a share
// of the display's frame (measured: 6 ms at 165 Hz), its own work and the drawing of its items in the next frame
// included, so it adapts to the machine and the items and leaves the rest of each frame to animations. Steps grow
// slowly and shrink at once, a frame over budget is followed by one without a step, and no step runs while a view
// slides in or out (steps of 12 ms guessed against 60 Hz frames grew to thousands of items at 165 Hz and
// stalled animations). The window is the items minus those still hidden at the far
// end: items arriving at the shown end show at once, and nothing shown is ever taken away (that would remount it).
// The items stay the caller's objects, so a keyed <For> keeps them.
import { createEffect, createMemo, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js";
import { afterSlides, sliding } from "./transitions";

export interface Progressive<T> {
  shown: Accessor<readonly T[]>;
  // Everything is shown.
  complete: Accessor<boolean>;
  // The background fill is still adding items (up to `limit`); what the reader asks for with `more` is not counted.
  filling: Accessor<boolean>;
  // One more step past the limit (the reader came near the hidden end); false when everything is shown.
  more(): boolean;
  // Shows everything up to this item (a link to it).
  reveal(item: T): void;
  showAll(): void;
}

// How the frame before a step went: how long it took to draw (style, layout and paint of the last step's items,
// mostly) and how long the display's frames are.
export interface Frame {
  renderMs: number;
  frameMs: number;
}

// A step and its frame's drawing take this share of a frame; the rest is the animations'.
const frameShare = 0.4;
const maxStep = 200;
const firstStep = 10;
const growth = 1.5;

// The display's frame: the shortest gap between frames lately (165 Hz here is 6 ms, not 60 Hz's 16.7), drifting up
// slowly in case the window moved to a slower display.
let displayFrameMs = 1000 / 60;
let lastFrameAt = 0;
function noteFrame(at: number) {
  const gap = at - lastFrameAt;
  lastFrameAt = at;
  if (gap < 2 || gap > 50) return;
  displayFrameMs = Math.min(34, Math.max(4, gap < displayFrameMs ? gap : displayFrameMs + (gap - displayFrameMs) * 0.05));
}

// After the next frame was drawn: a step's rendering lands between frames, and the time from the frame's start to
// the step is what drawing it took.
function afterFrame(step: (frame?: Frame) => void) {
  requestAnimationFrame((at) => {
    noteFrame(at);
    const start = performance.now();
    setTimeout(() => step({ renderMs: performance.now() - start, frameMs: displayFrameMs }), 0);
  });
}

export function createProgressive<T>(items: Accessor<readonly T[]>, options: {
  // Which end shows first: "end" for a conversation (its newest), "start" for a listing.
  from: "start" | "end";
  // How many show at once: about a screenful, or as many as the reader had last time. Read when the list starts.
  first: number | (() => number);
  // Shown in the background up to this many; the rest through `more`. All by default.
  limit?: number;
  // Shown again from `first` when it changes (another folder): change it with the items (the same data update).
  key?: Accessor<unknown>;
  schedule?: (step: (frame?: Frame) => void) => void;
  // Something steps wait for before going on: by default the slides of views coming and going.
  wait?: () => Promise<void> | undefined;
}): Progressive<T> {
  const schedule = options.schedule ?? afterFrame;
  const wait = options.wait ?? (() => (sliding() ? afterSlides() : undefined));
  const firstCount = () => (typeof options.first === "function" ? options.first() : options.first);
  const limit = options.limit ?? Infinity;
  // Items not shown yet at the far end; null until the list first has items.
  const [hidden, setHidden] = createSignal<number | null>(null);
  let step = firstStep;
  // The last step, while the next one follows it directly (a step after a pause tells nothing about its cost).
  let last: { size: number; took: number } | null = null;
  let pending = false;
  let wanted = 0;
  let disposed = false;
  onCleanup(() => (disposed = true));

  const start = (length: number) => {
    const first = untrack(firstCount);
    step = firstStep;
    last = null;
    wanted = 0;
    setHidden(Math.max(0, length - first));
  };
  createEffect(() => {
    const length = items().length;
    if (length > 0 && untrack(hidden) === null) start(length);
  });
  if (options.key) createEffect(on(options.key, () => {
    const length = untrack(items).length;
    if (length > 0) start(length);
    else setHidden(null);
  }, { defer: true }));

  const shownCount = () => untrack(items).length - (untrack(hidden) ?? 0);
  const grow = (frame?: Frame) => {
    pending = false;
    const left = untrack(hidden);
    if (disposed || !left) return;
    const allowed = wanted > 0 || shownCount() < limit;
    if (!allowed) return void (last = null);
    const paused = wait();
    if (paused) {
      // A step after the pause tells nothing about the one before it.
      last = null;
      pending = true;
      return void paused.then(() => {
        pending = false;
        next();
      });
    }
    const budget = (frame?.frameMs ?? 1000 / 60) * frameShare;
    // The last step's cost: its own work and the drawing of its items in the frame since. Smaller at once when it
    // was over, larger only slowly.
    if (last) {
      const cost = Math.max(last.took + (frame?.renderMs ?? 0), 0.1);
      step = Math.max(1, Math.min(maxStep, Math.ceil(last.size * growth), Math.round((last.size * budget) / cost)));
      // Over a whole frame: the next frame is the animations', unless the reader is waiting for more.
      if (cost > (frame?.frameMs ?? Infinity) && wanted === 0) {
        last = null;
        return next();
      }
    }
    const size = step;
    const now = performance.now();
    setHidden(Math.max(0, left - size));
    const took = performance.now() - now;
    if (wanted > 0) wanted--;
    if (untrack(hidden) && (wanted > 0 || shownCount() < limit)) {
      last = { size, took };
      next();
    } else last = null;
  };
  const next = () => {
    if (pending) return;
    pending = true;
    schedule(grow);
  };
  createEffect(() => {
    if (hidden()) next();
  });

  const shown = createMemo(() => {
    const list = items();
    const left = hidden();
    if (left === 0) return list;
    if (left === null) {
      const first = untrack(firstCount);
      return options.from === "end" ? list.slice(Math.max(0, list.length - first)) : list.slice(0, first);
    }
    return options.from === "end" ? list.slice(Math.min(left, list.length)) : list.slice(0, Math.max(0, list.length - left));
  });
  return {
    shown,
    complete: () => hidden() === 0,
    filling: () => {
      const left = hidden();
      return !!left && items().length - left < limit;
    },
    more() {
      if (!untrack(hidden)) return false;
      wanted = Math.min(wanted + 1, 2);
      next();
      return true;
    },
    reveal(item) {
      const list = untrack(items);
      const at = list.indexOf(item);
      const left = untrack(hidden);
      if (at < 0 || left === null) return;
      setHidden(Math.min(left, options.from === "end" ? at : list.length - 1 - at));
    },
    showAll: () => setHidden(0),
  };
}

// Calls `onNear` while `edge` is within `marginPx` of `root`'s view: once when it comes near, then each frame while
// it stays near (what onNear added may not have pushed it away) and onNear says there was more. `wake` asks again for
// an edge that stayed near after onNear said no (it may say yes now: a message list once the reader scrolled up).
export function watchNear(edge: Element, root: Element, onNear: () => boolean, options: {
  marginPx?: number;
  Observer?: typeof IntersectionObserver;
  frame?: (callback: () => void) => void;
} = {}): { stop: () => void; wake: () => void } {
  const Observer = options.Observer ?? IntersectionObserver;
  const frame = options.frame ?? ((callback) => void requestAnimationFrame(callback));
  const margin = options.marginPx ?? 800;
  let near = false;
  let stopped = false;
  // A frame's asking is due: waking now would ask twice a frame.
  let due = false;
  const again = () => {
    due = false;
    if (!near || stopped || !onNear()) return;
    due = true;
    frame(again);
  };
  const observer = new Observer((entries) => {
    const was = near;
    near = entries.some((entry) => entry.isIntersecting);
    if (near && !was && !due) again();
  }, { root, rootMargin: `${margin}px 0px ${margin}px 0px` });
  observer.observe(edge);
  return {
    stop() {
      stopped = true;
      observer.disconnect();
    },
    wake: () => void (!due && again()),
  };
}
