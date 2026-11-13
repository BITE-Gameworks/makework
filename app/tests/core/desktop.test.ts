import { describe, expect, it } from "vitest";
import { userMessage } from "../../src/api/client";
import { desktopError } from "../../src/core/desktop";

describe("desktop call errors", () => {
  it("shows the main process's message without Electron's prefix", () => {
    const e = new Error("Error invoking remote method 'git:pick-folder': Error: Git isn't installed. Install it from git-scm.com and try again.");
    expect(userMessage(desktopError(e))).toBe("Git isn't installed. Install it from git-scm.com and try again.");
  });

  it("asks for a restart when the running app doesn't know the call yet", () => {
    const e = new Error("Error invoking remote method 'secret:set': Error: No handler registered for 'secret:set'");
    expect(userMessage(desktopError(e))).toBe("Restart the app to finish updating it.");
  });
});
