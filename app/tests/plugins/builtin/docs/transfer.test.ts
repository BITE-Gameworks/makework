import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { DocPage } from "../../../../src/plugins/builtin/docs/data";
import {
  expandZips, exportFiles, importTree, linkedFile, pageCount, withImages, type ImportEntry, type ImportPage,
} from "../../../../src/plugins/builtin/docs/transfer";

const entry = (path: string, text = ""): ImportEntry => {
  const parts = path.split("/");
  return { path: parts, file: new File([text], parts.at(-1)!) };
};
// Titles as a nested outline, "+" for pages with their own .md file.
const outline = (pages: ImportPage[]): unknown => pages.map((p) => (p.children.length ? { [`${p.file ? "+" : ""}${p.title}`]: outline(p.children) } : `${p.file ? "+" : ""}${p.title}`));

describe("importTree", () => {
  it("makes pages of .md files, folders hold their pages, Title.md and Title/ are one page", () => {
    const tree = importTree([
      entry("notes/Guide.md"), entry("notes/Guide/Setup.md"), entry("notes/Guide/Setup/Linux.md"),
      entry("notes/Ideas/Later.md"), entry("notes/Pictures/cat.png"), entry("notes/readme.txt"),
      entry("notes/Chapter 10.md"), entry("notes/Chapter 2.md"), entry("notes/_assets/x.md"),
    ]);
    // The picked folder "notes" itself isn't a page; empty-of-.md folders and _assets aren't either.
    expect(outline(tree)).toEqual([
      "+Chapter 2", "+Chapter 10", { "+Guide": [{ "+Setup": ["+Linux"] }] }, { Ideas: ["+Later"] },
    ]);
    expect(pageCount(tree)).toBe(7);
  });

  it("keeps the top level when files come from several places", () => {
    expect(outline(importTree([entry("a.md"), entry("b/c.md")]))).toEqual(["+a", { b: ["+c"] }]);
    expect(importTree([entry("photo.png")])).toEqual([]);
  });

  it("imports what is inside .zip files", async () => {
    const zip = zipSync({ "Top.md": strToU8("# top"), "Top/Sub.md": strToU8("sub"), "_assets/a.png": new Uint8Array([1]) });
    const entries = await expandZips([{ path: ["export.zip"], file: new File([zip as BlobPart], "export.zip") }]);
    expect(entries.map((e) => e.path.join("/")).sort()).toEqual(["Top.md", "Top/Sub.md", "_assets/a.png"]);
    expect(outline(importTree(entries))).toEqual([{ "+Top": ["+Sub"] }]);
    expect(await entries.find((e) => e.file.name === "Top.md")!.file.text()).toBe("# top");
  });
});

describe("image links", () => {
  const png = new File([new Uint8Array([1])], "a b.png");
  const other = new File([new Uint8Array([2])], "b.png");
  const byPath = new Map([["docs/img/a b.png", png], ["img/b.png", other]]);

  it("finds imported files by relative path", () => {
    expect(linkedFile("img/a%20b.png", ["docs", "page.md"], byPath)).toBe(png);
    expect(linkedFile("./img/a b.png", ["docs", "page.md"], byPath)).toBe(png);
    expect(linkedFile("../img/b.png", ["docs", "page.md"], byPath)).toBe(other);
    expect(linkedFile("https://example.com/b.png", ["page.md"], byPath)).toBeNull();
    expect(linkedFile("../../b.png", ["docs", "page.md"], byPath)).toBeNull();
  });

  it("writes refs for found images and leaves the rest", async () => {
    const text = "![A](img/a%20b.png) ![web](https://x.y/z.png) ![gone](nope.png) ![again](<img/a b.png> \"t\")";
    const out = await withImages(text, ["docs", "page.md"], byPath, async (file) => `mwc:${file === png ? "aa" : "bb"}`);
    expect(out).toBe("![A](mwc:aa) ![web](https://x.y/z.png) ![gone](nope.png) ![again](<mwc:aa> \"t\")");
  });
});

describe("exportFiles", () => {
  const page = (id: number, title: string, parentId: number | null, z = id): DocPage => ({ id, title, parentId, z, updatedBy: 1, updatedAt: "" });
  const hash = "a".repeat(64);
  const pages = [page(1, "Guide", null), page(2, "Setup", 1), page(3, "Linux", 2), page(4, "Guide", null), page(5, "Other", null)];
  const bodies = new Map([[1, "guide"], [2, "setup"], [3, `![x](mwc:${hash}) and mwc:${"b".repeat(64)}`], [4, "second"], [5, "other"]]);

  it("writes chosen pages, folders for the ones holding chosen pages, numbered duplicate names", () => {
    expect(exportFiles(pages, bodies, new Set([1, 2, 3, 4, 5]))).toEqual({
      "Guide.md": "guide", "Guide/Setup.md": "setup", "Guide/Setup/Linux.md": `![x](mwc:${hash}) and mwc:${"b".repeat(64)}`,
      "Guide (2).md": "second", "Other.md": "other",
    });
    expect(Object.keys(exportFiles(pages, bodies, new Set([3, 5])))).toEqual(["Guide/Setup/Linux.md", "Other.md"]);
  });

  it("links images in _assets/ from each page's depth", () => {
    const files = exportFiles(pages, bodies, new Set([3]), new Map([[hash, "aaaa.png"]]));
    expect(files["Guide/Setup/Linux.md"]).toBe(`![x](../../_assets/aaaa.png) and mwc:${"b".repeat(64)}`);
  });
});
