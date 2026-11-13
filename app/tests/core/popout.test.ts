import { describe, expect, it } from "vitest";
import { modeOf, parseHandedOver, parsePlace } from "../../src/core/popout";

describe("view windows", () => {
  it("is the main window unless its URL says otherwise", () => {
    expect(modeOf(null)).toBe("main");
    expect(modeOf(JSON.stringify({ workspaceId: "w", channelId: 3 }))).toBe("popout");
  });

  it("reads the place a view window was started for", () => {
    expect(parsePlace(JSON.stringify({ workspaceId: "w", channelId: 3 }))).toEqual({ workspaceId: "w", channelId: 3 });
    expect(parsePlace(JSON.stringify({ workspaceId: "w", channelId: null, target: { kind: "message", id: 7 } })))
      .toEqual({ workspaceId: "w", channelId: null, target: { kind: "message", id: 7 } });
  });

  it("rejects a place it can't show", () => {
    expect(parsePlace(null)).toBeUndefined();
    expect(parsePlace("{oops")).toBeUndefined();
    expect(parsePlace(JSON.stringify({ channelId: 3 }))).toBeUndefined();
    expect(parsePlace(JSON.stringify({ workspaceId: "w", channelId: "three" }))).toBeUndefined();
  });

  it("reads a tab handed over from another window", () => {
    expect(parseHandedOver({ location: { workspaceId: "w", channelId: 3 }, index: 2, activate: false }))
      .toEqual({ location: { workspaceId: "w", channelId: 3 }, index: 2, activate: false });
    // A dropped tab with no index goes after the active tab and is shown.
    expect(parseHandedOver({ location: { workspaceId: "w", channelId: 3 } }))
      .toEqual({ location: { workspaceId: "w", channelId: 3 }, index: null, activate: true });
    expect(parseHandedOver({})).toBeUndefined();
    expect(parseHandedOver(null)).toBeUndefined();
    expect(parseHandedOver({ location: { channelId: 3 } })).toBeUndefined();
  });
});
