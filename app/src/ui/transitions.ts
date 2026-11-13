// Enter/exit animations for solid-transition-group, done with the Web Animations API.
import { motionMs } from "./presence";

const ease = "cubic-bezier(0.2, 0, 0, 1)";

// Slides running now, and who waits for them to be over (afterSlides).
let running = 0;
let waiting: (() => void)[] = [];

function run(el: Element, keyframes: Keyframe[], duration: number, done: () => void) {
  running++;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    running--;
    done();
    // Out-in: the slide in starts a microtask after the slide out ended, so the slides are over only if none started
    // by the next task.
    if (running === 0) setTimeout(() => {
      if (running > 0) return;
      const now = waiting;
      waiting = [];
      now.forEach((resolve) => resolve());
    }, 0);
  };
  if (duration === 0) return end();
  el.animate(keyframes, { duration, easing: ease }).finished.then(end, end);
}

// Resolves once no view is sliding in or out, at once when none is. A view's first data waits for it
// (plugins/live.ts): rendered mid-slide, a big channel's content took the slide's frames (mesh-test s15).
export function afterSlides(): Promise<void> {
  return running === 0 ? Promise.resolve() : new Promise((resolve) => waiting.push(resolve));
}

// A view is sliding in or out now (a long list's fill waits, ui/progressive.ts).
export function sliding(): boolean {
  return running > 0;
}

export type Slide = (el: Element, done: () => void) => void;

// direction: 1 slides content up (moving down a list), -1 slides it down, 0 only fades.
export function slideEnter(direction: () => number): Slide {
  return (el, done) =>
    run(el, [{ opacity: 0, transform: `translateY(${direction() * 14}px)` }, { opacity: 1, transform: "none" }], motionMs(), done);
}

export function slideExit(direction: () => number): Slide {
  return (el, done) =>
    run(el, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateY(${direction() * -14}px)` }], motionMs() * 0.6, done);
}

// The in-flow layer's enter/exit (messages, the empty state, a channel type that opted out): a view arriving while
// a kept view is still sliding out stays hidden until that slide is over, so the swap reads out-in; a view
// replaced before it ever showed has nothing to slide out of.
export function waitingSlides(direction: () => number): { enter: Slide; exit: Slide } {
  const waitingToShow = new WeakSet<Element>();
  return {
    enter(el, done) {
      waitingToShow.add(el);
      (el as HTMLElement).style.visibility = "hidden";
      void afterSlides().then(() => {
        if (!waitingToShow.delete(el)) return;
        (el as HTMLElement).style.visibility = "";
        slideEnter(direction)(el, done);
      });
    },
    exit(el, done) {
      if (waitingToShow.delete(el)) return done();
      slideExit(direction)(el, done);
    },
  };
}

export interface ViewSwapHooks {
  enter: Slide;
  exit: Slide;
  // Make a view visible / withdraw it. A withdrawn kept view keeps its state but isn't laid out (shell.css
  // .kept-view.hidden), except one holding a webview.
  show(el: Element): void;
  hide(el: Element): void;
}

export interface ViewSwap {
  // The view that should be shown (undefined: none). The view shown now slides out first, then this one is shown
  // and slides in. A call while a slide is running is coalesced: the last view asked for is the one that ends up
  // shown, and a view that never showed is dropped without a slide out.
  to(el: Element | undefined): void;
  // The element's wrapper unmounted: forget it, so it can neither block the next view nor be entered.
  dropped(el: Element): void;
}

// The kept layer's out-in swap. Kept views stay in the DOM (hidden), so the change cannot be a
// solid-transition-group Transition over unmounting children; this runs the same slides through the same helpers,
// which keeps `afterSlides` gating a view's first data.
export function createViewSwap(hooks: ViewSwapHooks): ViewSwap {
  let requested: Element | undefined;
  let current: Element | undefined;
  let next: Element | undefined;
  let entering: Element | undefined;
  let exiting = false;
  let presented = false;

  const enterNext = () => {
    const el = next;
    if (!el) return;
    next = undefined;
    current = el;
    if (!presented) {
      presented = true;
      // Like a Transition without `appear`: the view a window starts with shows at once, unless it arrives while
      // another view (an in-flow one) is still sliding out.
      if (running === 0) {
        hooks.show(el);
        return;
      }
    }
    entering = el;
    void afterSlides().then(() => {
      if (entering !== el || !el.isConnected) return;
      entering = undefined;
      hooks.show(el);
      hooks.enter(el, () => {});
    });
  };

  const exitCurrent = () => {
    const el = current!;
    exiting = true;
    hooks.exit(el, () => {
      exiting = false;
      hooks.hide(el);
      current = undefined;
      enterNext();
    });
  };

  return {
    to(el) {
      if (el === requested) return;
      requested = el;
      next = el;
      if (el && el !== current) hooks.hide(el);
      if (exiting) return;
      if (current?.isConnected) {
        if (el === current) return;
        if (entering) {
          // Still waiting for its slide and already replaced: it never showed, so there is nothing to slide out.
          entering = undefined;
          hooks.hide(current);
        } else return exitCurrent();
      }
      current = undefined;
      enterNext();
    },
    dropped(el) {
      if (next === el) next = undefined;
      if (entering === el) entering = undefined;
      if (current === el && !exiting) {
        current = undefined;
        enterNext();
      }
    },
  };
}
