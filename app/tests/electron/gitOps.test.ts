// The version control channel's git operations against real repositories: a bare "remote" and two clones (A, B),
// in a temporary folder with their own git config (the user's global config, hooks and signing don't apply).
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  blame, branches, checkPath, commit, createBranch, credentialName, createGit, deleteBranch, fetchRemote, graph, listFiles, mergeBranch,
  mergeConflicts, mergeCurrentInto, mergeDiff, mergeFile, mergeRemote, mergeResolved, push, pushCheck, remoteEnv, remoteHost, restoreCommit, showCommit, stashDelete, stashList, stashPush, stashRestore, status, attachBranch, prepareSubmodules, submodules, switchBranch, withCredentials,
} from "../../electron/gitOps.js";

let root: string;
let env: NodeJS.ProcessEnv;
let git: ReturnType<typeof createGit>;
let remote: string;
let a: string;
let b: string;

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const write = (dir: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};
const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), "utf8");
const head = (dir: string, ref = "HEAD") => sh(dir, "rev-parse", ref);
const remoteHead = (branch = "main") => sh(remote, "rev-parse", `refs/heads/${branch}`);

// A commits through the app's own commit, then pushes.
async function commitAll(dir: string, message: string) {
  const paths = (await status(git, dir)).map((f) => f.path);
  const result = await commit(git, dir, { paths, message, allowMassDelete: true });
  expect(result.ok).toBe(true);
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mw-gitops-"));
  const config = path.join(root, "gitconfig");
  // Git refuses submodules from local folders unless told; the test repositories are all local folders.
  fs.writeFileSync(config, "[user]\n\tname = Tester\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n"
    + "[protocol \"file\"]\n\tallow = always\n");
  env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", GIT_SSH_COMMAND: "false" };
  git = createGit({ env });
  remote = path.join(root, "remote.git");
  sh(root, "init", "--bare", "-b", "main", remote);
  a = path.join(root, "a");
  sh(root, "clone", "-q", remote, a);
  for (const name of ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]) write(a, name, `${name} line one\nline two\n`);
  await commitAll(a, "First commit");
  expect((await push(git, a)).ok).toBe(true);
  b = path.join(root, "b");
  sh(root, "clone", "-q", remote, b);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("git safety: commits", () => {
  it("needs a message and chosen files, and commits only those", async () => {
    write(a, "a.txt", "changed\n");
    write(a, "new.txt", "new\n");
    write(a, "b.txt", "also changed, not chosen\n");
    await expect(commit(git, a, { paths: ["a.txt"], message: "   " })).rejects.toThrow(/message/);
    await expect(commit(git, a, { paths: [], message: "x" })).rejects.toThrow(/at least one file/);
    await expect(commit(git, a, { paths: ["c.txt"], message: "x" })).rejects.toThrow(/no changes/);
    await expect(commit(git, a, { paths: ["../outside"], message: "x" })).rejects.toThrow(/Not a file/);

    const result = await commit(git, a, { paths: ["a.txt", "new.txt"], message: "Change a, add new" });
    expect(result.ok).toBe(true);
    expect(sh(a, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual(["a.txt", "new.txt"]);
    // The file that wasn't ticked keeps its change, uncommitted.
    expect((await status(git, a)).map((f) => f.path)).toEqual(["b.txt"]);
    expect(read(a, "b.txt")).toBe("also changed, not chosen\n");
  });

  it("never makes an empty tree, and asks before removing over a quarter of the files", async () => {
    const before = head(a);
    for (const name of ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]) fs.rmSync(path.join(a, name));
    const all = (await status(git, a)).map((f) => f.path);
    expect(await commit(git, a, { paths: all, message: "Remove everything", allowMassDelete: true })).toMatchObject({ ok: false, reason: "empty" });
    expect(head(a)).toBe(before);

    expect(await commit(git, a, { paths: ["a.txt", "b.txt"], message: "Remove two" })).toMatchObject({ ok: false, reason: "mass-delete", deleted: 2, total: 5 });
    expect(head(a)).toBe(before);
    expect((await commit(git, a, { paths: ["a.txt", "b.txt"], message: "Remove two", allowMassDelete: true })).ok).toBe(true);
    expect(sh(a, "ls-tree", "-r", "--name-only", "HEAD").split("\n")).toEqual(["c.txt", "d.txt", "e.txt"]);
  });
});

describe("git safety: pushing", () => {
  it("pushes when ahead, refuses while the remote has new commits and leaves the remote as it was", async () => {
    write(b, "b.txt", "from b\n");
    await commitAll(b, "B's change");
    expect((await push(git, b)).ok).toBe(true);
    const fromB = remoteHead();

    write(a, "c.txt", "from a\n");
    await commitAll(a, "A's change");
    const refused = await push(git, a);
    expect(refused).toMatchObject({ ok: false, reason: "behind" });
    expect(!refused.ok && refused.check).toMatchObject({ state: "diverged", ahead: 1, behind: 1, merge: { clean: true, conflicts: [] } });
    expect(remoteHead()).toBe(fromB);

    // Different files: the merge is clean, then the push goes through and keeps both changes.
    expect(await mergeRemote(git, a)).toMatchObject({ ok: true, merged: 1, fastForward: false });
    expect((await push(git, a)).ok).toBe(true);
    expect(sh(remote, "show", "main:b.txt")).toBe("from b");
    expect(sh(remote, "show", "main:c.txt")).toBe("from a");
  });

  it("lists conflicts and changes nothing", async () => {
    write(b, "a.txt", "b's version\n");
    await commitAll(b, "B edits a");
    await push(git, b);
    write(a, "a.txt", "a's version\n");
    await commitAll(a, "A edits a");
    const before = head(a);

    const check = await pushCheck(git, a);
    expect(check.merge).toEqual({ clean: false, conflicts: ["a.txt"] });
    expect(await mergeRemote(git, a)).toMatchObject({ ok: false, reason: "conflicts" });
    expect(head(a)).toBe(before);
    expect(read(a, "a.txt")).toBe("a's version\n");
    expect(fs.existsSync(path.join(a, ".git", "MERGE_HEAD"))).toBe(false);
    expect(await push(git, a)).toMatchObject({ ok: false, reason: "behind" });
  });

  it("merges only with nothing uncommitted, and fast-forwards when it can", async () => {
    write(b, "d.txt", "from b\n");
    await commitAll(b, "B");
    await push(git, b);
    write(a, "e.txt", "work in progress\n");
    expect(await mergeRemote(git, a)).toMatchObject({ ok: false, reason: "uncommitted" });
    expect(read(a, "e.txt")).toBe("work in progress\n");
    sh(a, "stash", "push", "-q");
    expect(await mergeRemote(git, a)).toMatchObject({ ok: true, fastForward: true });
    expect(head(a)).toBe(remoteHead());
  });

  it("refuses a push that would empty the remote or remove many files without confirming", async () => {
    for (const name of ["a.txt", "b.txt"]) fs.rmSync(path.join(a, name));
    await commitAll(a, "Remove two");
    const before = remoteHead();
    expect(await push(git, a)).toMatchObject({ ok: false, reason: "mass-delete" });
    expect(remoteHead()).toBe(before);
    expect((await push(git, a, { allowMassDelete: true })).ok).toBe(true);
  });

  it("sees the remote's new commits when fetching", async () => {
    write(b, "a.txt", "1\n");
    await commitAll(b, "one");
    write(b, "a.txt", "2\n");
    await commitAll(b, "two");
    await push(git, b);
    expect(await fetchRemote(git, a)).toEqual([{ branch: "main", from: expect.any(String), to: remoteHead(), count: 2 }]);
    expect(await fetchRemote(git, a)).toEqual([]);
  });
});

describe("git safety: branches", () => {
  it("creates, switches and deletes only safely", async () => {
    await createBranch(git, a, "feature", "main");
    await expect(createBranch(git, a, "feature", "main")).rejects.toThrow(/already exists/);
    await expect(createBranch(git, a, "bad..name", "main")).rejects.toThrow(/valid branch name/);
    await expect(createBranch(git, a, "-x", "main")).rejects.toThrow(/valid branch name/);

    write(a, "a.txt", "dirty\n");
    await expect(switchBranch(git, a, "feature")).rejects.toThrow(/Commit your changes first/);
    expect(read(a, "a.txt")).toBe("dirty\n");
    sh(a, "stash", "push", "-q");
    await switchBranch(git, a, "feature");
    expect((await branches(git, a)).current).toBe("feature");

    write(a, "f.txt", "feature work\n");
    await commitAll(a, "Feature work");
    await expect(deleteBranch(git, a, "feature")).rejects.toThrow(/branch you're on/);
    await switchBranch(git, a, "main");
    await expect(deleteBranch(git, a, "main")).rejects.toThrow(/branch you're on/);
    await expect(deleteBranch(git, a, "feature")).rejects.toThrow(/aren't merged/);
    expect(sh(a, "branch", "--list", "feature")).toContain("feature");

    await createBranch(git, a, "done", "main");
    await deleteBranch(git, a, "done");
    expect(sh(a, "branch", "--list", "done")).toBe("");
    await createBranch(git, a, "other", "main");
    await switchBranch(git, a, "other");
    await expect(deleteBranch(git, a, "main", ["main"])).rejects.toThrow(/default branch/);
  });
});

describe("git reading", () => {
  it("shows a commit's diff, the files at a commit and who wrote each line", async () => {
    write(a, "a.txt", "a.txt line one\nchanged line two\n");
    await commitAll(a, "Change line two");
    const { patch, truncated } = await showCommit(git, a, head(a));
    expect(truncated).toBe(false);
    expect(patch).toContain("+++ b/a.txt");
    expect(patch).toContain("+changed line two");
    expect(await listFiles(git, a, "main")).toEqual(["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]);
    const lines = await blame(git, a, "main", "a.txt");
    expect(lines.map((l) => [l.line, l.summary, l.text])).toEqual([[1, "First commit", "a.txt line one"], [2, "Change line two", "changed line two"]]);
    await expect(showCommit(git, a, "--output=/tmp/x")).rejects.toThrow(/commit id/);
    expect(() => checkPath("/etc/passwd")).toThrow();
    expect(() => checkPath("dir/../../x")).toThrow();
  });
});

describe("this copy's graph and remote branches", () => {
  it("marks commits that are only on origin and ones not pushed yet", async () => {
    write(b, "b.txt", "from b\n");
    await commitAll(b, "B's change");
    await push(git, b);
    await fetchRemote(git, a);
    write(a, "c.txt", "from a\n");
    await commitAll(a, "A's change");
    const g = await graph(git, a);
    const bySubject = (s: string) => g.commits.find((c) => c.message === s)!;
    expect(g.incoming).toEqual([bySubject("B's change").sha]);
    expect(g.outgoing).toEqual([bySubject("A's change").sha]);
    expect(bySubject("A's change").refs).toEqual([{ name: "main", kind: "local", head: true }]);
    expect(bySubject("B's change").refs).toEqual([{ name: "origin/main", kind: "remote", head: false }]);
    expect((await branches(git, a)).remotes).toEqual([{ name: "origin/main", head: bySubject("B's change").sha }]);
  });

  it("publishes a branch that isn't current, then checks it out elsewhere from origin", async () => {
    await createBranch(git, a, "topic", "main");
    expect((await pushCheck(git, a, "topic")).state).toBe("new-branch");
    // Nothing on topic beyond main yet: publishing still creates it on the remote.
    expect(await push(git, a, { branch: "topic" })).toMatchObject({ ok: true, pushed: 0, branch: "topic" });
    expect(sh(remote, "rev-parse", "topic")).toBe(head(a, "main"));
    expect((await pushCheck(git, a, "topic")).state).toBe("up-to-date");
    await switchBranch(git, a, "topic");
    write(a, "t.txt", "topic\n");
    await commitAll(a, "Topic work");
    await switchBranch(git, a, "main");
    expect(await push(git, a, { branch: "topic" })).toMatchObject({ ok: true, pushed: 1, branch: "topic" });
    expect(sh(remote, "log", "-1", "--format=%s", "topic")).toBe("Topic work");
    expect((await branches(git, a)).current).toBe("main");

    await fetchRemote(git, b);
    expect(await switchBranch(git, b, "origin/topic")).toBe("topic");
    const list = await branches(git, b);
    expect(list.current).toBe("topic");
    expect(list.branches.find((x) => x.name === "topic")?.upstream).toBe("origin/topic");
  });
});

describe("git safety: merging branches", () => {
  it("merges a branch into the current one, fast-forward or with a merge commit", async () => {
    await createBranch(git, a, "feature", "main");
    await switchBranch(git, a, "feature");
    write(a, "f.txt", "feature\n");
    await commitAll(a, "Feature");
    await switchBranch(git, a, "main");
    expect(await mergeBranch(git, a, "feature")).toMatchObject({ ok: true, merged: 1, fastForward: true, into: "main", from: "feature" });
    expect(await mergeBranch(git, a, "feature")).toMatchObject({ ok: false, reason: "nothing" });

    await switchBranch(git, a, "feature");
    write(a, "g.txt", "more\n");
    await commitAll(a, "More feature");
    await switchBranch(git, a, "main");
    write(a, "h.txt", "main work\n");
    await commitAll(a, "Main work");
    expect(await mergeBranch(git, a, "feature")).toMatchObject({ ok: true, merged: 1, fastForward: false });
    expect(sh(a, "log", "-1", "--format=%P").split(" ")).toHaveLength(2);
  });

  it("refuses conflicting merges in both directions and changes nothing", async () => {
    await createBranch(git, a, "other", "main");
    write(a, "a.txt", "main's version\n");
    await commitAll(a, "Main edits a");
    await switchBranch(git, a, "other");
    write(a, "a.txt", "other's version\n");
    await commitAll(a, "Other edits a");
    const otherHead = head(a);
    expect(await mergeBranch(git, a, "main")).toMatchObject({ ok: false, reason: "conflicts", conflicts: ["a.txt"] });
    expect(head(a)).toBe(otherHead);
    expect(read(a, "a.txt")).toBe("other's version\n");

    // The other way round is refused before switching branch.
    const mainHead = head(a, "main");
    expect(await mergeCurrentInto(git, a, "main")).toMatchObject({ ok: false, reason: "conflicts", into: "main", from: "other" });
    expect((await branches(git, a)).current).toBe("other");
    expect(head(a, "main")).toBe(mainHead);
    expect(fs.existsSync(path.join(a, ".git", "MERGE_HEAD"))).toBe(false);
  });

  it("switches to the target and merges the current branch into it when clean", async () => {
    await createBranch(git, a, "work", "main");
    await switchBranch(git, a, "work");
    write(a, "w.txt", "work\n");
    await commitAll(a, "Work");
    write(a, "b.txt", "uncommitted\n");
    expect(await mergeCurrentInto(git, a, "main")).toMatchObject({ ok: false, reason: "uncommitted" });
    expect((await branches(git, a)).current).toBe("work");
    sh(a, "stash", "push", "-q");
    expect(await mergeCurrentInto(git, a, "main")).toMatchObject({ ok: true, into: "main", from: "work", fastForward: true });
    expect((await branches(git, a)).current).toBe("main");
    expect(head(a, "main")).toBe(head(a, "work"));
  });
});

describe("git safety: resolving conflicts", () => {
  // B pushes its version of a.txt (and a clean change to c.txt); A commits its own version of a.txt and fetches.
  async function conflictingPull() {
    write(b, "a.txt", "a.txt line one\nfrom b\n");
    write(b, "c.txt", "c.txt from b\n");
    await commitAll(b, "B edits a and c");
    await push(git, b);
    write(a, "a.txt", "a.txt line one\nfrom a\n");
    await commitAll(a, "A edits a");
    await fetchRemote(git, a);
  }

  it("lists a pull's conflicts with each version, then merges the member's choices without a half-merged copy", async () => {
    await conflictingPull();
    const before = head(a);
    const found = await mergeConflicts(git, a, { kind: "pull" });
    expect(found).toMatchObject({ into: "main", from: "origin/main", receiving: before, incoming: head(a, "origin/main"), clean: ["c.txt"] });
    expect(found.files.map((f) => f.path)).toEqual(["a.txt"]);
    const versions = await mergeFile(git, a, found.files[0]);
    expect(versions).toEqual({
      base: { text: "a.txt line one\nline two\n" }, receiving: { text: "a.txt line one\nfrom a\n" }, incoming: { text: "a.txt line one\nfrom b\n" },
    });
    expect((await mergeDiff(git, a, found.receiving, found.tree, "c.txt")).patch).toMatch(/^\+c\.txt from b$/m);
    // Listing changed nothing.
    expect(head(a)).toBe(before);
    expect(fs.existsSync(path.join(a, ".git", "MERGE_HEAD"))).toBe(false);

    const result = await mergeResolved(git, a, {
      target: { kind: "pull" }, receiving: found.receiving, incoming: found.incoming, message: "",
      files: [{ path: "a.txt", content: "a.txt line one\nfrom a\nfrom b\n" }],
    });
    expect(result).toMatchObject({ ok: true, merged: 1, resolved: 1, into: "main", from: "origin/main" });
    expect(sh(a, "log", "-1", "--format=%P").split(" ")).toEqual([before, found.incoming]);
    expect(sh(a, "log", "-1", "--format=%s")).toBe("Merge remote-tracking branch 'origin/main'");
    expect(read(a, "a.txt")).toBe("a.txt line one\nfrom a\nfrom b\n");
    expect(read(a, "c.txt")).toBe("c.txt from b\n");
    expect(await status(git, a)).toEqual([]);
    expect((await push(git, a)).ok).toBe(true);
    expect(sh(remote, "show", "main:a.txt")).toBe("a.txt line one\nfrom a\nfrom b");
  });

  it("refuses with nothing touched: uncommitted changes, a moved branch, a file left out or added", async () => {
    await conflictingPull();
    const found = await mergeConflicts(git, a, { kind: "pull" });
    const before = head(a);
    const resolve = (files: { path: string; content: string }[]) =>
      mergeResolved(git, a, { target: { kind: "pull" }, receiving: found.receiving, incoming: found.incoming, message: "Merge", files });
    const chosen = [{ path: "a.txt", content: "chosen\n" }];

    write(a, "b.txt", "work in progress\n");
    expect(await resolve(chosen)).toMatchObject({ ok: false, reason: "uncommitted", files: ["b.txt"] });
    sh(a, "restore", "b.txt");
    expect(await resolve([])).toMatchObject({ ok: false, reason: "changed" });
    expect(await resolve([...chosen, { path: "b.txt", content: "not a conflict\n" }])).toMatchObject({ ok: false, reason: "changed" });
    expect(head(a)).toBe(before);

    write(a, "e.txt", "more of A's work\n");
    await commitAll(a, "A works on");
    expect(await resolve(chosen)).toMatchObject({ ok: false, reason: "moved" });
    expect(read(a, "a.txt")).toBe("a.txt line one\nfrom a\n");
    expect(fs.existsSync(path.join(a, ".git", "MERGE_HEAD"))).toBe(false);
  });

  it("keeps to the incoming commit it was resolved against when the remote moves on", async () => {
    await conflictingPull();
    const found = await mergeConflicts(git, a, { kind: "pull" });
    write(b, "d.txt", "later from b\n");
    await commitAll(b, "B again");
    await push(git, b);
    await fetchRemote(git, a);
    const result = await mergeResolved(git, a, {
      target: { kind: "pull" }, receiving: found.receiving, incoming: found.incoming, message: "Merge", files: [{ path: "a.txt", content: "both\n" }],
    });
    expect(result).toMatchObject({ ok: true });
    expect(sh(a, "log", "-1", "--format=%P").split(" ")[1]).toBe(found.incoming);
    expect(read(a, "d.txt")).toBe("d.txt line one\nline two\n");
    // A commit that isn't in the incoming branch's history any more (a force push) means checking again.
    const stray = sh(a, "commit-tree", "-m", "stray", `${found.receiving}^{tree}`);
    expect(await mergeResolved(git, a, { target: { kind: "pull" }, receiving: head(a), incoming: stray, message: "", files: [] }))
      .toMatchObject({ ok: false, reason: "changed" });
  });

  it("keeps a file mode the incoming branch changed when the file is resolved by its text", async () => {
    await createBranch(git, a, "other", "main");
    await switchBranch(git, a, "other");
    write(a, "a.txt", "other's line\n");
    fs.chmodSync(path.join(a, "a.txt"), 0o755);
    await commitAll(a, "Other edits a, makes it executable");
    expect(sh(a, "ls-tree", "HEAD", "a.txt").split(/\s/)[0]).toBe("100755");
    await switchBranch(git, a, "main");
    write(a, "a.txt", "main's line\n");
    await commitAll(a, "Main edits a");
    const found = await mergeConflicts(git, a, { kind: "branch", source: "other" });
    const result = await mergeResolved(git, a, {
      target: { kind: "branch", source: "other" }, receiving: found.receiving, incoming: found.incoming, message: "",
      files: [{ path: "a.txt", content: "both lines\n" }],
    });
    expect(result).toMatchObject({ ok: true });
    expect(sh(a, "ls-tree", "HEAD", "a.txt").split(/\s/)[0]).toBe("100755");
  });

  it("marks conflicts it can't resolve (a file and a folder, renames) and refuses to merge them", async () => {
    await createBranch(git, a, "other", "main");
    await switchBranch(git, a, "other");
    write(a, "x/y.txt", "in a folder\n");
    sh(a, "mv", "b.txt", "b-other.txt");
    await commitAll(a, "Other adds x/ and renames b");
    await switchBranch(git, a, "main");
    write(a, "x", "a file\n");
    sh(a, "mv", "b.txt", "b-main.txt");
    write(a, "a.txt", "main's line\n");
    await commitAll(a, "Main adds x and renames b");
    const found = await mergeConflicts(git, a, { kind: "branch", source: "other" });
    // Git moves the file out of the folder's way as x~<the receiving commit>.
    const unsupported = found.files.filter((f) => f.unsupported).map((f) => f.path).sort();
    expect(unsupported).toEqual(["b-main.txt", "b-other.txt", "b.txt", `x~${found.receiving}`]);
    expect(found.files.find((f) => f.path === "b.txt")!.unsupported).toMatch(/rename\/rename/);
    expect(found.files.find((f) => f.path === "a.txt")).toBeUndefined();
    expect(found.unsupported).toHaveLength(2);
    await expect(mergeResolved(git, a, {
      target: { kind: "branch", source: "other" }, receiving: found.receiving, incoming: found.incoming, message: "",
      files: found.files.map((f) => ({ path: f.path, side: "receiving" as const })),
    })).rejects.toThrow(/git tools/);
  });

  it("writes git's own merge message, with the branch merged into unless it is main or master", async () => {
    await createBranch(git, a, "develop", "main");
    await createBranch(git, a, "feature", "main");
    await switchBranch(git, a, "feature");
    write(a, "a.txt", "feature's a\n");
    await commitAll(a, "Feature edits a");
    await switchBranch(git, a, "develop");
    write(a, "a.txt", "develop's a\n");
    await commitAll(a, "Develop edits a");
    const found = await mergeConflicts(git, a, { kind: "branch", source: "feature" });
    expect(found.message).toBe("Merge branch 'feature' into develop");
    await mergeResolved(git, a, {
      target: { kind: "branch", source: "feature" }, receiving: found.receiving, incoming: found.incoming, message: "  ",
      files: [{ path: "a.txt", side: "receiving" }],
    });
    expect(sh(a, "log", "-1", "--format=%s")).toBe("Merge branch 'feature' into develop");
  });

  it("merges a branch with a whole side or a deletion as chosen", async () => {
    await createBranch(git, a, "other", "main");
    await switchBranch(git, a, "other");
    fs.rmSync(path.join(a, "a.txt"));
    write(a, "b.txt", "other's b\n");
    await commitAll(a, "Other removes a, edits b");
    await switchBranch(git, a, "main");
    write(a, "a.txt", "main keeps a\n");
    write(a, "b.txt", "main's b\n");
    await commitAll(a, "Main edits a and b");

    const found = await mergeConflicts(git, a, { kind: "branch", source: "other" });
    expect(found).toMatchObject({ into: "main", from: "other" });
    const deleted = found.files.find((f) => f.path === "a.txt")!;
    expect(deleted.incoming).toBeNull();
    expect(deleted.receiving).toMatchObject({ mode: "100644" });
    const result = await mergeResolved(git, a, {
      target: { kind: "branch", source: "other" }, receiving: found.receiving, incoming: found.incoming, message: "",
      files: [{ path: "a.txt", delete: true }, { path: "b.txt", side: "incoming" }],
    });
    expect(result).toMatchObject({ ok: true, resolved: 2 });
    expect(fs.existsSync(path.join(a, "a.txt"))).toBe(false);
    expect(read(a, "b.txt")).toBe("other's b\n");
    expect(sh(a, "log", "-1", "--format=%s")).toBe("Merge branch 'other'");
  });

  it("merges the current branch into another one, switching to it", async () => {
    await createBranch(git, a, "work", "main");
    write(a, "a.txt", "main's a\n");
    await commitAll(a, "Main edits a");
    await switchBranch(git, a, "work");
    write(a, "a.txt", "work's a\n");
    await commitAll(a, "Work edits a");
    const mainBefore = head(a, "main");

    const found = await mergeConflicts(git, a, { kind: "into", target: "main" });
    expect(found).toMatchObject({ into: "main", from: "work", receiving: mainBefore, incoming: head(a, "work") });
    const result = await mergeResolved(git, a, {
      target: { kind: "into", target: "main" }, receiving: found.receiving, incoming: found.incoming, message: "Merge work",
      files: [{ path: "a.txt", side: "receiving" }],
    });
    expect(result).toMatchObject({ ok: true, into: "main", from: "work" });
    expect((await branches(git, a)).current).toBe("main");
    expect(sh(a, "log", "-1", "--format=%P").split(" ")).toEqual([mainBefore, head(a, "work")]);
    expect(read(a, "a.txt")).toBe("main's a\n");
  });

  it("reads a version as text, or says it's binary or not UTF-8", async () => {
    write(a, "bin.dat", "a\0b");
    fs.writeFileSync(path.join(a, "latin.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    // A cut-off emoji: decoding it gives a replacement character of the same byte length.
    fs.writeFileSync(path.join(a, "cut.txt"), Buffer.from([0xf0, 0x9f, 0x98, 0x41, 0x0a]));
    const oid = (file: string) => sh(a, "hash-object", "-w", file);
    const side = (file: string) => ({ oid: oid(file), mode: "100644" });
    expect(await mergeFile(git, a, { base: side("cut.txt"), receiving: side("bin.dat"), incoming: side("latin.txt") }))
      .toEqual({ base: { binary: true }, receiving: { binary: true }, incoming: { binary: true } });
    expect(await mergeFile(git, a, { base: null, receiving: side("a.txt"), incoming: null }))
      .toEqual({ base: null, receiving: { text: "a.txt line one\nline two\n" }, incoming: null });
  });
});

describe("git safety: reverting to a commit", () => {
  // Three commits after "First commit": change a, add new.txt, delete e.txt.
  async function threeMore() {
    const first = head(a);
    write(a, "a.txt", "changed\n");
    await commitAll(a, "Change a");
    write(a, "new.txt", "new\n");
    await commitAll(a, "Add new");
    fs.rmSync(path.join(a, "e.txt"));
    await commitAll(a, "Remove e");
    return first;
  }
  const snapshot = (dir: string) => ({ head: head(dir), status: sh(dir, "status", "--porcelain=v1", "--untracked-files=all"), files: fs.readdirSync(dir).sort() });

  it("adds a commit with the files as they were, keeping the later commits, and pushes as a fast-forward", async () => {
    const first = await threeMore();
    const before = head(a);
    const result = await restoreCommit(git, a, first);
    expect(result).toMatchObject({ ok: true, branch: "main", restored: first, changed: 3 });
    expect(sh(a, "rev-parse", "HEAD^")).toBe(before);
    expect(sh(a, "rev-parse", "HEAD^{tree}")).toBe(sh(a, "rev-parse", `${first}^{tree}`));
    expect(read(a, "a.txt")).toBe("a.txt line one\nline two\n");
    expect(fs.existsSync(path.join(a, "new.txt"))).toBe(false);
    expect(read(a, "e.txt")).toBe("e.txt line one\nline two\n");
    expect(sh(a, "log", "-1", "--format=%s")).toBe('Revert to ' + first.slice(0, 7) + ' "First commit"');
    expect(Number(sh(a, "rev-list", "--count", "HEAD"))).toBe(5);
    expect(await status(git, a)).toHaveLength(0);
    expect(await push(git, a)).toMatchObject({ ok: true, pushed: 4 });
    expect(remoteHead()).toBe(head(a));
  });

  it("refuses and changes nothing: uncommitted work, untracked files in the way, HEAD itself, other branches", async () => {
    const first = await threeMore();
    write(a, "b.txt", "uncommitted\n");
    let before = snapshot(a);
    expect(await restoreCommit(git, a, first)).toMatchObject({ ok: false, reason: "uncommitted", files: ["b.txt"] });
    expect(snapshot(a)).toEqual(before);
    sh(a, "restore", "b.txt");

    // e.txt was deleted later; an untracked e.txt here would be overwritten by the restore.
    write(a, "e.txt", "mine, untracked\n");
    before = snapshot(a);
    expect(await restoreCommit(git, a, first)).toMatchObject({ ok: false, reason: "untracked", files: ["e.txt"] });
    expect(snapshot(a)).toEqual(before);
    expect(read(a, "e.txt")).toBe("mine, untracked\n");
    fs.rmSync(path.join(a, "e.txt"));

    expect(await restoreCommit(git, a, head(a))).toMatchObject({ ok: false, reason: "nothing" });
    sh(a, "switch", "-q", "-c", "side");
    write(a, "side.txt", "side\n");
    await commitAll(a, "Side");
    const side = head(a);
    sh(a, "switch", "-q", "main");
    await expect(restoreCommit(git, a, side)).rejects.toThrow(/isn't in main's history/);
    await expect(restoreCommit(git, a, "not-a-sha")).rejects.toThrow(/Not a commit id/);
  });

  it("asks before bringing back a state with far fewer files", async () => {
    const start = head(a);
    for (const name of ["f.txt", "g.txt", "h.txt", "i.txt", "j.txt"]) write(a, name, `${name}\n`);
    await commitAll(a, "Five more");
    const before = head(a);
    expect(await restoreCommit(git, a, start)).toMatchObject({ ok: false, reason: "mass-delete", deleted: 5, total: 10 });
    expect(head(a)).toBe(before);
    expect(await restoreCommit(git, a, start, { allowMassDelete: true })).toMatchObject({ ok: true, changed: 5 });
    expect(fs.existsSync(path.join(a, "f.txt"))).toBe(false);
  });
});

describe("git safety: stashes", () => {
  const files = (dir: string) => sh(dir, "status", "--porcelain=v1", "--untracked-files=all");

  it("puts changes and new files aside, and brings them back (then the stash leaves the list)", async () => {
    write(a, "a.txt", "edited\n");
    write(a, "fresh.txt", "brand new\n");
    const before = files(a);
    const pushed = await stashPush(git, a, { message: "Half done" });
    expect(pushed).toMatchObject({ ok: true, files: ["a.txt", "fresh.txt"] });
    expect(files(a)).toBe("");
    const [stash] = await stashList(git, a);
    expect(stash).toMatchObject({ message: "Half done", branch: "main", files: ["a.txt", "fresh.txt"] });

    // Something else happens meanwhile (a pull, here a commit), then the changes come back.
    write(a, "b.txt", "other work\n");
    await commitAll(a, "Other work");
    expect(await stashRestore(git, a, stash.sha)).toMatchObject({ ok: true, files: ["a.txt", "fresh.txt"] });
    expect(read(a, "a.txt")).toBe("edited\n");
    expect(read(a, "fresh.txt")).toBe("brand new\n");
    expect(files(a)).toBe(before);
    expect(await stashList(git, a)).toEqual([]);
  });

  it("stashes only the chosen files", async () => {
    write(a, "a.txt", "edited\n");
    write(a, "b.txt", "edited too\n");
    expect(await stashPush(git, a, { paths: ["b.txt"] })).toMatchObject({ ok: true, files: ["b.txt"] });
    expect(read(a, "a.txt")).toBe("edited\n");
    expect(read(a, "b.txt")).toBe("b.txt line one\nline two\n");
    await expect(stashPush(git, a, { paths: ["c.txt"] })).rejects.toThrow(/no changes/);
    sh(a, "restore", "a.txt");
    expect(await stashPush(git, a)).toEqual({ ok: false, reason: "nothing" });
  });

  it("refuses when something is in the way, undoes a conflicting restore, and keeps the stash", async () => {
    write(a, "a.txt", "stashed version\n");
    write(a, "fresh.txt", "stashed new file\n");
    write(a, "staged.txt", "new and staged\n");
    sh(a, "add", "staged.txt");
    const { sha } = (await stashPush(git, a)) as { sha: string };

    write(a, "a.txt", "uncommitted here\n");
    expect(await stashRestore(git, a, sha)).toMatchObject({ ok: false, reason: "uncommitted", files: ["a.txt"] });
    expect(read(a, "a.txt")).toBe("uncommitted here\n");
    sh(a, "restore", "a.txt");

    write(a, "fresh.txt", "mine\n");
    expect(await stashRestore(git, a, sha)).toMatchObject({ ok: false, reason: "untracked", files: ["fresh.txt"] });
    expect(read(a, "fresh.txt")).toBe("mine\n");
    fs.rmSync(path.join(a, "fresh.txt"));

    // The branch changed the same lines since: the restore conflicts, so it's undone.
    write(a, "a.txt", "committed meanwhile\n");
    await commitAll(a, "Meanwhile");
    const committed = head(a);
    expect(await stashRestore(git, a, sha)).toMatchObject({ ok: false, reason: "conflicts", files: ["a.txt"] });
    expect(files(a)).toBe("");
    expect(read(a, "a.txt")).toBe("committed meanwhile\n");
    expect(fs.existsSync(path.join(a, "fresh.txt"))).toBe(false);
    expect(fs.existsSync(path.join(a, "staged.txt"))).toBe(false);
    expect(head(a)).toBe(committed);
    expect((await stashList(git, a)).map((s) => s.sha)).toEqual([sha]);
  });

  it("picks stashes by commit id even after others were added, and deletes only the chosen one", async () => {
    write(a, "a.txt", "first\n");
    const first = (await stashPush(git, a, { message: "one" })) as { sha: string };
    write(a, "b.txt", "second\n");
    const second = (await stashPush(git, a, { message: "two" })) as { sha: string };
    // The first is stash@{1} now; restoring it by id leaves the second.
    expect(await stashRestore(git, a, first.sha)).toMatchObject({ ok: true });
    expect(read(a, "a.txt")).toBe("first\n");
    expect((await stashList(git, a)).map((s) => s.message)).toEqual(["two"]);
    await stashDelete(git, a, second.sha);
    expect(await stashList(git, a)).toEqual([]);
    await expect(stashDelete(git, a, second.sha)).rejects.toThrow(/isn't here any more/);
  });
});

describe("MakeWork's own credentials", () => {
  // Another app's connection, as VS Code and credential managers set it up: each leaves a marker if git asks it.
  const otherApps = () => {
    const marker = path.join(root, "asked");
    const askpass = path.join(root, "askpass.sh");
    fs.writeFileSync(askpass, `#!/bin/sh\necho askpass >> "${marker}"\necho other-secret\n`, { mode: 0o755 });
    fs.appendFileSync(env.GIT_CONFIG_GLOBAL!, `[credential]\n\thelper = "!f() { echo helper >> '${marker}'; echo username=someone; echo password=other-secret; }; f"\n`);
    return { marker, env: { ...env, GIT_ASKPASS: askpass, VSCODE_GIT_ASKPASS_MAIN: askpass, SSH_ASKPASS: askpass } };
  };
  // What git would send to `host` for a command run with remoteEnv's environment.
  const fill = async (runEnv: NodeJS.ProcessEnv, url: string, host: string, token: string | null) => {
    const extra = await remoteEnv(withCredentials(createGit({ env: runEnv }), (h) => (h === "github.com" ? token : null)), a, url);
    const childEnv = Object.fromEntries(Object.entries({ ...runEnv, GIT_TERMINAL_PROMPT: "0", ...extra }).filter(([, v]) => v !== undefined));
    const result = spawnSync("git", ["credential", "fill"], { cwd: a, env: childEnv, input: `protocol=https\nhost=${host}\n\n`, encoding: "utf8" });
    return { out: result.stdout, ok: result.status === 0, extra, childEnv };
  };

  it("reads the host of https, ssh and scp-like addresses", () => {
    expect(remoteHost("https://github.com/o/r.git")).toBe("github.com");
    expect(remoteHost("https://user@GitHub.com/o/r")).toBe("github.com");
    expect(remoteHost("git@github.com:o/r.git")).toBe("github.com");
    expect(remoteHost("ssh://git@gitlab.com:22/o/r.git")).toBe("gitlab.com");
    expect(remoteHost("/tmp/remote.git")).toBeNull();
    expect(remoteHost("C:\\repos\\remote.git")).toBeNull();
  });

  it("gives git only MakeWork's token for GitHub, never another app's connection", async () => {
    const other = otherApps();
    const { out, ok, extra } = await fill(other.env, "https://github.com/o/r.git", "github.com", "mw-token-123");
    expect(ok).toBe(true);
    expect(out).toContain("username=x-access-token");
    expect(out).toContain("password=mw-token-123");
    expect(fs.existsSync(other.marker)).toBe(false);
    // The token is only in the git process's environment, never in a config value or argument.
    expect(Object.entries(extra).filter(([k]) => k.startsWith("GIT_CONFIG_VALUE")).some(([, v]) => v?.includes("mw-token-123"))).toBe(false);
  });

  it("offers a working copy the token of its channel's connection, and only to that connection's host", () => {
    // No pick on this computer: the host's own slot (the GitHub sign-in, or a token kept before connections had names).
    expect(credentialName("github.com", undefined)).toBe("github.com");
    expect(credentialName("github.com", "github.com#k3y")).toBe("github.com#k3y");
    expect(credentialName("github.com", "github.com")).toBe("github.com");
    // "No connection": no token at all, not the host's slot.
    expect(credentialName("github.com", "")).toBeNull();
    // A connection for another host never goes to this one (a look-alike host included).
    expect(credentialName("github.com", "gitlab.com#k3y")).toBe("github.com");
    expect(credentialName("github.com", "github.com.evil.example#k3y")).toBe("github.com");
  });

  it("without a MakeWork sign-in, GitHub gets no credential at all (no prompt, no other app)", async () => {
    const other = otherApps();
    const { ok, out } = await fill(other.env, "git@github.com:o/r.git", "github.com", null);
    expect(ok).toBe(false);
    expect(out).not.toContain("other-secret");
    expect(fs.existsSync(other.marker)).toBe(false);
  });

  it("leaves other hosts to the user's own helpers, but never another app's askpass", async () => {
    const other = otherApps();
    const { out, extra } = await fill(other.env, "https://git.example.com/o/r.git", "git.example.com", "mw-token-123");
    expect(out).toContain("password=other-secret");
    expect(read(root, "asked").trim()).toBe("helper");
    expect(extra.GIT_ASKPASS).toBeUndefined();
    expect("GIT_ASKPASS" in extra).toBe(true);
  });

  it("sends ssh addresses over HTTPS for that command only, without touching the repository's config", async () => {
    sh(a, "remote", "set-url", "origin", "git@github.com:owner/repo.git");
    const config = read(a, ".git/config");
    const { childEnv } = await fill(env, "git@github.com:owner/repo.git", "github.com", "t");
    expect(execFileSync("git", ["remote", "get-url", "origin"], { cwd: a, env: childEnv, encoding: "utf8" }).trim()).toBe("https://github.com/owner/repo.git");
    expect(sh(a, "remote", "get-url", "origin")).toBe("git@github.com:owner/repo.git");
    expect(read(a, ".git/config")).toBe(config);
  });

  it("turns a failed sign-in into an auth refusal, with the token kept out of the arguments", async () => {
    const calls: { args: string[]; env?: Record<string, string | undefined> }[] = [];
    const fake = withCredentials(async (_cwd, args, options) => {
      calls.push({ args, env: options?.extraEnv });
      if (args[0] === "remote") return { out: "https://github.com/o/private.git\n", code: 0, truncated: false };
      if (args[0] === "fetch") throw new Error("fatal: could not read Username for 'https://github.com': terminal prompts disabled");
      return { out: "", code: 0, truncated: false };
    }, () => "secret-token");
    // A token was sent and refused: it says so (expired, or no access), not that the member never signed in.
    await expect(fetchRemote(fake, a)).rejects.toThrow(/^\[auth github\.com\] GitHub refused MakeWork's sign-in/);
    const fetchCall = calls.find((c) => c.args[0] === "fetch")!;
    expect(fetchCall.env?.MW_GIT_TOKEN).toBe("secret-token");
    expect(calls.some((c) => c.args.join(" ").includes("secret-token"))).toBe(false);
  });

  it("asks to sign in only when no token was kept for the host", async () => {
    const fake = withCredentials(async (_cwd, args) => {
      if (args[0] === "remote") return { out: "https://github.com/o/private.git\n", code: 0, truncated: false };
      if (args[0] === "fetch") throw new Error("fatal: could not read Username for 'https://github.com': terminal prompts disabled");
      return { out: "", code: 0, truncated: false };
    }, () => null);
    await expect(fetchRemote(fake, a)).rejects.toThrow(/^\[auth github\.com\] GitHub needs you to sign in/);
  });
});

describe("submodules", () => {
  // A second repository, added to A as a submodule at `sub` (file links between test folders need allowing).
  function addSubmodule(sub: string, url?: string) {
    const lib = path.join(root, `${sub.replaceAll("/", "-")}-src`);
    sh(root, "init", "-q", "-b", "main", lib);
    write(lib, "lib.txt", "lib\n");
    sh(lib, "add", ".");
    sh(lib, "commit", "-q", "-m", "Library");
    sh(a, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, sub);
    if (url) sh(a, "config", "-f", ".gitmodules", `submodule.${sub}.url`, url);
    sh(a, "add", ".");
    sh(a, "commit", "-q", "-m", `Add ${sub}`);
    return { lib, pinned: head(lib) };
  }

  it("lists what the last commit records, with the folder of each one checked out here", async () => {
    expect(await submodules(git, a)).toEqual([]);
    const lib = addSubmodule("vendor/lib", "../lib.git");
    const tool = addSubmodule("tool");
    const found = await submodules(git, a);
    expect(found.map((s) => [s.name, s.path, s.url, s.pinned, s.branch])).toEqual([
      ["tool", "tool", tool.lib, tool.pinned, null], ["vendor/lib", "vendor/lib", "../lib.git", lib.pinned, null],
    ]);
    expect(found.map((s) => s.folder && fs.realpathSync(s.folder))).toEqual([fs.realpathSync(path.join(a, "tool")), fs.realpathSync(path.join(a, "vendor/lib"))]);
    // The submodule's folder is a repository of its own.
    expect((await branches(git, found[0].folder!)).current).toBe("main");

    // A clone that never fetched them: listed, without a folder.
    sh(a, "push", "-q", "origin", "main");
    const c = path.join(root, "c");
    sh(root, "clone", "-q", remote, c);
    expect((await submodules(git, c)).map((s) => [s.path, s.pinned, s.folder])).toEqual([["tool", tool.pinned, null], ["vendor/lib", lib.pinned, null]]);
  });

  it("leaves out listed paths that aren't submodules, and never names a folder outside the repository", async () => {
    addSubmodule("tool");
    fs.appendFileSync(path.join(a, ".gitmodules"), '[submodule "fake"]\n\tpath = a.txt\n\turl = https://example.com/x.git\n'
      + '[submodule "out"]\n\tpath = ../b\n\turl = https://example.com/y.git\n');
    sh(a, "add", ".gitmodules");
    sh(a, "commit", "-q", "-m", "Odd entries");
    expect((await submodules(git, a)).map((s) => s.path)).toEqual(["tool"]);
    // A link in the submodule's place that leads out of the repository isn't a folder of it.
    fs.rmSync(path.join(a, "tool"), { recursive: true, force: true });
    fs.symlinkSync(b, path.join(a, "tool"));
    expect((await submodules(git, a)).map((s) => [s.path, s.folder])).toEqual([["tool", null]]);
  });

  // A clone of A, after A's submodules were pushed, that has none of them yet.
  function freshClone() {
    sh(a, "push", "-q", "origin", "main");
    const c = path.join(root, "c");
    sh(root, "clone", "-q", remote, c);
    return c;
  }
  const at = (dir: string) => sh(dir, "rev-parse", "HEAD");
  const branchOf = (dir: string) => sh(dir, "branch", "--show-current");

  it("clones the missing ones and puts each on its remote's default branch, following it", async () => {
    const tool = addSubmodule("tool");
    const lib = addSubmodule("vendor/lib");
    const c = freshClone();
    const prepared = await prepareSubmodules(git, c);
    expect(prepared.map((s) => [s.path, s.cloned, s.onBranch, s.attached, s.error ?? null])).toEqual([
      ["tool", true, "main", true, null], ["vendor/lib", true, "main", true, null],
    ]);
    const toolDir = path.join(c, "tool");
    expect(fs.realpathSync(prepared[0].folder!)).toBe(fs.realpathSync(toolDir));
    expect([at(toolDir), at(path.join(c, "vendor/lib"))]).toEqual([tool.pinned, lib.pinned]);
    expect(sh(toolDir, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main");
    // Nothing changed for the repository itself.
    expect(await status(git, c)).toEqual([]);
    // Again: nothing to do.
    expect((await prepareSubmodules(git, c)).map((s) => [s.cloned, s.attached, s.onBranch])).toEqual([[false, false, "main"], [false, false, "main"]]);
  });

  it("clones each one with the sign-in for the folder it goes into", async () => {
    addSubmodule("tool");
    addSubmodule("vendor/lib");
    const c = freshClone();
    const asked: string[] = [];
    const gitFor = (folder: string) => { asked.push(path.relative(c, folder)); return git; };
    expect((await prepareSubmodules(git, c, { gitFor })).map((s) => s.cloned)).toEqual([true, true]);
    expect(asked).toEqual(["tool", path.join("vendor", "lib")]);
  });

  it("takes the branch .gitmodules names, and '.' as the repository's own", async () => {
    const tool = addSubmodule("tool");
    sh(tool.lib, "branch", "dev");
    addSubmodule("same");
    sh(a, "config", "-f", ".gitmodules", "submodule.tool.branch", "dev");
    sh(a, "config", "-f", ".gitmodules", "submodule.same.branch", ".");
    sh(a, "commit", "-q", "-am", "Branches");
    const c = freshClone();
    expect((await prepareSubmodules(git, c)).map((s) => [s.path, s.branch, s.onBranch])).toEqual([["same", ".", "main"], ["tool", "dev", "dev"]]);
    expect(sh(path.join(c, "tool"), "rev-parse", "--abbrev-ref", "dev@{upstream}")).toBe("origin/dev");
  });

  it("leaves a submodule on its commit when that would change files, or something is in progress", async () => {
    const tool = addSubmodule("tool");
    const c = freshClone();
    await prepareSubmodules(git, c);
    const dir = path.join(c, "tool");
    // Its main moves on; the submodule goes back to the pinned commit with a change of its own.
    write(dir, "later.txt", "later\n");
    sh(dir, "add", ".");
    sh(dir, "commit", "-q", "-m", "Later");
    sh(dir, "switch", "-q", "--detach", tool.pinned);
    write(dir, "lib.txt", "edited\n");
    const left = await attachBranch(git, dir, null);
    expect(left.left).toMatch(/main is at another commit/);
    expect([at(dir), branchOf(dir), read(dir, "lib.txt")]).toEqual([tool.pinned, "", "edited\n"]);

    // A new branch at the same commit changes nothing, so a change in the way doesn't matter.
    expect(await attachBranch(git, dir, "fix")).toEqual({ onBranch: "fix", attached: true });
    expect([at(dir), read(dir, "lib.txt")]).toEqual([tool.pinned, "edited\n"]);

    sh(dir, "switch", "-q", "--detach", tool.pinned);
    fs.writeFileSync(path.join(sh(dir, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD"), `${tool.pinned}\n`);
    expect((await attachBranch(git, dir, "other")).left).toMatch(/merge is in progress/);
    expect(branchOf(dir)).toBe("");
  });

  it("clones the others when one can't be reached, and never into a folder with files", async () => {
    addSubmodule("tool");
    addSubmodule("gone");
    addSubmodule("full");
    sh(a, "config", "-f", ".gitmodules", "submodule.gone.url", path.join(root, "nowhere.git"));
    sh(a, "commit", "-q", "-am", "Moved away");
    const c = freshClone();
    write(c, "full/mine.txt", "mine\n");
    const prepared = await prepareSubmodules(git, c);
    expect(prepared.map((s) => [s.path, s.cloned, !!s.error, s.left ?? null])).toEqual([
      ["full", false, false, "Its folder already holds files, so nothing was cloned into it."],
      ["gone", false, true, null],
      ["tool", true, false, null],
    ]);
    expect(read(c, "full/mine.txt")).toBe("mine\n");
  });

  it("marks a submodule among the changes once it is at another commit", async () => {
    addSubmodule("tool");
    const tool = path.join(a, "tool");
    write(tool, "more.txt", "more\n");
    sh(tool, "add", ".");
    sh(tool, "commit", "-q", "-m", "More");
    write(a, "a.txt", "changed\n");
    expect((await status(git, a)).map((f) => [f.path, f.kind, f.submodule ?? false])).toEqual([["a.txt", "modified", false], ["tool", "modified", true]]);
    await commitAll(a, "Move tool");
    expect((await submodules(git, a))[0].pinned).toBe(head(tool));
  });
});

describe("git safety: the source", () => {
  it("never uses a forcing or history-rewriting option", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../electron/gitOps.js"), "utf8");
    const forbidden = ["--force", "--force-with-lease", "--force-if-includes", "-f", "-D", "--hard", "--amend", "--delete", "--allow-empty",
      "--discard-changes", "--mirror", "--prune", "reset", "clean", "checkout", "rebase", "filter-branch", "update-ref", "-uno",
      "pop", "clear"];
    for (const option of forbidden) expect(source).not.toMatch(new RegExp(`\\[\\s*"${option}"|,\\s*"${option}"\\s*[,\\]]`));
    expect(source).not.toMatch(/"\+refs/);
    // Stashes: only these subcommands, and dropping only in the two functions that check the stash's id first.
    const stashCommands = [...source.matchAll(/"stash",\s*"([\w-]+)"/g)].map((m) => m[1]);
    expect(stashCommands.length).toBeGreaterThan(0);
    for (const command of stashCommands) expect(["push", "list", "show", "apply", "drop"]).toContain(command);
    const drops = [...source.matchAll(/"stash",\s*"drop"/g)].map((m) => source.lastIndexOf("export async function", m.index));
    expect(new Set(drops.map((i) => /function (\w+)/.exec(source.slice(i))![1]))).toEqual(new Set(["stashRestore", "stashDelete"]));
    // Commits are made around the index only by a resolved merge, which checks everything first.
    const commitTrees = [...source.matchAll(/"commit-tree"/g)].map((m) => source.lastIndexOf("export async function", m.index));
    expect(commitTrees.length).toBeGreaterThan(0);
    expect(new Set(commitTrees.map((i) => /function (\w+)/.exec(source.slice(i))![1]))).toEqual(new Set(["mergeResolved"]));
  });
});
