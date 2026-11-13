import { describe, expect, it } from "vitest";
import { batch, createRoot, createSignal } from "solid-js";
import { createProgressive, watchNear, type Frame } from "../../src/ui/progressive";

// Steps run when the test says so (one frame each in the app), with how that frame went.
function steps() {
  const queue: ((frame?: Frame) => void)[] = [];
  return {
    schedule: (step: (frame?: Frame) => void) => void queue.push(step),
    run(times = 1, frame?: Frame) {
      for (let i = 0; i < times && queue.length; i++) queue.shift()!(frame);
    },
    all() {
      for (let i = 0; i < 10_000 && queue.length; i++) queue.shift()!();
    },
  };
}

const items = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: from + i }));

describe("a long list shown in pieces", () => {
  it("shows the newest first, then older ones step by step, until all of the same items are shown", () => {
    const list = items(1000);
    const clock = steps();
    const p = createRoot(() => createProgressive(() => list, { from: "end", first: 40, schedule: clock.schedule }));
    expect(p.shown()).toHaveLength(40);
    expect(p.shown()[39]).toBe(list[999]);
    expect(p.complete()).toBe(false);
    let before = p.shown().length;
    clock.run();
    expect(p.shown().length).toBeGreaterThan(before);
    expect(p.shown().at(-1)).toBe(list[999]);
    before = p.shown().length;
    clock.all();
    expect(p.complete()).toBe(true);
    expect(p.shown()).toEqual(list);
    expect(p.shown()[0]).toBe(list[0]);
  });

  it("shows a listing from its start", () => {
    const list = items(500);
    const clock = steps();
    const p = createRoot(() => createProgressive(() => list, { from: "start", first: 60, schedule: clock.schedule }));
    expect(p.shown()).toEqual(list.slice(0, 60));
    clock.all();
    expect(p.shown()).toEqual(list);
  });

  // A message arriving while older ones are still being added: it shows at once, and none shown goes away (that
  // would remount it and run its enter animation again).
  it("shows new items at the shown end at once and never takes a shown one away", () => {
    const [list, setList] = createSignal(items(1000));
    const clock = steps();
    const p = createRoot(() => createProgressive(list, { from: "end", first: 40, schedule: clock.schedule }));
    const shownBefore = p.shown().slice();
    setList([...list(), { id: 1000 }]);
    expect(p.shown().at(-1)).toEqual({ id: 1000 });
    expect(shownBefore.every((item) => p.shown().includes(item))).toBe(true);
    clock.all();
    expect(p.shown()).toHaveLength(1001);
  });

  it("waits for items that arrive later, and shows them in pieces too", () => {
    const [list, setList] = createSignal<{ id: number }[]>([]);
    const clock = steps();
    const p = createRoot(() => createProgressive(list, { from: "end", first: 40, schedule: clock.schedule }));
    expect(p.shown()).toEqual([]);
    setList(items(1000));
    expect(p.shown()).toHaveLength(40);
    clock.all();
    expect(p.shown()).toHaveLength(1000);
  });

  it("starts again from the first items for a new key (another folder)", () => {
    const [folder, setFolder] = createSignal(1);
    const [list, setList] = createSignal(items(300));
    const clock = steps();
    const p = createRoot(() => createProgressive(list, { from: "start", first: 50, key: folder, schedule: clock.schedule }));
    clock.all();
    expect(p.shown()).toHaveLength(300);
    // The folder and its listing change together (one data update).
    batch(() => {
      setFolder(2);
      setList(items(800, 1000));
    });
    expect(p.shown()).toEqual(list().slice(0, 50));
    clock.all();
    expect(p.shown()).toHaveLength(800);
  });

  it("shows everything at once when asked (a link to an old message)", () => {
    const list = items(1000);
    const clock = steps();
    const p = createRoot(() => createProgressive(() => list, { from: "end", first: 40, schedule: clock.schedule }));
    p.showAll();
    expect(p.shown()).toEqual(list);
    expect(p.complete()).toBe(true);
  });

  // A chat's whole history would end as tens of thousands of nodes, and leaving the channel then took 0.6 s (s15):
  // past the limit, older items come as the reader scrolls toward them.
  it("fills in the background up to its limit, and adds more only when asked", () => {
    const list = items(3000);
    const clock = steps();
    const p = createRoot(() => createProgressive(() => list, { from: "end", first: 50, limit: 300, schedule: clock.schedule }));
    clock.all();
    expect(p.shown().length).toBeGreaterThanOrEqual(300);
    expect(p.shown().length).toBeLessThan(3000);
    const filled = p.shown().length;
    p.more();
    clock.all();
    expect(p.shown().length).toBeGreaterThan(filled);
    expect(p.shown().at(-1)).toBe(list[2999]);
    expect(p.complete()).toBe(false);
  });

  // A message list remembers the reader's place only once it settled (messaging/scrollPlace.ts).
  it("says it is filling while the background fill runs, and stops at the limit or when everything shows", () => {
    const clock = steps();
    const big = createRoot(() => createProgressive(() => items(3000), { from: "end", first: 50, limit: 300, schedule: clock.schedule }));
    const small = createRoot(() => createProgressive(() => items(100), { from: "end", first: 50, limit: 300, schedule: clock.schedule }));
    const empty = createRoot(() => createProgressive(() => [], { from: "end", first: 50, limit: 300, schedule: clock.schedule }));
    expect(big.filling()).toBe(true);
    expect(small.filling()).toBe(true);
    expect(empty.filling()).toBe(false);
    clock.all();
    expect(big.filling()).toBe(false);
    expect(small.filling()).toBe(false);
    big.more(); // the reader asking for more is not the background fill
    expect(big.filling()).toBe(false);
  });

  it("reveals an item beyond the window (a link to an old message)", () => {
    const list = items(3000);
    const clock = steps();
    const p = createRoot(() => createProgressive(() => list, { from: "end", first: 50, limit: 300, schedule: clock.schedule }));
    p.reveal(list[10]);
    expect(p.shown()).toContain(list[10]);
    expect(p.shown().at(-1)).toBe(list[2999]);
  });

  // The fill takes a part of each frame and leaves the rest to animations: a 165 Hz frame is about 6 ms.
  it("grows its steps slowly while frames stay light, and makes them smaller after a heavy frame", () => {
    const list = items(3000);
    const clock = steps();
    const p = createRoot(() => createProgressive(() => list, { from: "end", first: 40, schedule: clock.schedule }));
    const sizes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = p.shown().length;
      clock.run(1, { renderMs: 0, frameMs: 6 });
      sizes.push(p.shown().length - before);
    }
    sizes.slice(1).forEach((size, i) => expect(size).toBeLessThanOrEqual(Math.ceil(sizes[i] * 1.5)));
    expect(sizes.at(-1)).toBeGreaterThan(sizes[0]);
    // The last step's new items took 20 ms to draw: the next one is far smaller.
    const before = p.shown().length;
    clock.run(1, { renderMs: 20, frameMs: 6 });
    clock.run(1, { renderMs: 0, frameMs: 6 });
    expect(p.shown().length - before).toBeLessThan(sizes.at(-1)! / 2);
  });

  it("leaves the frame after a heavy one to the animations, unless the reader is waiting for more", () => {
    const list = items(3000);
    const clock = steps();
    const p = createRoot(() => createProgressive(() => list, { from: "end", first: 40, limit: 300, schedule: clock.schedule }));
    clock.run(2, { renderMs: 0, frameMs: 6 });
    let before = p.shown().length;
    clock.run(1, { renderMs: 9, frameMs: 6 });
    expect(p.shown()).toHaveLength(before);
    clock.run(1, { renderMs: 0, frameMs: 6 });
    expect(p.shown().length).toBeGreaterThan(before);
    clock.all();
    p.more();
    p.more();
    clock.run(1, { renderMs: 0, frameMs: 6 });
    before = p.shown().length;
    clock.run(1, { renderMs: 9, frameMs: 6 });
    expect(p.shown().length).toBeGreaterThan(before);
  });

  it("adds nothing while a view slides in or out, and goes on once the slides are over", async () => {
    const list = items(3000);
    const clock = steps();
    let slidesOver!: () => void;
    let sliding: Promise<void> | undefined = new Promise((resolve) => (slidesOver = resolve));
    const p = createRoot(() => createProgressive(() => list, {
      from: "end", first: 40, schedule: clock.schedule, wait: () => sliding,
    }));
    clock.run(3);
    expect(p.shown()).toHaveLength(40);
    sliding = undefined;
    slidesOver();
    await Promise.resolve();
    clock.run(1);
    expect(p.shown().length).toBeGreaterThan(40);
  });

  // A message list: a screenful, then older ones only as the reader asks (messageWindow.ts).
  it("adds nothing in the background with no fill, and more as asked", () => {
    const list = items(3000);
    const clock = steps();
    const p = createRoot(() => createProgressive(() => list, { from: "end", first: 80, limit: 0, schedule: clock.schedule }));
    expect(p.filling()).toBe(false);
    clock.all();
    expect(p.shown()).toHaveLength(80);
    p.more();
    clock.all();
    expect(p.shown().length).toBeGreaterThan(80);
    expect(p.shown().at(-1)).toBe(list[2999]);
  });

  it("starts with as many shown as asked (the reader's place from last time)", () => {
    const list = items(3000);
    const clock = steps();
    const p = createRoot(() => createProgressive(() => list, { from: "end", first: () => 700, limit: 300, schedule: clock.schedule }));
    expect(p.shown()).toHaveLength(700);
  });
});

