import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS script without types
import { nextVersion, sameSeries } from "../../scripts/bump_version.mjs";

describe("bump_version", () => {
  it("raises one number and resets those to its right", () => {
    expect(nextVersion("1.2.7", "patch")).toBe("1.2.8");
    expect(nextVersion("1.2.7", "minor")).toBe("1.3.0");
    expect(nextVersion("1.2.7", "major")).toBe("2.0.0");
  });

  it("refuses anything else", () => {
    expect(() => nextVersion("1.2.7", "huge")).toThrow("major or minor");
    expect(() => nextVersion("1.2", "minor")).toThrow("first.second.third");
  });

  it("tells a push that raised the first or second number by hand", () => {
    expect(sameSeries("1.2.7", "1.2.8")).toBe(true);
    expect(sameSeries("1.2.7", "1.3.0")).toBe(false);
    expect(sameSeries("1.2.7", "2.0.0")).toBe(false);
  });
});
