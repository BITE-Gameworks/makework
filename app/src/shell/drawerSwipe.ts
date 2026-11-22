// Where a swipe that opens the narrow layout's drawer (the workspace and channel lists) may start: at the screen's
// left edge, or anywhere on the shown view unless what is under the finger takes sideways drags itself. The edge
// alone isn't enough: with Android's gesture navigation it belongs to the system's Back.
export const edgePx = 24;
// How far a finger travels sideways before the swipe opens or closes the drawer.
export const swipePx = 60;

const fields = "input, textarea, select";
const sidewaysPans = new Set(["auto", "manipulation", "pan-x", "pan-left", "pan-right"]);
const scrolls = new Set(["auto", "scroll"]);

// Whether the browser may pan sideways under this computed `touch-action`. Where it may not (`none`, `pan-y`), the
// page handles sideways drags itself: a canvas, a slider.
export const pansSideways = (touchAction: string): boolean => touchAction.split(/\s+/).some((value) => sidewaysPans.has(value));

function takesSidewaysDrags(target: Element, view: Element): boolean {
  if (target.closest(fields) || (target as HTMLElement).isContentEditable) return true;
  for (let el: Element | null = target; el && el !== view; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (!pansSideways(style.touchAction)) return true;
    if (el.scrollWidth > el.clientWidth && scrolls.has(style.overflowX)) return true;
  }
  return false;
}

export function opensDrawer(target: EventTarget | null, x: number): boolean {
  if (x <= edgePx) return true;
  const view = target instanceof Element ? target.closest(".main-view") : null;
  return !!view && !takesSidewaysDrags(target as Element, view);
}
