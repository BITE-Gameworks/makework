// The git plugin's data for one version control channel, and where this device can read the repository.
import type { Accessor } from "solid-js";
import type { PluginClient } from "../../../api/client";
import type { ApiValue } from "../../../api/types";
import { readJson, removeKey, writeJson } from "../../../core/storage";
import { compareText } from "../../../core/text";
import { decodeEmoji } from "../../../markdown/emoji";
import { createLive } from "../../live";
import { channelToken } from "./connections";
import { parseRepoLink, readerFor, type Provider, type RepoReader } from "./providers";

export interface Repo {
  id: number;
  provider: Provider;
  host: string;
  path: string;
  url: string;
  defaultBranch: string;
  importedBy: number;
  importedAt: string | null;
  // "" for the channel's main repository; a submodule's path from the main repository's root.
  subPath: string;
  // The commit a submodule's parent records for it; "" when unknown.
  pinned: string;
  // On the main repository: imports bring its submodules too.
  subrepos: boolean;
}

export interface Branch {
  id: number;
  name: string;
  head: string;
}

export interface Commit {
  id: number;
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  message: string;
}

type Row = Record<string, ApiValue>;

const toRepo = (r: Row): Repo => ({
  id: Number(r.id), provider: String(r.provider) as Provider, host: String(r.host ?? ""), path: String(r.path ?? ""),
  url: String(r.url ?? ""), defaultBranch: String(r.default_branch ?? ""), importedBy: Number(r.imported_by),
  importedAt: r.imported_at ? String(r.imported_at) : null,
  subPath: String(r.sub_path ?? ""), pinned: String(r.pinned ?? ""), subrepos: r.subrepos === true,
});

// The call arguments naming one of the channel's repositories.
const repoArgs = (channelId: number, sub: string): Record<string, ApiValue> => (sub ? { channel_id: channelId, sub } : { channel_id: channelId });

// The main repository first, then the submodules by path, so one comes right after the repository it is in.
const inTreeOrder = (repos: Repo[]) => [...repos].sort((a, b) => compareText(a.subPath, b.subPath));

// The host a repository's connection is for: its own, or for one made from a folder its origin's.
export const hostOf = (repo: Repo): string | null => (repo.provider === "local" ? parseRepoLink(repo.url)?.host ?? null : repo.host || null);

// What a repository is called in a list: the main one by its name, a submodule by its path.
export const repoName = (repo: Repo): string => repo.subPath || repo.path.split("/").pop() || repo.path;

// A repository's place in the channel's tree: the main one at depth 0, each submodule under the repository whose
// folder holds it. `name`: its path from that repository's root. `last`: no later sibling; `parentsLast`: the same
// for each repository above it, from depth 1 down, so guide lines know where they end.
export interface RepoTreeRow {
  repo: Repo;
  depth: number;
  name: string;
  last: boolean;
  parentsLast: boolean[];
}

// The main repository first, then each repository's submodules by name under it, depth first. A submodule's parent is
// the one whose path is the longest that starts its own (`vendor/lib` hangs under the main one when there is no
// `vendor`).
export function repoTree(repos: Repo[]): RepoTreeRow[] {
  const paths = new Set(repos.map((r) => r.subPath));
  const parentOf = (path: string) => {
    for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1))
      if (paths.has(path.slice(0, at))) return path.slice(0, at);
    return "";
  };
  const children = new Map<string, Repo[]>();
  for (const r of repos) {
    if (!r.subPath) continue;
    const parent = parentOf(r.subPath);
    const siblings = children.get(parent);
    if (siblings) siblings.push(r);
    else children.set(parent, [r]);
  }
  const rows: RepoTreeRow[] = [];
  const walk = (path: string, depth: number, parentsLast: boolean[]) => {
    const relative = (r: Repo) => (path ? r.subPath.slice(path.length + 1) : r.subPath);
    const kids = [...(children.get(path) ?? [])].sort((a, b) => compareText(relative(a), relative(b)));
    kids.forEach((r, i) => {
      const last = i === kids.length - 1;
      rows.push({ repo: r, depth, name: relative(r), last, parentsLast });
      walk(r.subPath, depth + 1, [...parentsLast, last]);
    });
  };
  const main = repos.find((r) => !r.subPath);
  if (main) rows.push({ repo: main, depth: 0, name: repoName(main), last: true, parentsLast: [] });
  // Without a main repository (it was removed while a view was open), its submodules still show from the top.
  walk("", 1, []);
  return rows;
}

const toCommit = (r: Row): Commit => ({
  id: Number(r.id), sha: String(r.sha), parents: String(r.parents ?? "").split(" ").filter(Boolean),
  authorName: decodeEmoji(String(r.author_name ?? "")), authorEmail: String(r.author_email ?? ""),
  authoredAt: String(r.authored_at), message: decodeEmoji(String(r.message ?? "")),
});

// The channel's repositories once, outside a view (the background watch): the main one first.
export async function loadRepos(api: PluginClient, channelId: number): Promise<Repo[]> {
  return inTreeOrder((await api.call<{ rows: Row[] }>("list-repos", { channel_id: channelId })).rows.map(toRepo));
}

// The channel's main repository and its submodules, for choosing between them.
export function createRepos(api: PluginClient, channelId: number) {
  return createLive<Repo[]>(api, [], () => channelId, () => loadRepos(api, channelId));
}

