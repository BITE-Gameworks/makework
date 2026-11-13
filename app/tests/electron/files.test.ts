import { describe, expect, it } from "vitest";
import path from "node:path";
import { caseFreePaths, isInside, removeOrDefer, safeSegment } from "../../electron/files.js";

describe("file names on every system", () => {
  it("replaces characters Windows refuses", () => {
    expect(safeSegment('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j");
    expect(safeSegment("tab\there")).toBe("tab_here");
  });

  it("keeps away from Windows device names, in any case and with an extension", () => {
    expect(safeSegment("CON")).toBe("CON_");
    expect(safeSegment("nul.txt")).toBe("nul_.txt");
    expect(safeSegment("Com3.tar.gz")).toBe("Com3_.tar.gz");
    expect(safeSegment("console.log")).toBe("console.log");
    expect(safeSegment("LPT10")).toBe("LPT10");
  });

  it("drops trailing dots and spaces, which Windows would drop silently", () => {
    expect(safeSegment("report. ")).toBe("report");
    expect(safeSegment("...")).toBe("_");
    expect(safeSegment("..")).toBe("_");
    expect(safeSegment("  ")).toBe("_");
    expect(safeSegment(".hidden")).toBe(".hidden");
  });

  it("numbers names that only differ in case, the same way every time", () => {
    const paths = [["docs", "README.md"], ["Docs", "notes.txt"], ["docs", "Readme.md"], ["docs", "readme.md"]];
    const named = caseFreePaths(paths);
    // Assigned in sorted order: "Docs" sorts before "docs".
    expect(named).toEqual([["docs (2)", "README.md"], ["Docs", "notes.txt"], ["docs (2)", "Readme (2).md"], ["docs (2)", "readme (3).md"]]);
    expect(caseFreePaths([...paths].reverse())).toEqual([...named].reverse());
  });

  it("defers a busy file instead of failing", async () => {
    const later: string[] = [];
    const busy = async () => {
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    };
    await expect(removeOrDefer("/x/content/abc", { rm: busy, later: async (f) => void later.push(f) })).resolves.toBeUndefined();
    expect(later).toEqual(["/x/content/abc"]);
    const removed: string[] = [];
    await removeOrDefer("/x/content/def", { rm: async (f) => void removed.push(f), later: async (f) => void later.push(f) });
    expect(removed).toEqual(["/x/content/def"]);
  });
});

describe("isInside", () => {
  it("is true only for paths below the folder", () => {
    expect(isInside("/a", "/a/b/c")).toBe(true);
    expect(isInside("/a", "/a/..foo")).toBe(true);
    expect(isInside("/a", "/a")).toBe(false);
    expect(isInside("/a", "/a/../b")).toBe(false);
    expect(isInside("/a", "/ab")).toBe(false);
  });
  it("follows Windows paths, where a backslash is a separator", () => {
    expect(isInside("C:\\run", "C:\\run\\src\\a.ts", path.win32)).toBe(true);
    expect(isInside("C:\\run", "C:\\run\\..\\x.exe", path.win32)).toBe(false);
    expect(isInside("C:\\run", "D:\\run\\a", path.win32)).toBe(false);
  });
});
