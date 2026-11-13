import { afterEach, describe, expect, it } from "vitest";
import { openChannel } from "../../src/core/navigation";
import { isLooking } from "../../src/core/notifier";

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
});
