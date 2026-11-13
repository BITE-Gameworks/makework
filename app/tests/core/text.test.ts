import { describe, expect, it } from "vitest";
import { compareText, trimChars, trimEnd, trimStart } from "../../src/core/text";

describe("trimming characters", () => {
  it("cuts the run at the end, and only there", () => {
    expect(trimEnd("https://a.example///", "/")).toBe("https://a.example");
    expect(trimEnd("a/b/c", "/")).toBe("a/b/c");
    expect(trimEnd("report. . ", ". ")).toBe("report");
    expect(trimEnd("///", "/")).toBe("");
    expect(trimEnd("", "/")).toBe("");
  });

  it("cuts the run at the start, and only there", () => {
    expect(trimStart("\n\ntext\n", "\n")).toBe("text\n");
    expect(trimStart("__a_b", "_")).toBe("a_b");
    expect(trimStart("", "_")).toBe("");
  });

  it("cuts both ends", () => {
    expect(trimChars("--a-b--", "-")).toBe("a-b");
    expect(trimChars("._name_.", "._")).toBe("name");
    expect(trimChars("//", "/")).toBe("");
  });

  it("leaves the same characters inside the text alone", () => {
    const cases: [string, string, string][] = [
      ["", "", ""], ["/", "", ""], ["a", "a", "a"], ["a/", "a", "a"], ["a//", "a", "a"], ["/a/", "/a", "a"],
      ["//a//b//", "//a//b", "a//b"], ["a/b", "a/b", "a/b"],
    ];
    for (const [text, end, both] of cases) {
      expect(trimEnd(text, "/")).toBe(end);
      expect(trimChars(text, "/")).toBe(both);
    }
  });

  it("stays quick on a long run that doesn't reach the end", () => {
    const text = `${"/".repeat(200_000)}x`;
    const started = performance.now();
    expect(trimEnd(text, "/")).toBe(text);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("compareText", () => {
  it("orders like sort() without a function", () => {
    const words = ["b", "a", "B", "A", "10", "9", "é", "e", "z", "", "aa", "a\u{1F600}", "a￿", "ä"];
    expect([...words].sort(compareText)).toEqual([...words].sort());
  });
});
