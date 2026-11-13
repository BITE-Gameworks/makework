import { describe, expect, it } from "vitest";
import { botConfig, botParent } from "../../src/core/botConfig";

describe("botConfig", () => {
  it("reads a bot's settings, and {} for anything else", () => {
    expect(botConfig({ config: '{"a":1,"_parent":7}' })).toEqual({ a: 1, _parent: 7 });
    for (const config of [undefined, "", "not json", "[1]", "null", "3"]) expect(botConfig({ config })).toEqual({});
    expect(botConfig(undefined)).toEqual({});
  });
  it("names a helper's leader", () => {
    expect(botParent({ config: '{"_parent":7}' })).toBe(7);
    expect(botParent({ config: "{}" })).toBeNaN();
    expect(botParent(null)).toBeNaN();
  });
});
