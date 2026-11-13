import { describe, expect, it } from "vitest";
import { textChange } from "../../../../src/plugins/builtin/code/data";

const apply = (before: string, after: string) => {
  const edit = textChange(before, after);
  return before.slice(0, edit.start) + edit.insert + before.slice(edit.start + edit.remove);
};

describe("textChange", () => {
  it("replaces only the changed middle", () => {
    expect(textChange("hello brave world", "hello new world")).toEqual({ start: 6, remove: 5, insert: "new" });
  });
  it("reproduces the new text", () => {
    for (const [a, b] of [["", "abc"], ["abc", ""], ["aaa", "aaaa"], ["abcabc", "abc"], ["x", "x"]]) expect(apply(a, b)).toBe(b);
  });
});
