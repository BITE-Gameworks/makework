// Git for version control channels: reading (status, diffs, blame, files, branches) and the few writes the app makes
// (commits, branches, fetch, push, merging the remote's new commits, cloning missing submodules). Safety comes first, so this file never uses a
// forcing or history-rewriting option of any kind (tests/electron/gitOps.test.ts checks the source), and every write
// checks first that it can't lose work:
// - commits take only the files the user ticked, never an empty or emptied tree, and ask before removing over a
//   quarter of the files;
// - pushes fetch first, are refused while the remote has commits this copy lacks, and are plain fast-forwards;
// - the remote's commits are merged only when a dry run (merge-tree, nothing touched) finds no conflicts, or once the
//   user chose what every conflicted file becomes: that merge commit is built on a scratch index and the branch
//   fast-forwards to it, so the working copy is never left half merged;
// - branches are deleted only with `branch -d` (git refuses unmerged work), never the current or default one,
//   never on the remote; switching needs a clean working tree;
// - missing submodules are cloned only into an empty or missing folder, and a submodule is put on a branch only when
//   that changes no file;
// - stashes are restored only when nothing in the way would be overwritten (a failed restore is undone and the stash
//   kept), and removed from the list only after a clean restore or a confirmed delete, always picked by commit id.
// Every function takes the `git` runner from createGit, so main.js and the tests share all of it.
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { trimEnd } from "./text.js";

export const shaPattern = /^[0-9a-f]{7,64}$/;
// Over this share of the files removed, a commit or push needs the user to confirm it.
export const massDeleteShare = 0.25;
const remoteTimeoutMs = 120_000;

export class GitRefusal extends Error {
  constructor(message, details = {}) {
    super(message);
    this.details = details;
  }
}

// Runs git without a shell. Never prompts (credentials come from the user's helpers or fail), stable English output.
// `allowCodes`: exit codes that aren't errors; `maxBytes` with `truncate`: output beyond it is cut and flagged;
// `input`: text given to git on stdin.
export function createGit({ spawn = nodeSpawn, env = process.env } = {}) {
  return function git(cwd, args, options = {}) {
    const { timeoutMs = 30_000, maxBytes = 64 * 1024 * 1024, allowCodes = [0], truncate = false, extraEnv = {}, input = null } = options;
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn("git", args, {
          cwd, windowsHide: true, stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"],
          // An undefined value in extraEnv removes that variable.
          env: Object.fromEntries(Object.entries({ ...env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...extraEnv }).filter(([, v]) => v !== undefined)),
        });
      } catch (e) {
        reject(e);
        return;
      }
      const out = [];
      let size = 0;
      let truncated = false;
      let err = "";
      const timer = setTimeout(() => child.kill(), timeoutMs);
      if (input !== null) {
        // git stopping early shows as its exit code; the broken pipe itself isn't an error.
        child.stdin.on("error", () => {});
        child.stdin.end(input);
      }
      child.stdout.on("data", (chunk) => {
        if (truncated) return;
        if (size + chunk.length > maxBytes) {
          out.push(chunk.subarray(0, maxBytes - size));
          truncated = true;
          if (truncate) child.kill();
          return;
        }
        out.push(chunk);
        size += chunk.length;
      });
      child.stderr.on("data", (chunk) => (err += chunk));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e.code === "ENOENT" ? new Error("Git isn't installed. Install it from git-scm.com and try again.") : e);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const text = Buffer.concat(out).toString("utf8");
        if (truncated && truncate) return resolve({ out: text, code: 0, truncated: true });
        if (truncated) return reject(new Error("Git's answer was too large."));
        if (signal) return reject(new Error(`Git took too long (${args[0]}).`));
        if (!allowCodes.includes(code)) return reject(new Error(err.trim() || `git ${args[0]} failed (${code}).`));
        resolve({ out: text, code, truncated: false });
      });
    });
  };
}

const run = async (git, cwd, args, options) => (await git(cwd, args, options)).out;

// ---- Checking what comes from the page ----

export function checkSha(sha) {
  if (typeof sha !== "string" || !shaPattern.test(sha)) throw new GitRefusal("Not a commit id.");
  return sha;
}

// A path inside the repository, as git printed it: relative, no "..", nothing an option parser could take.
export function checkPath(p) {
  if (typeof p !== "string" || p === "" || p.includes("\0") || p.startsWith("-") || path.isAbsolute(p) || /^[A-Za-z]:/.test(p))
    throw new GitRefusal("Not a file in this repository.");
  if (p.split(/[\\/]/).includes("..")) throw new GitRefusal("Not a file in this repository.");
  return p;
}

export async function checkBranchName(git, cwd, name) {
  if (typeof name !== "string" || name === "" || name.startsWith("-") || name.length > 200)
    throw new GitRefusal("That isn't a valid branch name.");
  const { code } = await git(cwd, ["check-ref-format", "--branch", name], { allowCodes: [0, 1, 128] });
  if (code !== 0) throw new GitRefusal("That isn't a valid branch name.");
  return name;
}

// A branch name or a commit id that names a commit here.
async function checkRevision(git, cwd, rev) {
  if (typeof rev !== "string" || rev === "" || rev.startsWith("-") || !/^[\w./@-]+$/.test(rev)) throw new GitRefusal("Not a branch or commit.");
  const { code, out } = await git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`], { allowCodes: [0, 1] });
  if (code !== 0) throw new GitRefusal(`${rev} isn't a branch or commit here.`);
  return out.trim();
}

// ---- Repository state ----

// The current branch (null when detached), its commit (null before the first one) and an operation git is in the
// middle of (merge, rebase, cherry-pick, revert), which the app leaves to the user's own tools.
export async function repoState(git, cwd) {
  const branch = (await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowCodes: [0, 1, 128] })).out.trim() || null;
  const head = (await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowCodes: [0, 1, 128] })).out.trim() || null;
  const gitDir = path.resolve(cwd, (await run(git, cwd, ["rev-parse", "--git-dir"])).trim());
  const exists = (name) => fs.access(path.join(gitDir, name)).then(() => true, () => false);
  let operation = null;
  if (await exists("MERGE_HEAD")) operation = "merge";
  else if ((await exists("rebase-merge")) || (await exists("rebase-apply"))) operation = "rebase";
  else if (await exists("CHERRY_PICK_HEAD")) operation = "cherry-pick";
  else if (await exists("REVERT_HEAD")) operation = "revert";
  return { branch, head, operation };
}

const kindOf = (xy) => {
  if (xy.includes("D")) return "deleted";
  if (xy[0] === "A") return "added";
  return "modified";
};

// Porcelain v2 writes "S..." for a submodule (the commit it is at, not a file) and "N..." for everything else.
const submoduleMark = (sub) => (sub?.[0] === "S" ? { submodule: true } : {});

// Changed files in the working tree and index: { path, origPath?, kind, staged, submodule? }.
export async function status(git, cwd) {
  const out = await run(git, cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--no-renames"]);
  const records = out.split("\0");
  const files = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const type = record[0];
    if (type === "?") files.push({ path: record.slice(2), kind: "untracked", staged: false });
    else if (type === "1") {
      const parts = record.split(" ");
      const xy = parts[1];
      files.push({ path: parts.slice(8).join(" "), kind: kindOf(xy), staged: xy[0] !== ".", ...submoduleMark(parts[2]) });
    } else if (type === "2") {
      const parts = record.split(" ");
      files.push({ path: parts.slice(9).join(" "), origPath: records[++i], kind: "renamed", staged: true, ...submoduleMark(parts[2]) });
    } else if (type === "u") {
      const parts = record.split(" ");
      files.push({ path: parts.slice(10).join(" "), kind: "conflicted", staged: false, ...submoduleMark(parts[2]) });
    }
  }
  return files;
}

const maxSubmodules = 200;

