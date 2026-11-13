import { describe, expect, it } from "vitest";
import { diskEntries, type DiskSource } from "../../src/p2p/diskView";
import { designDisk } from "../../src/plugins/builtin/design/disk";
import { docsDisk } from "../../src/plugins/builtin/docs/disk";
import { filesDisk } from "../../src/plugins/builtin/files/disk";
import type { DiskEntry } from "../../src/plugins/types";
import type { JsonRow } from "../../src/system/data";

const h = (n: number) => n.toString(16).padStart(64, "0");
const ref = (n: number) => `mwc:${h(n)}`;
const layouts = { files: filesDisk, docs: docsDisk, design: designDisk };

function source(
  tables: Record<string, JsonRow[]>,
  channels: DiskSource["channels"],
  kept = (_: string) => true,
  exportFile?: DiskSource["exportFile"],
  forgotten?: DiskSource["forgotten"],
): DiskSource {
  return {
    categories: [{ id: 1, name: "Art", position: 0 }, { id: 2, name: "Text", position: 1 }],
    channels,
    layoutFor: (type) => layouts[type as keyof typeof layouts],
    rows: (_ext, table) => tables[table] ?? [],
    kept,
    fileExtension: (hash) => (hash === h(9) ? ".png" : ""),
    exportFile,
    forgotten,
  };
}
const paths = (entries: DiskEntry[]) => entries.map((e) => e.path.join("/")).sort();
const textOf = (entries: DiskEntry[], p: string) => (entries.find((e) => e.path.join("/") === p) as { text: string }).text;

describe("diskView", () => {
  it("puts channels in category folders, each type in its own shape", async () => {
    const entries = await diskEntries(source({
      files_entries: [
        { id: 1, channel_id: 10, parent_id: null, kind: "folder", name: "refs" },
        { id: 2, channel_id: 10, parent_id: 1, kind: "file", name: "a.png", url: ref(1) },
        { id: 3, channel_id: 10, parent_id: 1, kind: "file", name: "A.png", url: ref(2) },
        { id: 4, channel_id: 10, parent_id: null, kind: "file", name: "gone.txt", url: ref(3), deleted: true },
      ],
      docs_pages: [
        { id: 5, channel_id: 11, parent_id: null, title: "Guide", body: "Hi ![shot](mwc:" + h(9) + ")", z: 1 },
        { id: 6, channel_id: 11, parent_id: 5, title: "Sub", body: "![shot](mwc:" + h(9) + ")", z: 1 },
      ],
    }, [
      { id: 10, name: "assets", type: "files", categoryId: 1, position: 0 },
      { id: 11, name: "wiki", type: "docs", categoryId: 2, position: 0 },
      { id: 13, name: "plans", type: "git", categoryId: 1, position: 2 },
    ]));
    expect(paths(entries)).toEqual([
      "channels/Art/assets/refs/A (2).png",
      "channels/Art/assets/refs/a.png",
      "channels/Text/wiki/Guide.md",
      "channels/Text/wiki/Guide/Sub.md",
      "channels/Text/wiki/_assets/shot.png",
    ]);
    expect(textOf(entries, "channels/Text/wiki/Guide/Sub.md")).toBe("![shot](../_assets/shot.png)");
  });

  it("leaves a forgotten channel's folder out of the readable folder", async () => {
    const entries = await diskEntries(source({
      files_entries: [{ id: 1, channel_id: 10, parent_id: null, kind: "file", name: "a.png", url: ref(1) }],
      docs_pages: [{ id: 5, channel_id: 11, parent_id: null, title: "Guide", body: "Hi", z: 1 }],
    }, [
      { id: 10, name: "assets", type: "files", categoryId: 1, position: 0 },
      { id: 11, name: "wiki", type: "docs", categoryId: 2, position: 0 },
    ], undefined, undefined, (id) => id === 10));
    expect(paths(entries)).toEqual([
      "channels/Text/wiki/Guide.md",
    ]);
  });

  it("gives channels with the same name their own folders and leaves content that isn't kept out", async () => {
    const entries = await diskEntries(source({
      files_entries: [
        { id: 1, channel_id: 1, parent_id: null, kind: "file", name: "x.zip", url: ref(1) },
        { id: 2, channel_id: 2, parent_id: null, kind: "file", name: "y.zip", url: ref(2) },
        { id: 3, channel_id: 2, parent_id: null, kind: "file", name: "z.zip", url: ref(3) },
      ],
    }, [
      { id: 1, name: "shared", type: "files", categoryId: 1, position: 0 },
      { id: 2, name: "Shared", type: "files", categoryId: 1, position: 1 },
    ], (hash) => hash !== h(2)));
    expect(paths(entries)).toEqual(["channels/Art/Shared (2)/z.zip", "channels/Art/shared/x.zip"]);
  });

  it("writes a design as document.json with its layer tree and assets", async () => {
    const entries = await diskEntries(source({
      design_nodes: [
        { id: 1, channel_id: 5, parent_id: null, kind: "frame", name: "Card", z: 1, x: 0, y: 0, width: 100, height: 50, props: "{}" },
        { id: 2, channel_id: 5, parent_id: 1, kind: "svg", name: "star", z: 1, props: JSON.stringify({ svg: "<svg/>" }) },
      ],
    }, [{ id: 5, name: "UI", type: "design", categoryId: 1, position: 0 }]));
    expect(paths(entries)).toEqual(["channels/Art/UI/.design/document.json", "channels/Art/UI/.design/star.svg"]);
    const doc = JSON.parse(textOf(entries, "channels/Art/UI/.design/document.json"));
    expect(doc.layers[0]).toMatchObject({ name: "Card", width: 100, layers: [{ name: "star", svg: "star.svg" }] });
  });

  it("writes live export embeds as local SVG files", async () => {
    const url = "makework://work/99/export/7";
    const entries = await diskEntries(source({
      docs_pages: [{ id: 8, channel_id: 5, parent_id: null, title: "Guide", body: `See ![Star](${url})`, z: 1 }],
    }, [{ id: 5, name: "Wiki", type: "docs", categoryId: 1, position: 0 }], undefined, async (ref, format) => {
      expect(ref).toBe(url);
      expect(format).toBe("svg");
      return { name: "star", blob: new Blob(["<svg/>"], { type: "image/svg+xml" }) };
    }));
    expect(textOf(entries, "channels/Art/Wiki/Guide.md")).toBe("See ![Star](_assets/star.svg)");
    expect(textOf(entries, "channels/Art/Wiki/_assets/star.svg")).toBe("<svg/>");
  });
});
