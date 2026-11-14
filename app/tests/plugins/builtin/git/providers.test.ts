import { describe, expect, it } from "vitest";
import { RepoAccessError, parseRepoLink, readerFor } from "../../../../src/plugins/builtin/git/providers";

// A fetch that answers from a table of URL -> JSON (or a status), and records the requests.
function stubFetch(routes: Record<string, unknown | { status: number; headers?: Record<string, string> }>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const route = routes[url];
    if (route && typeof route === "object" && "status" in (route as object))
      return new Response("{}", { status: (route as { status: number }).status, headers: (route as { headers?: Record<string, string> }).headers });
    if (route === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(route), { status: 200 });
  }) as typeof fetch;
  return { fn, calls };
}

const ghCommit = (sha: string, parents: string[], message = `m ${sha}`) =>
  ({ sha, parents: parents.map((p) => ({ sha: p })), commit: { author: { name: "Ann", email: "a@x", date: "2026-01-01T00:00:00Z" }, message } });

describe("repository links", () => {
  it("reads GitHub and GitLab links in their https and ssh forms", () => {
    expect(parseRepoLink("https://github.com/owner/repo.git")).toMatchObject({ provider: "github", host: "github.com", path: "owner/repo" });
    expect(parseRepoLink("https://github.com/owner/repo/tree/main/src")).toMatchObject({ path: "owner/repo", url: "https://github.com/owner/repo" });
    expect(parseRepoLink("git@github.com:owner/repo.git")).toMatchObject({ provider: "github", path: "owner/repo" });
    expect(parseRepoLink("https://gitlab.com/group/sub/project/-/tree/main")).toMatchObject({ provider: "gitlab", path: "group/sub/project" });
    expect(parseRepoLink("ssh://git@gitlab.example.org:2222/team/app.git")).toMatchObject({ provider: "gitlab", host: "gitlab.example.org", path: "team/app" });
    expect(parseRepoLink("https://code.example.org/team/app")).toMatchObject({ provider: null, host: "code.example.org" });
    expect(parseRepoLink("not a link")).toBeNull();
    expect(parseRepoLink("https://github.com/")).toBeNull();
  });
});

const base64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const gitmodules = { content: base64('[submodule "lib"]\n\tpath = vendor/lib\n\turl = ../lib.git\n[submodule "tool"]\n\tpath = tool\n\turl = https://gitlab.com/g/tool.git\n'
  + '[submodule "gone"]\n\tpath = gone\n\turl = https://github.com/o/gone\n') };

