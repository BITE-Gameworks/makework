import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import { createMessageWindow } from "../../src/messaging/messageWindow";

// A message list opens with a screenful and holds still: older messages come only once the reader scrolled up, as the
// top comes near, or while the list is too short to scroll. The browser bits it uses are faked: the observer that says
// when the top is near, and frames.
let near: (on: boolean) => void;
let frames: FrameRequestCallback[];

beforeEach(() => {
  vi.useFakeTimers();
  frames = [];
  globalThis.requestAnimationFrame = ((fn: FrameRequestCallback) => frames.push(fn)) as typeof requestAnimationFrame;
  globalThis.IntersectionObserver = class {
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
      near = (on) => callback([{ isIntersecting: on }]);
    }
    observe() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
});
afterEach(() => vi.useRealTimers());

// Runs frames (and the steps they schedule) until nothing is due.
const runFrames = () => {
  for (let i = 0; i < 200 && frames.length; i++) {
    frames.shift()!(performance.now());
    vi.runOnlyPendingTimers();
  }
};

const messages = Array.from({ length: 3000 }, (_, i) => ({ id: i }));
const scroller = (clientHeight: number, scrollHeight: number) => ({ clientHeight, scrollHeight }) as unknown as Element;

describe("a message list's window", () => {
  it("shows a screenful and adds nothing while the top is near, until the reader scrolls up", () => {
    const window = createRoot(() => createMessageWindow(() => messages, "test:still"));
    const first = window.shown().length;
    expect(first).toBeGreaterThanOrEqual(30);
    expect(window.filling()).toBe(false);
    const stop = window.watch({} as Element, scroller(800, 4000));
    near(true);
    runFrames();
    expect(window.shown()).toHaveLength(first);
    window.readerUp();
    runFrames();
    expect(window.shown().length).toBeGreaterThan(first);
    expect(window.shown().at(-1)).toBe(messages[2999]);
    stop();
  });

  it("takes more on its own while the list is too short to scroll", () => {
    const window = createRoot(() => createMessageWindow(() => messages, "test:short"));
    const first = window.shown().length;
    const stop = window.watch({} as Element, scroller(800, 600));
    near(true);
    runFrames();
    expect(window.shown().length).toBeGreaterThan(first);
    stop();
  });

  it("takes nothing for a list that isn't laid out yet (built off the page)", () => {
    const window = createRoot(() => createMessageWindow(() => messages, "test:offpage"));
    const first = window.shown().length;
    const stop = window.watch({} as Element, scroller(0, 0));
    near(true);
    runFrames();
    expect(window.shown()).toHaveLength(first);
    stop();
  });
});
