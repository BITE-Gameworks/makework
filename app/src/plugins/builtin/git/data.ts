// The git plugin's data for one version control channel, and where this device can read the repository.
import type { Accessor } from "solid-js";
import type { PluginClient } from "../../../api/client";
import type { ApiValue } from "../../../api/types";
import { readJson, writeJson } from "../../../core/storage";
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
});

const toCommit = (r: Row): Commit => ({
  id: Number(r.id), sha: String(r.sha), parents: String(r.parents ?? "").split(" ").filter(Boolean),
  authorName: decodeEmoji(String(r.author_name ?? "")), authorEmail: String(r.author_email ?? ""),
  authoredAt: String(r.authored_at), message: decodeEmoji(String(r.message ?? "")),
});

// The channel's repository once, outside a view (the background watch).
export async function loadRepo(api: PluginClient, channelId: number): Promise<Repo | null> {
  const { repo } = await api.call<{ repo: Row | null }>("get-repo", { channel_id: channelId });
  return repo && toRepo(repo);
}

export function createRepo(api: PluginClient, channelId: number) {
  return createLive<{ repo: Repo | null; branches: Branch[] }>(api, { repo: null, branches: [] }, () => channelId, async () => {
    const { repo, branches } = await api.call<{ repo: Row | null; branches: Row[] }>("get-repo", { channel_id: channelId });
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
export function createHistory(api: PluginClient, channelId: number, branch: Accessor<string | null>, limit: Accessor<number>) {
  return createLive<History>(api, { rows: [], total: 0, truncated: false, heads: [] }, () => [branch(), limit()], async () => {
    const name = branch();
    const result = await api.call<{ rows: Row[]; total: number; truncated: boolean; heads: History["heads"] }>("list-commits",
      { channel_id: channelId, limit: limit(), ...(name === null ? {} : { branch: name }) });
    return { rows: result.rows.map(toCommit), total: result.total, truncated: result.truncated, heads: result.heads };
  });
}

// The local folder this device read the channel's repository from, if any.
const folderPrefix = "mw.git.folder.";
const folderKey = (workspaceId: string, channelId: number) => `${folderPrefix}${workspaceId}:${channelId}`;
export const localFolder = (workspaceId: string, channelId: number) => readJson<string | null>(folderKey(workspaceId, channelId), null);
// Changes whenever a channel's folder here is set or cleared, so what depends on all of them is worked out again.
let folderRevision = 0;
export const workingCopiesRevision = () => folderRevision;
export const setLocalFolder = (workspaceId: string, channelId: number, folder: string | null) => {
  writeJson(folderKey(workspaceId, channelId), folder);
  folderRevision++;
};

// Every channel with a working copy on this device.
export function workingCopies(): { workspaceId: string; channelId: number; folder: string }[] {
  const found: { workspaceId: string; channelId: number; folder: string }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(folderPrefix)) continue;
      const rest = key.slice(folderPrefix.length);
      const at = rest.lastIndexOf(":");
      const folder = readJson<string | null>(key, null);
      if (at > 0 && folder) found.push({ workspaceId: rest.slice(0, at), channelId: Number(rest.slice(at + 1)), folder });
    }
  } catch {
    // No storage: no working copies known.
  }
  return found;
}

// How this device can read the repository for an update: for a channel made from a local folder, that folder if it is
// on this device; otherwise the shared link through the host's API (with the channel's host connection here, if it
// has one: connections.ts). A GitHub/GitLab channel always reads the host, even when this device also has a working copy: an update
// replaces the channel's branch list, which must be the remote's, not one person's local branches. Null when it can't.
export async function readerHere(workspaceId: string, channelId: number, repo: Repo, token?: string): Promise<{ reader: RepoReader; host: string | null } | null> {
  const folder = localFolder(workspaceId, channelId);
  if (folder && repo.provider === "local") return { reader: readerFor({ provider: "local", host: "", path: folder }, null), host: null };
  // A folder imported on another device: its origin link, if it has one.
  const link = repo.provider === "local" ? parseRepoLink(repo.url) : { provider: repo.provider, host: repo.host, path: repo.path };
  if (!link) return null;
  const provider = link.provider ?? "gitlab";
  return { reader: readerFor({ provider, host: link.host, path: link.path }, token ?? (await channelToken(workspaceId, channelId, link.host))),
    host: link.host };
}
