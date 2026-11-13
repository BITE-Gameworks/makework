import { describe, expect, it } from "vitest";
import { resolvePresenceStatus } from "../../src/core/onlineStatus";

describe("online status", () => {
  it("derives Away only from Online and idle state", () => {
    expect(resolvePresenceStatus("online", true, false)).toBe("away");
    expect(resolvePresenceStatus("online", false, false)).toBe("online");
    expect(resolvePresenceStatus("dnd", true, false)).toBe("dnd");
    expect(resolvePresenceStatus("hidden", true, false)).toBe("hidden");
    expect(resolvePresenceStatus("dnd", false, true)).toBe("offline");
  });
});
