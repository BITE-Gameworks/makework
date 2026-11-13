import { describe, expect, it, vi } from "vitest";
import { noteCallEvent, recentCallEvents } from "../../src/voice/activity";

describe("call events", () => {
  it("shows a workspace's events newest first with names, logs losses as warnings, and keeps the last 60", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    noteCallEvent("w1", "direct link to {peer} closed", "p1", true);
    noteCallEvent("w1", "the call goes through a node now");
    noteCallEvent("w2", "direct link to {peer} opened", "p9");
    expect(warn).toHaveBeenCalledWith("Call: direct link to peer p1 closed");
    expect(info).toHaveBeenCalledWith("Call: the call goes through a node now");

    // A name is text: `$'` and `$&` in it are not replacement patterns.
    const names = (peer: string) => (peer === "p1" ? "Ada $' $&" : "someone");
    const shown = recentCallEvents("w1", names);
    expect(shown).toHaveLength(2);
    expect(shown[0]).toMatch(/ the call goes through a node now$/);
    expect(shown[1]).toMatch(/ direct link to Ada \$' \$& closed$/);

    for (let i = 0; i < 70; i++) noteCallEvent("w1", `sync: ${i} commits from {peer}`, "p2");
    const kept = recentCallEvents("w1", names);
    expect(kept).toHaveLength(60);
    expect(kept[0]).toMatch(/ sync: 69 commits from someone$/);
    expect(kept.at(-1)).toMatch(/ sync: 10 commits from someone$/);
    expect(recentCallEvents("w2", names)).toEqual([]);
    info.mockRestore();
    warn.mockRestore();
  });
});
