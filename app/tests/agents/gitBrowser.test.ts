import { describe, expect, it } from "vitest";
import { ApiClient } from "../../src/api/client";
import { allSkills } from "../../src/agents/skills";
import { MockTransport } from "../../src/mock/transport";
import type { BotContext } from "../../src/plugins/types";
import { MockBackend } from "../../src/system/backend";
import { browser } from "../../src/system/browser";
import { git } from "../../src/system/git";
import { installAgentSource } from "./source";

installAgentSource();

const env = { server: { baseUrl: "http://localhost" }, imageSide: 512 };

describe("git and browser skills", () => {
  it("reads a repository's branches and log, and drives a shared browser", async () => {
    const backend = new MockBackend({ userId: 7 });
    backend.load(git);
    backend.load(browser);
    const api = new ApiClient(new MockTransport(backend));
    const context = {
      workspaceId: "w", bot: { id: 1, nickname: "Bot" }, granted: () => true,
      channels: async () => [{ id: 1, name: "repo", type: "git" }, { id: 2, name: "web", type: "browser" }],
      read: async (plugin: string, table: string, where?: Record<string, never>) => api.plugin(plugin).read(table, where),
      write: (plugin: string) => api.plugin(plugin),
    } as unknown as BotContext;
    const run = (name: string, args: Record<string, string | number>) => allSkills().find((s) => s.name === name)!.run(context, args, env);
    await api.plugin("git").call("set-repo", { channel_id: 1, provider: "github", host: "github.com", path: "a/b", default_branch: "main" });
    await api.plugin("git").call("import-commits", { channel_id: 1, commits: JSON.stringify([
      { sha: "a".repeat(40), parents: [], author_name: "Ann", author_email: "a@x", authored_at: "2026-01-01T00:00:00Z", message: "First\nmore" },
      { sha: "b".repeat(40), parents: ["a".repeat(40)], author_name: "Ben", author_email: "b@x", authored_at: "2026-01-02T00:00:00Z", message: "Second" },
    ]) });
    await api.plugin("git").call("set-branches", { channel_id: 1, branches: JSON.stringify([{ name: "main", head: "b".repeat(40) }]) });
    expect(await run("git_branches", { channel: "repo" })).toMatch(/default branch main[\s\S]*main at bbbbbbb/);
    expect(await run("git_log", { channel: "repo", branch: "" })).toMatch(/^bbbbbbb 2026-01-02 Ben: Second\naaaaaaa 2026-01-01 Ann: First$/);
    await expect(run("git_log", { channel: "repo", branch: "dev" })).rejects.toThrow(/no branch 'dev'/);
    // A submodule's history, by its path.
    await api.plugin("git").call("set-subrepos", { channel_id: 1, subrepos: JSON.stringify([
      { sub_path: "libs/core", provider: "github", host: "github.com", path: "a/core", default_branch: "main", pinned: "c".repeat(40) },
    ]) });
    await api.plugin("git").call("import-commits", { channel_id: 1, sub: "libs/core", commits: JSON.stringify([
      { sha: "c".repeat(40), parents: [], author_name: "Cy", author_email: "c@x", authored_at: "2026-01-03T00:00:00Z", message: "Core" },
    ]) });
    expect(await run("git_branches", { channel: "repo", repo: "" })).toMatch(/Submodules: libs\/core$/);
    expect(await run("git_branches", { channel: "repo", repo: "/libs/core/" })).toMatch(/^libs\/core in #repo: github a\/core.*pinned at ccccccc/);
    expect(await run("git_log", { channel: "repo", branch: "", repo: "libs/core" })).toBe("ccccccc 2026-01-03 Cy: Core");
    await expect(run("git_log", { channel: "repo", branch: "", repo: "libs/other" })).rejects.toThrow(/no submodule 'libs\/other'. Its submodules: libs\/core/);
    await run("browser_open", { channel: "web", url: "https://example.com" });
    await run("browser_bookmark", { channel: "web", url: "https://example.com/a", title: "A" });
    expect(await run("browser_page", { channel: "web" })).toMatch(/on https:\/\/example.com[\s\S]*A \(https:\/\/example.com\/a\)/);
  });
});
