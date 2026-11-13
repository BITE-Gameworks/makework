import { describe, expect, it } from "vitest";
import { continuesFrom, dayLabel, startsNewDay } from "../../src/messaging/grouping";

const at = (date: string) => new Date(date).toISOString();

describe("message grouping", () => {
  it("runs together one author's messages within five minutes", () => {
    const first = { authorId: 1, createdAt: at("2026-11-02T10:00:00") };
    expect(continuesFrom(first, { authorId: 1, createdAt: at("2026-11-02T10:04:00") })).toBe(true);
    expect(continuesFrom(first, { authorId: 1, createdAt: at("2026-11-02T10:06:00") })).toBe(false);
    expect(continuesFrom(first, { authorId: 2, createdAt: at("2026-11-02T10:01:00") })).toBe(false);
    expect(continuesFrom(undefined, first)).toBe(false);
  });

  it("starts a new group and day divider at midnight", () => {
    const late = { authorId: 1, createdAt: at("2026-11-02T23:59:00") };
    const next = { authorId: 1, createdAt: at("2026-11-03T00:01:00") };
    expect(continuesFrom(late, next)).toBe(false);
    expect(startsNewDay(late, next.createdAt)).toBe(true);
  });

  it("names today and yesterday", () => {
    const today = new Date("2026-11-02T12:00:00");
    expect(dayLabel(at("2026-11-02T08:00:00"), today)).toBe("Today");
    expect(dayLabel(at("2026-11-01T08:00:00"), today)).toBe("Yesterday");
    expect(dayLabel(at("2025-03-01T08:00:00"), today)).toContain("2025");
  });
});
