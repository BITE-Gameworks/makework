import { describe, expect, it } from "vitest";
import { hasUnread, isUnread, markRead, markUnread, mentionCount, serverMentions } from "../../src/core/sidebar";

describe("unread and mentions", () => {
  it("counts mentions per channel and server, and clears them on read", () => {
    markUnread("s", 1, false);
    expect(isUnread("s", 1)).toBe(true);
    expect(mentionCount("s", 1)).toBe(0);
    markUnread("s", 1, true);
    markUnread("s", 1, true);
    markUnread("s", 2, true);
    expect(mentionCount("s", 1)).toBe(2);
    expect(serverMentions("s")).toBe(3);
    expect(serverMentions("other")).toBe(0);

    markRead("s", 1);
    expect(isUnread("s", 1)).toBe(false);
    expect(mentionCount("s", 1)).toBe(0);
    expect(serverMentions("s")).toBe(1);
    markRead("s", 2);
    expect(hasUnread("s")).toBe(false);
    expect(serverMentions("s")).toBe(0);
  });
});