// The repository's submodules as its last commit lists them: [{ name, path, url, branch, pinned, folder }]. `url` is
// as .gitmodules has it (it can be relative to the repository's own link), `branch` the branch .gitmodules names for
// it (null for none, "." for the repository's own current one), `pinned` the commit recorded for it, `folder` its
// working copy when it is checked out here, else null. A listed path that isn't a submodule in the commit is left out,
// and a folder counts only when it is a repository of its own inside this one: .gitmodules is content anyone can write.
export async function submodules(git, cwd) {
  const listed = await git(cwd, ["config", "-z", "--blob", "HEAD:.gitmodules", "--get-regexp", "^submodule\\..*\\.(path|url|branch)$"],
    { allowCodes: [0, 1, 128] });
  if (listed.code !== 0) return [];
  const byName = new Map();
  for (const record of listed.out.split("\0")) {
    // "submodule.<name>.<key>", a line break, then the value.
    const at = record.indexOf("\n");
    const key = /^submodule\.(.*)\.(path|url|branch)$/.exec(at < 0 ? "" : record.slice(0, at));
    if (!key) continue;
    const entry = byName.get(key[1]) ?? { name: key[1] };
    entry[key[2]] = record.slice(at + 1);
    byName.set(key[1], entry);
  }
  const byPath = new Map();
  for (const { name, path: listedPath, url, branch } of byName.values()) {
    if (typeof listedPath !== "string" || byPath.size >= maxSubmodules) continue;
    const subPath = trimEnd(listedPath.replaceAll("\\", "/"), "/");
    try {
      checkPath(subPath);
    } catch {
      continue;
    }
    byPath.set(subPath, { name, url: typeof url === "string" ? url : "", branch: typeof branch === "string" && branch.trim() ? branch.trim() : null });
  }
  if (byPath.size === 0) return [];
  const tree = await run(git, cwd, ["ls-tree", "-z", "HEAD", "--", ...byPath.keys()]);
  const root = await fs.realpath(cwd);
  const found = [];
  for (const record of tree.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, , pinned] = record.slice(0, tab).split(" ");
    const subPath = record.slice(tab + 1);
    if (mode !== "160000" || !byPath.has(subPath)) continue;
    found.push({ ...byPath.get(subPath), path: subPath, pinned, folder: await checkedOut(git, root, subFolder(cwd, subPath)) });
  }
  return found.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

const subFolder = (cwd, subPath) => path.join(cwd, ...subPath.split("/"));
const cloneTimeoutMs = 15 * 60_000;

// Gets the repository's submodules ready to work in, one at a time (one failing never stops the others):
// - a submodule that isn't here is cloned into its folder, at the commit the repository records for it, when that
//   folder is missing or empty (never over files, never through a link), with git's plain checkout (a repository's
//   own `update` setting, which can name a command, is never used);
// - a submodule on no branch is put on its branch (see attachBranch), which never changes a file.
// Returns submodules() with, for each: cloned, onBranch (its branch now, null for none), attached (put on it now),
// left (why it stays as it is), error and auth (the host a sign-in is missing for). `serial(folder, fn)` runs `fn`
// in turn with the other git work in a submodule's folder; `gitFor(folder)` gives the runner that clones into it (its
// own sign-in: one host holds repositories of owners one token can't read).
export async function prepareSubmodules(git, cwd, { serial = (_folder, fn) => fn(), gitFor = () => git } = {}) {
  const own = (await repoState(git, cwd)).branch;
  const root = await fs.realpath(cwd);
  const results = [];
  for (const s of await submodules(git, cwd)) {
    const result = { ...s, cloned: false, onBranch: null, attached: false };
    results.push(result);
    try {
      if (!result.folder) {
        const left = await cloneSubmodule(git, gitFor(subFolder(cwd, s.path)), cwd, s);
        if (left) {
          result.left = left;
          continue;
        }
        result.folder = await checkedOut(git, root, subFolder(cwd, s.path));
        result.cloned = !!result.folder;
        if (!result.folder) continue;
      }
      const wanted = s.branch === "." ? own : s.branch;
      Object.assign(result, await serial(result.folder, () => attachBranch(git, result.folder, wanted)));
    } catch (e) {
      const auth = /^\[auth ([\w.-]+)\] ?/.exec(e.message);
      result.error = auth ? e.message.slice(auth[0].length) : e.message;
      if (auth) result.auth = auth[1];
    }
  }
  return results;
}

// Clones one submodule that isn't here, signing in through `cloner`; returns why it didn't, or null once it did.
async function cloneSubmodule(git, cloner, cwd, s) {
  const dir = subFolder(cwd, s.path);
  const there = await fs.lstat(dir).catch(() => null);
  if (there?.isSymbolicLink()) return "Its folder is a link, so nothing was cloned into it.";
  if (there && !there.isDirectory()) return "A file is in its place, so nothing was cloned.";
  if (there && (await fs.readdir(dir)).length) return "Its folder already holds files, so nothing was cloned into it.";
  // Init copies its link, made whole, into this copy's own config; that is where the clone reads it.
  await run(git, cwd, ["submodule", "init", "--", s.path]);
  const url = (await git(cwd, ["config", "--get", `submodule.${s.name}.url`], { allowCodes: [0, 1] })).out.trim();
  if (!url) return "It has no link to clone from.";
  await remoteRun(cloner, cwd, url, ["submodule", "update", "--checkout", "--", s.path], cloneTimeoutMs);
  return null;
}

// Puts a submodule that is on no branch onto `wanted` (else its remote's default branch), only where that
// changes no file: a new branch made at its commit (following origin's of that name when there is one), or an
// existing one that is at exactly that commit. Anything else stays as it is, with the reason.
export async function attachBranch(git, cwd, wanted) {
  const state = await repoState(git, cwd);
  if (state.branch) return { onBranch: state.branch };
  if (state.operation) return { left: `A ${state.operation} is in progress in it, so it stays on its commit.` };
  if (!state.head) return { left: "It has no commit yet." };
  const name = wanted || (await remoteDefault(git, cwd));
  if (!name) return { left: "Its remote names no default branch, so it stays on its commit." };
  try {
    await checkBranchName(git, cwd, name);
  } catch {
    return { left: `${name} isn't a valid branch name, so it stays on its commit.` };
  }
  const local = `refs/heads/${name}`;
  if (await branchExists(git, cwd, local)) {
    const at = (await run(git, cwd, ["rev-parse", "--verify", "--end-of-options", local])).trim();
    if (at !== state.head) return { left: `Its branch ${name} is at another commit, so it stays on the pinned one (switch in Branches).` };
  } else {
    await run(git, cwd, ["branch", "--no-track", name, state.head]);
    if (await branchExists(git, cwd, `refs/remotes/origin/${name}`)) await run(git, cwd, ["branch", `--set-upstream-to=origin/${name}`, name]);
  }
  // The branch is at the commit already checked out, so switching changes no file.
  await run(git, cwd, ["switch", name]);
  return { onBranch: name, attached: true };
}

// `dir` as git names it when it is the top of a working copy of its own inside `root` (links followed), else null.
async function checkedOut(git, root, dir) {
  const real = await fs.realpath(dir).catch(() => null);
  if (!real || !real.startsWith(root + path.sep)) return null;
  const top = (await git(dir, ["rev-parse", "--show-toplevel"], { allowCodes: [0, 128] }).catch(() => ({ out: "" }))).out.trim();
  if (!top || (await fs.realpath(top).catch(() => null)) !== real) return null;
  return top;
}

// The working copy's changes to one file against the last commit (new files against nothing).
export async function workingDiff(git, cwd, file) {
  checkPath(file);
  const changed = (await status(git, cwd)).find((f) => f.path === file);
  if (!changed) return { patch: "", truncated: false };
  const args = changed.kind === "untracked"
    ? ["diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", file]
    : (await repoState(git, cwd)).head
      ? ["diff", "--no-color", "--no-ext-diff", "HEAD", "--", file]
      : ["diff", "--cached", "--no-color", "--no-ext-diff", "--", file];
  const { out, truncated } = await git(cwd, args, { allowCodes: [0, 1], maxBytes: 8 * 1024 * 1024, truncate: true });
  return { patch: out, truncated };
}

// A commit's changes (merge commits against their first parent), as a unified diff.
export async function showCommit(git, cwd, sha) {
  checkSha(sha);
  const { out, truncated } = await git(cwd,
    ["show", "--format=", "--patch", "-M", "--no-color", "--no-ext-diff", "--diff-merges=first-parent", sha, "--"],
    { maxBytes: 8 * 1024 * 1024, truncate: true });
  return { patch: out, truncated };
}

// Every file at a commit or branch.
export async function listFiles(git, cwd, rev) {
  const commit = await checkRevision(git, cwd, rev);
  return (await run(git, cwd, ["ls-tree", "-r", "-z", "--name-only", commit])).split("\0").filter(Boolean);
}

// Who last changed each line of a file at a commit: [{ line, sha, author, time, summary, text }].
export async function blame(git, cwd, rev, file) {
  const commit = await checkRevision(git, cwd, rev);
  checkPath(file);
  const out = await run(git, cwd, ["blame", "--porcelain", commit, "--", file], { maxBytes: 32 * 1024 * 1024 });
  const info = new Map();
  const lines = [];
  let current = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("\t")) {
      if (current) lines.push({ line: current.line, sha: current.sha, ...info.get(current.sha), text: line.slice(1) });
      current = null;
      continue;
    }
    const header = /^([0-9a-f]{40,64}) \d+ (\d+)/.exec(line);
    if (header) {
      current = { sha: header[1], line: Number(header[2]) };
      if (!info.has(current.sha)) info.set(current.sha, { author: "", time: 0, summary: "" });
      continue;
    }
    if (!current) continue;
    const entry = info.get(current.sha);
    if (line.startsWith("author ")) entry.author = line.slice(7);
    else if (line.startsWith("author-time ")) entry.time = Number(line.slice(12)) * 1000;
    else if (line.startsWith("summary ")) entry.summary = line.slice(8);
  }
  return lines;
}

