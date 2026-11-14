// Imports a repository's history into the channel's `git` plugin, for every member: new commits in batches,
// then the branch list. The first import and each update bring at most 1,000 new commits per branch; "older"
// continues below what is imported, 1,000 more per branch.
//
// With its submodules (importTree): each is found in its repository's default branch, saved as a repository of the
// same channel under its path from the main repository's root, imported the same way, and looked into in turn.
import { userMessage, type PluginClient } from "../../../api/client";
import { encodeEmoji } from "../../../markdown/emoji";
import type { ImportedCommit, ImportedSubmodule } from "../../../system/git";
import { parseRepoLink, type Branch, type RepoReader, type Submodule } from "./providers";

export type ImportMode = "first" | "update" | "older";
export interface ImportProgress {
  read: number;
  sent: number;
  // The submodule being imported, by its path from the main repository's root; the main repository without it.
  sub?: string;
}

export const perBranch = 1000;
const batch = 200;
// Submodules inside submodules are followed this deep, and a channel holds at most this many repositories.
export const maxDepth = 8;
export const maxRepos = 50;

// `sub`: one of the channel's submodules, by its path from the main repository's root.
export async function importRepo(api: PluginClient, channelId: number, reader: RepoReader, mode: ImportMode,
  onProgress: (progress: ImportProgress) => void = () => {}, signal?: AbortSignal, sub = ""): Promise<{ added: number; branches: Branch[] }> {
  const repo: Record<string, string | number> = sub ? { channel_id: channelId, sub } : { channel_id: channelId };
  const lines = async (fn: string) => (await api.call<{ shas: string }>(fn, repo)).shas.split("\n").filter(Boolean);
  const known = new Set(await lines("known-shas"));
  const branches = await reader.branches();
  // Older history continues at the parents that aren't imported yet.
  const starts = mode === "older" ? await lines("frontier") : branches.map((b) => b.name);
  let budget = mode === "older" ? perBranch * Math.max(1, branches.length) : Infinity;
  const found: ImportedCommit[] = [];
  for (const from of starts) {
    signal?.throwIfAborted();
    if (budget <= 0) break;
    const commits = await reader.history(from, Math.min(perBranch, budget), (sha) => known.has(sha));
    for (const c of commits) {
      known.add(c.sha);
      // Repositories made on Windows can have \r\n line ends in messages.
      found.push({ ...c, author_name: encodeEmoji(c.author_name), message: encodeEmoji(c.message.replace(/\r\n?/g, "\n")) });
    }
    budget -= commits.length;
    onProgress({ read: found.length, sent: 0, sub });
  }
  for (let i = 0; i < found.length; i += batch) {
    signal?.throwIfAborted();
    await api.call("import-commits", { ...repo, commits: JSON.stringify(found.slice(i, i + batch)) });
    onProgress({ read: found.length, sent: Math.min(found.length, i + batch), sub });
  }
  if (mode !== "older") await api.call("set-branches", { ...repo, branches: JSON.stringify(branches) });
  return { added: found.length, branches };
}

export interface TreeSource {
  reader: RepoReader;
  // The main repository's default branch, when it is known already.
  defaultBranch?: string;
  // The channel was made from a folder: its submodules are saved like it, by folder name with their origin's link.
  fromFolder: boolean;
  // The repository `reader` reads when it isn't the main one: a submodule, by its path from the main one's root.
  sub?: string;
}

// A submodule that wasn't imported, by its path from the main repository's root, and why.
export interface Skipped {
  sub: string;
  reason: string;
}

// How this device reads a submodule (`sub`: its path from the main repository's root); null when it can't.
export type OpenSubmodule = (sub: string, submodule: Submodule) => Promise<RepoReader | null>;

const aborted = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

