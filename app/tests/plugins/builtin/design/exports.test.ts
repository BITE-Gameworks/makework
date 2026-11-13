import { describe, expect, it } from "vitest";
import { designExportList } from "../../../../src/plugins/builtin/design/exportProvider";
import { toNode } from "../../../../src/plugins/builtin/design/model";

describe("design exports", () => {
  it("lists named layers configured for export and skips ordinary layers", () => {
    const nodes = [
      toNode({ id: 1, kind: "frame", name: "Card", props: JSON.stringify({ exports: [{ format: "svg" }] }) }),
      toNode({ id: 2, kind: "rect", name: "Background", props: "{}" }),
      toNode({ id: 3, kind: "text", name: "   ", props: JSON.stringify({ exports: [{ format: "png" }] }) }),
    ];
    expect(designExportList(nodes)).toEqual([
      { id: 1, name: "Card", kinds: ["image", "svg"] },
      { id: 3, name: "Untitled", kinds: ["image", "svg"] },
    ]);
  });
});