// ---- Branches ----

// The remote's default branch as this copy knows it (origin/HEAD), else null.
export async function remoteDefault(git, cwd) {
  const out = (await git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { allowCodes: [0, 1, 128] })).out.trim();
  return out.startsWith("origin/") ? out.slice("origin/".length) : null;
}

// Local branches with their remote counterpart: [{ name, head, upstream, ahead, behind }], plus the current one.
export async function branches(git, cwd) {
  const out = await run(git, cwd, ["for-each-ref", "--format=%(refname:short)%00%(objectname)%00%(upstream:short)%00%(upstream:track,nobracket)", "refs/heads"]);
  const list = out.split("\n").filter(Boolean).map((line) => {
    const [name, head, upstream, track] = line.split("\0");
    const ahead = Number(/ahead (\d+)/.exec(track ?? "")?.[1] ?? 0);
    const behind = Number(/behind (\d+)/.exec(track ?? "")?.[1] ?? 0);
    return { name, head, upstream: upstream || null, ahead, behind, gone: (track ?? "").includes("gone") };
  });
  const { branch } = await repoState(git, cwd);
  const remotes = Object.entries(await remoteHeads(git, cwd)).map(([name, head]) => ({ name: `origin/${name}`, head }));
  return { current: branch, defaultBranch: await remoteDefault(git, cwd), branches: list, remotes };
}

// The graph of this copy: every local branch and origin's, newest first in topological order, each commit with the
// branch names pointing at it. `incoming`: commits on origin this copy's branches don't have yet; `outgoing`: commits
// on local branches that aren't on origin (not pushed). Both capped at 1,000.
export async function graph(git, cwd, { max = 400, skip = 0 } = {}) {
  const state = await repoState(git, cwd);
  if (!state.head) return { head: state, commits: [], incoming: [], outgoing: [], more: false };
  const limit = Math.min(Math.max(Number(max) || 400, 1), 5000);
  const out = await run(git, cwd, ["log", "--topo-order", "--decorate=short", `--skip=${Math.max(Number(skip) || 0, 0)}`, `--max-count=${limit}`,
    "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%B%x1e", "--branches", "--remotes=origin", "HEAD", "--"]);
  const commits = out.split("\x1e").map((r) => r.replace(/^\n/, "")).filter(Boolean).map((record) => {
    const [sha, parents, author_name, author_email, authored_at, decoration, message] = record.split("\x1f");
    const refs = [];
    for (const raw of decoration.split(", ").filter(Boolean)) {
      if (raw.startsWith("HEAD -> ")) refs.push({ name: raw.slice(8), kind: "local", head: true });
      else if (raw === "HEAD") refs.push({ name: "HEAD", kind: "detached", head: true });
      else if (raw.startsWith("tag: ")) refs.push({ name: raw.slice(5), kind: "tag", head: false });
      else if (raw === "origin/HEAD") continue;
      else refs.push({ name: raw, kind: raw.startsWith("origin/") ? "remote" : "local", head: false });
    }
    return {
      sha, parents: parents.split(" ").filter(Boolean), author_name, author_email, authored_at,
      message: trimEnd(message.replace(/\r\n?/g, "\n"), "\n"), refs,
    };
  });
  const list = async (args) => (await run(git, cwd, ["rev-list", "--max-count=1000", ...args])).split("\n").filter(Boolean);
  return {
    head: state, commits, more: commits.length === limit,
    incoming: await list(["--remotes=origin", "--not", "--branches"]),
    outgoing: await list(["--branches", "--not", "--remotes=origin"]),
  };
}

export async function createBranch(git, cwd, name, from) {
  await checkBranchName(git, cwd, name);
  const { code } = await git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], { allowCodes: [0, 1] });
  if (code === 0) throw new GitRefusal(`A branch named ${name} already exists.`);
  const start = await checkRevision(git, cwd, from);
  await run(git, cwd, ["branch", "--no-track", name, start]);
  return { name, head: start };
}

// Only fully merged branches (git's own `-d` check), never the current one or a default one.
export async function deleteBranch(git, cwd, name, protectedNames = []) {
  await checkBranchName(git, cwd, name);
  const { branch } = await repoState(git, cwd);
  if (name === branch) throw new GitRefusal("That's the branch you're on. Switch to another one first.");
  const defaults = new Set([...protectedNames, await remoteDefault(git, cwd)].filter(Boolean));
  if (defaults.has(name)) throw new GitRefusal(`${name} is the repository's default branch; it can't be deleted here.`);
  try {
    await run(git, cwd, ["branch", "-d", name]);
  } catch (e) {
    if (/not fully merged/i.test(e.message))
      throw new GitRefusal(`${name} has commits that aren't merged anywhere else, so it wasn't deleted (nothing is lost).`);
    throw e;
  }
}

const branchExists = async (git, cwd, ref) => (await git(cwd, ["show-ref", "--verify", "--quiet", ref], { allowCodes: [0, 1] })).code === 0;
const trackedChanges = async (git, cwd) => (await status(git, cwd)).filter((f) => f.kind !== "untracked").map((f) => f.path);

// Only with nothing uncommitted (untracked files are left alone and git refuses to overwrite them). `origin/x`
// checks out the local `x`, made to follow origin's first if this copy doesn't have it yet. Returns the branch.
export async function switchBranch(git, cwd, name) {
  await checkBranchName(git, cwd, name);
  const state = await repoState(git, cwd);
  if (state.operation) throw new GitRefusal(`A ${state.operation} is in progress; finish it in your git tools first.`);
  const dirty = await trackedChanges(git, cwd);
  if (dirty.length) throw new GitRefusal("Commit your changes first: switching branches with uncommitted changes could mix them up.", { files: dirty });
  if (name.startsWith("origin/")) {
    const local = name.slice("origin/".length);
    await checkBranchName(git, cwd, local);
    if (!(await branchExists(git, cwd, `refs/remotes/${name}`))) throw new GitRefusal(`${name} isn't on the remote (fetch first?).`);
    if (await branchExists(git, cwd, `refs/heads/${local}`)) await run(git, cwd, ["switch", local]);
    else await run(git, cwd, ["switch", "--create", local, "--track", name]);
    return local;
  }
  await run(git, cwd, ["switch", name]);
  return name;
}

// The ref behind a branch name from the page: a local branch, or `origin/x` for the remote's.
async function branchRef(git, cwd, name) {
  await checkBranchName(git, cwd, name);
  const ref = name.startsWith("origin/") ? `refs/remotes/${name}` : `refs/heads/${name}`;
  if (!(await branchExists(git, cwd, ref))) throw new GitRefusal(`There is no branch ${name} here.`);
  return ref;
}

const countRange = async (git, cwd, range) => Number((await run(git, cwd, ["rev-list", "--count", range])).trim()) || 0;

// The refusals every merge shares: on a branch, nothing in progress, never the branch itself, and (merging the
// current branch into `into`) only into a local branch. Returns the repository's state.
async function mergeable(git, cwd, { source = null, into = null } = {}) {
  const state = await repoState(git, cwd);
  if (!state.branch) throw new GitRefusal("This copy isn't on a branch (detached HEAD). Switch to a branch first.");
  if (state.operation) throw new GitRefusal(`A ${state.operation} is in progress; finish it in your git tools first.`);
  if (typeof into === "string" && into.startsWith("origin/")) throw new GitRefusal("Merge into a local branch; push it to update the remote.");
  if (source === state.branch || into === state.branch) throw new GitRefusal("That's the branch you're on.");
  return state;
}

