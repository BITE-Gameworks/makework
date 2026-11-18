import { afterEach, describe, expect, it } from "vitest";
import { openChannel } from "../../src/core/navigation";
import { isLooking, phoneShows } from "../../src/core/notifier";

// Node has no document; the notifier only asks whether the window has focus.
const focus = (focused: boolean) => Object.assign(globalThis, { document: { hasFocus: () => focused } });

describe("notifier", () => {
  afterEach(() => Reflect.deleteProperty(globalThis, "document"));

  it("is looking only with the window focused on that channel", () => {
    openChannel("server", 7);
    focus(true);
    expect(isLooking("server", 7)).toBe(true);
    expect(isLooking("server", 8)).toBe(false);
    expect(isLooking("other", 7)).toBe(false);
    focus(false);
    expect(isLooking("server", 7)).toBe(false);
  });

  it("shows on the phone only mentions and the first unread private message from someone", () => {
    expect(phoneShows({ kind: "mention" })).toBe(true);
    expect(phoneShows({ kind: "message" })).toBe(true);
    expect(phoneShows({ kind: "message", again: false })).toBe(true);
    expect(phoneShows({ kind: "message", again: true })).toBe(false);
    for (const kind of ["reply", "commits", "friend", "workspace"] as const) expect(phoneShows({ kind })).toBe(false);
  });
});
