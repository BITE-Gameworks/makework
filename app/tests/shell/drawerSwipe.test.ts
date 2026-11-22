import { describe, expect, it } from "vitest";
import { pansSideways } from "../../src/shell/drawerSwipe";

describe("pansSideways", () => {
  it("lets the browser pan sideways by default", () => {
    expect(pansSideways("auto")).toBe(true);
    expect(pansSideways("manipulation")).toBe(true);
  });

  it("allows any value with a sideways pan", () => {
    expect(pansSideways("pan-x")).toBe(true);
    expect(pansSideways("pan-left pan-y")).toBe(true);
    expect(pansSideways("pan-right pinch-zoom")).toBe(true);
  });

  it("leaves sideways drags to the page when they can't pan", () => {
    expect(pansSideways("none")).toBe(false);
    expect(pansSideways("pan-y")).toBe(false);
    expect(pansSideways("pinch-zoom")).toBe(false);
    expect(pansSideways("pan-up pinch-zoom")).toBe(false);
  });
});
