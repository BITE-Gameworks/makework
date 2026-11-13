import { describe, expect, it } from "vitest";
import { describeRoll, parseRoll, roll } from "../../../src/plugins/builtin/bots/dice";
import { forbiddenWord, parseWords, reasonFor, type ModSettings } from "../../../src/plugins/builtin/bots/modLogic";
import { dueReminders, nextMilestone, staleTasks, toTask, type TaskRow } from "../../../src/plugins/builtin/bots/tasksLogic";
import { findZone, parseClock, parseDuration, zoneTime } from "../../../src/plugins/builtin/bots/time";

describe("dice", () => {
  it("parses plain numbers and NdM+K", () => {
    expect(parseRoll("20")).toEqual({ count: 1, sides: 20, modifier: 0 });
    expect(parseRoll("2d6+3")).toEqual({ count: 2, sides: 6, modifier: 3 });
    expect(parseRoll("d20-1")).toEqual({ count: 1, sides: 20, modifier: -1 });
    expect(parseRoll("99d6")).toBeNull();
    expect(parseRoll("banana")).toBeNull();
  });
  it("rolls inside range", () => {
    const r = roll("2d6+1", () => 0.999)!;
    expect(r.dice).toEqual([6, 6]);
    expect(r.total).toBe(13);
    expect(describeRoll(r)).toBe("6 + 6 + 1 = **13**");
  });
});

describe("time", () => {
  it("finds zones", () => {
    expect(findZone("Berlin")).toBe("Europe/Berlin");
    expect(findZone("America/New_York")).toBe("America/New_York");
    expect(findZone("nowhere land")).toBeNull();
  });
  it("converts clock times between zones", () => {
    const now = new Date("2026-01-15T12:00:00Z");
    expect(zoneTime("Europe/Berlin", 15, 0, now).toISOString()).toBe("2026-01-15T14:00:00.000Z");
    expect(zoneTime("Asia/Tokyo", 9, 30, now).toISOString()).toBe("2026-01-15T00:30:00.000Z");
  });
  it("parses clocks and durations", () => {
    expect(parseClock("3pm")).toEqual({ hour: 15, minute: 0 });
    expect(parseClock("25:00")).toBeNull();
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("2 h 5 min")).toBe(7_500_000);
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration("1234567890s")).toBeNull();
  });
});

const task = (id: number, over: Partial<TaskRow> = {}): TaskRow => ({ id, channelId: 1, columnId: 1, title: `t${id}`, createdAt: "2026-01-01T00:00:00Z", doneAt: null, assignees: [], ...over });

describe("taskbot", () => {
  it("announces after ten finished tasks since the last announcement", () => {
    const done = Array.from({ length: 12 }, (_, i) => task(i, { doneAt: `2026-02-01T00:00:${String(i).padStart(2, "0")}Z` }));
    const group = nextMilestone(done, "2026-02-01T00:00:01Z")!;
    expect(group.map((t) => t.id)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(nextMilestone(done.slice(0, 5), "")).toBeNull();
  });
  it("finds old tasks and respects the reminder gap", () => {
    const now = Date.parse("2026-02-01T00:00:00Z");
    const tasks = [task(1), task(2, { createdAt: "2026-01-30T00:00:00Z" }), task(3, { doneAt: "2026-01-02T00:00:00Z" })];
    const stale = staleTasks(tasks, now, 14);
    expect(stale.map((t) => t.id)).toEqual([1]);
    expect(dueReminders(stale, new Map([[1, now - 86_400_000]]), now, 7)).toEqual([]);
    expect(dueReminders(stale, new Map(), now, 7).map((t) => t.id)).toEqual([1]);
  });
  it("ignores deleted and archived tasks", () => {
    expect(toTask({ id: 1, deleted: true }, new Map())).toBeNull();
    expect(toTask({ id: 1, archived_at: "x" }, new Map())).toBeNull();
    expect(toTask({ id: 1, channel_id: 2, column_id: 3, assignee_id: 9 }, new Map([[1, [9, 4]]]))!.assignees).toEqual([9, 4]);
  });
});

const settings: ModSettings = { words: ["badword"], spamCount: 3, spamSeconds: 10, repeats: 3, maxMentions: 2 };

describe("automoderator", () => {
  it("matches whole words only", () => {
    expect(forbiddenWord("this is a BadWord!", ["badword"])).toBe("badword");
    expect(forbiddenWord("badwords are fine here", ["badword"])).toBeNull();
    expect(parseWords("A, b\nc,,")).toEqual(["a", "b", "c"]);
  });
  it("flags words, floods, repeats and mention piles", () => {
    expect(reasonFor("badword", [{ at: 0, text: "badword" }], settings)).toMatch(/language/);
    const flood = [0, 1000, 2000, 3000].map((at) => ({ at, text: `m${at}` }));
    expect(reasonFor("m3000", flood, settings)).toMatch(/too fast/);
    const same = [0, 20_000, 40_000].map((at) => ({ at, text: "buy now" }));
    expect(reasonFor("buy now", same, settings)).toMatch(/repeat/);
    expect(reasonFor("<@1> <@2> <@3>", [{ at: 0, text: "x" }], settings)).toMatch(/mentions/);
    expect(reasonFor("hello", [{ at: 0, text: "hello" }], settings)).toBeNull();
  });
});
