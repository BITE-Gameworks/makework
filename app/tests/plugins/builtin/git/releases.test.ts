import { describe, expect, it } from "vitest";
import type { Repo } from "../../../../src/plugins/builtin/git/data";
import { releaseTarget } from "../../../../src/plugins/builtin/git/releases";

const repo = (fields: Partial<Repo>): Repo => ({
  id: 1, provider: "github", host: "github.com", path: "o/r", url: "https://github.com/o/r", defaultBranch: "main", importedBy: 1, importedAt: null,
  subPath: "", pinned: "", subrepos: false, ...fields,
});

describe("where a repository's releases go", () => {
  it("goes to the repository's own GitHub or GitLab", () => {
    expect(releaseTarget(repo({}))).toEqual({ kind: "github", host: "github.com", path: "o/r" });
    expect(releaseTarget(repo({ provider: "gitlab", host: "gitlab.com", path: "group/sub/project" })))
      .toEqual({ kind: "gitlab", host: "gitlab.com", path: "group/sub/project" });
    expect(releaseTarget(repo({ provider: "gitlab", host: "code.example.org", path: "team/app" })))
      .toEqual({ kind: "gitlab", host: "code.example.org", path: "team/app" });
  });

  it("goes to a local folder's origin on GitHub or GitLab, and nowhere without one", () => {
    expect(releaseTarget(repo({ provider: "local", host: "", path: "app", url: "git@github.com:o/r.git" }))).toEqual({ kind: "github", host: "github.com", path: "o/r" });
    expect(releaseTarget(repo({ provider: "local", host: "", path: "app", url: "https://gitlab.example.com/team/app.git" })))
      .toEqual({ kind: "gitlab", host: "gitlab.example.com", path: "team/app" });
    expect(releaseTarget(repo({ provider: "local", host: "", path: "app", url: "" }))).toBeNull();
    expect(releaseTarget(repo({ provider: "local", host: "", path: "app", url: "https://bitbucket.org/o/r.git" }))).toBeNull();
  });
});