// One of the channel's repositories with its branches; `sub` names a submodule.
export function createRepo(api: PluginClient, channelId: number, sub = "") {
  return createLive<{ repo: Repo | null; branches: Branch[] }>(api, { repo: null, branches: [] }, () => channelId, async () => {
    const { repo, branches } = await api.call<{ repo: Row | null; branches: Row[] }>("get-repo", repoArgs(channelId, sub));
    return {
      repo: repo && toRepo(repo),
      branches: branches.map((b) => ({ id: Number(b.id), name: String(b.name), head: String(b.head) })),
    };
  });
}

export interface History {
  rows: Commit[];
  total: number;
  truncated: boolean;
  heads: { name: string; head: string }[];
}

// One branch's history, or all branches' together with `branch` null.
export function createHistory(api: PluginClient, channelId: number, sub: string, branch: Accessor<string | null>, limit: Accessor<number>) {
  return createLive<History>(api, { rows: [], total: 0, truncated: false, heads: [] }, () => [branch(), limit()], async () => {
    const name = branch();
    const result = await api.call<{ rows: Row[]; total: number; truncated: boolean; heads: History["heads"] }>("list-commits",
      { ...repoArgs(channelId, sub), limit: limit(), ...(name === null ? {} : { branch: name }) });
    return { rows: result.rows.map(toCommit), total: result.total, truncated: result.truncated, heads: result.heads };
  });
}

// The local folder this device read the channel's repository from, if any; with `sub`, that submodule's folder inside
// it when it is checked out here.
const folderPrefix = "mw.git.folder.";
const folderKey = (workspaceId: string, channelId: number) => `${folderPrefix}${workspaceId}:${channelId}`;
export const localFolder = (workspaceId: string, channelId: number, sub = "") => (sub
  ? subFolders(workspaceId, channelId)[sub]?.folder ?? null : readJson<string | null>(folderKey(workspaceId, channelId), null));
// Changes whenever a channel's folder here is set or cleared, so what depends on all of them is worked out again.
let folderRevision = 0;
export const workingCopiesRevision = () => folderRevision;
export const setLocalFolder = (workspaceId: string, channelId: number, folder: string | null) => {
  writeJson(folderKey(workspaceId, channelId), folder);
  removeKey(subFoldersKey(workspaceId, channelId));
  folderRevision++;
};

// The submodules checked out inside a channel's folder here, by their path from the main repository's root.
export interface SubFolder {
  folder: string;
}
const subFoldersKey = (workspaceId: string, channelId: number) => `mw.git.subfolders.${workspaceId}:${channelId}`;
export const subFolders = (workspaceId: string, channelId: number) =>
  readJson<Record<string, SubFolder>>(subFoldersKey(workspaceId, channelId), {});

// Remembers the submodules found checked out in a channel's folder here (tree.ts findSubFolders).
export function saveSubFolders(workspaceId: string, channelId: number, found: Record<string, SubFolder>): void {
  if (JSON.stringify(found) === JSON.stringify(subFolders(workspaceId, channelId))) return;
  writeJson(subFoldersKey(workspaceId, channelId), found);
  folderRevision++;
}

export interface LocalCopy {
  workspaceId: string;
  channelId: number;
  folder: string;
  // "" for the channel's main repository.
  sub: string;
}

// Every channel with a working copy on this device, and the submodules checked out inside each.
export function workingCopies(): LocalCopy[] {
  const found: LocalCopy[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(folderPrefix)) continue;
      const rest = key.slice(folderPrefix.length);
      const at = rest.lastIndexOf(":");
      const folder = readJson<string | null>(key, null);
      if (at <= 0 || !folder) continue;
      const workspaceId = rest.slice(0, at);
      const channelId = Number(rest.slice(at + 1));
      found.push({ workspaceId, channelId, folder, sub: "" });
      for (const [sub, copy] of Object.entries(subFolders(workspaceId, channelId))) found.push({ workspaceId, channelId, sub, folder: copy.folder });
    }
  } catch {
    // No storage: no working copies known.
  }
  return found;
}

// How this device can read a repository for an update: for a channel made from a local folder, that folder if it is
// on this device (a submodule: its folder inside it, when checked out); otherwise the shared link through the host's
// API (with the channel's host connection here, if it has one: connections.ts). A GitHub/GitLab channel always reads
// the host, even when this device also has a working copy: an update replaces the channel's branch list, which must
// be the remote's, not one person's local branches. Null when it can't. A submodule uses its own connection pick.
export async function readerHere(workspaceId: string, channelId: number, repo: Repo,
  token?: string): Promise<{ reader: RepoReader; host: string | null } | null> {
  const folder = localFolder(workspaceId, channelId, repo.subPath);
  if (folder && repo.provider === "local") return { reader: readerFor({ provider: "local", host: "", path: folder }, null), host: null };
  // A folder imported on another device: its origin link, if it has one.
  const link = repo.provider === "local" ? parseRepoLink(repo.url) : { provider: repo.provider, host: repo.host, path: repo.path };
  if (!link) return null;
  const provider = link.provider ?? "gitlab";
  return { reader: readerFor({ provider, host: link.host, path: link.path }, token ?? (await channelToken(workspaceId, channelId, link.host, repo.subPath))),
    host: link.host };
}
