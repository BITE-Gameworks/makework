import { describe, expect, it } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createQuiet } from "../../src/plugins/quiet";

// The shape a view's live data follows while hidden (plugins/live.ts, GenericView.tsx).
describe("a hidden view's work", () => {
  it("runs at once while the view is shown", () => {
    const [active] = createSignal(true);
    let ran = 0;
    createRoot(() => createQuiet(active)).run(() => (ran += 1));
    expect(ran).toBe(1);
  });

  it("remembers work asked for while hidden, and runs it once when the view shows", () => {
    const [active, setActive] = createSignal(false);
    let ran = 0;
    const quiet = createRoot(() => createQuiet(active));
    quiet.run(() => (ran += 1));
    quiet.run(() => (ran += 1));
    expect(ran).toBe(0);
    setActive(true);
    expect(ran).toBe(1);
  });

  it("runs nothing when the view shows with nothing asked", () => {
    const [active, setActive] = createSignal(false);
    let ran = 0;
    const quiet = createRoot(() => createQuiet(active));
    setActive(true);
    expect(ran).toBe(0);
    quiet.run(() => (ran += 1));
    expect(ran).toBe(1);
  });
});
