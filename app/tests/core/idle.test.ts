import { afterEach, describe, expect, it, vi } from "vitest";
import { awayAfterMs, idle, startIdleTracker, stopIdleTracker } from "../../src/core/idle";

describe("idle tracker", () => {
  afterEach(() => {
    stopIdleTracker();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("marks away after 15 minutes and returns to active on input", () => {
    vi.useFakeTimers();
    const listeners = new Map<string, EventListener>();
    vi.stubGlobal("window", {
      addEventListener: (name: string, listener: EventListener) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
    });

    startIdleTracker();
    vi.advanceTimersByTime(awayAfterMs - 1);
    expect(idle()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(idle()).toBe(true);

    listeners.get("pointermove")?.(new Event("pointermove"));
    expect(idle()).toBe(false);
  });
});
