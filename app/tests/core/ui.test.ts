import { afterEach, describe, expect, it, vi } from "vitest";
import { markWhileResizing } from "../../src/core/ui";

afterEach(() => vi.useRealTimers());

describe("markWhileResizing", () => {
  it("marks the root from the first resize until a quiet moment after the last", () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    const classes = new Set<string>();
    const root = { classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) } };
    markWhileResizing(target, root, 150);

    target.dispatchEvent(new Event("resize"));
    expect(classes.has("window-resizing")).toBe(true);
    vi.advanceTimersByTime(100);
    target.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(100);
    expect(classes.has("window-resizing")).toBe(true);
    vi.advanceTimersByTime(60);
    expect(classes.has("window-resizing")).toBe(false);
  });
});
