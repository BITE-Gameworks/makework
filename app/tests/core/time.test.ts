import { describe, expect, it } from "vitest";
import { formatBytes } from "../../src/core/time";

describe("formatBytes", () => {
  it("names the size in the unit it rounds to", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024 - 1)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1023.7)).toBe("1.0 MB");
    expect(formatBytes(9.96 * 1024 * 1024)).toBe("10 MB");
    expect(formatBytes(5 * 1024 ** 4)).toBe("5.0 TB");
  });
});
