// Version control channels. A channel points at one repository (GitHub, GitLab or a
// member's local folder); a member who can read it imports its branches and commit history here, so every member
// sees them without access of their own. Tokens never come here. API values are scalars, so commit batches
// arrive as JSON text.
import type { MockPlugin } from "./backend";
import type { JsonRow } from "./data";
import { InvalidRequest } from "./errors";

export interface ImportedCommit {
  sha: string;
  parents: string[];
  author_name: string;
  author_email: string;
  authored_at: string;
  message: string;
}

const maxBatch = 200;
const shaPattern = /^[0-9a-f]{7,64}$/;

export const git: MockPlugin = {
  manifest: {
    name: "git",
    version: "1.0.0",
    description: "Version control: a repository's branches and commit history, imported for the whole workspace.",
    tables: [
      {
        name: "git_repos", parent: null,
        columns: {
          channel_id: "bigint", provider: "text", host: "text", path: "text", url: "text", default_branch: "text",
          imported_by: "bigint", imported_at: "timestamp",
        },
      },
      { name: "git_branches", parent: "git_repos", columns: { repo_id: "bigint", name: "text", head: "text" } },
      {
        name: "git_commits", parent: "git_repos",
        columns: {
          repo_id: "bigint", sha: "text", parents: "text", author_name: "text", author_email: "text",
          authored_at: "timestamp", message: "text",
        },
      },
      {
        // Build configurations for releases: commands a member runs in a temporary copy of a branch (desktop), the
        // folder they land in and which files to take. Steps and collect are JSON text. Each device asks before
        // running commands someone else wrote or changed; `system` is the one they were written on.
        name: "git_builds", parent: null,
        columns: {
          channel_id: "bigint", name: "text", project: "text", steps: "text", output: "text", collect: "text", system: "text",
          author_id: "bigint", created_at: "timestamp", updated_by: "bigint", updated_at: "timestamp", deleted: "bool",
        },
      },
    ],
  },

  register({ data, onApi, onApiRead }) {
    const repoOf = (channelId: unknown): JsonRow | null => data.select("git_repos", { channel_id: channelId as number })[0] ?? null;
    const needRepo = (channelId: unknown) => {
      const repo = repoOf(channelId);
      if (!repo) throw new InvalidRequest("This channel has no repository yet.");
      return repo;
    };
    const clear = (repoId: number) => {
      data.delete("git_commits", { repo_id: repoId });
      data.delete("git_branches", { repo_id: repoId });
    };
    const parseList = <T>(text: unknown, what: string): T[] => {
      try {
        const list: unknown = JSON.parse(String(text));
        if (Array.isArray(list)) return list as T[];
      } catch {
        // Reported below.
      }
      throw new InvalidRequest(`'${what}' must be a JSON list.`);
    };
    const channelArg = { name: "channel_id", type: "bigint", description: "The version control channel." } as const;

    onApi("get-repo", "The channel's repository and its branches: { repo, branches } (repo is null without one).",
      [channelArg],
      (r) => {
        const repo = repoOf(r.args.channel_id);
        return { repo, branches: repo ? data.select("git_branches", { repo_id: repo.id }) : [] };
      });

    onApi("set-repo", "Points the channel at a repository; forgets what was imported from the previous one. Returns its id.",
      [
        channelArg,
        { name: "provider", type: "text", description: "github, gitlab or local." },
        { name: "host", type: "text", description: "github.com, gitlab.com, a GitLab host, or '' for a local folder." },
        { name: "path", type: "text", description: "owner/repo, the GitLab project path, or the folder's name." },
        { name: "url", type: "text", required: false, description: "A link members can open; '' for a folder without a remote." },
        { name: "default_branch", type: "text", required: false, description: "The branch shown first." },
      ],
      (r) => {
        if (!["github", "gitlab", "local"].includes(String(r.args.provider))) throw new InvalidRequest("'provider' must be github, gitlab or local.");
        const old = repoOf(r.args.channel_id);
        if (old) {
          clear(old.id);
          data.delete("git_repos", { id: old.id });
        }
        return {
          id: data.insert("git_repos", {
            channel_id: r.args.channel_id, provider: r.args.provider, host: r.args.host, path: r.args.path, url: r.args.url ?? "",
            default_branch: r.args.default_branch ?? "", imported_by: r.userId, imported_at: null,
          }),
        };
      });

    onApi("import-commits", `Adds up to ${maxBatch} commits (JSON list of { sha, parents, author_name, author_email, authored_at, message }); ones already there are skipped. Returns { added }.`,
      [channelArg, { name: "commits", type: "text", description: "The commits, as JSON text." }],
      (r) => {
        const repo = needRepo(r.args.channel_id);
        const commits = parseList<ImportedCommit>(r.args.commits, "commits");
        if (commits.length > maxBatch) throw new InvalidRequest(`At most ${maxBatch} commits at a time.`);
        const known = new Set(data.select("git_commits", { repo_id: repo.id }).map((c) => c.sha));
        let added = 0;
        for (const c of commits) {
          if (!shaPattern.test(String(c.sha)) || !Array.isArray(c.parents)) throw new InvalidRequest("A commit needs a sha and a list of parents.");
          if (known.has(c.sha)) continue;
          known.add(c.sha);
          data.insert("git_commits", {
            repo_id: repo.id, sha: c.sha, parents: c.parents.join(" "), author_name: String(c.author_name ?? ""),
            author_email: String(c.author_email ?? ""), authored_at: c.authored_at, message: String(c.message ?? ""),
          });
          added++;
        }
        return { added };
      });

    onApi("set-branches", "Replaces the branch list (JSON list of { name, head }) and records the import. Returns { branches }.",
      [channelArg, { name: "branches", type: "text", description: "The branches, as JSON text." }],
      (r) => {
        const repo = needRepo(r.args.channel_id);
        const branches = parseList<{ name: string; head: string }>(r.args.branches, "branches");
        data.delete("git_branches", { repo_id: repo.id });
        for (const b of branches) {
          if (!b.name || !shaPattern.test(String(b.head))) throw new InvalidRequest("A branch needs a name and a head sha.");
          data.insert("git_branches", { repo_id: repo.id, name: b.name, head: b.head });
        }
        data.update("git_repos", { imported_by: r.userId, imported_at: new Date().toISOString() }, { id: repo.id });
        return { branches: branches.length };
      });

    onApi("list-commits", "Imported history of one branch, or of all of them without branch, newest first and never a parent before its children: { rows, total, truncated, heads }. truncated: older commits exist that aren't imported; heads: the branches and their head commits.",
      [
        channelArg,
        { name: "branch", type: "text", required: false, description: "The branch name; all branches without it." },
        { name: "offset", type: "int", required: false, description: "Commits to skip." },
        { name: "limit", type: "int", required: false, description: "At most this many (up to 5000), 100 by default." },
      ],
      (r) => {
        const repo = needRepo(r.args.channel_id);
        const branches = data.select("git_branches", { repo_id: repo.id });
        const from = r.args.branch == null ? branches : branches.filter((b) => b.name === r.args.branch);
        if (from.length === 0 && r.args.branch != null) throw new InvalidRequest(`Unknown branch '${r.args.branch}'.`);
        const bySha = new Map(data.select("git_commits", { repo_id: repo.id }).map((c) => [String(c.sha), c]));
        const history = walk(bySha, from.map((b) => String(b.head)));
        const offset = Number(r.args.offset ?? 0);
        const limit = Math.min(5000, Number(r.args.limit ?? 100));
        return {
          rows: history.rows.slice(offset, offset + limit), total: history.rows.length, truncated: history.truncated,
          heads: branches.map((b) => ({ name: b.name, head: b.head })),
        };
      });

    onApi("known-shas", "Every imported sha of the channel's repository, one per line: { shas }.",
      [channelArg],
      (r) => {
        const repo = repoOf(r.args.channel_id);
        return { shas: repo ? data.select("git_commits", { repo_id: repo.id }).map((c) => c.sha).join("\n") : "" };
      });

    onApi("frontier", "Parents of imported commits that aren't imported yet, where older history continues: { shas }.",
      [channelArg],
      (r) => {
        const repo = repoOf(r.args.channel_id);
        if (!repo) return { shas: "" };
        const commits = data.select("git_commits", { repo_id: repo.id });
        const known = new Set(commits.map((c) => String(c.sha)));
        const missing = new Set(commits.flatMap((c) => String(c.parents).split(" ").filter((p) => p && !known.has(p))));
        return { shas: [...missing].join("\n") };
      });

    onApi("remove-repo", "Disconnects the channel's repository and forgets its imported history. Returns { removed }.",
      [channelArg],
      (r) => {
        const repo = repoOf(r.args.channel_id);
        if (!repo) return { removed: 0 };
        clear(repo.id);
        return { removed: data.delete("git_repos", { id: repo.id }) };
      });

    const build = (id: unknown): JsonRow => {
      const [row] = data.select("git_builds", { id: Number(id) });
      if (!row || row.deleted === true) throw new InvalidRequest(`Unknown build configuration ${id}`);
      return row;
    };
    const buildArgs = [
      { name: "name", type: "text", description: "What the release page lists." },
      { name: "project", type: "text", description: "The folder in the repository the commands run in (\".\" for its root)." },
      { name: "steps", type: "text", description: "The commands, as a JSON list of 1 to 20 texts, run one after the other." },
      { name: "output", type: "text", description: "The folder the files land in, relative to the project folder." },
      { name: "collect", type: "text", description: 'Which files: JSON {"kind":"binaries"|"installers"|"zip"} or {"kind":"pattern","pattern":"*.jar"}.' },
      { name: "system", type: "text", description: "The system the commands are written for: linux, win32 or darwin." },
    ] as const;
    const buildFields = (r: { args: Record<string, unknown> }) => {
      const text = (key: string, max: number) => String(r.args[key] ?? "").trim().slice(0, max + 1);
      const buildName = text("name", 80);
      if (!buildName || buildName.length > 80) throw new InvalidRequest("A build configuration needs a name of up to 80 characters.");
      let steps: unknown;
      try {
        steps = JSON.parse(String(r.args.steps ?? ""));
      } catch {
        steps = null;
      }
      if (!Array.isArray(steps) || !steps.every((s) => typeof s === "string")) throw new InvalidRequest("Steps must be a JSON list of commands.");
      const commands = steps.map((s) => s.trim()).filter(Boolean);
      if (commands.length === 0 || commands.length > 20 || commands.some((s) => s.length > 2000))
        throw new InvalidRequest("A build configuration needs 1 to 20 commands of up to 2000 characters.");
      let collect: { kind?: unknown; pattern?: unknown } | null;
      try {
        collect = JSON.parse(String(r.args.collect ?? ""));
      } catch {
        collect = null;
      }
      const kind = collect?.kind;
      const pattern = typeof collect?.pattern === "string" ? collect.pattern.trim() : "";
      if (kind === "pattern" ? !pattern || pattern.length > 200 : !["binaries", "installers", "zip"].includes(String(kind)))
        throw new InvalidRequest("Choose which files the build makes.");
      // The same folder rule as the desktop app's checkPlan (electron/release.js), which checks again before running:
      // folders inside the repository.
      const project = text("project", 300) || ".";
      const output = text("output", 300) || ".";
      if (project.length > 300 || output.length > 300) throw new InvalidRequest("A build configuration's folders can be up to 300 characters.");
      const outside = (folder: string) => { const f = folder.replaceAll("\\", "/"); return f.startsWith("/") || /^[a-z]:/i.test(f) || f.split("/").includes(".."); };
      if (outside(project) || outside(output)) throw new InvalidRequest("A build configuration's folders must be inside the repository.");
      const system = text("system", 20);
      if (system.length > 20) throw new InvalidRequest("Not a system name.");
      return {
        name: buildName, project, output, system,
        steps: JSON.stringify(commands), collect: JSON.stringify(kind === "pattern" ? { kind, pattern } : { kind }),
      };
    };

    onApi("list-builds", "Lists a channel's build configurations: { rows }.",
      [channelArg],
      (r) => ({ rows: data.select("git_builds", { channel_id: Number(r.args.channel_id) }).filter((row) => row.deleted !== true) }));

    onApi("add-build", "Adds a build configuration; returns { id }.",
      [channelArg, ...buildArgs],
      (r) => {
        const now = new Date().toISOString();
        return { id: data.insert("git_builds", {
          channel_id: Number(r.args.channel_id), ...buildFields(r), author_id: r.userId, created_at: now, updated_by: r.userId, updated_at: now, deleted: false,
        }) };
      });

    onApi("update-build", "Changes a build configuration; returns { updated }.",
      [{ name: "build_id", type: "bigint", description: "The build configuration." }, ...buildArgs],
      (r) => ({ updated: data.update("git_builds", { ...buildFields(r), updated_by: r.userId, updated_at: new Date().toISOString() }, { id: build(r.args.build_id).id }) }));

    onApi("remove-build", "Removes a build configuration; returns { deleted }.",
      [{ name: "build_id", type: "bigint", description: "The build configuration." }],
      (r) => ({ deleted: data.update("git_builds", { deleted: true, updated_by: r.userId, updated_at: new Date().toISOString() }, { id: build(r.args.build_id).id }) }));

    onApiRead((r) => data.select(r.table, r.where));
  },
};

