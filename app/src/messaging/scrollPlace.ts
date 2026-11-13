// Where each message list was left, so coming back to a channel, thread or conversation keeps the place. This session
// only. A list opens at its newest message and stays there, also while older messages fill in above and images load,
// until the reader scrolls up themselves. From then on they are at a reading place (docs/glossary.md, ADR 0017): the
// message at the top of the view and where it was on screen. It is remembered once the list has settled (or when it is
// the place just brought back), and coming back puts that message where it was; a list left at the newest, or left
// before it settled, opens at the newest.
import { createEffect, on, untrack } from "solid-js";

// The message at the top of the view, by its `data-message-id`, and how far its top was below the view's top
// (negative when part of it was above).
interface ReadingPlace {
  id: string;
  offset: number;
}

// The reading place's message as drawn now, found again by its id when the list redrew it.
interface Anchor extends ReadingPlace {
  el: Element;
}

const places = new Map<string, ReadingPlace>();

// The message a list's remembered reading place is at, for its message window to show down to (messageWindow.ts).
export const rememberedPlace = (key: string): string | undefined => places.get(key)?.id;

// Within this many pixels of the end the list counts as being at the bottom.
const bottomThreshold = 80;
// A scroll this soon after the reader's input (or their last scroll, so a fling's glide counts) is theirs.
const inputMs = 300;
// Keys that scroll the list.
const scrollKeys = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
const inputs = ["wheel", "touchstart", "touchmove"];

// The scroll handling every message list shares (chat channels, threads and private-message conversations).
// Installed when the list mounts: places the first load (the newest, or the remembered reading place), follows the
// bottom while the reader is there, and holds a reading place through every growth: older messages filling in above,
// images arriving after their messages, and a kept view that keeps filling while hidden (the browser's own anchoring
// does not apply in a hidden subtree, nor at the very top of a list).
export interface ScrollPlaceAttach {
  // Per list: chat `server:channel[:thread]`, private messages `dm:<account>:<peer>`.
  key: string;
  scroller: HTMLElement;
  // The inner list the messages are drawn in, each message's element a child with a `data-message-id`. Its height
  // changes as older messages fill in and images load; the scroller's own size doesn't.
  content: HTMLElement;
  // Only act once the first messages are here.
  isReady: () => boolean;
  // Loaded and done filling in the background (messageWindow.ts); reactive. A reading place counts only from then
  // on, so the loading never makes one up. isReady by default.
  isSettled?: () => boolean;
  // Whether the view is shown; reactive. Omitted means always shown (a private-message list is never kept hidden).
  active?: () => boolean;
  // The reader scrolled up themselves (never the list's own scrolls): older messages may come now (messageWindow.ts).
  onReaderUp?: () => void;
}

export interface ScrollPlaceHandle {
  // Call when the message count or readiness changes: places the first load once, later sticks to new messages while
  // the reader is at the newest.
  onChange(): void;
  // Jumping to a specific message (a followed link, a pin): drops a restore that is due, runs the jump once the list
  // is on the page (a view is built off-page while the old one animates out, and scrolling does nothing there) and
  // takes the reading place from where it landed, or the newest when that is at the bottom.
  jump(action: () => void): void;
  dispose(): void;
}

