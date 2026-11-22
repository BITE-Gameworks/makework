// HTML drag-and-drop barely works with a finger, so on touch screens a hold picks an element up and the finger then
// drags it. Until the hold ends a move is a scroll as usual; after it the page stops scrolling, a copy of the element
// follows the finger, and the scrollers under it scroll near their edges. The mouse keeps HTML drag-and-drop.
import { motionMs } from "./presence";
import "./touchDrag.css";

export interface HoldDrag {
  start(): void;
  // The finger's place, in client px.
  move(x: number, y: number): void;
  drop(x: number, y: number): void;
  cancel(): void;
}

const holdMs = 400;
// A finger that moves this far before the hold ends is scrolling.
const slopPx = 10;
// Near a scroller's edge a drag scrolls it, faster closer to the edge, up to this much each tick.
const edgeBandPx = 40;
const maxStepPx = 14;
const scrollTickMs = 16;
const scrolls = new Set(["auto", "scroll"]);
const ease = "cubic-bezier(0.2, 0, 0, 1)";

// How far a scroller from `start` to `end` scrolls this tick for a finger at `pos`: negative near the start,
// positive near the end, 0 in between.
export function edgeStep(pos: number, start: number, end: number): number {
  const band = Math.min(edgeBandPx, (end - start) / 2);
  if (band <= 0) return 0;
  if (pos < start + band) return -Math.ceil(maxStepPx * Math.min(1, (start + band - pos) / band));
  if (pos > end - band) return Math.ceil(maxStepPx * Math.min(1, (pos - (end - band)) / band));
  return 0;
}

// Scrolls the nearest scroller under the point that can still go that way, for each axis. True when one moved.
function edgeScroll(x: number, y: number): boolean {
  let movedX = false;
  let movedY = false;
  for (let el = document.elementFromPoint(x, y); el && !(movedX && movedY); el = el.parentElement) {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    if (!movedX && scrolls.has(style.overflowX)) {
      const dx = edgeStep(x, box.left, box.right);
      if (dx < 0 ? el.scrollLeft > 0 : dx > 0 && el.scrollLeft < el.scrollWidth - el.clientWidth) {
        el.scrollLeft += dx;
        movedX = true;
      }
    }
    if (!movedY && scrolls.has(style.overflowY)) {
      const dy = edgeStep(y, box.top, box.bottom);
      if (dy < 0 ? el.scrollTop > 0 : dy > 0 && el.scrollTop < el.scrollHeight - el.clientHeight) {
        el.scrollTop += dy;
        movedY = true;
      }
    }
  }
  return movedX || movedY;
}

// Lets a finger drag `el` after holding it. While a finger is on it, a long press doesn't open the menu and the
// element isn't draggable the HTML way. Returns the cleanup.
export function holdToDrag(el: HTMLElement, handlers: HoldDrag): () => void {
  let from: { x: number; y: number } | null = null;
  let at = { x: 0, y: 0 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scroller: ReturnType<typeof setInterval> | undefined;
  let ghost: HTMLElement | null = null;
  let draggable = el.draggable;

  const follow = () => {
    if (ghost && from) ghost.style.transform = `translate(${at.x - from.x}px, ${at.y - from.y}px)`;
  };
  const pickUp = () => {
    timer = undefined;
    const box = el.getBoundingClientRect();
    ghost = el.cloneNode(true) as HTMLElement;
    // Its fade-in moves `transform`, which the ghost needs for following the finger.
    ghost.classList.remove("mw-fade-in");
    ghost.classList.add("mw-drag-ghost");
    Object.assign(ghost.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px` });
    document.body.append(ghost);
    ghost.animate([{ opacity: 0 }, { opacity: 1 }], { duration: motionMs(), easing: ease });
    follow();
    handlers.start();
    handlers.move(at.x, at.y);
    scroller = setInterval(() => edgeScroll(at.x, at.y) && handlers.move(at.x, at.y), scrollTickMs);
  };
  const finish = () => {
    clearTimeout(timer);
    clearInterval(scroller);
    timer = undefined;
    scroller = undefined;
    from = null;
    el.draggable = draggable;
    const lifted = ghost;
    ghost = null;
    if (!lifted) return;
    const gone = () => lifted.remove();
    lifted.animate([{ opacity: 1 }, { opacity: 0 }], { duration: motionMs(), easing: ease }).finished.then(gone, gone);
  };
  const cancel = () => {
    const dragging = !!ghost;
    finish();
    if (dragging) handlers.cancel();
  };

  const onStart = (e: TouchEvent) => {
    // A second finger makes it a pinch.
    if (e.touches.length !== 1) return void (from && cancel());
    const touch = e.touches[0];
    from = { x: touch.clientX, y: touch.clientY };
    at = { ...from };
    draggable = el.draggable;
    el.draggable = false;
    timer = setTimeout(pickUp, holdMs);
  };
  const onMove = (e: TouchEvent) => {
    if (!from) return;
    if (e.touches.length !== 1) return cancel();
    at = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    if (ghost) {
      e.preventDefault();
      follow();
      handlers.move(at.x, at.y);
    } else if (Math.hypot(at.x - from.x, at.y - from.y) > slopPx) finish();
  };
  const onEnd = (e: TouchEvent) => {
    if (!from) return;
    const dragging = !!ghost;
    finish();
    if (!dragging) return;
    // Keeps the lifted finger from clicking what is under it.
    e.preventDefault();
    handlers.drop(at.x, at.y);
  };
  const onCancel = () => from && cancel();
  const onMenu = (e: Event) => {
    if (!from) return;
    e.preventDefault();
    e.stopPropagation();
  };

  // ui/longPress.ts leaves presses here alone.
  el.dataset.holdDrag = "";
  el.addEventListener("touchstart", onStart, { passive: true });
  // Not passive, so it can stop the scroll once the element is picked up. Added now: browsers decide whether a touch
  // can scroll before a listener added during it would count.
  el.addEventListener("touchmove", onMove, { passive: false });
  el.addEventListener("touchend", onEnd);
  el.addEventListener("touchcancel", onCancel);
  el.addEventListener("contextmenu", onMenu);
  return () => {
    if (from) cancel();
    delete el.dataset.holdDrag;
    el.removeEventListener("touchstart", onStart);
    el.removeEventListener("touchmove", onMove);
    el.removeEventListener("touchend", onEnd);
    el.removeEventListener("touchcancel", onCancel);
    el.removeEventListener("contextmenu", onMenu);
  };
}
