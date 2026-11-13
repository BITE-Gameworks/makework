import { afterEach, describe, expect, it, vi } from "vitest";
import { Deliveries, forgetAfterMs } from "../../src/p2p/deliveries";

const hash = (c: string) => c.repeat(64);
// One localStorage key, shared by every window of the app.
const memory = (initial: Record<string, number> = {}) => {
  let saved = initial;
  let writes = 0;
  return {
    read: () => saved,
    write: (entries: Record<string, number>) => void ((saved = entries), writes++),
    writes: () => writes,
  };
};
const always = () => true;

afterEach(() => vi.useRealTimers());

describe("new uploads on their way to a node", () => {
  it("counts an upload until a node received all of it", () => {
    const deliveries = new Deliveries(memory());
    deliveries.expect(hash("a"));
    deliveries.expect(hash("b"));
    expect(deliveries.pending(always)).toEqual([hash("a"), hash("b")]);
    deliveries.delivered(hash("a"));
    expect(deliveries.pending(always)).toEqual([hash("b")]);
  });

  it("keeps them across a restart", () => {
    const store = memory();
    const before = new Deliveries(store);
    before.expect(hash("a"));
    before.flush();
    expect(new Deliveries(store).pending(always)).toEqual([hash("a")]);
  });

  it("leaves out an upload whose item was removed since", () => {
    const deliveries = new Deliveries(memory());
    deliveries.expect(hash("a"));
    deliveries.expect(hash("b"));
    expect(deliveries.pending((h) => h === hash("b"))).toEqual([hash("b")]);
  });

  it("forgets one no node asked for after a while (its content reached the nodes another way)", () => {
    let now = 1_000_000;
    const store = memory();
    const deliveries = new Deliveries(store, { now: () => now });
    deliveries.expect(hash("a"));
    now += forgetAfterMs + 1;
    expect(deliveries.pending(always)).toEqual([]);
    expect(new Deliveries(store, { now: () => now }).pending(always)).toEqual([]);
  });

  it("ignores what isn't a content hash in what was saved", () => {
    const deliveries = new Deliveries(memory({ nonsense: Date.now(), [hash("c")]: Number.NaN, [hash("d")]: Date.now() }));
    expect(deliveries.pending(always)).toEqual([hash("d")]);
  });

  // A folder of 14k files is one upload after the other: writing the whole list each time is quadratic.
  it("writes at most once a second while a batch is uploaded", () => {
    vi.useFakeTimers();
    const store = memory();
    const deliveries = new Deliveries(store);
    for (let i = 0; i < 500; i++) deliveries.expect(i.toString(16).padStart(64, "0"));
    expect(store.writes()).toBe(0);
    vi.advanceTimersByTime(1_000);
    expect(store.writes()).toBe(1);
    expect(Object.keys(store.read())).toHaveLength(500);
  });

  // Windows of the app (a tab popped out, ADR 0009) and browser tabs each keep a list of their own over one key.
  it("shares the list between windows: one's upload counts in the other, and a delivery either sees clears it", () => {
    const store = memory();
    const main = new Deliveries(store);
    const popout = new Deliveries(store);
    popout.expect(hash("a"));
    main.expect(hash("b"));
    popout.flush();
    main.flush();
    expect(main.pending(always)).toEqual([hash("a"), hash("b")]);
    main.delivered(hash("a"));
    main.flush();
    expect(popout.pending(always)).toEqual([hash("b")]);
  });
});
