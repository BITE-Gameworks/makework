import { describe, expect, it } from "vitest";
import { describePlayback, findLink, formatTime, looksLikePlaylist, nextIndex, parseLoop, parseSeek, queueText, shuffledAfter } from "../../../src/plugins/builtin/bots/mediaLogic";

describe("media bot links", () => {
  it("finds the first address and ignores mentions", () => {
    expect(findLink("<@12> https://youtu.be/abc?t=3 please")).toBe("https://youtu.be/abc?t=3");
    expect(findLink("<@12> (see https://example.com/a.mp3).")).toBe("https://example.com/a.mp3");
    expect(findLink("<@12> pause")).toBeNull();
  });
});

describe("media bot seeking", () => {
  it("reads clock times and units", () => {
    expect(parseSeek("1:30")).toEqual({ relative: false, seconds: 90 });
    expect(parseSeek("1:02:03")).toEqual({ relative: false, seconds: 3723 });
    expect(parseSeek("90")).toEqual({ relative: false, seconds: 90 });
    expect(parseSeek("1m30s")).toEqual({ relative: false, seconds: 90 });
    expect(parseSeek("2h")).toEqual({ relative: false, seconds: 7200 });
  });
  it("reads steps", () => {
    expect(parseSeek("+30")).toEqual({ relative: true, seconds: 30 });
    expect(parseSeek("-1:10")).toEqual({ relative: true, seconds: -70 });
  });
  it("refuses nonsense", () => {
    expect(parseSeek("")).toBeNull();
    expect(parseSeek("soon")).toBeNull();
    expect(parseSeek("1:99x")).toBeNull();
  });
  it("words times", () => {
    expect(formatTime(75)).toBe("1:15");
    expect(formatTime(3723)).toBe("1:02:03");
    expect(describePlayback("Song", 75, 200, "paused")).toBe("**Song** · 1:15 / 3:20 · paused");
  });
});

describe("media bot playlists", () => {
  it("tells a playlist link from one video", () => {
    expect(looksLikePlaylist("https://www.youtube.com/playlist?list=PL1")).toBe(true);
    expect(looksLikePlaylist("https://www.youtube.com/watch?v=abc&list=PL1")).toBe(false);
    expect(looksLikePlaylist("https://youtu.be/abc?list=PL1")).toBe(false);
    expect(looksLikePlaylist("https://soundcloud.com/artist/sets/mix")).toBe(true);
    expect(looksLikePlaylist("https://example.com/song.mp3")).toBe(false);
  });
  it("reads loop words", () => {
    expect(parseLoop("one")).toBe("one");
    expect(parseLoop("ALL")).toBe("queue");
    expect(parseLoop("never")).toBeNull();
  });
  it("picks the next item", () => {
    expect(nextIndex(0, 3, "off")).toBe(1);
    expect(nextIndex(2, 3, "off")).toBeNull();
    expect(nextIndex(2, 3, "queue")).toBe(0);
    expect(nextIndex(1, 3, "one")).toBe(1);
    expect(nextIndex(1, 3, "one", true)).toBe(2);
    expect(nextIndex(0, 0, "queue")).toBeNull();
  });
  it("shuffles only what is still to come", () => {
    const out = shuffledAfter([1, 2, 3, 4, 5], 1, () => 0);
    expect(out.slice(0, 2)).toEqual([1, 2]);
    expect([...out].sort()).toEqual([1, 2, 3, 4, 5]);
  });
  it("lists the queue from the current item", () => {
    const text = queueText([{ title: "A" }, { title: "B" }, { title: "" }], 1, "queue");
    expect(text).toContain("looping the queue");
    expect(text).toContain("▶ B");
    expect(text).toContain("3. (not loaded yet)");
    expect(text).not.toContain("1. A");
    expect(queueText([], -1, "off")).toBe("The queue is empty.");
  });
});