// Merges `source` (a local branch or origin/x) into the current branch, only when that can't conflict: nothing
// uncommitted, a clean dry run, then a fast-forward when possible, else a merge commit (never a rebase; a failed merge
// is aborted, which puts everything back as it was).
export async function mergeBranch(git, cwd, source) {
  const state = await mergeable(git, cwd, { source });
  const ref = await branchRef(git, cwd, source);
  const incoming = await countRange(git, cwd, `HEAD..${ref}`);
  if (incoming === 0) return { ok: false, reason: "nothing", into: state.branch, from: source };
  const uncommitted = await trackedChanges(git, cwd);
  if (uncommitted.length) return { ok: false, reason: "uncommitted", files: uncommitted, into: state.branch, from: source };
  const dry = await mergeDryRun(git, cwd, "HEAD", ref);
  if (!dry.clean) return { ok: false, reason: dry.conflicts ? "conflicts" : "unknown", conflicts: dry.conflicts ?? [], into: state.branch, from: source };
  const fastForward = (await countRange(git, cwd, `${ref}..HEAD`)) === 0;
  try {
    if (fastForward) await run(git, cwd, ["merge", "--ff-only", ref], { timeoutMs: 120_000 });
    else await run(git, cwd, ["merge", "--no-edit", "--no-ff", ref], { timeoutMs: 120_000 });
  } catch (e) {
    if ((await repoState(git, cwd)).operation === "merge") await git(cwd, ["merge", "--abort"], { allowCodes: [0, 1, 128] });
    return { ok: false, reason: "failed", message: e.message, into: state.branch, from: source };
  }
  return { ok: true, merged: incoming, fastForward, into: state.branch, from: source };
}

// The other way round: switches to `target` (a local branch) and merges the branch that was current into it. The dry
// run is done on the branches before switching, so a conflict or anything uncommitted leaves you where you were.
export async function mergeCurrentInto(git, cwd, target) {
  const state = await mergeable(git, cwd, { into: target });
  const targetRef = await branchRef(git, cwd, target);
  const source = state.branch;
  const incoming = await countRange(git, cwd, `${targetRef}..refs/heads/${source}`);
  if (incoming === 0) return { ok: false, reason: "nothing", into: target, from: source };
  const uncommitted = await trackedChanges(git, cwd);
  if (uncommitted.length) return { ok: false, reason: "uncommitted", files: uncommitted, into: target, from: source };
  const dry = await mergeDryRun(git, cwd, targetRef, `refs/heads/${source}`);
  if (!dry.clean) return { ok: false, reason: dry.conflicts ? "conflicts" : "unknown", conflicts: dry.conflicts ?? [], into: target, from: source };
  await switchBranch(git, cwd, target);
  return mergeBranch(git, cwd, source);
}

// ---- Commits ----

const fileCount = async (git, cwd, tree) => (await run(git, cwd, ["ls-tree", "-r", "-z", "--name-only", tree])).split("\0").filter(Boolean).length;
const deletedBetween = async (git, cwd, from, to) =>
  (await run(git, cwd, ["diff-tree", "-r", "-z", "--no-renames", "--diff-filter=D", "--name-only", from, to])).split("\0").filter(Boolean).length;

// Commits the ticked files with the message. Checked first on a scratch copy of the index, so the real one is only
// touched once the result is known to be safe: never empty while the last commit wasn't, and over a quarter of the
// files removed only with `allowMassDelete`. Returns { ok: true, sha } or { ok: false, reason, ... }.
export async function commit(git, cwd, { paths, message, allowMassDelete = false }) {
  const text = typeof message === "string" ? message.replace(/\r\n?/g, "\n").trim() : "";
  if (!text) throw new GitRefusal("Write a message for the commit.");
  if (!Array.isArray(paths) || paths.length === 0) throw new GitRefusal("Choose at least one file to commit.");
  paths.forEach(checkPath);
  const state = await repoState(git, cwd);
  if (!state.branch) throw new GitRefusal("This copy isn't on a branch (detached HEAD). Switch to a branch first.");
  if (state.operation) throw new GitRefusal(`A ${state.operation} is in progress; finish it in your git tools first.`);
  const changed = new Map((await status(git, cwd)).map((f) => [f.path, f]));
  const chosen = [];
  for (const p of paths) {
    const file = changed.get(p);
    if (!file) throw new GitRefusal(`${p} has no changes to commit.`);
    if (file.kind === "conflicted") throw new GitRefusal(`${p} has merge conflicts; resolve them first.`);
    chosen.push(file);
    if (file.origPath) chosen.push({ path: file.origPath, kind: "deleted" });
  }
  const chosenPaths = [...new Set(chosen.map((f) => f.path))];

  // The tree this commit would make, built on a scratch index.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mw-git-"));
  let tree;
  try {
    const extraEnv = { GIT_INDEX_FILE: path.join(dir, "index") };
    await run(git, cwd, state.head ? ["read-tree", state.head] : ["read-tree", "--empty"], { extraEnv });
    await run(git, cwd, ["add", "-A", "--", ...chosenPaths], { extraEnv });
    tree = (await run(git, cwd, ["write-tree"], { extraEnv })).trim();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  if (state.head) {
    const before = await fileCount(git, cwd, state.head);
    const after = await fileCount(git, cwd, tree);
    if (after === 0 && before > 0) return { ok: false, reason: "empty", total: before };
    const deleted = await deletedBetween(git, cwd, state.head, tree);
    if (!allowMassDelete && before >= 4 && deleted / before > massDeleteShare) return { ok: false, reason: "mass-delete", deleted, total: before };
  }

  // New files have to be known to git before `commit --only` can take them; nothing else in the index is included.
  const added = chosen.filter((f) => f.kind === "untracked").map((f) => f.path);
  if (added.length) await run(git, cwd, ["add", "--", ...added]);
  await run(git, cwd, ["commit", "--only", "-m", text, "--", ...chosenPaths], { timeoutMs: 120_000 });
  const sha = (await run(git, cwd, ["rev-parse", "HEAD"])).trim();
  return { ok: true, sha };
}

// "Revert the branch to this commit", without rewriting anything: one new commit on top whose files are exactly as
// they were at `sha` (an earlier commit of the current branch). The commits after it stay in the history, and the
// branch pushes as a plain fast-forward. Checked first, with nothing touched: a clean tree, no untracked or ignored
// file in the way, never an empty tree, a big deletion only with `allowMassDelete`. Returns { ok: true, sha, restored,
// changed } or { ok: false, reason, ... }.
export async function restoreCommit(git, cwd, sha, { allowMassDelete = false } = {}) {
  checkSha(sha);
  const state = await repoState(git, cwd);
  if (!state.branch) throw new GitRefusal("This copy isn't on a branch (detached HEAD). Switch to a branch first.");
  if (state.operation) throw new GitRefusal(`A ${state.operation} is in progress; finish it in your git tools first.`);
  const target = (await git(cwd, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], { allowCodes: [0, 1] })).out.trim();
  if (!target) throw new GitRefusal("That commit isn't in this repository.");
  const inHistory = (await git(cwd, ["merge-base", "--is-ancestor", target, "HEAD"], { allowCodes: [0, 1] })).code === 0;
  if (!inHistory) throw new GitRefusal(`That commit isn't in ${state.branch}'s history; check out the branch it's on to revert that one.`);
  const base = { branch: state.branch, restored: target };

  const uncommitted = await trackedChanges(git, cwd);
  if (uncommitted.length) return { ok: false, reason: "uncommitted", files: uncommitted, ...base };
  const [headTree, targetTree] = (await run(git, cwd, ["rev-parse", "HEAD^{tree}", `${target}^{tree}`])).trim().split("\n");
  if (headTree === targetTree) return { ok: false, reason: "nothing", ...base };

  // Files the restore would write over that git doesn't track here (they'd be lost): untracked or ignored ones.
  const wanted = await listFiles(git, cwd, target);
  const untracked = (await status(git, cwd)).filter((f) => f.kind === "untracked").map((f) => f.path);
  const ignored = (await run(git, cwd, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"])).split("\0").filter(Boolean);
  const loose = [...untracked, ...ignored];
  const inTheWay = wanted.filter((file) => loose.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p)));
  if (inTheWay.length) return { ok: false, reason: "untracked", files: inTheWay, ...base };

  const before = await fileCount(git, cwd, "HEAD");
  if (wanted.length === 0 && before > 0) return { ok: false, reason: "empty", ...base };
  const deleted = await deletedBetween(git, cwd, "HEAD", target);
  if (!allowMassDelete && before >= 4 && deleted / before > massDeleteShare) return { ok: false, reason: "mass-delete", deleted, total: before, ...base };
  const changed = (await run(git, cwd, ["diff-tree", "-r", "-z", "--no-renames", "--name-only", "HEAD", target])).split("\0").filter(Boolean).length;

  const short = target.slice(0, 7);
  const subject = (await run(git, cwd, ["log", "-1", "--format=%s", target])).trim();
  // The tree was clean, so the restore is all that gets staged; a failed commit puts everything back the same way.
  await run(git, cwd, ["restore", `--source=${target}`, "--staged", "--worktree", "--", ":/"], { timeoutMs: 120_000 });
  try {
    await run(git, cwd, ["commit", "-m", `Revert to ${short} "${subject}"`,
      "-m", `Restores every file as it was at ${target}. The commits after it stay in the history.`], { timeoutMs: 120_000 });
  } catch (e) {
    await git(cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ":/"], { allowCodes: [0, 1, 128], timeoutMs: 120_000 });
    return { ok: false, reason: "failed", message: e.message, ...base };
  }
  const head = (await run(git, cwd, ["rev-parse", "HEAD"])).trim();
  return { ok: true, sha: head, changed, ...base };
}