// Everything reachable from `heads` through imported commits, newest first like git log: by date, but never a
// commit before the ones built on it (equal dates are common). truncated: some parent isn't imported.
function walk(bySha: Map<string, JsonRow>, heads: string[]): { rows: JsonRow[]; truncated: boolean } {
  const parentsOf = (c: JsonRow) => String(c.parents).split(" ").filter(Boolean);
  const reachable = new Map<string, JsonRow>();
  let truncated = false;
  const stack = [...heads];
  while (stack.length) {
    const sha = stack.pop()!;
    if (reachable.has(sha)) continue;
    const commit = bySha.get(sha);
    if (!commit) {
      truncated = true;
      continue;
    }
    reachable.set(sha, commit);
    stack.push(...parentsOf(commit));
  }
  // How many children inside the walk each commit still waits for.
  const waiting = new Map<string, number>();
  for (const c of reachable.values()) for (const p of parentsOf(c)) if (reachable.has(p)) waiting.set(p, (waiting.get(p) ?? 0) + 1);
  const newer = (a: JsonRow, b: JsonRow) => String(b.authored_at).localeCompare(String(a.authored_at));
  const ready = [...reachable.values()].filter((c) => !waiting.get(String(c.sha)));
  const rows: JsonRow[] = [];
  while (ready.length) {
    ready.sort(newer);
    const next = ready.shift()!;
    rows.push(next);
    for (const p of parentsOf(next)) {
      if (!reachable.has(p)) continue;
      const left = waiting.get(p)! - 1;
      waiting.set(p, left);
      if (left === 0) ready.push(reachable.get(p)!);
    }
  }
  return { rows, truncated };
}
