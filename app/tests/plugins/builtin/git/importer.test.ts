import { describe, expect, it } from "vitest";
import { ApiClient } from "../../../../src/api/client";
import { MockTransport } from "../../../../src/mock/transport";
import { describeSkipped, importRepo, importTree, maxDepth, maxRepos } from "../../../../src/plugins/builtin/git/importer";
import { ShownError } from "../../../../src/api/client";
import type { RepoReader, Submodule } from "../../../../src/plugins/builtin/git/providers";
import { MockBackend } from "../../../../src/system/backend";
import { git, type ImportedCommit } from "../../../../src/system/git";

function client() {
  const backend = new MockBackend();
  backend.load(git);
  return new ApiClient(new MockTransport(backend, 0)).plugin("git");
}

const sha = (n: number) => n.toString(16).padStart(8, "0");
const commit = (n: number, parents: number[]): ImportedCommit => ({
  sha: sha(n), parents: parents.map(sha), author_name: "Ann", author_email: "a@x",
  authored_at: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(), message: `commit ${n} 🎉`,
});

// A repository whose `main` is commits 1..n in a line, and `dev` branches off at 10 with commits 5001..5003.
function repository(n: number) {
  const all = new Map<string, ImportedCommit>();
  for (let i = 1; i <= n; i++) all.set(sha(i), commit(i, i > 1 ? [i - 1] : []));
  for (let i = 5001; i <= 5003; i++) all.set(sha(i), commit(i, [i === 5001 ? 10 : i - 1]));
  let heads = { main: sha(n), dev: sha(5003) };
  const reader: RepoReader & { calls: string[]; grow(to: number): void } = {
    calls: [],
    defaultBranch: async () => "main",
    branches: async () => Object.entries(heads).map(([name, head]) => ({ name, head })),
    diff: async () => ({ files: [], truncated: false }),
    async history(from, max, known) {
      reader.calls.push(from);
      let at: string | undefined = from in heads ? heads[from as keyof typeof heads] : from;
      const out: ImportedCommit[] = [];
      while (at && out.length < max) {
        const c: ImportedCommit = all.get(at)!;
        if (known(c.sha)) break;
        out.push(c);
        at = c.parents[0];
      }
      return out;
    },
    grow(to) {
      for (let i = n + 1; i <= to; i++) all.set(sha(i), commit(i, [i - 1]));
      heads = { ...heads, main: sha(to) };
    },
  };
  return reader;
}

describe("importing a repository", () => {
  it("brings the newest 1,000 per branch in batches, then only what's new, then older commits", async () => {
    const api = client();
    await api.call("set-repo", { channel_id: 1, provider: "github", host: "github.com", path: "o/r", url: "https://github.com/o/r" });
    const repo = repository(1500);
    const progress: number[] = [];
    const first = await importRepo(api, 1, repo, "first", (p) => p.sent && progress.push(p.sent));
    // main: 1500..501; dev: 5003..5001 and then commit 10, which main didn't reach.
    expect(first.added).toBe(1000 + 3 + 10);
    expect(progress).toEqual([200, 400, 600, 800, 1000, 1013]);
    const main = await api.call<{ rows: { message: string }[]; total: number; truncated: boolean }>("list-commits", { channel_id: 1, branch: "main", limit: 5 });
    expect(main.total).toBe(1000);
    expect(main.truncated).toBe(true);
    expect(main.rows[0].message).toBe("commit 1500 :tada:");

    // Messages from Windows repositories come with \r\n line ends.
    const windows = { ...commit(9001, [1500]), message: "Fix it\r\n\r\nDetails here\r\n" };
    await importRepo(api, 1, { ...repo, history: async (_from, _max, known) => (known(windows.sha) ? [] : [windows]) }, "update");
    const [fix] = await api.read("git_commits", { sha: windows.sha });
    expect(fix.message).not.toContain("\r");
    expect(String(fix.message).split("\n")).toEqual(["Fix it", "", "Details here"]);

    repo.grow(1502);
    expect((await importRepo(api, 1, repo, "update")).added).toBe(2);

    const older = await importRepo(api, 1, repo, "older");
    expect(older.added).toBe(490);
    const after = await api.call<{ total: number; truncated: boolean }>("list-commits", { channel_id: 1, branch: "main" });
    expect(after).toMatchObject({ total: 1502, truncated: false });
  });
});