// ---- Stashes ----
// Changes put aside and brought back later. Only push, list, show, apply and drop are used (never pop or clear), and a
// stash is always picked by its commit id, whose current stash@{n} is checked before anything removes it.

const stashFiles = async (git, cwd, sha) =>
  (await run(git, cwd, ["stash", "show", "--name-only", "--include-untracked", sha])).split("\n").filter(Boolean);
// The files a stash brings back that git didn't track (its third parent), if it has any.
const stashUntracked = async (git, cwd, sha) => {
  const third = (await git(cwd, ["rev-parse", "--verify", "--quiet", `${sha}^3`], { allowCodes: [0, 1, 128] })).out.trim();
  return third ? (await run(git, cwd, ["ls-tree", "-r", "-z", "--name-only", third])).split("\0").filter(Boolean) : [];
};

// The stashes, newest first: [{ sha, ref, message, branch, time, files }].
export async function stashList(git, cwd) {
  const { out } = await git(cwd, ["stash", "list", "--max-count=50", "--format=%H%x1f%gd%x1f%gs%x1f%cI"], { allowCodes: [0, 128] });
  const stashes = [];
  for (const line of out.split("\n").filter(Boolean)) {
    const [sha, ref, subject, time] = line.split("\x1f");
    const match = /^(?:WIP )?[Oo]n ([^:]+): (.*)$/.exec(subject);
    stashes.push({ sha, ref, message: match ? match[2] : subject, branch: match ? match[1] : null, time, files: await stashFiles(git, cwd, sha) });
  }
  return stashes;
}

// Its current stash@{n}, checked to still be that commit (refs shift as stashes come and go); null when it's gone.
async function stashRef(git, cwd, sha) {
  checkSha(sha);
  const entry = (await stashList(git, cwd)).find((s) => s.sha === sha);
  if (!entry) return null;
  const now = (await git(cwd, ["rev-parse", "--verify", "--quiet", entry.ref], { allowCodes: [0, 1, 128] })).out.trim();
  return now === sha ? entry : null;
}

// Puts the changed files (all, or `paths`) aside in a new stash and leaves them as in the last commit. New files go
// with them (`includeUntracked`, always when one is chosen). Returns { ok: true, sha, files } or { ok: false, reason }.
export async function stashPush(git, cwd, { paths = [], message = "", includeUntracked = true } = {}) {
  if (!Array.isArray(paths)) throw new GitRefusal("Choose files to stash.");
  paths.forEach(checkPath);
  const state = await repoState(git, cwd);
  if (state.operation) throw new GitRefusal(`A ${state.operation} is in progress; finish it in your git tools first.`);
  if (!state.head) throw new GitRefusal("This branch has no commits yet, so there is nothing to put changes aside from.");
  const changed = await status(git, cwd);
  if (changed.some((f) => f.kind === "conflicted")) throw new GitRefusal("Some files have merge conflicts; resolve them first.");
  const byPath = new Map(changed.map((f) => [f.path, f]));
  for (const p of paths) if (!byPath.has(p)) throw new GitRefusal(`${p} has no changes to stash.`);
  const chosen = paths.length ? paths.map((p) => byPath.get(p)) : changed.filter((f) => includeUntracked || f.kind !== "untracked");
  if (!chosen.length) return { ok: false, reason: "nothing" };
  const untracked = includeUntracked || chosen.some((f) => f.kind === "untracked");
  const text = (typeof message === "string" ? message.replace(/\s+/g, " ").trim() : "") || `Changes on ${state.branch ?? "a detached HEAD"}`;
  const before = (await git(cwd, ["rev-parse", "--verify", "--quiet", "refs/stash"], { allowCodes: [0, 1, 128] })).out.trim();
  await run(git, cwd, ["stash", "push", ...(untracked ? ["--include-untracked"] : []), "-m", text, ...(paths.length ? ["--", ...paths] : [])],
    { timeoutMs: 120_000 });
  const sha = (await git(cwd, ["rev-parse", "--verify", "--quiet", "refs/stash"], { allowCodes: [0, 1, 128] })).out.trim();
  if (!sha || sha === before) return { ok: false, reason: "nothing" };
  return { ok: true, sha, files: chosen.map((f) => f.path) };
}

