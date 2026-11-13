import { describe, expect, it } from "vitest";
import { compareText, trimEnd } from "../../electron/text.js";

describe("the main process's text helpers", () => {
  it("cuts the run at the end, and only there", () => {
    expect(trimEnd("message\n\n", "\n")).toBe("message");
    expect(trimEnd("a\nb", "\n")).toBe("a\nb");
    expect(trimEnd("dist//", "/")).toBe("dist");
    expect(trimEnd("", "/")).toBe("");
    expect(trimEnd("/", "/")).toBe("");
    expect(trimEnd("/a/", "/")).toBe("/a");
    expect(trimEnd("a/b", "/")).toBe("a/b");
  });

  it("orders like sort() without a function", () => {
    const names = ["b.jsonl", "a.jsonl", "B.jsonl", "10.jsonl", "9.jsonl", "é.jsonl"];
    expect([...names].sort(compareText)).toEqual([...names].sort());
  });
});