// A small repository with one branch of `count` commits starting at `start`, and the submodules it records.
function small(start: number, count: number, submodules: Submodule[] = []): RepoReader {
  const commits = Array.from({ length: count }, (_, i) => commit(start + i, i ? [start + i - 1] : []));
  return {
    defaultBranch: async () => "main",
    branches: async () => [{ name: "main", head: sha(start + count - 1) }],
    diff: async () => ({ files: [], truncated: false }),
    history: async (_from, max, known) => [...commits].reverse().filter((c) => !known(c.sha)).slice(0, max),
    submodules: async () => submodules,
  };
}
const at = (path: string, repo: string, pinned = "abcdef1"): Submodule => ({ path, url: `https://github.com/o/${repo}.git`, pinned });

describe("importing a repository with its submodules", () => {
  async function channel() {
    const api = client();
    await api.call("set-repo", { channel_id: 1, provider: "github", host: "github.com", path: "o/main", subrepos: true });
    const repos = async () => Object.fromEntries((await api.call<{ rows: Record<string, unknown>[] }>("list-repos", { channel_id: 1 })).rows
      .map((row) => [String(row.sub_path), `${row.provider}:${row.host}/${row.path}@${row.pinned}`]));
    const count = async (sub: string) => (await api.call<{ shas: string }>("known-shas", { channel_id: 1, sub })).shas.split("\n").filter(Boolean).length;
    return { api, repos, count };
  }

  it("imports each one into the channel under its path, and looks inside it", async () => {
    const { api, repos, count } = await channel();
    const readers: Record<string, RepoReader> = {
      lib: small(100, 3, [at("vendor/x", "x", "1234567")]),
      "lib/vendor/x": small(200, 2),
      tool: small(300, 1),
    };
    const opened: string[] = [];
    const progress = new Set<string>();
    const result = await importTree(api, 1, { reader: small(1, 4, [at("lib", "lib"), at("tool", "tool")]), fromFolder: false }, "first",
      async (sub) => { opened.push(sub); return readers[sub]; }, (p) => progress.add(p.sub ?? ""));
    expect(result).toEqual({ added: 4 + 3 + 2 + 1, skipped: [] });
    expect(opened).toEqual(["lib", "tool", "lib/vendor/x"]);
    expect(await repos()).toEqual({
      "": "github:github.com/o/main@", lib: "github:github.com/o/lib@abcdef1", "lib/vendor/x": "github:github.com/o/x@1234567",
      tool: "github:github.com/o/tool@abcdef1",
    });
    expect([await count("lib"), await count("lib/vendor/x"), await count("tool")]).toEqual([3, 2, 1]);
    expect([...progress].sort()).toEqual(["", "lib", "lib/vendor/x", "tool"]);
    const lib = await api.call<{ repo: Record<string, unknown>; branches: unknown[] }>("get-repo", { channel_id: 1, sub: "lib" });
    expect([lib.repo.default_branch, lib.branches.length]).toEqual(["main", 1]);

    // An update: only what is new, and a submodule that left the repository leaves the channel.
    readers.lib = small(100, 5, [at("vendor/x", "x", "7654321")]);
    const update = await importTree(api, 1, { reader: small(1, 4, [at("lib", "lib", "abcdef2")]), fromFolder: false }, "update", async (sub) => readers[sub]);
    expect(update.added).toBe(2);
    expect(await repos()).toEqual({ "": "github:github.com/o/main@", lib: "github:github.com/o/lib@abcdef2", "lib/vendor/x": "github:github.com/o/x@7654321" });
  });

  it("goes on past a submodule it can't read, and says which", async () => {
    const { api, repos, count } = await channel();
    const main = small(1, 2, [at("private", "private"), at("lib", "lib"), { path: "odd", url: "/srv/git/odd.git", pinned: "abcdef1" }, at("away", "away")]);
    const result = await importTree(api, 1, { reader: main, fromFolder: false }, "first", async (sub) => {
      if (sub === "private") throw new ShownError("github.com wants a token for this repository.");
      return sub === "lib" ? small(100, 3) : null;
    });
    expect(result.added).toBe(5);
    expect(result.skipped).toEqual([
      { sub: "odd", reason: "Its link (/srv/git/odd.git) isn't a GitHub or GitLab one." },
      { sub: "private", reason: "github.com wants a token for this repository." },
      { sub: "away", reason: "This device can't read it." },
    ]);
    // The ones with a link stay listed for a member who can read them.
    expect(Object.keys(await repos()).sort()).toEqual(["", "away", "lib", "private"]);
    expect(await count("lib")).toBe(3);
    expect(describeSkipped(result.skipped)).toBe("3 submodules weren't imported: odd (Its link (/srv/git/odd.git) isn't a GitHub or GitLab one), "
      + "private (github.com wants a token for this repository), away (This device can't read it).");
    expect(describeSkipped([])).toBe("");
  });

  it("saves a folder's submodules like the folder itself, with or without a link", async () => {
    const api = client();
    await api.call("set-repo", { channel_id: 1, provider: "local", host: "", path: "main", subrepos: true });
    const main = small(1, 1, [{ ...at("vendor/lib", "lib"), folder: "/repo/vendor/lib" }, { path: "local-only", url: "", pinned: "abcdef1", folder: "/repo/local-only" }]);
    const folders: (string | null | undefined)[] = [];
    const result = await importTree(api, 1, { reader: main, fromFolder: true }, "first", async (_sub, submodule) => { folders.push(submodule.folder); return small(100, 1); });
    expect(result.skipped).toEqual([]);
    expect(folders).toEqual(["/repo/vendor/lib", "/repo/local-only"]);
    const rows = (await api.call<{ rows: Record<string, unknown>[] }>("list-repos", { channel_id: 1 })).rows.filter((row) => row.sub_path);
    expect(rows.map((row) => [row.sub_path, row.provider, row.path, row.url])).toEqual([
      ["vendor/lib", "local", "lib", "https://github.com/o/lib"], ["local-only", "local", "local-only", ""],
    ]);
  });

  it("stops at a repository that contains itself, at the deepest level and at the most repositories", async () => {
    const { api, repos } = await channel();
    // "loop" records itself as its own submodule: read once inside itself, then not again.
    const loop: RepoReader = small(100, 1, [at("again", "loop")]);
    await importTree(api, 1, { reader: small(1, 1, [at("loop", "loop")]), fromFolder: false }, "first", async () => loop);
    expect(Object.keys(await repos()).sort()).toEqual(["", "loop", "loop/again"]);

    // A chain of different repositories, each inside the last.
    let depth = 0;
    const chain = (n: number): RepoReader => small(1000 * n, 1, [at("next", `chain-${n}`)]);
    await api.call("set-repo", { channel_id: 1, provider: "github", host: "github.com", path: "o/main", subrepos: true });
    await importTree(api, 1, { reader: chain(0), fromFolder: false }, "first", async () => chain(++depth));
    expect(Object.keys(await repos())).toHaveLength(1 + maxDepth);

    await api.call("set-repo", { channel_id: 1, provider: "github", host: "github.com", path: "o/main", subrepos: true });
    const many = Array.from({ length: maxRepos + 5 }, (_, i) => at(`m${i}`, `m${i}`));
    const wide = await importTree(api, 1, { reader: small(1, 1, many), fromFolder: false }, "first", async () => small(500, 1));
    expect(Object.keys(await repos())).toHaveLength(maxRepos);
    expect(wide.skipped).toHaveLength(6);
    expect(wide.skipped[0].reason).toBe(`A channel holds at most ${maxRepos} repositories.`);
  });

  it("stops when cancelled", async () => {
    const { api } = await channel();
    const stop = new AbortController();
    const main = small(1, 1, [at("lib", "lib"), at("tool", "tool")]);
    const run = importTree(api, 1, { reader: main, fromFolder: false }, "first", async (sub) => { if (sub === "tool") stop.abort(); return small(100, 1); },
      () => {}, stop.signal);
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
  });
});