// Brings a stash's changes back, then removes it from the list. Refused with nothing touched when a changed or
// untracked file is in the way; a restore that conflicts is undone (the stash's files go back to the last commit, the
// untracked ones it had just added are removed) and the stash is kept. Returns { ok, reason?, files }.
export async function stashRestore(git, cwd, sha) {
  const entry = await stashRef(git, cwd, sha);
  if (!entry) throw new GitRefusal("That stash isn't here any more.");
  const state = await repoState(git, cwd);
  if (state.operation) throw new GitRefusal(`A ${state.operation} is in progress; finish it in your git tools first.`);
  const untracked = await stashUntracked(git, cwd, sha);
  const tracked = entry.files.filter((f) => !untracked.includes(f));
  const dirty = new Set(await trackedChanges(git, cwd));
  const busy = tracked.filter((f) => dirty.has(f));
  if (busy.length) return { ok: false, reason: "uncommitted", files: busy };
  // Files the stash adds that the last commit doesn't have: like its untracked ones, nothing may be there yet.
  const inHead = new Set(tracked.length
    ? (await run(git, cwd, ["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ...tracked])).split("\0").filter(Boolean) : []);
  const added = [...untracked, ...tracked.filter((f) => !inHead.has(f))];
  const present = [];
  for (const file of added) if (await fs.access(path.join(cwd, file)).then(() => true, () => false)) present.push(file);
  if (present.length) return { ok: false, reason: "untracked", files: present };

  const { code, out } = await git(cwd, ["stash", "apply", sha], { allowCodes: [0, 1, 128], timeoutMs: 120_000 });
  const conflicted = (await status(git, cwd)).filter((f) => f.kind === "conflicted").map((f) => f.path);
  if (code !== 0 || conflicted.length) {
    // Nothing of these files was changed before (checked above), so the last commit is what they were, and the ones
    // it doesn't have weren't there at all.
    const indexed = new Set(added.length ? (await run(git, cwd, ["ls-files", "-z", "--cached", "--", ...added])).split("\0").filter(Boolean) : []);
    const back = [...inHead, ...added.filter((f) => indexed.has(f))];
    if (back.length) await run(git, cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...back], { timeoutMs: 120_000 });
    for (const file of added) await fs.rm(path.join(cwd, file), { force: true });
    return { ok: false, reason: "conflicts", files: conflicted.length ? conflicted : tracked, message: out.trim() };
  }
  // Removed from the list only now that its changes are back in the files.
  const again = await stashRef(git, cwd, sha);
  if (again) await run(git, cwd, ["stash", "drop", again.ref]);
  return { ok: true, files: entry.files };
}

// Deletes a stash for good (the user confirmed it): picked by commit id, its stash@{n} checked first.
export async function stashDelete(git, cwd, sha) {
  const entry = await stashRef(git, cwd, sha);
  if (!entry) throw new GitRefusal("That stash isn't here any more.");
  await run(git, cwd, ["stash", "drop", entry.ref]);
}

// ---- The remote ----

// Hosts where MakeWork's own sign-in is the only credential git gets (the user name each expects with a token).
// Other apps' connections (VS Code's askpass, credential managers, `gh`, ssh keys) are never used for them.
export const ownHosts = { "github.com": "x-access-token", "gitlab.com": "oauth2" };
const hostNames = { "github.com": "GitHub", "gitlab.com": "GitLab" };

// The host of a remote URL: https://host/..., ssh://[user@]host[:port]/... or user@host:path; null for local paths.
export function remoteHost(url) {
  const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)/i.exec(url) ?? /^(?:[^@/\\]+@)?([^/\\:]{2,}):(?!\/\/)/.exec(url);
  return match ? match[1].toLowerCase() : null;
}

// A runner whose network commands sign in with MakeWork's credential: `tokenFor(host)` gives the token kept for that
// host (or null). It never goes into arguments or the repository's config, only into the git process's environment.
export function withCredentials(git, tokenFor) {
  const authed = (cwd, args, options) => git(cwd, args, options);
  authed.tokenFor = tokenFor;
  return authed;
}

// The secret a folder's network command signs in to `host` with (app/src/plugins/builtin/git/connections.ts):
// `chosen` is the key of its channel's host connection ("<host>" or "<host>#<id>"), "" for no connection, undefined
// when its channel has none picked on this computer (then the host's own slot, as before connections had names).
// A connection for another host is never offered: that host's own slot is.
export function credentialName(host, chosen) {
  if (chosen === "") return null;
  if (typeof chosen === "string" && (chosen === host || chosen.startsWith(`${host}#`))) return chosen;
  return host;
}

// Other apps' prompts, which git would otherwise ask for a password (VS Code sets these in its terminals).
const promptVariables = ["GIT_ASKPASS", "SSH_ASKPASS", "SSH_ASKPASS_REQUIRE", "VSCODE_GIT_ASKPASS_MAIN", "VSCODE_GIT_ASKPASS_NODE",
  "VSCODE_GIT_ASKPASS_EXTRA_ARGS", "VSCODE_GIT_IPC_HANDLE"];

// The environment of a command that talks to origin (`url`). Never waits on a hidden prompt, never uses another
// app's askpass. For GitHub and GitLab: every inherited credential helper is cleared and only MakeWork's token is
// offered (through a helper that answers just that host, reading MW_GIT_TOKEN), and ssh addresses go over HTTPS for
// this command only, so the user's own setup doesn't decide who pushes.
export async function remoteEnv(git, cwd, url) {
  const env = Object.fromEntries(promptVariables.map((name) => [name, undefined]));
  const host = remoteHost(url ?? "");
  if (host && Object.hasOwn(ownHosts, host)) {
    const token = (await git.tokenFor?.(host)) ?? null;
    const config = [
      ["credential.helper", ""],
      ["core.askPass", ""],
      [`url.https://${host}/.insteadOf`, `git@${host}:`],
      [`url.https://${host}/.insteadOf`, `ssh://git@${host}/`],
    ];
    if (token) {
      config.push([`credential.https://${host}.helper`,
        String.raw`!f() { test "$1" = get && printf 'username=%s\npassword=%s\n' '${ownHosts[host]}' "$MW_GIT_TOKEN"; }; f`]);
      env.MW_GIT_TOKEN = token;
    }
    env.GIT_CONFIG_COUNT = String(config.length);
    config.forEach(([key, value], i) => Object.assign(env, { [`GIT_CONFIG_KEY_${i}`]: key, [`GIT_CONFIG_VALUE_${i}`]: value }));
    return env;
  }
  if (!process.env.GIT_SSH_COMMAND) {
    const own = (await git(cwd, ["config", "--get", "core.sshCommand"], { allowCodes: [0, 1] })).out.trim();
    // Never wait on a hidden ssh passphrase prompt; the user's own ssh command (core.sshCommand) is kept.
    if (!own) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  }
  return env;
}

// What git says when it couldn't sign in (or a private repository looks missing without one).
const authFailure = /could not read (Username|Password)|Authentication failed|terminal prompts disabled|Invalid username or (password|token)|HTTP Basic: Access denied|returned error: 40[13]|Permission to \S+ denied|Repository not found|Permission denied \(publickey/i;

// The page recognises "[auth host]" and offers that host's sign-in (plugins/builtin/git/local.ts). `hadToken`: MakeWork's
// token for the host was sent and refused (expired, or no access to this repository), which isn't "never signed in".
export function authRefusal(host, hadToken = false) {
  const name = hostNames[host] ?? host ?? "The remote";
  const own = Object.hasOwn(ownHosts, host ?? "");
  return new GitRefusal(`[auth ${host ?? "remote"}] ${own && hadToken
    ? `${name} refused MakeWork's sign-in for this repository (the token may have expired, or can't reach it).`
    : own ? `${name} needs you to sign in to MakeWork's ${name} connection to reach this repository.`
      : `${name} refused the sign-in; check your git credentials for it.`}`, { auth: host });
}

// A command that talks to `url`, with the environment above; sign-in failures become an auth refusal.
async function remoteRun(git, cwd, url, args, timeoutMs = remoteTimeoutMs) {
  const extraEnv = await remoteEnv(git, cwd, url);
  try {
    return await run(git, cwd, args, { timeoutMs, extraEnv });
  } catch (e) {
    if (authFailure.test(e.message)) throw authRefusal(remoteHost(url), !!extraEnv.MW_GIT_TOKEN);
    throw e;
  }
}

async function requireOrigin(git, cwd) {
  const { code, out } = await git(cwd, ["remote", "get-url", "origin"], { allowCodes: [0, 2, 128] });
  if (code !== 0) throw new GitRefusal("This repository has no remote named origin.");
  return out.trim();
}

// The remote's branch heads as this copy last fetched them: { name: sha }.
export async function remoteHeads(git, cwd) {
  const out = await run(git, cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/remotes/origin"]);
  const heads = {};
  for (const line of out.split("\n").filter(Boolean)) {
    const [ref, sha] = line.split("\0");
    const name = ref.slice("refs/remotes/origin/".length);
    if (name !== "HEAD") heads[name] = sha;
  }
  return heads;
}

// Fetches from origin. Never touches local branches or files. Returns the branches that moved:
// [{ branch, from (null for new ones), to, count (new commits) }].
export async function fetchRemote(git, cwd) {
  const url = await requireOrigin(git, cwd);
  const before = await remoteHeads(git, cwd);
  await remoteRun(git, cwd, url, ["fetch", "--no-write-fetch-head", "origin"]);
  const after = await remoteHeads(git, cwd);
  const changes = [];
  for (const [branch, to] of Object.entries(after)) {
    const from = before[branch] ?? null;
    if (from === to) continue;
    const range = from ? [to, "--not", from] : [to, "--not", ...Object.values(before)];
    const count = Number((await run(git, cwd, ["rev-list", "--count", ...range])).trim()) || 0;
    changes.push({ branch, from, to, count });
  }
  return changes;
}

const subjects = async (git, cwd, range, max = 20) =>
  (await run(git, cwd, ["log", `--max-count=${max}`, "--format=%H%x1f%an%x1f%s", ...range, "--"])).split("\n").filter(Boolean).map((l) => {
    const [sha, author, subject] = l.split("\x1f");
    return { sha, author, subject };
  });

// Dry run of merging the remote's branch into the local one: { clean, conflicts } (conflicts null if this git can't
// tell; nothing in the repository changes either way).
export async function mergeDryRun(git, cwd, local, remote) {
  const { code, out } = await git(cwd, ["merge-tree", "--write-tree", "--name-only", "--no-messages", local, remote], { allowCodes: [0, 1, 128, 129] });
  if (code === 0) return { clean: true, conflicts: [] };
  if (code === 1) return { clean: false, conflicts: [...new Set(out.split("\n").slice(1).filter(Boolean))] };
  return { clean: false, conflicts: null };
}

// What a push of the current branch would do, after fetching:
// { branch, state: "up-to-date"|"ahead"|"behind"|"diverged"|"new-branch", ahead, behind, outgoing, incoming,
//   merge: { clean, conflicts } when the remote has new commits, uncommitted (files), blocked/massDelete safety }.
export async function pushCheck(git, cwd, branchName = null) {
  const state = await repoState(git, cwd);
  if (state.operation) throw new GitRefusal(`A ${state.operation} is in progress; finish it in your git tools first.`);
  if (!branchName && !state.branch) throw new GitRefusal("This copy isn't on a branch (detached HEAD). Switch to a branch first.");
  if (!state.head) throw new GitRefusal("This branch has no commits yet.");
  const branch = branchName ?? state.branch;
  if (branch.startsWith("origin/")) throw new GitRefusal("Push a local branch.");
  const local = await branchRef(git, cwd, branch);
  await fetchRemote(git, cwd);
  const current = branch === state.branch;
  const remoteRef = `refs/remotes/origin/${branch}`;
  // Uncommitted changes only matter for the branch that is checked out.
  const uncommitted = current ? await trackedChanges(git, cwd) : [];
  const remoteHead = (await git(cwd, ["rev-parse", "--verify", "--quiet", remoteRef], { allowCodes: [0, 1] })).out.trim();
  const result = { branch, current, ahead: 0, behind: 0, outgoing: [], incoming: [], merge: null, uncommitted, blocked: null, massDelete: null };
  if (!remoteHead) {
    const ahead = Number((await run(git, cwd, ["rev-list", "--count", local, "--not", "--remotes=origin"])).trim()) || 0;
    Object.assign(result, { state: "new-branch", ahead, outgoing: await subjects(git, cwd, [local, "--not", "--remotes=origin"]) });
  } else {
    const [behind, ahead] = (await run(git, cwd, ["rev-list", "--left-right", "--count", `${remoteRef}...${local}`])).trim().split(/\s+/).map(Number);
    Object.assign(result, {
      ahead, behind,
      state: behind && ahead ? "diverged" : behind ? "behind" : ahead ? "ahead" : "up-to-date",
      outgoing: ahead ? await subjects(git, cwd, [`${remoteRef}..${local}`]) : [],
      incoming: behind ? await subjects(git, cwd, [`${local}..${remoteRef}`]) : [],
    });
    if (behind) result.merge = await mergeDryRun(git, cwd, local, remoteRef);
  }
  // What the push would leave on the remote: never an empty tree, and a big deletion only once confirmed.
  if (result.ahead > 0 || result.state === "new-branch") {
    const base = remoteHead || null;
    const after = await fileCount(git, cwd, local);
    if (base) {
      const before = await fileCount(git, cwd, base);
      if (after === 0 && before > 0) result.blocked = "empty";
      const deleted = await deletedBetween(git, cwd, base, local);
      if (before >= 4 && deleted / before > massDeleteShare) result.massDelete = { deleted, total: before };
    } else if (after === 0) result.blocked = "empty";
  }
  return result;
}

// Pushes a branch (the current one by default) as a plain fast-forward, after checking again; one that isn't on the
// remote yet is published. Refused while the remote has commits this copy lacks; git itself also refuses anything
// that isn't a fast-forward, and nothing here retries with force.
export async function push(git, cwd, { allowMassDelete = false, branch = null } = {}) {
  const check = await pushCheck(git, cwd, branch);
  if (check.state === "up-to-date") return { ok: false, reason: "up-to-date", check };
  if (check.state === "behind" || check.state === "diverged") return { ok: false, reason: "behind", check };
  // A branch that isn't on the remote yet is published even without commits of its own.
  if (check.ahead === 0 && check.state !== "new-branch") return { ok: false, reason: "up-to-date", check };
  if (check.blocked) return { ok: false, reason: check.blocked, check };
  if (check.massDelete && !allowMassDelete) return { ok: false, reason: "mass-delete", check };
  const refspec = `refs/heads/${check.branch}:refs/heads/${check.branch}`;
  const upstream = (await git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${check.branch}@{upstream}`], { allowCodes: [0, 128] })).out.trim();
  const args = ["push", "--porcelain", ...(upstream ? [] : ["--set-upstream"]), "origin", refspec];
  const url = await requireOrigin(git, cwd);
  try {
    const out = await remoteRun(git, cwd, url, args);
    if (/^!/m.test(out)) return { ok: false, reason: "rejected", message: out.trim(), check };
    return { ok: true, pushed: check.ahead, branch: check.branch };
  } catch (e) {
    if (e.details?.auth !== undefined) throw e;
    return { ok: false, reason: "rejected", message: e.message, check };
  }
}