describe("an edge coming near", () => {
  // IntersectionObserver as the browser runs it: a callback when the edge comes into the margin or leaves it.
  function observer() {
    let callback!: (entries: { isIntersecting: boolean }[]) => void;
    const near = (on: boolean) => callback([{ isIntersecting: on }]);
    class Fake {
      constructor(cb: typeof callback) {
        callback = cb;
      }
      observe() {}
      disconnect() {}
    }
    return { Fake, near };
  }

  it("asks again each frame while the edge stays near, and stops once it left", () => {
    const { Fake, near } = observer();
    const frames: (() => void)[] = [];
    const calls: number[] = [];
    const { stop } = watchNear({} as Element, {} as Element, () => calls.push(1) > 0, {
      Observer: Fake as unknown as typeof IntersectionObserver, frame: (f) => void frames.push(f),
    });
    near(true);
    expect(calls).toHaveLength(1);
    frames.shift()!();
    expect(calls).toHaveLength(2);
    near(false);
    frames.shift()?.();
    expect(calls).toHaveLength(2);
    stop();
  });

  it("stops asking once nothing is left to show", () => {
    const { Fake, near } = observer();
    const frames: (() => void)[] = [];
    let calls = 0;
    watchNear({} as Element, {} as Element, () => ++calls < 2, {
      Observer: Fake as unknown as typeof IntersectionObserver, frame: (f) => void frames.push(f),
    });
    near(true);
    frames.shift()!();
    expect(calls).toBe(2);
    expect(frames).toHaveLength(0);
  });

  // A message list asks only once the reader scrolled up: the edge may have been near all along, and the observer says
  // nothing for an edge that stays near.
  it("asks again when woken while the edge is still near, and not when it is away", () => {
    const { Fake, near } = observer();
    const frames: (() => void)[] = [];
    let allowed = false;
    let calls = 0;
    const { wake, stop } = watchNear({} as Element, {} as Element, () => allowed && ++calls < 3, {
      Observer: Fake as unknown as typeof IntersectionObserver, frame: (f) => void frames.push(f),
    });
    near(true);
    expect(calls).toBe(0);
    expect(frames).toHaveLength(0);
    allowed = true;
    wake();
    expect(calls).toBe(1);
    frames.shift()!();
    expect(calls).toBe(2);
    frames.shift()!();
    expect(calls).toBe(3);
    near(false);
    wake();
    expect(calls).toBe(3);
    stop();
  });
});