// The channel's repository (or one of its submodules) and every submodule below it. One submodule that can't be read
// (private, unreachable, a link to somewhere unknown) is reported and doesn't stop the others; it stays listed, so a
// member who can read it imports it later. A repository is not followed into a copy of itself.
export async function importTree(api: PluginClient, channelId: number, main: TreeSource, mode: "first" | "update", open: OpenSubmodule,
  onProgress: (progress: ImportProgress) => void = () => {}, signal?: AbortSignal): Promise<{ added: number; skipped: Skipped[] }> {
  const skipped: Skipped[] = [];
  let added = 0;
  let repos = 1;

  const into = async (reader: RepoReader, sub: string, defaultBranch: string | undefined, branches: Branch[], depth: number, above: string[]) => {
    if (!reader.submodules) return;
    const branch = defaultBranch ?? (await reader.defaultBranch());
    const found = await reader.submodules(branches.find((b) => b.name === branch)?.head ?? branch);
    const listed: { row: ImportedSubmodule; submodule: Submodule; reader: RepoReader | null; why: string; identity: string }[] = [];
    for (const submodule of found) {
      signal?.throwIfAborted();
      const path = sub ? `${sub}/${submodule.path}` : submodule.path;
      const link = parseRepoLink(submodule.url);
      if (!link && !main.fromFolder) {
        skipped.push({ sub: path, reason: submodule.url ? `Its link (${submodule.url}) isn't a GitHub or GitLab one.` : "It has no link." });
        continue;
      }
      if (repos >= maxRepos) {
        skipped.push({ sub: path, reason: `A channel holds at most ${maxRepos} repositories.` });
        continue;
      }
      repos++;
      const place = main.fromFolder ? { provider: "local", host: "", path: submodule.path.split("/").pop()!, url: link?.url ?? "" }
        : { provider: link!.provider ?? "gitlab", host: link!.host, path: link!.path, url: link!.url };
      let opened: RepoReader | null = null;
      let why = "This device can't read it.";
      let subBranch = "";
      try {
        opened = await open(path, submodule);
        if (opened) subBranch = await opened.defaultBranch();
      } catch (e) {
        if (aborted(e)) throw e;
        opened = null;
        why = userMessage(e);
      }
      listed.push({
        row: { sub_path: path, ...place, default_branch: subBranch, pinned: submodule.pinned }, submodule, reader: opened, why,
        identity: link ? `${link.host}/${link.path}`.toLowerCase() : "",
      });
    }
    await api.call("set-subrepos", { channel_id: channelId, ...(sub ? { sub } : {}), subrepos: JSON.stringify(listed.map((l) => l.row)) });
    for (const { row, reader: opened, why, identity } of listed) {
      signal?.throwIfAborted();
      if (!opened) {
        skipped.push({ sub: row.sub_path, reason: why });
        continue;
      }
      try {
        const result = await importRepo(api, channelId, opened, mode, onProgress, signal, row.sub_path);
        added += result.added;
        if (depth >= maxDepth || (identity && above.includes(identity))) continue;
        await into(opened, row.sub_path, row.default_branch || undefined, result.branches, depth + 1, identity ? [...above, identity] : above);
      } catch (e) {
        if (aborted(e)) throw e;
        skipped.push({ sub: row.sub_path, reason: userMessage(e) });
      }
    }
  };

  const top = main.sub ?? "";
  const first = await importRepo(api, channelId, main.reader, mode, onProgress, signal, top);
  added += first.added;
  try {
    await into(main.reader, top, main.defaultBranch || undefined, first.branches, 1, []);
  } catch (e) {
    if (aborted(e)) throw e;
    skipped.push({ sub: top, reason: userMessage(e) });
  }
  return { added, skipped };
}

// What wasn't imported, in a sentence or two for the view; "" when everything was. `top`: the repository the import
// started at, whose own entry means its list of submodules couldn't be read.
export function describeSkipped(skipped: Skipped[], top = ""): string {
  if (!skipped.length) return "";
  const own = skipped.find((s) => s.sub === top);
  const others = skipped.filter((s) => s.sub !== top);
  const parts = others.map((s) => `${s.sub} (${s.reason.replace(/\.$/, "")})`);
  return [
    own ? `The submodules couldn't be read: ${own.reason}` : "",
    others.length ? `${others.length === 1 ? "A submodule wasn't" : `${others.length} submodules weren't`} imported: ${parts.join(", ")}.` : "",
  ].filter(Boolean).join(" ");
}