// Brings the remote's new commits into the current branch, only when that can't conflict: a dry run first, nothing
// uncommitted, then a fast-forward when possible, else a merge commit (never a rebase). Returns { ok, ... }.
export async function mergeRemote(git, cwd) {
  const check = await pushCheck(git, cwd);
  if (check.behind === 0) return { ok: false, reason: "nothing", check };
  if (check.uncommitted.length) return { ok: false, reason: "uncommitted", check };
  if (!check.merge?.clean) return { ok: false, reason: check.merge?.conflicts ? "conflicts" : "unknown", check };
  const remoteRef = `refs/remotes/origin/${check.branch}`;
  try {
    if (check.ahead === 0) await run(git, cwd, ["merge", "--ff-only", remoteRef], { timeoutMs: 120_000 });
    else await run(git, cwd, ["merge", "--no-edit", "--no-ff", remoteRef], { timeoutMs: 120_000 });
  } catch (e) {
    // The working tree was clean before, so stopping the merge puts everything back as it was.
    if ((await repoState(git, cwd)).operation === "merge") await git(cwd, ["merge", "--abort"], { allowCodes: [0, 1, 128] });
    return { ok: false, reason: "failed", message: e.message, check };
  }
  return { ok: true, merged: check.behind, fastForward: check.ahead === 0 };
}

// ---- Resolving conflicts ----
// A merge the app starts that would conflict is resolved before anything is touched: the user sees each conflicted
// file's versions and chooses what it becomes, then `mergeResolved` builds the merge commit on a scratch index and the
// branch fast-forwards to it. The working copy never holds a half-done merge with conflict markers in its files.

// Versions bigger than this aren't read for resolving line by line (one side is chosen as a whole instead).
const resolveLimit = 2 * 1024 * 1024;

// The branch a merge lands on and the one coming in (names and refs), for a merge the app starts: the remote's
// commits into the current branch ("pull"), another branch into it ("branch"), or it into another one ("into",
// switching to that branch). Refused like the merges themselves when it can't happen here.
async function mergeSides(git, cwd, target) {
  const kind = target?.kind;
  const state = await mergeable(git, cwd, kind === "branch" ? { source: target.source } : kind === "into" ? { into: target.target } : {});
  const current = { into: state.branch, receivingRef: `refs/heads/${state.branch}`, switchTo: null };
  switch (kind) {
    case "pull": {
      const ref = `refs/remotes/origin/${state.branch}`;
      if (!(await branchExists(git, cwd, ref))) throw new GitRefusal(`${state.branch} isn't on the remote yet.`);
      return { ...current, from: `origin/${state.branch}`, incomingRef: ref };
    }
    case "branch":
      return { ...current, from: target.source, incomingRef: await branchRef(git, cwd, target.source) };
    case "into":
      return { into: target.target, receivingRef: await branchRef(git, cwd, target.target), switchTo: target.target, from: state.branch,
        incomingRef: `refs/heads/${state.branch}` };
  }
  throw new GitRefusal("Not a merge this app makes.");
}