export function installScrollPlace(attach: ScrollPlaceAttach): ScrollPlaceHandle {
  const { scroller, content } = attach;
  const awake = attach.active ?? (() => true);
  const settled = attach.isSettled ?? attach.isReady;
  let saved = places.get(attach.key);
  // Nothing placed yet: the first load (the newest, or the remembered place) is still due.
  let first = true;
  // At the newest the list sticks to the bottom. Otherwise the reader is at `anchor` (undefined only when a jump found
  // nothing to stand on), and every growth puts it back where it was on screen.
  let atNewest = true;
  let anchor: Anchor | undefined;
  // The anchor is the remembered place brought back, untouched since: remembered again even before the list settled.
  let restored = false;
  // The reader's input (see the handlers below): until when a scroll counts as theirs, when they last gave input
  // themselves (a wheel turn, a touch, a key, the scrollbar moving under a held button), and a scrollbar held down.
  let readerUntil = 0;
  let inputAt = -Infinity;
  let pressed = false;

  let waiting = 0;
  const whenOnPage = (action: () => void) => {
    cancelAnimationFrame(waiting);
    let frames = 0;
    const attempt = () => {
      if (scroller.isConnected && scroller.clientHeight > 0) action();
      else if (++frames < 120) waiting = requestAnimationFrame(attempt);
    };
    waiting = requestAnimationFrame(attempt);
  };

  // A smooth scroll doesn't run where nothing is drawn (`visibility: hidden`: a kept view on its way in).
  const drawn = () => scroller.checkVisibility?.({ visibilityProperty: true }) ?? true;

  // Never while the reader is scrolling: snapping to the bottom then undid a wheel turn up that hadn't yet gone the
  // bottom's 80 px (images loading, a new message), and on a slow machine the list felt stuck there. It waits until
  // `inputMs` after the reader's own last input, then sticks (gliding when a glide was asked for) if they are still at
  // the newest. Only their input counts: the list's own scrolls meanwhile (the browser's anchoring as images load
  // above) would put it off for as long as the list kept settling, and a scrollbar press whose release never came
  // (let go outside the window) for good.
  let afterInput: ReturnType<typeof setTimeout> | undefined;
  let glideAfterInput = false;
  const inputLive = () => performance.now() < inputAt + inputMs;
  const stickAfterInput = (smooth: boolean) => {
    glideAfterInput ||= smooth;
    clearTimeout(afterInput);
    afterInput = setTimeout(() => {
      if (inputLive()) return stickAfterInput(false);
      const glide = glideAfterInput;
      glideAfterInput = false;
      if (atNewest && awake()) stick(glide && drawn());
    }, Math.max(0, inputAt + inputMs - performance.now()) + 16);
  };
  const stick = (smooth: boolean) => whenOnPage(() => {
    if (!atNewest) return;
    if (inputLive()) return stickAfterInput(smooth);
    readerUntil = 0; // the list's own scroll, though the reader's scroll was a moment ago
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  });

  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < bottomThreshold;

  const idOf = (el: Element) => el.getAttribute("data-message-id");

  const find = (id: string) => {
    for (const child of content.children) if (idOf(child) === id) return child;
  };

  // The message at the top of the view: the first whose bottom is below the view's top. Walks from the last one found
  // (a scroll moves it only a little), so a long list isn't measured whole on every scroll.
  const anchorAt = (): Anchor | undefined => {
    const top = scroller.getBoundingClientRect().top;
    let el: Element | null = anchor?.el.parentElement === content ? anchor.el : content.firstElementChild;
    while (el?.previousElementSibling && el.previousElementSibling.getBoundingClientRect().bottom > top) el = el.previousElementSibling;
    while (el && (el.getBoundingClientRect().bottom <= top || idOf(el) === null)) el = el.nextElementSibling;
    return el ? { el, id: idOf(el)!, offset: el.getBoundingClientRect().top - top } : undefined;
  };

  // Puts the reading place's message back where it was on screen. Adds nothing when it is there already (the browser
  // anchored it), so the reader never moves twice. Less than a pixel off counts as there: at fractional display
  // scaling the measured offsets differ by fractions, and every write to scrollTop stops the wheel's smooth scroll.
  const pin = () => {
    if (!anchor) return;
    if (anchor.el.parentElement !== content) {
      const el = find(anchor.id);
      if (!el) return void (anchor = anchorAt());
      anchor.el = el;
    }
    const offset = anchor.el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    if (Math.abs(offset - anchor.offset) >= 1) scroller.scrollTop += offset - anchor.offset;
  };

  // The newest, or the remembered reading place when its message is still there.
  const placeFirst = () => whenOnPage(() => {
    if (!first) return;
    first = false;
    const place = saved;
    saved = undefined;
    const el = place && find(place.id);
    if (!place || !el) return scroller.scrollTo({ top: scroller.scrollHeight, behavior: "auto" });
    atNewest = false;
    anchor = { ...place, el };
    restored = true;
    pin();
  });

  const onChange = () => {
    if (!awake()) return; // a first load that was due while hidden is placed when the view shows
    if (!attach.isReady()) return;
    if (first) return placeFirst();
    if (atNewest) stick(drawn());
  };

  // Only the reader moves their place: a scroll the list made itself (following the bottom while older messages fill
  // in above, the browser's anchoring, a pin, a placement) may measure short of the bottom mid-way, and its event can
  // arrive a frame late, after more messages came in above; it is never the reader leaving the newest or a new place.
  // Keys count from anywhere on the page (they scroll the list last clicked in while the page itself has the focus),
  // except where they move a caret. A scrollbar drag can end without a pointerup: a move with no button held ends it.
  const view = scroller.ownerDocument?.defaultView;
  const input = () => {
    inputAt = performance.now();
    readerUntil = inputAt + inputMs;
  };
  const release = () => {
    if (!pressed) return;
    pressed = false;
    view?.removeEventListener("pointermove", moved);
    input();
  };
  const moved = (e: Event) => (e as PointerEvent).buttons === 0 && release();
  const press = () => {
    pressed = true;
    view?.addEventListener("pointermove", moved, { passive: true });
    input();
  };
  const key = (e: Event) => {
    const target = e.target as HTMLElement | null;
    const typing = !!target && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA");
    if (!typing && scrollKeys.has((e as KeyboardEvent).key)) input();
  };
  // Where the last scroll left the list, the list's own included: a reader's scroll above it went up.
  let lastTop = scroller.scrollTop;
  const onScroll = () => {
    const up = scroller.scrollTop < lastTop;
    lastTop = scroller.scrollTop;
    if (!pressed && performance.now() >= readerUntil) return;
    // A scroll under a held scrollbar is the reader moving it; any other keeps counting as theirs (a fling's glide)
    // without being new input of theirs.
    if (pressed) input();
    else readerUntil = performance.now() + inputMs;
    if (up) attach.onReaderUp?.();
    if (first) return;
    // Within reach of the bottom is the newest. Going up past it leaves the newest; going down short of it doesn't
    // (the list grew below meanwhile, and sticks once the reader's input ends). The list's own scrolls during the
    // reader's input (the browser's anchoring as older messages come in above, a pin) keep the distance to the bottom,
    // so they never cross it.
    if (nearBottom()) {
      atNewest = true;
      anchor = undefined;
      return;
    }
    if (!up && atNewest) return;
    atNewest = false;
    restored = false;
    anchor = anchorAt() ?? anchor;
  };
  scroller.addEventListener("scroll", onScroll, { passive: true });
  for (const type of inputs) scroller.addEventListener(type, input, { passive: true });
  scroller.addEventListener("pointerdown", press);
  view?.addEventListener("keydown", key);
  view?.addEventListener("pointerup", release);
  view?.addEventListener("pointercancel", release);
  view?.addEventListener("blur", release);

  // The inner list changes size as older messages fill in and images arrive after their messages: back to the bottom
  // when the reader is at the newest (not while hidden; showing the view does it), else hold their place.
  const observer = new ResizeObserver(() => {
    if (first || !attach.isReady()) return;
    if (!atNewest) pin();
    else if (awake()) stick(false);
  });
  observer.observe(content);

  // Shown again: place the first load that was due meanwhile, return to the bottom, or keep the reading place.
  createEffect(on(awake, (shown) => {
    if (!shown) return;
    if (first) return onChange();
    if (atNewest) stick(false);
    else pin();
  }, { defer: true }));

  return {
    onChange,
    jump(action) {
      saved = undefined;
      first = false;
      atNewest = false;
      anchor = undefined;
      restored = false;
      clearTimeout(afterInput);
      glideAfterInput = false;
      whenOnPage(() => {
        action();
        atNewest = nearBottom();
        anchor = atNewest ? undefined : anchorAt();
      });
    },
    dispose() {
      cancelAnimationFrame(waiting);
      clearTimeout(afterInput);
      scroller.removeEventListener("scroll", onScroll);
      for (const type of inputs) scroller.removeEventListener(type, input);
      scroller.removeEventListener("pointerdown", press);
      view?.removeEventListener("keydown", key);
      view?.removeEventListener("pointerup", release);
      view?.removeEventListener("pointercancel", release);
      view?.removeEventListener("blur", release);
      view?.removeEventListener("pointermove", moved);
      observer.disconnect();
      if (first) return; // nothing placed yet: a remembered place waits as it was
      if (!atNewest && anchor && (restored || untrack(settled))) places.set(attach.key, { id: anchor.id, offset: anchor.offset });
      else places.delete(attach.key);
    },
  };
}
