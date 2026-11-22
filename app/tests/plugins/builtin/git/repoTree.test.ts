import { describe, expect, it } from "vitest";
import { repoTree, type Repo } from "../../../../src/plugins/builtin/git/data";

const repo = (subPath: string): Repo => ({
  id: subPath.length + 1, provider: "github", host: "github.com", path: subPath ? `o/${subPath}` : "o/app", url: "", defaultBranch: "main",
  importedBy: 1, importedAt: null, subPath, pinned: "", subrepos: true,
});

const shape = (paths: string[]) => repoTree(paths.map(repo)).map((r) => [r.repo.subPath, r.depth, r.name, r.last, r.parentsLast]);

describe("the channel's repositories as a tree", () => {
  it("puts the main repository first and each submodule under the one whose folder holds it", () => {
    expect(shape(["a-c", "a/b", "", "a", "a/b/deep", "vendor/lib"])).toEqual([
      ["", 0, "app", true, []],
      ["a", 1, "a", false, []],
      ["a/b", 2, "b", true, [false]],
      ["a/b/deep", 3, "deep", true, [false, true]],
      ["a-c", 1, "a-c", false, []],
      // No `vendor` submodule: it hangs under the main repository by its whole path.
      ["vendor/lib", 1, "vendor/lib", true, []],
    ]);
  });

  it("shows submodules from the top when the main repository is missing", () => {
    expect(shape(["x", "x/y"])).toEqual([["x", 1, "x", true, []], ["x/y", 2, "y", true, [true]]]);
  });
});