const commitOf = async (git, cwd, ref) => (await run(git, cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();

// Conflicts resolved here: a file's text (also when both added it), a binary file, a file deleted on one side and
// changed on the other. Others (renames, a file where the other side has a folder, ...) are left to the user's tools.
const resolvable = new Set(["CONFLICT (contents)", "CONFLICT (binary)", "CONFLICT (modify/delete)"]);

// What git makes of the merge, with nothing touched (merge-tree only writes objects): the merged tree, conflicted
// files with markers in it; each conflicted file's versions ({ oid, mode }, null where that side has no file) and,
// for a kind of conflict not resolved here, git's message (`unsupported`, also listed on its own).
async function mergeTree(git, cwd, receiving, incoming) {
  const { code, out } = await git(cwd, ["merge-tree", "--write-tree", "-z", receiving, incoming], { allowCodes: [0, 1, 128, 129] });
  if (code > 1) throw new GitRefusal("This version of git can't merge without touching the files; resolve the conflicts with your git tools.");
  const [tree, ...rest] = out.split("\0");
  // The versions end with an empty record; git's messages follow: <count>, that many paths, <type>, <message>.
  const end = rest.indexOf("");
  const stages = { 1: "base", 2: "receiving", 3: "incoming" };
  const files = new Map();
  for (const record of end < 0 ? rest : rest.slice(0, end)) {
    const match = /^(\d{6}) ([0-9a-f]{40,64}) ([123])\t(.+)$/s.exec(record);
    if (!match) continue;
    const [, mode, oid, stage, file] = match;
    if (!files.has(file)) files.set(file, { path: file, base: null, receiving: null, incoming: null, unsupported: null });
    files.get(file)[stages[stage]] = { oid, mode };
  }
  const unsupported = [];
  const messages = end < 0 ? [] : rest.slice(end + 1);
  for (let i = 0; i < messages.length;) {
    const count = Number(messages[i]);
    if (!Number.isInteger(count) || count < 1) break;
    const paths = messages.slice(i + 1, i + 1 + count);
    const [type = "", text = ""] = messages.slice(i + 1 + count, i + 3 + count);
    i += count + 3;
    if (!type.startsWith("CONFLICT") || resolvable.has(type)) continue;
    unsupported.push(text.trim());
    for (const p of paths) if (files.has(p)) files.get(p).unsupported = text.trim();
  }
  return { tree: tree.trim(), files: [...files.values()], unsupported };
}

// The message git's own merge writes: " into <branch>" unless that is an integration branch (merge.suppressDest, by
// default main and master).
async function defaultMergeMessage(git, cwd, sides, kind) {
  const { code, out } = await git(cwd, ["config", "--get-all", "merge.suppressDest"], { allowCodes: [0, 1] });
  const values = code === 0 ? out.replace(/\n$/, "").split("\n") : null;
  // An empty value clears the ones before it.
  const globs = values ? values.slice(values.lastIndexOf("") + 1) : ["main", "master"];
  const matches = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, String.raw`\$&`).replaceAll("*", ".*").replaceAll("?", ".")}$`).test(sides.into);
  const into = globs.some(matches) ? "" : ` into ${sides.into}`;
  return kind === "pull" ? `Merge remote-tracking branch '${sides.from}'${into}` : `Merge branch '${sides.from}'${into}`;
}

// The conflicts of a merge the app would make (see mergeSides), changing nothing: { into, from, receiving, incoming
// (the two commits), tree (git's merged tree), files: [{ path, base, receiving, incoming, unsupported }], unsupported
// (git's messages for conflicts not resolved here), clean (the other files the merge changes, which merge by
// themselves), message (the merge commit's message unless the user writes one) }.
export async function mergeConflicts(git, cwd, target) {
  const sides = await mergeSides(git, cwd, target);
  const receiving = await commitOf(git, cwd, sides.receivingRef);
  const incoming = await commitOf(git, cwd, sides.incomingRef);
  if ((await countRange(git, cwd, `${receiving}..${incoming}`)) === 0) throw new GitRefusal(`${sides.into} already has everything from ${sides.from}.`);
  const { tree, files, unsupported } = await mergeTree(git, cwd, receiving, incoming);
  const conflicted = new Set(files.map((f) => f.path));
  const changed = (await run(git, cwd, ["diff-tree", "-r", "-z", "--no-renames", "--name-only", receiving, tree])).split("\0").filter(Boolean);
  return {
    into: sides.into, from: sides.from, receiving, incoming, tree, files, unsupported, clean: changed.filter((f) => !conflicted.has(f)),
    message: await defaultMergeMessage(git, cwd, sides, target.kind),
  };
}

const checkVersion = (version) => {
  if (version === null || version === undefined) return null;
  if (typeof version !== "object" || !/^\d{6}$/.test(String(version.mode))) throw new GitRefusal("Not a version of a file.");
  checkSha(version.oid);
  return version;
};

// A conflicted file's versions to resolve line by line: { text }, { binary } (also when it isn't UTF-8, which
// couldn't be written back byte for byte) or { tooLarge }; null where that side has no file.
export async function mergeFile(git, cwd, { base = null, receiving = null, incoming = null } = {}) {
  const read = async (version) => {
    if (!checkVersion(version)) return null;
    // A submodule's commit, not a file.
    if (version.mode === "160000") return { binary: true };
    const [, type, size] = (await run(git, cwd, ["cat-file", "--batch-check"], { input: `${version.oid}\n` })).trim().split(" ");
    if (type !== "blob") throw new GitRefusal("That version of the file isn't in this repository.");
    if (Number(size) > resolveLimit) return { tooLarge: true };
    const text = await run(git, cwd, ["cat-file", "blob", version.oid]);
    // Bytes that aren't UTF-8 come out as U+FFFD (sometimes as many bytes long); a file that really holds that
    // character is taken as a whole too, which never rewrites it.
    if (text.slice(0, 8000).includes("\0") || text.includes("\uFFFD") || Buffer.byteLength(text, "utf8") !== Number(size)) return { binary: true };
    return { text };
  };
  const [b, r, i] = await Promise.all([read(base), read(receiving), read(incoming)]);
  return { base: b, receiving: r, incoming: i };
}

// A file that merges by itself: the receiving branch's version against the merged one.
export async function mergeDiff(git, cwd, receiving, tree, file) {
  checkSha(receiving);
  checkSha(tree);
  checkPath(file);
  const { out, truncated } = await git(cwd, ["diff", "--no-color", "--no-ext-diff", receiving, tree, "--", file],
    { allowCodes: [0, 1], maxBytes: 8 * 1024 * 1024, truncate: true });
  return { patch: out, truncated };
}

// Makes the merge with the user's choice for every conflicted file (`files`: { path, content }, { path, side:
// "receiving" | "incoming" } or { path, delete: true }), for exactly the two commits the choices were made for. Checked
// first, with nothing touched: no uncommitted changes, the receiving branch still where it was (`moved`), the incoming
// commit still in its branch's history (newer commits there wait for the next merge), a choice for every conflicted
// file and no other (`changed`), never an empty tree. The tree is merge-tree's with the chosen files written in, on a
// scratch index; the branch then fast-forwards to the new merge commit, which goes through or changes nothing.
export async function mergeResolved(git, cwd, { target, receiving, incoming, message, files } = {}) {
  const sides = await mergeSides(git, cwd, target);
  const names = { into: sides.into, from: sides.from };
  checkSha(receiving);
  checkSha(incoming);
  // The incoming commit gone from its branch (a force push) means the conflicts have to be read again.
  const incomingCommit = (await git(cwd, ["rev-parse", "--verify", "--quiet", `${incoming}^{commit}`], { allowCodes: [0, 1] })).out.trim();
  const inHistory = !!incomingCommit
    && (await git(cwd, ["merge-base", "--is-ancestor", incomingCommit, sides.incomingRef], { allowCodes: [0, 1] })).code === 0;
  if (!inHistory) return { ok: false, reason: "changed", ...names };
  if ((await commitOf(git, cwd, sides.receivingRef)) !== receiving) return { ok: false, reason: "moved", ...names };
  if (!Array.isArray(files)) throw new GitRefusal("Choose what every conflicted file becomes.");
  const uncommitted = await trackedChanges(git, cwd);
  if (uncommitted.length) return { ok: false, reason: "uncommitted", files: uncommitted, ...names };

  const merged = await mergeTree(git, cwd, receiving, incomingCommit);
  if (merged.unsupported.length) throw new GitRefusal(`Some of these conflicts can't be resolved here; merge with your git tools: ${merged.unsupported.join(" ")}`);
  const conflicted = new Map(merged.files.map((f) => [f.path, f]));
  const chosen = new Map(files.map((f) => [checkPath(f?.path), f]));
  if (chosen.size !== files.length || chosen.size !== conflicted.size || [...chosen.keys()].some((p) => !conflicted.has(p)))
    return { ok: false, reason: "changed", ...names };

  // A file written from its text keeps the mode git's merge gave it (an executable bit set on either side stays).
  const written = [...chosen].filter(([, choice]) => typeof choice.content === "string").map(([file]) => file);
  const mergedModes = new Map(written.length ? (await run(git, cwd, ["ls-tree", "-r", "-z", merged.tree, "--", ...written]))
    .split("\0").filter(Boolean).map((line) => [line.slice(line.indexOf("\t") + 1), line.split(" ")[0]]) : []);
  // The chosen files as index entries; mode 0 takes a path out.
  const none = `0 ${"0".repeat(receiving.length)}`;
  const entries = [];
  for (const [file, choice] of chosen) {
    const versions = conflicted.get(file);
    if (choice.delete === true) entries.push(`${none}\t${file}`);
    else if (choice.side === "receiving" || choice.side === "incoming") {
      const version = versions[choice.side];
      entries.push(version ? `${version.mode} ${version.oid}\t${file}` : `${none}\t${file}`);
    } else if (typeof choice.content === "string") {
      const mode = mergedModes.get(file) ?? (versions.receiving ?? versions.incoming ?? versions.base).mode;
      if (mode === "160000") throw new GitRefusal(`${file} is a submodule; choose one side's commit for it.`);
      const oid = (await run(git, cwd, ["hash-object", "-w", "--no-filters", "--stdin"], { input: choice.content })).trim();
      entries.push(`${mode} ${oid}\t${file}`);
    } else throw new GitRefusal(`Choose what ${file} becomes.`);
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mw-git-"));
  let tree;
  try {
    const extraEnv = { GIT_INDEX_FILE: path.join(dir, "index") };
    await run(git, cwd, ["read-tree", merged.tree], { extraEnv });
    await run(git, cwd, ["update-index", "-z", "--index-info"], { extraEnv, input: entries.map((e) => `${e}\0`).join("") });
    tree = (await run(git, cwd, ["write-tree"], { extraEnv })).trim();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  if ((await fileCount(git, cwd, tree)) === 0 && (await fileCount(git, cwd, receiving)) > 0) return { ok: false, reason: "empty", ...names };

  // The message git's own merge would write, unless the user wrote one.
  const text = (typeof message === "string" ? message.replace(/\r\n?/g, "\n").trim() : "")
    || await defaultMergeMessage(git, cwd, sides, target.kind);
  const sha = (await run(git, cwd, ["commit-tree", tree, "-p", receiving, "-p", incomingCommit, "-m", text])).trim();
  const count = await countRange(git, cwd, `${receiving}..${incomingCommit}`);
  const before = (await repoState(git, cwd)).branch;
  if (sides.switchTo) await switchBranch(git, cwd, sides.switchTo);
  try {
    await run(git, cwd, ["merge", "--ff-only", sha], { timeoutMs: 120_000 });
  } catch (e) {
    // Nothing moved; a switch for it is undone.
    if (sides.switchTo && before) await switchBranch(git, cwd, before).catch(() => {});
    return { ok: false, reason: "failed", message: e.message, ...names };
  }
  return { ok: true, sha, merged: count, resolved: chosen.size, ...names };
}
