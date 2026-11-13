// Imports a repository's history into the channel's `git` plugin, for every member: new commits in batches,
// then the branch list. The first import and each update bring at most 1,000 new commits per branch; "older"
// continues below what is imported, 1,000 more per branch.
import type { PluginClient } from "../../../api/client";
import { encodeEmoji } from "../../../markdown/emoji";
import type { ImportedCommit } from "../../../system/git";
import type { RepoReader } from "./providers";

export type ImportMode = "first" | "update" | "older";
export interface ImportProgress {
  read: number;
  sent: number;
}

export const perBranch = 1000;
const batch = 200;

export async function importRepo(api: PluginClient, channelId: number, reader: RepoReader, mode: ImportMode,
  onProgress: (progress: ImportProgress) => void = () => {}, signal?: AbortSignal): Promise<{ added: number }> {
  const lines = async (fn: string) => (await api.call<{ shas: string }>(fn, { channel_id: channelId })).shas.split("\n").filter(Boolean);
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
    onProgress({ read: found.length, sent: 0 });
  }
  for (let i = 0; i < found.length; i += batch) {
    signal?.throwIfAborted();
    await api.call("import-commits", { channel_id: channelId, commits: JSON.stringify(found.slice(i, i + batch)) });
    onProgress({ read: found.length, sent: Math.min(found.length, i + batch) });
  }
  if (mode !== "older") await api.call("set-branches", { channel_id: channelId, branches: JSON.stringify(branches) });
  return { added: found.length };
}
