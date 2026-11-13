// Reading a repository's branches and commits: from GitHub or GitLab through their web APIs (with the member's own
// token for private projects), or from a local folder through the desktop app. All give the same shape.
import { ShownError } from "../../../api/client";
import { desktop, desktopError } from "../../../core/desktop";
import type { ImportedCommit } from "../../../system/git";
import { hostFile, parseUnifiedDiff, type CommitDiff, type DiffFile } from "./diff";
import { trimChars } from "../../../core/text";

export type Provider = "github" | "gitlab" | "local";

export interface RepoRef {
  provider: Provider;
  host: string;
  // owner/repo, the GitLab project path, or for a local folder its path on this device.
  path: string;
}

export interface Branch {
  name: string;
  head: string;
}

export interface RepoReader {
  defaultBranch(): Promise<string>;
  branches(): Promise<Branch[]>;
  // Commits reachable from `from` (a branch or a sha), newest first, up to `max` that `known` doesn't have yet.
  history(from: string, max: number, known: (sha: string) => boolean): Promise<ImportedCommit[]>;
  // A commit's changes, file by file.
  diff(sha: string): Promise<CommitDiff>;
  // For watching the remote: the branches, or null when they haven't changed since `etag` (GitHub answers that with
  // 304 Not Modified, which doesn't count against the rate limit; hosts without ETags always send the list).
  watchBranches?(etag: string | null): Promise<{ etag: string | null; branches: Branch[] } | null>;
}

// Hosts send at most this many files of a commit (GitHub: 300); bigger commits are shown cut off.
const maxDiffPages = 3;

type Fetch = typeof fetch;
const perPage = 100;

