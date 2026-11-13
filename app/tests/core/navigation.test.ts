import { describe, expect, it } from "vitest";
import { activeTabId, messagesHome, moveToWindow, openInNewTabAt, poppable, seedPopoutTab, tabLocation, tabs } from "../../src/core/navigation";

describe("which tabs can have their own window", () => {
  it("takes a channel whose type can stand alone", () => {
    expect(poppable({ workspaceId: "w", channelId: 3 }, { ownWindow: true })).toBe(true);
    expect(poppable({ workspaceId: "w", channelId: 3 }, {})).toBe(true);
  });

  it("keeps private messages, empty tabs and main-window-only types in the main window", () => {
    expect(poppable({ workspaceId: messagesHome, channelId: null }, { ownWindow: true })).toBe(false);
    expect(poppable({ workspaceId: "w", channelId: null }, { ownWindow: true })).toBe(false);
    expect(poppable({ workspaceId: "w", channelId: 3 }, { ownWindow: false })).toBe(false);
    expect(poppable({ workspaceId: "w", channelId: 3 }, undefined)).toBe(false);
    expect(poppable(undefined, { ownWindow: true })).toBe(false);
  });
});

describe("moving a tab to its own window", () => {
  it("refuses a type that stays in the main window", () => {
    seedPopoutTab({ workspaceId: "w", channelId: 1 });
    moveToWindow("w", 1, { ownWindow: false });
    expect(tabs()).toHaveLength(1);
    expect(tabLocation(tabs()[0])?.channelId).toBe(1);
  });
});

describe("tabs handed to a window", () => {
  it("opens where the drop said, showing it only when asked", () => {
    seedPopoutTab({ workspaceId: "w", channelId: 1 });
    expect(tabs()).toHaveLength(1);

    openInNewTabAt({ workspaceId: "w", channelId: 2 }, null, false);
    expect(tabs()).toHaveLength(2);
    expect(activeTabId()).toBe(tabs()[0].id);

    openInNewTabAt({ workspaceId: "w", channelId: 3 }, 0, true);
    expect(tabs()).toHaveLength(3);
    expect(tabLocation(tabs()[0])?.channelId).toBe(3);
    expect(activeTabId()).toBe(tabs()[0].id);
  });
});
