import { describe, expect, it } from "vitest";
import { ApiClient } from "../../../../src/api/client";
import { MockTransport } from "../../../../src/mock/transport";
import { importRepo } from "../../../../src/plugins/builtin/git/importer";
import type { RepoReader } from "../../../../src/plugins/builtin/git/providers";
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
