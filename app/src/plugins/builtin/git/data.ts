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
// `ownHost`: its link leads to another host than the main repository's, so it has a connection of its own.
export interface SubFolder {
  folder: string;
  ownHost?: string;
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
  ownHost?: string;
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
      for (const [sub, copy] of Object.entries(subFolders(workspaceId, channelId))) found.push({ workspaceId, channelId, sub, ...copy });
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
// be the remote's, not one person's local branches. Null when it can't. `mainHost`: the main repository's host, for
// a submodule (one on another host has a connection of its own).
export async function readerHere(workspaceId: string, channelId: number, repo: Repo, token: string | undefined,
  mainHost: string | null): Promise<{ reader: RepoReader; host: string | null } | null> {
  const folder = localFolder(workspaceId, channelId, repo.subPath);
  if (folder && repo.provider === "local") return { reader: readerFor({ provider: "local", host: "", path: folder }, null), host: null };
  // A folder imported on another device: its origin link, if it has one.
  const link = repo.provider === "local" ? parseRepoLink(repo.url) : { provider: repo.provider, host: repo.host, path: repo.path };
  if (!link) return null;
  const provider = link.provider ?? "gitlab";
  const own = repo.subPath !== "" && link.host !== mainHost;
  return { reader: readerFor({ provider, host: link.host, path: link.path }, token ?? (await channelToken(workspaceId, channelId, link.host, own))),
    host: link.host };
}
