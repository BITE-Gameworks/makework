import { describe, expect, it, vi } from "vitest";
import { createRoot, createSignal, type Accessor } from "solid-js";
import { installScrollPlace, rememberedPlace, type ScrollPlaceHandle } from "../../src/messaging/scrollPlace";

// A kept view is hidden (`visibility`, so it still has a layout) while its list keeps filling with older messages
// above the reader. The browser's own anchoring doesn't apply there, so scrollPlace holds the place itself.
// The fakes below are the little of the DOM it touches: a scroller, its content, cards, rects and scroll events.

let grow!: () => void;

class TestResizeObserver {
  constructor(cb: () => void) { grow = cb; }
  observe() {}
  disconnect() {}
}
globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
globalThis.requestAnimationFrame = ((fn: FrameRequestCallback) => (fn(0), 0)) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;

const rect = (top: number, height: number) =>
  ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

class TestWindow {
  private listeners = new Map<string, Set<(e: object) => void>>();
  addEventListener(type: string, listener: (e: object) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (e: object) => void) { this.listeners.get(type)?.delete(listener); }
  dispatch(type: string, event: object = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class TestScroller {
  isConnected = true;
  ownerDocument = { defaultView: new TestWindow() };
  clientHeight = 400;
  scrollHeight = 0;
  // `visibility: hidden` (a kept view that isn't shown): there is a layout, but nothing is drawn.
  visible = true;
  scrolls: { top: number; behavior: string }[] = [];
  private listeners = new Map<string, Set<() => void>>();
  private value = 0;

  get scrollTop() { return this.value; }
  // Like a browser: kept within the content, and a scroll event when it moved.
  set scrollTop(value: number) {
    const next = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
    if (next === this.value) return;
    this.value = next;
    this.dispatch("scroll");
  }
  addEventListener(type: string, listener: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: () => void) { this.listeners.get(type)?.delete(listener); }
  dispatch(type: string, event: object = {}) {
    for (const listener of this.listeners.get(type) ?? []) (listener as (e: object) => void)(event);
  }
  getBoundingClientRect() { return rect(0, this.clientHeight); }
  checkVisibility() { return this.visible; }
  scrollTo(options: { top: number; behavior?: string }) {
    this.scrolls.push({ top: options.top, behavior: options.behavior ?? "auto" });
    this.scrollTop = options.top;
  }
  querySelector() { return null; }
}

class TestCard {
  isConnected = true;
  constructor(private scroller: TestScroller, private list: TestContent, public top: number, public id: number, public height = 60) {}
  getBoundingClientRect() { return rect(this.top - this.scroller.scrollTop, this.height); }
  getAttribute(name: string) { return name === "data-message-id" ? String(this.id) : null; }
  get previousElementSibling() { return this.list.children[this.list.children.indexOf(this) - 1] ?? null; }
  get nextElementSibling() { return this.list.children[this.list.children.indexOf(this) + 1] ?? null; }
  get parentElement() { return this.list; }
}

class TestContent {
  isConnected = true;
  children: TestCard[] = [];
  constructor(private scroller: TestScroller) {}
  get firstElementChild() { return this.children[0] ?? null; }
  getBoundingClientRect() { return rect(-this.scroller.scrollTop, this.scroller.scrollHeight); }
}

// A list of cards, 60 px each, message ids 1000 and up; the scroller shows 400 px of it. Older messages (lower ids)
// are added above.
function makeList(count = 20) {
  const scroller = new TestScroller();
  const content = new TestContent(scroller);
  for (let i = 0; i < count; i++) content.children.push(new TestCard(scroller, content, i * 60, 1000 + i));
  scroller.scrollHeight = count * 60;
  let oldest = 1000;
  const insertOlder = (n: number) => {
    for (const card of content.children) card.top += n * 60;
    oldest -= n;
    content.children.unshift(...Array.from({ length: n }, (_, i) => new TestCard(scroller, content, i * 60, oldest + i)));
    scroller.scrollHeight += n * 60;
  };
  let newest = 1000 + count - 1;
  const addNewer = (height = 60) => {
    content.children.push(new TestCard(scroller, content, scroller.scrollHeight, ++newest, height));
    scroller.scrollHeight += height;
  };
  // The reader scrolls there themselves (a mouse wheel), unlike the list's own scrolls.
  const read = (top: number) => {
    scroller.dispatch("wheel");
    scroller.scrollTop = top;
  };
  const card = (id: number) => content.children.find((c) => c.id === id)!;
  const atBottom = () => scroller.scrollTop === scroller.scrollHeight - scroller.clientHeight;
  return { scroller, content, insertOlder, addNewer, read, card, atBottom };
}

type List = ReturnType<typeof makeList>;

function install(key: string, list: List, active?: Accessor<boolean>, onReaderUp?: () => void) {
  let place!: ScrollPlaceHandle;
  let disposeRoot!: () => void;
  createRoot((dispose) => {
    disposeRoot = dispose;
    place = installScrollPlace({
      key, scroller: list.scroller as unknown as HTMLElement, content: list.content as unknown as HTMLElement,
      isReady: () => true, active, onReaderUp,
    });
  });
  return { place, disposeRoot };
}

// Where a card is on screen, in the scroller's coordinates.
const screenTop = (card: TestCard) => card.getBoundingClientRect().top;

// A clock for the reader's input window (300 ms after their last input or scroll): a stick waits for it to end.
function fakeClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let now = 1000;
  const spy = vi.spyOn(performance, "now").mockImplementation(() => now);
  return {
    advance(ms: number) {
      now += ms;
      vi.advanceTimersByTime(ms);
    },
    restore() {
      spy.mockRestore();
      vi.useRealTimers();
    },
  };
}

describe("a kept view's scroll place while it is hidden", () => {
  it("holds the reader's place while the hidden list fills, and keeps it when the view shows", () => {
    const [active, setActive] = createSignal(true);
    const list = makeList(20);
    const { place, disposeRoot } = install("chat:hold", list, active);
    place.onChange(); // first open: at the bottom
    expect(list.atBottom()).toBe(true);
    list.read(500); // the reader scrolls up into history
    const anchor = list.content.children.find((card) => card.getBoundingClientRect().bottom > 0)!;
    const anchorTop = screenTop(anchor);

    setActive(false); // leave the channel: the view stays, hidden
    list.insertOlder(5); // the hidden list keeps filling (300 px above)
    expect(list.scroller.scrollTop).toBe(500); // nothing has moved it yet
    grow(); // the list changed size
    expect(list.scroller.scrollTop).toBe(800); // the place was pinned
    setActive(true);
    expect(list.scroller.scrollTop).toBe(800);
    expect(screenTop(anchor)).toBe(anchorTop);
    disposeRoot();
  });

  it("adds nothing when something else already kept the place", () => {
    const [active, setActive] = createSignal(true);
    const list = makeList(20);
    const { place, disposeRoot } = install("chat:kept", list, active);
    place.onChange();
    list.read(500);
    setActive(false);
    list.insertOlder(5);
    list.scroller.scrollTop = 800; // as if the browser had anchored it
    grow();
    expect(list.scroller.scrollTop).toBe(800);
    setActive(true);
    expect(list.scroller.scrollTop).toBe(800);
    disposeRoot();
  });

  it("returns to the bottom when the reader was there, without scrolling while hidden", () => {
    const [active, setActive] = createSignal(true);
    const list = makeList(20);
    const { place, disposeRoot } = install("chat:bottom", list, active);
    place.onChange();
    setActive(false);
    list.insertOlder(5);
    grow();
    expect(list.scroller.scrolls).toEqual([{ top: 1200, behavior: "auto" }]); // only the first stick
    setActive(true);
    expect(list.atBottom()).toBe(true);
    expect(list.scroller.scrolls.at(-1)).toEqual({ top: 1500, behavior: "auto" });
    disposeRoot();
  });

  it("places a first load that was due while hidden once the view shows", () => {
    const [active, setActive] = createSignal(false);
    const list = makeList(20);
    const { place, disposeRoot } = install("chat:first-hidden", list, active);
    place.onChange(); // the messages arrived while hidden
    expect(list.scroller.scrolls).toEqual([]);
    setActive(true);
    expect(list.atBottom()).toBe(true);
    disposeRoot();
  });

  it("restores a saved history place on show", () => {
    const first = makeList(20);
    const before = install("chat:saved", first, () => true);
    before.place.onChange();
    first.read(500);
    before.place.dispose();
    before.disposeRoot();

    const [active, setActive] = createSignal(false);
    const list = makeList(20);
    const { place, disposeRoot } = install("chat:saved", list, active);
    place.onChange(); // hidden: nothing happens yet
    expect(list.scroller.scrollTop).toBe(0);
    setActive(true);
    expect(list.scroller.scrollTop).toBe(500);
    disposeRoot();
  });

  it("does not fight a jump taken while hidden", () => {
    const [active, setActive] = createSignal(true);
    const list = makeList(20);
    const { place, disposeRoot } = install("chat:jump", list, active);
    place.onChange();
    list.read(500);
    setActive(false);
    place.jump(() => {}); // a jump that found its message already in view
    list.insertOlder(5);
    grow();
    setActive(true);
    expect(list.card(1008).getBoundingClientRect().top).toBe(-20); // where the jump left the reader
    disposeRoot();
  });

  it("remembers the held place when a hidden view is dropped", () => {
    const [active, setActive] = createSignal(true);
    const list = makeList(20);
    const first = install("chat:dropped", list, active);
    first.place.onChange();
    list.read(500); // message 1008 at the top, 20 px of it above the view
    setActive(false);
    list.insertOlder(5);
    grow();
    first.place.dispose(); // the view is let go while hidden
    first.disposeRoot();

    const again = makeList(20);
    const second = install("chat:dropped", again, () => true);
    second.place.onChange();
    expect(again.card(1008).getBoundingClientRect().top).toBe(-20);
    second.disposeRoot();
  });

  it("keeps sticking to the bottom while the view is shown", () => {
    const list = makeList(20);
    const { place, disposeRoot } = install("chat:visible", list, () => true);
    place.onChange();
    list.insertOlder(5);
    grow();
    expect(list.scroller.scrolls.at(-1)).toEqual({ top: 1500, behavior: "auto" });
    disposeRoot();
  });

  it("behaves as before when no active accessor is given (private messages)", () => {
    const list = makeList(20);
    const { place, disposeRoot } = install("dm:1", list);
    place.onChange();
    list.insertOlder(5);
    grow();
    expect(list.atBottom()).toBe(true);
    disposeRoot();
  });
});

describe("a message list at its newest message", () => {
  // The list grows above the reader a step per frame while older messages fill in. A scroll the list caused itself
  // (catching up with the bottom, the browser's anchoring) is not the reader leaving the newest.
  it("stays at the newest through the fill, whatever the list's own scrolls measured", () => {
    const list = makeList(20);
    const { place, disposeRoot } = install("chat:fill", list);
    place.onChange();
    expect(list.atBottom()).toBe(true);
    list.insertOlder(5);
    list.scroller.scrollTop = 900; // caught mid-way: 200 px above the bottom
    grow();
    expect(list.atBottom()).toBe(true);
    list.insertOlder(5);
    grow();
    expect(list.atBottom()).toBe(true);
    expect(list.scroller.scrolls.at(-1)?.behavior).toBe("auto"); // the fill is followed at once, not chased smoothly
    disposeRoot();
  });

  it("glides to a new message, and goes at once where a glide wouldn't run (a hidden kept view on its way in)", () => {
    const list = makeList(20);
    const { place, disposeRoot } = install("chat:new", list);
    place.onChange();
    list.addNewer();
    place.onChange();
    expect(list.scroller.scrolls.at(-1)).toEqual({ top: 1260, behavior: "smooth" });
    list.scroller.visible = false;
    list.addNewer();
    place.onChange();
    expect(list.scroller.scrolls.at(-1)).toEqual({ top: 1320, behavior: "auto" });
    expect(list.atBottom()).toBe(true);
    disposeRoot();
  });
});

describe("a reading place", () => {
  // Coming back, the list is built again: more or fewer older messages above, images not loaded yet. The place is
  // the message the reader looked at, not a distance in pixels.
  it("brings back the message the reader was looking at, where it was on screen", () => {
    const before = makeList(20);
    const first = install("chat:message", before);
    first.place.onChange();
    before.read(500); // message 1008 is at the top, 20 px of it above the view
    first.place.dispose();
    first.disposeRoot();

    const after = makeList(20);
    after.insertOlder(5); // five more older messages are shown this time
    expect(rememberedPlace("chat:message")).toBe("1008"); // the message window shows down to it
    const second = install("chat:message", after);
    second.place.onChange();
    expect(after.card(1008).getBoundingClientRect().top).toBe(-20);
    second.disposeRoot();
  });

  // At the very top the browser doesn't anchor: older messages coming in above would push the reader to them.
  it("holds the reader's message while older ones come in above, also at the very top", () => {
    const list = makeList(20);
    const { place, disposeRoot } = install("chat:top", list);
    place.onChange();
    list.read(0);
    list.insertOlder(5);
    grow();
    expect(list.card(1000).getBoundingClientRect().top).toBe(0);
    disposeRoot();
  });

  it("is forgotten when the reader scrolls back to the newest", () => {
    const before = makeList(20);
    const first = install("chat:back", before);
    first.place.onChange();
    before.read(300);
    before.read(790); // within the bottom's reach
    first.place.dispose();
    first.disposeRoot();

    const after = makeList(20);
    expect(rememberedPlace("chat:back")).toBeUndefined();
    const second = install("chat:back", after);
    second.place.onChange();
    expect(after.atBottom()).toBe(true);
    second.disposeRoot();
  });

  it("is not remembered when the reader left before the list settled", () => {
    const [settled] = createSignal(false);
    const before = makeList(20);
    let first!: ScrollPlaceHandle;
    const disposeFirst = createRoot((dispose) => {
      first = installScrollPlace({
        key: "chat:unsettled", scroller: before.scroller as unknown as HTMLElement,
        content: before.content as unknown as HTMLElement, isReady: () => true, isSettled: settled,
      });
      return dispose;
    });
    first.onChange();
    before.read(300);
    first.dispose();
    disposeFirst();

    const after = makeList(20);
    const second = install("chat:unsettled", after);
    second.place.onChange();
    expect(after.atBottom()).toBe(true);
    second.disposeRoot();
  });

  it("is remembered once the list settled, though the reader scrolled up before", () => {
    const [settled, setSettled] = createSignal(false);
    const before = makeList(20);
    let first!: ScrollPlaceHandle;
    const disposeFirst = createRoot((dispose) => {
      first = installScrollPlace({
        key: "chat:settles", scroller: before.scroller as unknown as HTMLElement,
        content: before.content as unknown as HTMLElement, isReady: () => true, isSettled: settled,
      });
      return dispose;
    });
    first.onChange();
    before.read(500);
    setSettled(true);
    first.dispose();
    disposeFirst();

    const after = makeList(20);
    const second = install("chat:settles", after);
    second.place.onChange();
    expect(after.card(1008).getBoundingClientRect().top).toBe(-20);
    second.disposeRoot();
  });

  it("opens at the newest when its message is gone", () => {
    const before = makeList(20);
    const first = install("chat:gone", before);
    first.place.onChange();
    before.read(500);
    first.place.dispose();
    first.disposeRoot();

    const after = makeList(20);
    after.content.children.splice(8, 1); // message 1008 was deleted meanwhile
    after.scroller.scrollHeight -= 60;
    const second = install("chat:gone", after);
    second.place.onChange();
    expect(after.atBottom()).toBe(true);
    second.disposeRoot();
  });

  it("counts a scrollbar held down however long it is held", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    const list = makeList(20);
    const { place, disposeRoot } = install("chat:scrollbar", list);
    place.onChange();
    list.scroller.dispatch("pointerdown");
    now.mockReturnValue(5000); // held still for a while, then dragged
    list.scroller.scrollTop = 400;
    list.insertOlder(5);
    grow();
    expect(list.scroller.scrollTop).toBe(700);
    now.mockRestore();
    disposeRoot();
  });

  // A followed link or pin: the list shows the message wherever it is, and nothing pulls the reader away from it.
  it("keeps a jump to a message through the growth that follows it", () => {
    const list = makeList(20);
    const { place, disposeRoot } = install("chat:jumped", list);
    place.onChange();
    place.jump(() => (list.scroller.scrollTop = 240)); // message 1004 at the top
    list.insertOlder(5);
    grow();
    expect(list.card(1004).getBoundingClientRect().top).toBe(0);
    disposeRoot();
  });

  it("follows the newest after a jump to a message that is already at the bottom", () => {
    const list = makeList(20);
    const { place, disposeRoot } = install("chat:jump-bottom", list);
    place.onChange();
    place.jump(() => {}); // the message was already in view: nothing scrolled
    list.addNewer();
    place.onChange();
    expect(list.atBottom()).toBe(true);
    disposeRoot();
  });

  // Coming back to a place and leaving again while older messages still fill in.
  it("keeps a place it brought back when the reader leaves again before the list settled", () => {
    const before = makeList(20);
    const first = install("chat:again", before);
    first.place.onChange();
    before.read(500);
    first.place.dispose();
    first.disposeRoot();

    const [settled] = createSignal(false);
    const again = makeList(20);
    let second!: ScrollPlaceHandle;
    const disposeSecond = createRoot((dispose) => {
      second = installScrollPlace({
        key: "chat:again", scroller: again.scroller as unknown as HTMLElement,
        content: again.content as unknown as HTMLElement, isReady: () => true, isSettled: settled,
      });
      return dispose;
    });
    second.onChange();
    second.dispose();
    disposeSecond();

    const third = makeList(20);
    const last = install("chat:again", third);
    last.place.onChange();
    expect(third.card(1008).getBoundingClientRect().top).toBe(-20);
    last.disposeRoot();
  });

  // The reader wheels at the bottom and a tall message arrives right away: the wheel's next frames go down but stay
  // short of the new bottom.
  it("stays at the newest through scrolls down short of a bottom that just moved, and sticks once input ends", () => {
    const clock = fakeClock();
    const list = makeList(20);
    const { place, disposeRoot } = install("chat:glide", list);
    try {
      place.onChange();
      list.read(790);
      list.addNewer(300);
      place.onChange(); // waits: the reader's input is still going on
      list.scroller.scrollTop = 950; // their wheel, 150 px above the new bottom
      list.addNewer();
      grow();
      clock.advance(400);
      expect(list.atBottom()).toBe(true);
    } finally {
      clock.restore();
      disposeRoot();
    }
  });

  // Keys scroll the list the reader last clicked in even while the focus is on the page itself.
  it("counts scroll keys pressed anywhere on the page, but not typing", () => {
    const list = makeList(20);
    const { place, disposeRoot } = install("chat:page-keys", list);
    place.onChange();
    const page = list.scroller.ownerDocument.defaultView;
    page.dispatch("keydown", { key: "ArrowUp", target: { isContentEditable: true } }); // moving a caret
    list.scroller.scrollTop = 600;
    list.insertOlder(5);
    grow();
    expect(list.atBottom()).toBe(true);
    page.dispatch("keydown", { key: "PageUp", target: {} });
    list.scroller.scrollTop = 400;
    list.insertOlder(5);
    grow();
    expect(list.scroller.scrollTop).toBe(700);
    disposeRoot();
  });

  // A scrollbar drag can end without a pointerup; the next move with no button held ends it.
  it("lets go of a scrollbar press once the pointer moves with no button held", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    const list = makeList(20);
    const { place, disposeRoot } = install("chat:released", list);
    place.onChange();
    list.scroller.dispatch("pointerdown");
    list.scroller.ownerDocument.defaultView.dispatch("pointermove", { buttons: 0 });
    now.mockReturnValue(5000);
    list.insertOlder(5);
    list.scroller.scrollTop = 900; // the list's own scroll, long after
    grow();
    expect(list.atBottom()).toBe(true);
    now.mockRestore();
    disposeRoot();
  });

