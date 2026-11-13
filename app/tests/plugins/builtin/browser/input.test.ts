import { describe, expect, it } from "vitest";
import { isVideoRegion } from "../../../../src/plugins/builtin/browser/videoShare";
import { addressFor, electedHost, isBrowserMessage, keyInput } from "../../../../src/plugins/builtin/browser/input";

const key = (k: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) =>
  ({ key: k, code: "", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods });

describe("shared browser input", () => {
  it("reads the address bar", () => {
    expect(addressFor("https://a.com/x")).toBe("https://a.com/x");
    expect(addressFor("makework.dev/docs")).toBe("https://makework.dev/docs");
    expect(addressFor("localhost:1420")).toBe("http://localhost:1420");
    expect(addressFor("solid js signals")).toBe("https://duckduckgo.com/?q=solid%20js%20signals");
    expect(addressFor("  ")).toBeNull();
  });

  it("gives typed characters their text, other keys none", () => {
    const text = (k: ReturnType<typeof key>) => {
      const input = keyInput("keyDown", k);
      return input && "text" in input ? input.text : undefined;
    };
    expect(text(key("a"))).toBe("a");
    expect(text(key("Enter"))).toBe("\r");
    expect(text(key("ArrowLeft"))).toBeUndefined();
    expect(text(key("a", { ctrlKey: true }))).toBeUndefined();
    expect(keyInput("keyDown", key("Shift"))).toBeNull();
  });

  it("accepts only well-formed messages", () => {
    expect(isBrowserMessage({ t: "host", at: 42 })).toBe(true);
    expect(isBrowserMessage({ t: "close" })).toBe(true);
    expect(isBrowserMessage({ t: "host", at: "now" })).toBe(false);
    expect(isBrowserMessage({ t: "go", url: "https://a.com" })).toBe(true);
    expect(isBrowserMessage({ t: "go", url: "javascript:alert(1)" })).toBe(false);
    expect(isBrowserMessage({ t: "input", events: [{ type: "mouseDown", x: 1, y: 2, button: "left", clickCount: 1, modifiers: [] }] })).toBe(true);
    expect(isBrowserMessage({ t: "input", events: [{ type: "mouseDown", x: 1, y: 2, button: "left", clickCount: 1, modifiers: ["evil"] }] })).toBe(false);
    expect(isBrowserMessage({ t: "media", paused: true, time: Infinity })).toBe(false);
    expect(isBrowserMessage({ t: "mode", mode: "together" })).toBe(true);
    expect(isBrowserMessage({ t: "mode", mode: "solo" })).toBe(false);
    const down = { type: "mouseDown", x: 1, y: 2, button: "left", clickCount: 1, modifiers: [] };
    expect(isBrowserMessage({ t: "input", events: [{ ...down, at: { id: 12, fx: 0.5, fy: 0.25 } }] })).toBe(true);
    expect(isBrowserMessage({ t: "input", events: [{ ...down, at: { id: -1, fx: 0.5, fy: 0.25 } }] })).toBe(false);
  });

  it("accepts only video regions inside the element", () => {
    expect(isVideoRegion({ id: 6, fx0: 0, fy0: 0.2, fx1: 1, fy1: 1 })).toBe(true);
    expect(isVideoRegion({ id: 6, fx0: 0, fy0: 0, fx1: 1.5, fy1: 1 })).toBe(false);
    expect(isVideoRegion({ id: 0, fx0: 0, fy0: 0, fx1: 1, fy1: 1 })).toBe(false);
  });

  it("elects the latest host declaration, otherwise the lowest member", () => {
    expect(electedHost(8, [{ userId: 3, state: {} }, { userId: 5, state: {} }])).toBe(3);
    expect(electedHost(8, [
      { userId: 3, state: { host: true, hostAt: 100 } },
      { userId: 5, state: { host: true, hostAt: 200 } },
    ])).toBe(5);
    expect(electedHost(8, [
      { userId: 3, state: { host: true, hostAt: 200 } },
      { userId: 5, state: { host: true, hostAt: 200 } },
    ])).toBe(3);
  });
});
