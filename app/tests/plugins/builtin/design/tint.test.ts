import { describe, expect, it } from "vitest";
import { tintedSvg } from "../../../../src/plugins/builtin/design/render";
import { defaultProps, solid, type DesignNode } from "../../../../src/plugins/builtin/design/model";

const icon = (tint: ReturnType<typeof solid> | null): DesignNode => ({
  id: 1, parentId: null, name: "house", z: 1, x: 0, y: 0, width: 24, height: 24, rotation: 0,
  props: { ...defaultProps("svg"), svg: '<svg viewBox="0 0 24 24"><path stroke="currentColor" d="M0 0h1"/></svg>', tint },
} as DesignNode);

describe("tintedSvg", () => {
  it("sets the tint on the svg, where currentColor comes from, following palette colors", () => {
    expect(tintedSvg(icon(null), (c) => c.color)).not.toContain("color=");
    expect(tintedSvg(icon(solid("#ff0000")), (c) => c.color)).toContain('<svg color="#ff0000" viewBox');
    expect(tintedSvg(icon({ ...solid("#ff0000", 0.5), ref: 7 }), () => "#00ff00")).toContain('<svg color="#00ff00" opacity="0.5"');
  });
});