  // The browser sends the scroll event of a placement in the next frame, by when the fill may have added older
  // messages above: that late event is the list's own and must not move the place.
  it("keeps a brought-back place when the placement's scroll event arrives after older messages came in", () => {
    const before = makeList(20);
    const first = install("chat:late", before);
    first.place.onChange();
    before.read(500);
    first.place.dispose();
    first.disposeRoot();

    const after = makeList(20);
    const second = install("chat:late", after);
    second.place.onChange();
    after.insertOlder(5);
    after.scroller.dispatch("scroll");
    grow();
    expect(after.card(1008).getBoundingClientRect().top).toBe(-20);
    second.disposeRoot();
  });
});

// On a slow machine (a laptop on battery) the list grows while the reader is still scrolling: a stick then undid their
// scroll, and the list felt stuck at the bottom. It waits for their input to end.
describe("the list growing while the reader scrolls", () => {
  it("doesn't pull a reader scrolling up back to the bottom", () => {
    const clock = fakeClock();
    const list = makeList(20);
    const { place, disposeRoot } = install("chat:wheel-up", list);
    try {
      place.onChange();
      list.read(780); // the wheel's first frames, still within the bottom's 80 px
      list.addNewer(); // an image or a message arrives
      place.onChange();
      grow();
      expect(list.scroller.scrollTop).toBe(780);
      list.read(600); // on up, out of the bottom's reach
      clock.advance(400);
      expect(list.scroller.scrollTop).toBe(600);
    } finally {
      clock.restore();
      disposeRoot();
    }
  });

  it("sticks once the reader's input ends within reach of the bottom", () => {
    const clock = fakeClock();
    const list = makeList(20);
    const { place, disposeRoot } = install("chat:within", list);
    try {
      place.onChange();
      list.read(780);
      list.addNewer();
      place.onChange();
      expect(list.scroller.scrollTop).toBe(780);
      clock.advance(400);
      expect(list.atBottom()).toBe(true);
    } finally {
      clock.restore();
      disposeRoot();
    }
  });

  // Older messages coming in above as the reader scrolls up: the browser keeps their place by scrolling down by the
  // height that came in. The distance to the bottom stays the same, so that scroll is never the reader reaching it.
  it("doesn't take the browser's anchoring during the reader's scroll for the reader reaching the newest", () => {
    const clock = fakeClock();
    const list = makeList(20);
    const { place, disposeRoot } = install("chat:anchoring", list);
    try {
      place.onChange();
      list.read(780);
      list.insertOlder(5);
      list.scroller.scrollTop = 1080; // the browser's anchoring: 300 px came in above
      list.read(900); // the reader goes on up, out of the bottom's reach
      list.addNewer(); // an image below
      grow();
      clock.advance(400);
      expect(list.scroller.scrollTop).toBe(900);
    } finally {
      clock.restore();
      disposeRoot();
    }
  });

  it("waits with a stick that was due when the reader started scrolling", () => {
    const clock = fakeClock();
    const frames: FrameRequestCallback[] = [];
    const run = globalThis.requestAnimationFrame;
    const list = makeList(20);
    const { place, disposeRoot } = install("chat:due", list);
    try {
      place.onChange();
      globalThis.requestAnimationFrame = ((fn: FrameRequestCallback) => (frames.push(fn), 1)) as typeof requestAnimationFrame;
      list.addNewer();
      grow(); // a stick for the next frame
      list.scroller.dispatch("wheel");
      frames.splice(0).forEach((fn) => fn(0));
      expect(list.scroller.scrollTop).toBe(800);
      clock.advance(400);
      frames.splice(0).forEach((fn) => fn(0));
      expect(list.atBottom()).toBe(true);
    } finally {
      globalThis.requestAnimationFrame = run;
      clock.restore();
      disposeRoot();
    }
  });

  // Only the reader's own input puts a stick off: the list's own scrolls meanwhile (the browser's anchoring as images
  // load above) would keep putting it off while the list settles.
  it("sticks once the reader's own input ended, though the list kept adjusting itself", () => {
    const clock = fakeClock();
    const list = makeList(20);
    const { place, disposeRoot } = install("chat:settling", list);
    try {
      place.onChange();
      list.read(790);
      list.addNewer();
      place.onChange();
      clock.advance(200);
      list.insertOlder(5);
      list.scroller.scrollTop += 300; // the browser's anchoring
      clock.advance(200);
      expect(list.atBottom()).toBe(true);
    } finally {
      clock.restore();
      disposeRoot();
    }
  });

  // A scrollbar let go of outside the window sends no pointerup: the press alone must not hold the list back.
  it("follows new messages while a scrollbar press seems to go on with nothing moving", () => {
    const clock = fakeClock();
    const list = makeList(20);
    const { place, disposeRoot } = install("chat:held", list);
    try {
      place.onChange();
      list.scroller.dispatch("pointerdown");
      clock.advance(5000);
      list.addNewer();
      place.onChange();
      expect(list.atBottom()).toBe(true);
    } finally {
      clock.restore();
      disposeRoot();
    }
  });

  it("still glides to a new message that came during the reader's input", () => {
    const clock = fakeClock();
    const list = makeList(20);
    const { place, disposeRoot } = install("chat:glide-later", list);
    try {
      place.onChange();
      list.read(790);
      list.addNewer();
      place.onChange(); // a glide, put off
      clock.advance(400);
      expect(list.scroller.scrolls.at(-1)).toEqual({ top: 1260, behavior: "smooth" });
    } finally {
      clock.restore();
      disposeRoot();
    }
  });

  // At fractional display scaling positions are measured in fractions; every write to scrollTop stops the wheel's
  // smooth scroll, so a correction of less than a pixel is left out.
  it("doesn't correct a held place that is off by less than a pixel", () => {
    const clock = fakeClock();
    const list = makeList(20);
    const { place, disposeRoot } = install("chat:subpixel", list);
    try {
      place.onChange();
      list.read(500); // message 1008 at the top, 20 px of it above the view
      clock.advance(4000);
      list.insertOlder(5);
      list.scroller.scrollTop = 800.4; // the browser anchored it, 0.4 px off
      grow();
      expect(list.scroller.scrollTop).toBe(800.4);
    } finally {
      clock.restore();
      disposeRoot();
    }
  });
});

// A message list shows a screenful and loads older messages only once the reader scrolls up (messageWindow.ts).
describe("the reader scrolling up", () => {
  it("is reported for the reader's own scroll up, not for scrolling down or the list's own scrolls", () => {
    const list = makeList(20);
    let ups = 0;
    const { place, disposeRoot } = install("chat:up", list, undefined, () => ups++);
    place.onChange(); // placed at the newest: the list's own scroll
    list.addNewer();
    place.onChange(); // follows the newest: its own again
    list.insertOlder(5);
    grow(); // held at the bottom: its own
    expect(ups).toBe(0);
    list.read(500);
    expect(ups).toBe(1);
    list.read(700); // down
    expect(ups).toBe(1);
    list.insertOlder(5);
    grow(); // the place held while older ones come in above: its own
    expect(ups).toBe(1);
    list.read(300);
    expect(ups).toBe(2);
    disposeRoot();
  });
});
