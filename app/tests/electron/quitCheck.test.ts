import { describe, expect, it, vi } from "vitest";
import { createQuitCheck, type QuitQuestion } from "../../electron/quitCheck.js";

// A question shown answers with this button (0 keeps running, 1 quits).
function check(undelivered: number, button = 0) {
  const ask = vi.fn(async (_win: unknown) => undelivered);
  const show = vi.fn(async (_win: unknown, _question: QuitQuestion) => ({ response: button }));
  return { ask, show, quitCheck: createQuitCheck({ ask, show }) };
}

describe("asking before a quit while new uploads haven't reached a node", () => {
  it("quits at once when nothing is on its way", async () => {
    const { show, quitCheck } = check(0);
    expect(await quitCheck.confirm("win")).toBe(true);
    expect(show).not.toHaveBeenCalled();
  });

  it("asks, and keeps running unless the user picks Quit anyway", async () => {
    const kept = check(3, 0);
    expect(await kept.quitCheck.confirm("win")).toBe(false);
    const options = kept.show.mock.calls[0][1];
    expect(options.message).toBe("3 new files haven't reached the node yet");
    expect(options.buttons).toEqual(["Keep running", "Quit anyway"]);
    expect(options.defaultId).toBe(0);
    expect(options.cancelId).toBe(0);
    expect(await check(3, 1).quitCheck.confirm("win")).toBe(true);
  });

  it("says one file", async () => {
    const { show, quitCheck } = check(1);
    await quitCheck.confirm("win");
    expect(show.mock.calls[0][1].message).toBe("1 new file hasn't reached the node yet");
  });

  it("asks once for quits that come while it asks", async () => {
    const { ask, show, quitCheck } = check(2, 1);
    expect(await Promise.all([quitCheck.confirm("win"), quitCheck.confirm("win")])).toEqual([true, true]);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("never asks for a quit nobody can answer (shutdown, a signal)", async () => {
    const { ask, show, quitCheck } = check(5);
    quitCheck.force();
    expect(await quitCheck.confirm("win")).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
  });
});