describe("GitHub reader", () => {
  const api = "https://api.github.com/repos/o/r";

  it("finds the submodules a commit records, with their links made whole", async () => {
    const { fn, calls } = stubFetch({
      [`${api}/contents/.gitmodules?ref=abc1234`]: gitmodules,
      [`${api}/git/trees/abc1234?recursive=1`]: { tree: [
        { path: "README.md", type: "blob", sha: "f00" }, { path: "vendor/lib", type: "commit", sha: "1111111" }, { path: "tool", type: "commit", sha: "2222222" },
      ] },
    });
    const reader = readerFor({ provider: "github", host: "github.com", path: "o/r" }, null, fn);
    // "gone" is listed but no longer in the tree.
    expect(await reader.submodules!("abc1234")).toEqual([
      { path: "vendor/lib", url: "https://github.com/o/lib.git", pinned: "1111111" },
      { path: "tool", url: "https://gitlab.com/g/tool.git", pinned: "2222222" },
    ]);
    expect(calls).toHaveLength(2);
  });

  it("asks for nothing more when the repository has no .gitmodules, and path by path when its tree is too large", async () => {
    const none = stubFetch({});
    expect(await readerFor({ provider: "github", host: "github.com", path: "o/r" }, null, none.fn).submodules!("main")).toEqual([]);
    expect(none.calls).toHaveLength(1);
    const { fn } = stubFetch({
      [`${api}/contents/.gitmodules?ref=main`]: gitmodules,
      [`${api}/git/trees/main?recursive=1`]: { tree: [{ path: "tool", type: "commit", sha: "2222222" }], truncated: true },
      [`${api}/contents/vendor/lib?ref=main`]: { type: "submodule", sha: "1111111" },
    });
    const found = await readerFor({ provider: "github", host: "github.com", path: "o/r" }, null, fn).submodules!("main");
    expect(found.map((s) => [s.path, s.pinned])).toEqual([["vendor/lib", "1111111"], ["tool", "2222222"]]);
  });
  it("sends the token, pages through commits and stops at what is known", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ghCommit(`a${String(i).padStart(3, "0")}`, [`a${String(i + 1).padStart(3, "0")}`]));
    const page2 = [ghCommit("a100", ["0ld"]), ghCommit("0ld", [])];
    const { fn, calls } = stubFetch({
      [api]: { default_branch: "main" },
      [`${api}/branches?per_page=100&page=1`]: [{ name: "main", commit: { sha: "a000" } }],
      [`${api}/commits?sha=main&per_page=100&page=1`]: page1,
      [`${api}/commits?sha=main&per_page=100&page=2`]: page2,
    });
    const reader = readerFor({ provider: "github", host: "github.com", path: "o/r" }, "secret", fn);
    expect(await reader.defaultBranch()).toBe("main");
    expect(await reader.branches()).toEqual([{ name: "main", head: "a000" }]);
    const commits = await reader.history("main", 1000, (sha) => sha === "0ld");
    expect(commits).toHaveLength(101);
    expect(commits[0]).toMatchObject({ sha: "a000", parents: ["a001"], author_name: "Ann", message: "m a000" });
    expect(calls.every((c) => c.headers.Authorization === "Bearer secret")).toBe(true);
  });

  it("stops at the limit", async () => {
    const page = Array.from({ length: 100 }, (_, i) => ghCommit(`b${i}`, []));
    const { fn, calls } = stubFetch({ [`${api}/commits?sha=main&per_page=100&page=1`]: page });
    const commits = await readerFor({ provider: "github", host: "github.com", path: "o/r" }, null, fn).history("main", 30, () => false);
    expect(commits).toHaveLength(30);
    expect(calls).toHaveLength(1);
  });

  it("explains refusals", async () => {
    const reader = (route: unknown) => readerFor({ provider: "github", host: "github.com", path: "o/r" }, null, stubFetch({ [api]: route }).fn);
    await expect(reader({ status: 401 }).defaultBranch()).rejects.toThrow(/github\.com wants a token/);
    await expect(reader({ status: 404 }).defaultBranch()).rejects.toThrow(/not found.*private/);
    await expect(reader({ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" } }).defaultBranch())
      .rejects.toThrow(/rate limit/);
  });

  // The view asks for a token only when one would let the request through (RepoAccessError): never for "already up to
  // date", an unreachable host or a server error, and not for a rate limit the token already raised. Asking anyway told
  // members who had signed in to GitHub that they couldn't.
  it("tells refusals a token would fix from the rest, and says so when a token was already sent", async () => {
    const reader = (route: unknown, token: string | null = null) =>
      readerFor({ provider: "github", host: "github.com", path: "o/r" }, token, stubFetch({ [api]: route }).fn);
    const failure = (promise: Promise<unknown>) => promise.then(() => null, (e: unknown) => e as Error);
    const limit = { status: 403, headers: { "x-ratelimit-remaining": "0" } };

    for (const route of [{ status: 401 }, { status: 404 }, limit]) expect(await failure(reader(route).defaultBranch())).toBeInstanceOf(RepoAccessError);
    const refused = await failure(reader({ status: 401 }, "kept").defaultBranch());
    expect(refused).toBeInstanceOf(RepoAccessError);
    expect(refused?.message).toMatch(/token for github\.com was refused/);
    const hidden = await failure(reader({ status: 404 }, "kept").defaultBranch());
    expect(hidden).toBeInstanceOf(RepoAccessError);
    expect(hidden?.message).toMatch(/token for github\.com can't read it/);

    expect(await failure(reader(limit, "kept").defaultBranch())).not.toBeInstanceOf(RepoAccessError);
    expect(await failure(reader({ status: 502 }, "kept").defaultBranch())).not.toBeInstanceOf(RepoAccessError);
    const offline = readerFor({ provider: "github", host: "github.com", path: "o/r" }, "kept", (async () => {
      throw new TypeError("network down");
    }) as typeof fetch);
    expect(await failure(offline.defaultBranch())).not.toBeInstanceOf(RepoAccessError);
  });
});

describe("GitLab reader", () => {
  it("finds the submodules a commit records in its folders' listings", async () => {
    const api = "https://gitlab.example.org/api/v4/projects/team%2Fapp";
    const { fn } = stubFetch({
      [`${api}/repository/files/.gitmodules?ref=main`]: gitmodules,
      [`${api}/repository/tree?ref=main&path=vendor&per_page=100&page=1`]: [{ id: "1111111", path: "vendor/lib", type: "commit" }, { id: "d1", path: "vendor/x", type: "tree" }],
      [`${api}/repository/tree?ref=main&path=&per_page=100&page=1`]: [{ id: "2222222", path: "tool", type: "commit" }, { id: "b1", path: "gone", type: "blob" }],
    });
    const reader = readerFor({ provider: "gitlab", host: "gitlab.example.org", path: "team/app" }, null, fn);
    expect(await reader.submodules!("main")).toEqual([
      { path: "vendor/lib", url: "https://gitlab.example.org/team/lib.git", pinned: "1111111" },
      { path: "tool", url: "https://gitlab.com/g/tool.git", pinned: "2222222" },
    ]);
  });

  it("uses the project API with the PRIVATE-TOKEN header", async () => {
    const api = "https://gitlab.example.org/api/v4/projects/team%2Fapp";
    const { fn, calls } = stubFetch({
      [`${api}/repository/branches?per_page=100&page=1`]: [{ name: "dev", commit: { id: "c1" } }],
      [`${api}/repository/commits?ref_name=dev&per_page=100&page=1`]: [
        { id: "c1", parent_ids: ["c0"], author_name: "Bo", author_email: "b@x", authored_date: "2026-02-02T10:00:00Z", message: "two" },
        { id: "c0", parent_ids: [], author_name: "Bo", author_email: "b@x", authored_date: "2026-02-01T10:00:00Z", message: "one" },
      ],
    });
    const reader = readerFor({ provider: "gitlab", host: "gitlab.example.org", path: "team/app" }, "glpat", fn);
    expect(await reader.branches()).toEqual([{ name: "dev", head: "c1" }]);
    expect((await reader.history("dev", 1000, () => false)).map((c) => [c.sha, c.parents])).toEqual([["c1", ["c0"]], ["c0", []]]);
    expect(calls.every((c) => c.headers["PRIVATE-TOKEN"] === "glpat")).toBe(true);
  });
});

describe("commit diffs from the hosts", () => {
  it("reads GitHub's files of a commit, binary ones without a patch", async () => {
    const api = "https://api.github.com/repos/o/r";
    const { fn } = stubFetch({
      [`${api}/commits/abc1234?per_page=100&page=1`]: {
        files: [
          { filename: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-x\n+y" },
          { filename: "new.md", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+hi" },
          { filename: "b.ts", previous_filename: "a.ts", status: "renamed", additions: 0, deletions: 0 },
          { filename: "logo.png", status: "removed", additions: 0, deletions: 0 },
        ],
      },
    });
    const diff = await readerFor({ provider: "github", host: "github.com", path: "o/r" }, null, fn).diff("abc1234");
    expect(diff.truncated).toBe(false);
    expect(diff.files.map((f) => [f.path, f.oldPath, f.status, f.binary])).toEqual([
      ["src/a.ts", "src/a.ts", "modified", false], ["new.md", null, "added", false], ["b.ts", "a.ts", "renamed", true],
      ["logo.png", "logo.png", "deleted", true],
    ]);
    expect(diff.files[0].lines.map((l) => l.kind)).toEqual(["hunk", "del", "add"]);
  });

  it("reads GitLab's diff of a commit", async () => {
    const api = "https://gitlab.com/api/v4/projects/g%2Fp";
    const { fn } = stubFetch({
      [`${api}/repository/commits/abc1234/diff?per_page=100&page=1`]: [
        { old_path: "a.txt", new_path: "a.txt", new_file: false, deleted_file: false, renamed_file: false, diff: "@@ -1 +1 @@\n-a\n+b\n" },
        { old_path: "gone.txt", new_path: "gone.txt", new_file: false, deleted_file: true, renamed_file: false, diff: "@@ -1 +0,0 @@\n-x\n" },
      ],
    });
    const diff = await readerFor({ provider: "gitlab", host: "gitlab.com", path: "g/p" }, null, fn).diff("abc1234");
    expect(diff.files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([["a.txt", "modified", 1, 1], ["gone.txt", "deleted", 0, 1]]);
  });
});