// The user a token belongs to as its host names them (GitHub's login, GitLab's username); null when the host doesn't
// say within a few seconds (offline, a refused token, a server that never answers).
export async function hostUser(provider: "github" | "gitlab", host: string, token: string, fetchFn: Fetch = fetch): Promise<string | null> {
  const [url, headers]: [string, Record<string, string>] = provider === "github"
    ? ["https://api.github.com/user", { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` }]
    : [`https://${host}/api/v4/user`, { "PRIVATE-TOKEN": token }];
  try {
    const response = await fetchFn(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const user = (await response.json()) as { login?: unknown; username?: unknown };
    const name = provider === "github" ? user.login : user.username;
    return typeof name === "string" && name ? name : null;
  } catch {
    return null;
  }
}

// Understands https and ssh links to GitHub and GitLab (also self-hosted, then provider is null: the user says).
export function parseRepoLink(text: string): { provider: "github" | "gitlab" | null; host: string; path: string; url: string } | null {
  const link = text.trim();
  let host: string;
  let path: string;
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(link);
  if (scp) [, host, path] = scp;
  else {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      return null;
    }
    if (!["https:", "http:", "ssh:"].includes(url.protocol)) return null;
    host = url.hostname;
    path = url.pathname;
  }
  path = trimChars(path, "/").replace(/\.git$/, "").split("/-/")[0];
  host = host.toLowerCase();
  const provider = host === "github.com" ? "github" : host === "gitlab.com" || host.includes("gitlab") ? "gitlab" : null;
  // GitHub links can point inside a repo (…/tree/main/src): owner/repo is the start.
  if (provider === "github") path = path.split("/").slice(0, 2).join("/");
  if (!/^[\w.-]+(\/[\w.-]+)+$/.test(path)) return null;
  return { provider, host, path, url: provider === "github" ? `https://github.com/${path}` : `https://${host}/${path}` };
}

export function readerFor(ref: RepoRef, token: string | null, fetchFn: Fetch = fetch): RepoReader {
  if (ref.provider === "github") return github(ref, token, fetchFn);
  if (ref.provider === "gitlab") return gitlab(ref, token, fetchFn);
  return local(ref);
}

// A refusal a (different) token would let through: the view asks for one only then. Asking after any failed update
// ("Already up to date", an unreachable host) told members who had signed in to GitHub that they couldn't.
export class RepoAccessError extends ShownError {}

// Turns the APIs' refusals into messages people can act on.
async function getJson<T>(fetchFn: Fetch, url: string, headers: Record<string, string>): Promise<T> {
  const response = await request(fetchFn, url, headers);
  if (response.ok) return (await response.json()) as T;
  throw refusal(response, url, headers);
}

async function request(fetchFn: Fetch, url: string, headers: Record<string, string>): Promise<Response> {
  try {
    return await fetchFn(url, { headers });
  } catch {
    throw new ShownError(`Couldn't reach ${new URL(url).host}.`);
  }
}

// Branches with an ETag: null when unchanged (304); a long list is then read in full.
async function watchedBranches(fetchFn: Fetch, url: string, headers: Record<string, string>, etag: string | null,
  all: () => Promise<Branch[]>, toBranch: (item: never) => Branch): Promise<{ etag: string | null; branches: Branch[] } | null> {
  const response = await request(fetchFn, url, etag ? { ...headers, "If-None-Match": etag } : headers);
  if (response.status === 304) return null;
  if (!response.ok) throw refusal(response, url, headers);
  const items = (await response.json()) as never[];
  return { etag: response.headers.get("etag"), branches: items.length < perPage ? items.map(toBranch) : await all() };
}

// `headers`: what was sent, so a refusal knows whether a token went with it.
function refusal(response: Response, url: string, headers: Record<string, string>): ShownError {
  // The site people know: GitHub's API answers from api.github.com.
  const host = new URL(url).host.replace(/^api\.(?=github\.com$)/, "");
  const token = "Authorization" in headers || "PRIVATE-TOKEN" in headers;
  const reset = Number(response.headers.get("x-ratelimit-reset") ?? response.headers.get("ratelimit-reset"));
  const remaining = response.headers.get("x-ratelimit-remaining") ?? response.headers.get("ratelimit-remaining");
  if (response.status === 429 || (response.status === 403 && remaining === "0")) {
    const when = reset ? ` Try again after ${new Date(reset * 1000).toLocaleTimeString()}.` : "";
    // With a token the limit is already the token's: another one wouldn't help.
    return token ? new ShownError(`The ${host} rate limit is used up.${when}`)
      : new RepoAccessError(`The ${host} rate limit is used up.${when} A token raises the limit.`);
  }
  if (response.status === 401 || response.status === 403)
    return new RepoAccessError(token ? `The token for ${host} was refused, or it can't read this repository.` : `${host} wants a token for this repository.`);
  if (response.status === 404)
    return new RepoAccessError(token ? `Repository not found, or the token for ${host} can't read it.` : "Repository not found. If it is private, add a token that can read it.");
  return new ShownError(`${host} answered ${response.status}.`);
}

// Pages through a list until `take` says stop (returns false) or a page comes back short.
async function pages<T>(load: (page: number) => Promise<T[]>, take: (items: T[]) => boolean): Promise<void> {
  for (let page = 1; ; page++) {
    const items = await load(page);
    if (!take(items) || items.length < perPage) return;
  }
}

async function collect<T>(load: (page: number) => Promise<T[]>, toCommit: (item: T) => ImportedCommit, max: number,
  known: (sha: string) => boolean): Promise<ImportedCommit[]> {
  const found: ImportedCommit[] = [];
  const seen = new Set<string>();
  await pages(load, (items) => {
    const fresh = items.map(toCommit).filter((c) => !known(c.sha) && !seen.has(c.sha));
    for (const c of fresh.slice(0, max - found.length)) {
      seen.add(c.sha);
      found.push(c);
    }
    // A page with nothing new means the rest is already there.
    return fresh.length > 0 && found.length < max;
  });
  return found;
}

interface GitHubCommit {
  sha: string;
  parents: { sha: string }[];
  commit: { author: { name: string; email: string; date: string } | null; message: string };
}

function github(ref: RepoRef, token: string | null, fetchFn: Fetch): RepoReader {
  const api = `https://api.github.com/repos/${ref.path}`;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const get = <T>(url: string) => getJson<T>(fetchFn, url, headers);
  const branches = async () => {
    const all: Branch[] = [];
    await pages((page) => get<{ name: string; commit: { sha: string } }[]>(`${api}/branches?per_page=${perPage}&page=${page}`),
      (items) => { all.push(...items.map((b) => ({ name: b.name, head: b.commit.sha }))); return true; });
    return all;
  };
  return {
    defaultBranch: async () => (await get<{ default_branch: string }>(api)).default_branch,
    branches,
    watchBranches: (etag) => watchedBranches(fetchFn, `${api}/branches?per_page=${perPage}&page=1`, headers, etag, branches,
      (b: { name: string; commit: { sha: string } }) => ({ name: b.name, head: b.commit.sha })),
    history: (from, max, known) => collect(
      (page) => get<GitHubCommit[]>(`${api}/commits?sha=${encodeURIComponent(from)}&per_page=${perPage}&page=${page}`),
      (c) => ({
        sha: c.sha, parents: c.parents.map((p) => p.sha), author_name: c.commit.author?.name ?? "",
        author_email: c.commit.author?.email ?? "", authored_at: c.commit.author?.date ?? new Date(0).toISOString(), message: c.commit.message,
      }),
      max, known),
    async diff(sha) {
      const files: DiffFile[] = [];
      let page = 1;
      for (; page <= maxDiffPages; page++) {
        const { files: items = [] } = await get<{ files?: GitHubFile[] }>(`${api}/commits/${encodeURIComponent(sha)}?per_page=${perPage}&page=${page}`);
        files.push(...items.map((f) => hostFile({
          path: f.filename, oldPath: f.status === "added" ? null : f.previous_filename ?? f.filename,
          status: f.status === "removed" ? "deleted" : f.status === "added" || f.status === "copied" ? "added" : f.status === "renamed" ? "renamed" : "modified",
          patch: f.patch ?? null, additions: f.additions, deletions: f.deletions,
        })));
        if (items.length < perPage) break;
      }
      return { files, truncated: page > maxDiffPages };
    },
  };
}

interface GitHubFile {
  filename: string;
  previous_filename?: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  patch?: string;
}

interface GitLabDiff {
  old_path: string;
  new_path: string;
  new_file: boolean;
  deleted_file: boolean;
  renamed_file: boolean;
  diff: string;
}

interface GitLabCommit {
  id: string;
  parent_ids: string[];
  author_name: string;
  author_email: string;
  authored_date: string;
  message: string;
}

function gitlab(ref: RepoRef, token: string | null, fetchFn: Fetch): RepoReader {
  const api = `https://${ref.host}/api/v4/projects/${encodeURIComponent(ref.path)}`;
  const headers: Record<string, string> = token ? { "PRIVATE-TOKEN": token } : {};
  const get = <T>(url: string) => getJson<T>(fetchFn, url, headers);
  const branches = async () => {
    const all: Branch[] = [];
    await pages((page) => get<{ name: string; commit: { id: string } }[]>(`${api}/repository/branches?per_page=${perPage}&page=${page}`),
      (items) => { all.push(...items.map((b) => ({ name: b.name, head: b.commit.id }))); return true; });
    return all;
  };
  return {
    defaultBranch: async () => (await get<{ default_branch: string }>(api)).default_branch,
    branches,
    watchBranches: (etag) => watchedBranches(fetchFn, `${api}/repository/branches?per_page=${perPage}&page=1`, headers, etag, branches,
      (b: { name: string; commit: { id: string } }) => ({ name: b.name, head: b.commit.id })),
    history: (from, max, known) => collect(
      (page) => get<GitLabCommit[]>(`${api}/repository/commits?ref_name=${encodeURIComponent(from)}&per_page=${perPage}&page=${page}`),
      (c) => ({
        sha: c.id, parents: c.parent_ids, author_name: c.author_name, author_email: c.author_email,
        authored_at: c.authored_date, message: c.message,
      }),
      max, known),
    async diff(sha) {
      const files: DiffFile[] = [];
      let page = 1;
      for (; page <= maxDiffPages; page++) {
        const items = await get<GitLabDiff[]>(`${api}/repository/commits/${encodeURIComponent(sha)}/diff?per_page=${perPage}&page=${page}`);
        // An empty diff is GitLab's way of saying binary or too large.
        files.push(...items.map((d) => hostFile({
          path: d.new_path, oldPath: d.new_file ? null : d.old_path,
          status: d.new_file ? "added" : d.deleted_file ? "deleted" : d.renamed_file ? "renamed" : "modified",
          patch: d.diff ? d.diff.replace(/\n$/, "") : null,
        })));
        if (items.length < perPage) break;
      }
      return { files, truncated: page > maxDiffPages };
    },
  };
}

// A folder on this device (`ref.path`, picked in the desktop app's folder dialog), read with git.
function local(ref: RepoRef): RepoReader {
  const git = desktop?.git;
  if (!git) throw new ShownError("Local folders need the desktop app.");
  return {
    defaultBranch: async () => (await git.branches(ref.path).catch((e) => { throw desktopError(e); })).current,
    branches: async () => (await git.branches(ref.path).catch((e) => { throw desktopError(e); })).branches,
    async history(from, max, known) {
      // Pages of git log, skipping what the server already has.
      const found: ImportedCommit[] = [];
      for (let skip = 0; found.length < max; skip += 1000) {
        const page = await git.log(ref.path, from, skip, 1000).catch((e) => { throw desktopError(e); });
        const fresh = page.filter((c) => !known(c.sha));
        found.push(...fresh.slice(0, max - found.length));
        if (page.length < 1000 || fresh.length === 0) break;
      }
      return found;
    },
    async diff(sha) {
      const { patch, truncated } = await git.show(ref.path, sha).catch((e) => { throw desktopError(e); });
      return { files: parseUnifiedDiff(patch), truncated };
    },
  };
}
