import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appVersion, compareVersions, newerThanMine, validVersion } from "../../src/core/version";

describe("app version", () => {
  it("comes from package.json", () => {
    expect(appVersion).toBe(JSON.parse(readFileSync("package.json", "utf8")).version);
  });

  it("takes only what looks like a version from others", () => {
    expect(validVersion("1.2.3")).toBe(true);
    expect(validVersion("1.2.3-beta.1+abc")).toBe(true);
    expect(validVersion("<img src=x>")).toBe(false);
    expect(validVersion(`1.2.3${"x".repeat(100)}`)).toBe(false);
    expect(validVersion(5)).toBe(false);
  });

  it("compares by number, not by text", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("tells when someone is ahead, on any of their devices", () => {
    expect(newerThanMine("999.0.0")).toBe(true);
    expect(newerThanMine(`${appVersion}, 999.0.0`)).toBe(true);
    expect(newerThanMine(appVersion)).toBe(false);
  });
});
