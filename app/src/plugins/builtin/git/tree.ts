// Importing a version control channel as this device can read it: its repository, and with it the submodules when
// the channel includes them (ticked at setup or in the More menu) or its folder on this device has some. A folder
// here first gets its missing submodules cloned and each put on its branch (findSubFolders).
import { userMessage, type PluginClient } from "../../../api/client";
import { desktop, type GitSubmodule, type GitPreparedSubmodule } from "../../../core/desktop";
import { channelToken } from "./connections";
import { hostOf, localFolder, saveSubFolders, subFolders, type Repo, type SubFolder } from "./data";
import { importRepo, importTree, maxDepth, maxRepos, type ImportProgress, type OpenSubmodule, type Skipped } from "./importer";
import { gitCall } from "./local";
import { parseRepoLink, readerFor, type RepoReader } from "./providers";
import { resolveSubmoduleUrl } from "./submodules";

// What getting a folder's submodules ready did, each by its path from the main repository's root.
export interface Prepared {
  cloned: string[];
  attached: { sub: string; branch: string }[];
  left: { sub: string; reason: string }[];
  failed: { sub: string; reason: string; auth?: string }[];
}

const nothingDone = (): Prepared => ({ cloned: [], attached: [], left: [], failed: [] });

// Looks through the channel's folder here for its submodules at every level and remembers the folders of the ones
// checked out (asking the desktop app is also what lets it read them). With `prepare`, the missing ones are cloned
// first and each is put on its branch where that changes no file (electron/gitOps.js prepareSubmodules), so the
// submodules of a fresh clone are looked into too. `mainHost`: the main repository's host. When the folder can't be
// asked, what was known stays.
export async function findSubFolders(workspaceId: string, channelId: number, mainHost: string | null,
  prepare = false): Promise<{ folders: Record<string, SubFolder>; prepared: Prepared }> {
  const root = localFolder(workspaceId, channelId);
  const prepared = nothingDone();
  if (!root || !desktop?.git?.submodules) return { folders: {}, prepared };
  const found: Record<string, SubFolder> = {};
  const look = async (folder: string, above: string, depth: number): Promise<void> => {
    const { origin, submodules } = await gitCall((git): Promise<{ origin: string; submodules: (GitSubmodule & Partial<GitPreparedSubmodule>)[] }> =>
      (prepare ? git.prepareSubmodules(folder) : git.submodules(folder)));
    for (const s of submodules) {
      const sub = above ? `${above}/${s.path}` : s.path;
      if (s.cloned) prepared.cloned.push(sub);
      if (s.attached && s.onBranch) prepared.attached.push({ sub, branch: s.onBranch });
      if (s.left) prepared.left.push({ sub, reason: s.left });
      if (s.error) prepared.failed.push({ sub, reason: s.error, ...(s.auth ? { auth: s.auth } : {}) });
      if (!s.folder || Object.keys(found).length >= maxRepos - 1) continue;
      const host = parseRepoLink(resolveSubmoduleUrl(origin, s.url))?.host ?? null;
      found[sub] = host && host !== mainHost ? { folder: s.folder, ownHost: host } : { folder: s.folder };
      if (depth < maxDepth) await look(s.folder, sub, depth + 1);
    }
  };
  try {
    await look(root, "", 1);
  } catch (e) {
    prepared.failed.push({ sub: "", reason: userMessage(e) });
    return { folders: subFolders(workspaceId, channelId), prepared };
  }
  saveSubFolders(workspaceId, channelId, found);
  return { folders: found, prepared };
}

// "a", "a and b", "a, b and c".
const listed = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

// What getting the submodules ready did, in a few sentences for the view; "" when nothing needed doing.
export function describePrepared(p: Prepared): string {
  return [
    p.cloned.length ? `Cloned ${listed(p.cloned)} into this folder.` : "",
    p.attached.length ? `Put ${listed(p.attached.map((a) => `${a.sub} on ${a.branch}`))}.` : "",
    ...p.left.map((l) => `${l.sub}: ${l.reason}`),
    ...p.failed.map((f) => (f.sub ? `${f.sub} couldn't be cloned: ${f.reason}` : `The submodules couldn't be got ready: ${f.reason}`)),
  ].filter(Boolean).join(" ");
}

// Whether the channel's folder on this device has submodules of its own (checked out or not).
async function folderHasSubmodules(workspaceId: string, channelId: number): Promise<boolean> {
  const folder = localFolder(workspaceId, channelId);
  const git = desktop?.git;
  if (!folder || !git?.submodules) return false;
  return (await git.submodules(folder).then((found) => found.submodules.length > 0, () => false));
}

// A submodule's reader here: its folder when the channel was made from one and it is checked out, else its host
// with the channel's connection for it.
const opener = (workspaceId: string, channelId: number, main: Repo): OpenSubmodule => async (_sub, submodule) => {
  if (main.provider === "local" && submodule.folder && desktop?.git)
    return readerFor({ provider: "local", host: "", path: submodule.folder }, null);
  const link = parseRepoLink(submodule.url);
  if (!link) return null;
  const token = await channelToken(workspaceId, channelId, link.host, link.host !== hostOf(main));
  return readerFor({ provider: link.provider ?? "gitlab", host: link.host, path: link.path }, token);
};

// Imports the channel's main repository with `reader`, and its submodules when they are included. A folder here
// that has submodules includes them from then on, for every member. `from`: start at that submodule instead, which
// `reader` then reads. `prepare`: clone the folder's missing submodules and put them on their branches first (not
// from the background watch, which only reads).
export async function importChannel(api: PluginClient, workspaceId: string, channelId: number, main: Repo, reader: RepoReader,
  mode: "first" | "update", onProgress: (progress: ImportProgress) => void = () => {}, signal?: AbortSignal,
  from = "", prepare = true): Promise<{ added: number; skipped: Skipped[]; prepared: Prepared }> {
  let included = main.subrepos;
  if (!included && (await folderHasSubmodules(workspaceId, channelId))) {
    await api.call("include-subrepos", { channel_id: channelId, subrepos: true });
    included = true;
  }
  if (!included) return { added: (await importRepo(api, channelId, reader, mode, onProgress, signal, from)).added, skipped: [], prepared: nothingDone() };
  // Before reading: the desktop app lets the page read a submodule's folder once it was found from its repository's.
  const { prepared } = await findSubFolders(workspaceId, channelId, hostOf(main), prepare);
  // A submodule's default branch is asked of its reader.
  const source = { reader, defaultBranch: from ? undefined : main.defaultBranch, fromFolder: main.provider === "local", sub: from };
  return { ...(await importTree(api, channelId, source, mode, opener(workspaceId, channelId, main), onProgress, signal)), prepared };
}
