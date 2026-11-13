import { afterEach, describe, expect, it, vi } from "vitest";

const notices: string[] = [];
vi.mock("../../src/core/notices", () => ({ showNotice: (title: string) => notices.push(title) }));

import { createRoot } from "solid-js";
import { copyToClipboard, createCopied } from "../../src/ui/clipboard";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  notices.length = 0;
});

describe("copyToClipboard", () => {
  it("says whether the copy worked, and tells the user when it didn't", async () => {
    const written: string[] = [];
    vi.stubGlobal("navigator", { clipboard: { writeText: async (text: string) => void written.push(text) } });
    expect(await copyToClipboard("hello")).toBe(true);
    expect(written).toEqual(["hello"]);
    expect(notices).toEqual([]);

    vi.stubGlobal("navigator", { clipboard: { writeText: async () => { throw new Error("Document is not focused."); } } });
    expect(await copyToClipboard("again")).toBe(false);
    vi.stubGlobal("navigator", {});
    expect(await copyToClipboard("none")).toBe(false);
    expect(notices).toHaveLength(2);
  });

  it("shows copied for a moment after a copy that worked, the last copy's moment", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { clipboard: { writeText: async () => {} } });
    await createRoot(async (dispose) => {
      const { copied, copy } = createCopied(1000);
      await copy("a");
      expect(copied()).toBe(true);
      await vi.advanceTimersByTimeAsync(600);
      await copy("b");
      await vi.advanceTimersByTimeAsync(600);
      expect(copied()).toBe(true);
      await vi.advanceTimersByTimeAsync(500);
      expect(copied()).toBe(false);
      dispose();
    });
  });
});
