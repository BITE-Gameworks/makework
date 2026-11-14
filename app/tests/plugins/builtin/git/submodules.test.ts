import { describe, expect, it } from "vitest";
import { parseGitmodules, resolveSubmoduleUrl } from "../../../../src/plugins/builtin/git/submodules";

describe("a repository's submodules", () => {
  it("reads the paths and links .gitmodules lists", () => {
    const text = [
      "# Third-party code",
      '[submodule "app"]',
      "\tpath = makework",
      "\turl = https://github.com/BITE-Gameworks/makework.git",
      "\tbranch = main",
      "",
      '[submodule "vendor lib"]',
      '  path = "vendor/lib/"',
      "  url = ../lib.git",
      "[core]",
      "  path = not/a/submodule",
    ].join("\r\n");
    expect(parseGitmodules(text)).toEqual([
      { path: "makework", url: "https://github.com/BITE-Gameworks/makework.git" },
      { path: "vendor/lib", url: "../lib.git" },
    ]);
  });

  it("leaves out entries without a path or with one outside the repository", () => {
    const entry = (path: string) => `[submodule "x"]\n\tpath = ${path}\n\turl = https://example.com/x.git\n`;
    expect(parseGitmodules(`[submodule "none"]\n\turl = https://example.com/x.git\n`)).toEqual([]);
    for (const path of ["../outside", "/etc", "a/../../b", "C:/Windows", "-option", "a//b"]) expect(parseGitmodules(entry(path))).toEqual([]);
    expect(parseGitmodules(entry("inside\\folder")).map((s) => s.path)).toEqual(["inside/folder"]);
  });

  it("reads a relative link against its repository's own, as git does", () => {
    expect(resolveSubmoduleUrl("https://github.com/o/main", "https://gitlab.com/g/lib.git")).toBe("https://gitlab.com/g/lib.git");
    expect(resolveSubmoduleUrl("https://github.com/o/main", "../lib.git")).toBe("https://github.com/o/lib.git");
    expect(resolveSubmoduleUrl("https://github.com/o/main.git/", "../../other/lib")).toBe("https://github.com/other/lib");
    expect(resolveSubmoduleUrl("https://gitlab.com/group/sub/main", "./nested.git")).toBe("https://gitlab.com/group/sub/main/nested.git");
    expect(resolveSubmoduleUrl("git@gitlab.com:group/main.git", "../lib.git")).toBe("git@gitlab.com:group/lib.git");
    expect(resolveSubmoduleUrl("", "../lib.git")).toBe("");
  });
});
