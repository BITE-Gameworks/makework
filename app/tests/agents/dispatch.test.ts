import { describe, expect, it } from "vitest";
import { dispatch, registerWorker } from "../../src/agents/dispatch";

const task = { instruction: "x", channelId: 1, threadId: null, leader: { id: 9, name: "Boss", request: "do x" } };
const limits = { start: 100, report: 100 };

describe("helper dispatch", () => {
  it("returns a helper's report, and turns a missing, failing or slow helper into a failed report", async () => {
    const stops = [
      registerWorker(1, async () => ({ ok: true, report: "done" })),
      registerWorker(2, async () => { throw new Error("boom"); }),
      registerWorker(3, () => new Promise(() => {})),
    ];
    expect(await dispatch(1, task, limits)).toEqual({ ok: true, report: "done" });
    expect(await dispatch(2, task, limits)).toEqual({ ok: false, report: "boom" });
    expect(await dispatch(3, task, limits)).toEqual({ ok: false, report: "The helper took too long." });
    expect(await dispatch(4, task, limits)).toEqual({ ok: false, report: "The helper did not start." });
    stops.forEach((stop) => stop());
  });
});
