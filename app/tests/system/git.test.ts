import { describe, expect, it } from "vitest";
import { ApiClient, ApiRequestError } from "../../src/api/client";
import { MockTransport } from "../../src/mock/transport";
import { MockBackend } from "../../src/system/backend";
import { git } from "../../src/system/git";

describe("git plugin", () => {
  it("keeps a channel's build configurations, with the system they were written on", async () => {
    const backend = new MockBackend();
    backend.load(git);
    const api = new ApiClient(new MockTransport(backend, 0)).plugin("git");
    const fields = {
      channel_id: 1, name: "Desktop app", project: "UI/app", output: "release", system: "linux",
      steps: JSON.stringify(["npm ci", "npm run dist"]), collect: JSON.stringify({ kind: "binaries" }),
    };
    const { id } = await api.call<{ id: number }>("add-build", fields);
    await api.call("add-build", { ...fields, channel_id: 2, name: "Elsewhere" });
    const { channel_id: _, ...changed } = fields;
    await api.call("update-build", { ...changed, build_id: id, steps: JSON.stringify(["npm ci", "npm run dist:linux"]), system: "win32" });
    const rows = (await api.call<{ rows: Record<string, unknown>[] }>("list-builds", { channel_id: 1 })).rows;
    expect(rows.map((row) => [row.name, JSON.parse(String(row.steps)), row.system])).toEqual([["Desktop app", ["npm ci", "npm run dist:linux"], "win32"]]);
    await api.call("remove-build", { build_id: id });
    expect((await api.call<{ rows: unknown[] }>("list-builds", { channel_id: 1 })).rows).toEqual([]);
  });

  it("refuses a build configuration without a name, commands or a way to choose its files", async () => {
    const backend = new MockBackend();
    backend.load(git);
    const api = new ApiClient(new MockTransport(backend, 0)).plugin("git");
    const fields = { channel_id: 1, name: "App", project: ".", output: "dist", system: "linux", steps: JSON.stringify(["make"]), collect: JSON.stringify({ kind: "zip" }) };
    const code = (args: Record<string, string | number>) => api.call("add-build", args).then(() => "ok", (error: ApiRequestError) => error.code);
    expect(await code(fields)).toBe("ok");
    expect(await code({ ...fields, name: " " })).toBe("invalid_request");
    expect(await code({ ...fields, steps: JSON.stringify([" "]) })).toBe("invalid_request");
    expect(await code({ ...fields, steps: "make" })).toBe("invalid_request");
    expect(await code({ ...fields, collect: JSON.stringify({ kind: "everything" }) })).toBe("invalid_request");
    expect(await code({ ...fields, collect: JSON.stringify({ kind: "pattern", pattern: "" }) })).toBe("invalid_request");
    expect(await code({ ...fields, output: `${"deep/".repeat(60)}out` })).toBe("invalid_request");
    // Folders outside the repository fail on every member's computer at build time: refused when saved instead.
    expect(await code({ ...fields, project: "../other" })).toBe("invalid_request");
    expect(await code({ ...fields, output: "/etc" })).toBe("invalid_request");
    expect(await code({ ...fields, output: "C:\\Windows" })).toBe("invalid_request");
    expect(await code({ ...fields, system: "x".repeat(21) })).toBe("invalid_request");
  });

  const commitsOf = (shas: string[]) => JSON.stringify(shas.map((sha, i) => ({
    sha, parents: i ? [shas[i - 1]] : [], author_name: "Ann", author_email: "a@x", authored_at: `2026-01-0${i + 1}T00:00:00.000Z`, message: sha,
  })));
  const submodule = (sub_path: string, path: string, pinned = "") => ({ sub_path, provider: "github", host: "github.com", path, url: `https://github.com/${path}`, pinned });
  async function withRepo() {
    const backend = new MockBackend();
    backend.load(git);
    const api = new ApiClient(new MockTransport(backend, 0)).plugin("git");
    await api.call("set-repo", { channel_id: 1, provider: "github", host: "github.com", path: "o/main", subrepos: true });
    const subs = async () => (await api.call<{ rows: Record<string, unknown>[] }>("list-repos", { channel_id: 1 })).rows
      .map((row) => String(row.sub_path)).sort();
    const shas = async (sub?: string) => (await api.call<{ shas: string }>("known-shas", { channel_id: 1, ...(sub ? { sub } : {}) })).shas;
    return { api, subs, shas };
  }

  it("keeps a repository's submodules in its channel, each with a history of its own", async () => {
    const { api, subs, shas } = await withRepo();
    await api.call("set-subrepos", { channel_id: 1, subrepos: JSON.stringify([submodule("lib", "o/lib", "abcdef1"), submodule("tools/gen", "o/gen")]) });
    await api.call("set-subrepos", { channel_id: 1, sub: "lib", subrepos: JSON.stringify([submodule("lib/vendor/x", "o/x")]) });
    expect(await subs()).toEqual(["", "lib", "lib/vendor/x", "tools/gen"]);

    await api.call("import-commits", { channel_id: 1, commits: commitsOf(["aaaaaaa1"]) });
    await api.call("import-commits", { channel_id: 1, sub: "lib", commits: commitsOf(["bbbbbbb1", "bbbbbbb2"]) });
    await api.call("set-branches", { channel_id: 1, sub: "lib", branches: JSON.stringify([{ name: "main", head: "bbbbbbb2" }]) });
    expect(await shas()).toBe("aaaaaaa1");
    expect(await shas("lib")).toBe("bbbbbbb1\nbbbbbbb2");
    const lib = await api.call<{ repo: Record<string, unknown>; branches: unknown[] }>("get-repo", { channel_id: 1, sub: "lib" });
    expect([lib.repo.path, lib.repo.pinned, lib.branches.length]).toEqual(["o/lib", "abcdef1", 1]);
    const history = await api.call<{ rows: { sha: string }[] }>("list-commits", { channel_id: 1, sub: "lib" });
    expect(history.rows.map((row) => row.sha)).toEqual(["bbbbbbb2", "bbbbbbb1"]);
    // The main repository's own calls never see a submodule's rows.
    expect((await api.call<{ repo: Record<string, unknown> }>("get-repo", { channel_id: 1 })).repo.path).toBe("o/main");
    await expect(api.call("import-commits", { channel_id: 1, sub: "nowhere", commits: "[]" })).rejects.toThrow(/no submodule/);
  });

  it("updates a repository's submodules: a new pinned commit keeps the history, another repository or a removal doesn't", async () => {
    const { api, subs, shas } = await withRepo();
    await api.call("set-subrepos", { channel_id: 1, subrepos: JSON.stringify([submodule("lib", "o/lib", "abcdef1"), submodule("tools/gen", "o/gen")]) });
    await api.call("set-subrepos", { channel_id: 1, sub: "lib", subrepos: JSON.stringify([submodule("lib/vendor/x", "o/x")]) });
    await api.call("import-commits", { channel_id: 1, sub: "lib", commits: commitsOf(["bbbbbbb1"]) });
    await api.call("import-commits", { channel_id: 1, sub: "tools/gen", commits: commitsOf(["ccccccc1"]) });

    // The main repository's list only says what is directly in it: lib's own submodule stays.
    expect(await api.call("set-subrepos", { channel_id: 1, subrepos: JSON.stringify([submodule("lib", "o/lib", "abcdef2"), submodule("tools/gen", "o/gen")]) }))
      .toEqual({ added: 0, removed: 0 });
    expect(await subs()).toEqual(["", "lib", "lib/vendor/x", "tools/gen"]);
    expect(await shas("lib")).toBe("bbbbbbb1");
    expect((await api.call<{ repo: Record<string, unknown> }>("get-repo", { channel_id: 1, sub: "lib" })).repo.pinned).toBe("abcdef2");

    await api.call("set-subrepos", { channel_id: 1, subrepos: JSON.stringify([submodule("lib", "o/other"), submodule("tools/gen", "o/gen")]) });
    expect(await subs()).toEqual(["", "lib", "tools/gen"]);
    expect(await shas("lib")).toBe("");
    expect(await shas("tools/gen")).toBe("ccccccc1");

    expect(await api.call("set-subrepos", { channel_id: 1, subrepos: JSON.stringify([submodule("tools/gen", "o/gen")]) })).toEqual({ added: 0, removed: 1 });
    expect(await subs()).toEqual(["", "tools/gen"]);
  });

  it("forgets the submodules with the repository, and refuses paths outside it", async () => {
    const { api, subs } = await withRepo();
    const set = (list: unknown[], sub?: string) => api.call("set-subrepos", { channel_id: 1, ...(sub ? { sub } : {}), subrepos: JSON.stringify(list) })
      .then(() => "ok", (error: ApiRequestError) => error.code);
    expect(await set([submodule("lib", "o/lib")])).toBe("ok");
    expect(await set([submodule("../lib", "o/lib")])).toBe("invalid_request");
    expect(await set([submodule("/lib", "o/lib")])).toBe("invalid_request");
    expect(await set([submodule("", "o/lib")])).toBe("invalid_request");
    expect(await set([submodule("elsewhere/x", "o/x")], "lib")).toBe("invalid_request");
    expect(await set([{ ...submodule("lib", "o/lib"), provider: "svn" }])).toBe("invalid_request");
    expect(await set([{ ...submodule("lib", "o/lib"), pinned: "not a sha" }])).toBe("invalid_request");
    expect(await subs()).toEqual(["", "lib"]);

    await api.call("set-repo", { channel_id: 1, provider: "github", host: "github.com", path: "o/next" });
    expect(await subs()).toEqual([""]);
    await api.call("set-subrepos", { channel_id: 1, subrepos: JSON.stringify([submodule("lib", "o/lib")]) });
    expect(await api.call("remove-repo", { channel_id: 1 })).toEqual({ removed: 2 });
    expect(await subs()).toEqual([]);
  });

  it("reads a repository saved before submodules as the channel's main one", async () => {
    const backend = new MockBackend();
    backend.load(git);
    const api = new ApiClient(new MockTransport(backend, 0)).plugin("git");
    await api.call("set-repo", { channel_id: 1, provider: "github", host: "github.com", path: "o/main" });
    const [row] = await api.read("git_repos");
    expect([row.sub_path, row.subrepos]).toEqual(["", false]);
    expect(await api.call("include-subrepos", { channel_id: 1, subrepos: true })).toEqual({ updated: 1 });
    expect((await api.call<{ repo: Record<string, unknown> }>("get-repo", { channel_id: 1 })).repo.subrepos).toBe(true);
  });
});
