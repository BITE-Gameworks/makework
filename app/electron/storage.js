// Where serverless servers keep their data on this computer. A server is either in the app's own storage (its
// history in IndexedDB, file contents in the shared store, readable files in ~/MakeWork) or in a folder the user
// picked, which then holds everything for it:
//   <folder>/<channel>/...           readable copy of its synced files
//   <folder>/.makework/server.json   { id, name, secret, v }: whose folder this is, and enough to open it again
//   <folder>/.makework/commits/      the signed history, one file per plugin (chat.jsonl, git.jsonl, ...),
//                                    one commit per line, plus checkpoint.json
//   <folder>/.makework/content/      file contents by hash (and content-partial/ for unfinished downloads)
//   <folder>/.makework/mirror.json   the readable copy's manifest
// The registry of folders is kept by the main process only, and only holds folders picked in its dialog.
import fs from "node:fs/promises";
import path from "node:path";
import { safeSegment } from "./files.js";
import { compareText } from "./text.js";

export const dataDirName = ".makework";
export const dataDir = (folder) => path.join(folder, dataDirName);
export const contentDirOf = (folder) => path.join(dataDir(folder), "content");
export const partialDirOf = (folder) => path.join(dataDir(folder), "content-partial");
export const commitsDirOf = (folder) => path.join(dataDir(folder), "commits");
const checkpointFileOf = (folder) => path.join(commitsDirOf(folder), "checkpoint.json");
const previousCommitsDirOf = (folder) => `${commitsDirOf(folder)}.previous`;
const compactingCommitsDirOf = (folder) => `${commitsDirOf(folder)}.compacting`;
const serverFile = (folder) => path.join(dataDir(folder), "server.json");
// Folders made before 2026-10-09 kept the whole history in this one file.
const oldCommitsFile = (folder) => path.join(dataDir(folder), "commits.jsonl");

// The file a commit goes into: the plugin that made it, from its action ("chat.post" -> "chat.jsonl"). A commit
// whose ops reach other plugins (a member move) still stays whole in one file, or its signature breaks. Actions
// come from peers, so only plain lowercase names are used (no paths, no case clashes on Windows and macOS).
export function commitFileName(commit) {
  const ext = /^([a-z][a-z0-9_]{0,63})\./.exec(typeof commit?.action === "string" ? commit.action : "")?.[1];
  return `${ext ? safeSegment(ext) : "other"}.jsonl`;
}

function byFile(commits) {
  const groups = new Map();
  for (const commit of commits) {
    const name = commitFileName(commit);
    (groups.get(name) ?? groups.set(name, []).get(name)).push(commit);
  }
  return groups;
}

// The history as lines: one JSON commit per line. A half-written last line (a crash mid-append) is skipped.
export function parseCommitLines(text) {
  const commits = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      commits.push(JSON.parse(line));
    } catch {
      // An unfinished line.
    }
  }
  return commits;
}
export const commitLines = (commits) => commits.map((c) => `${JSON.stringify(c)}\n`).join("");

// What a folder is to a server: "empty" (usable), "same" (already this server's: reopen), "other" (another
// server's) or "used" (has other things in it).
export async function folderState(folder, workspaceId) {
  let names;
  try {
    names = await fs.readdir(folder);
  } catch {
    return "empty";
  }
  if (names.includes(dataDirName)) {
    try {
      const marker = JSON.parse(await fs.readFile(serverFile(folder), "utf8"));
      return marker.id === workspaceId ? "same" : "other";
    } catch {
      return "other";
    }
  }
  return names.length === 0 ? "empty" : "used";
}

export async function readServerFile(folder) {
  try {
    const marker = JSON.parse(await fs.readFile(serverFile(folder), "utf8"));
    return typeof marker?.id === "string" ? marker : null;
  } catch {
    return null;
  }
}

// Fields already in server.json are kept unless given again (a folder brought back keeps its secret and version).
export async function describeFolder(folder, workspaceId, fields) {
  const kept = await readServerFile(folder);
  const marker = { ...(kept?.id === workspaceId ? kept : {}), id: workspaceId };
  for (const [key, value] of Object.entries(fields)) if (value) marker[key] = value;
  marker.name ??= "";
  await fs.writeFile(serverFile(folder), JSON.stringify(marker, null, 2));
}

export async function prepareFolder(folder, workspaceId, fields = {}) {
  await fs.mkdir(contentDirOf(folder), { recursive: true });
  await fs.mkdir(commitsDirOf(folder), { recursive: true });
  await describeFolder(folder, workspaceId, fields);
}

async function recoverCommitDirectory(folder) {
  const dir = commitsDirOf(folder);
  const previous = previousCommitsDirOf(folder);
  try {
    await fs.access(dir);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    try {
      await fs.rename(previous, dir);
    } catch (restoreError) {
      if (restoreError?.code !== "ENOENT") throw restoreError;
    }
  }
  await fs.rm(previous, { recursive: true, force: true });
  await fs.rm(compactingCommitsDirOf(folder), { recursive: true, force: true });
}

// Splits an old single commits.jsonl into the per-plugin files. The new files are written whole (not appended)
// and the old file is removed only after they are all there, so a crash midway just runs it again next time.
export async function splitOldHistory(folder) {
  let text;
  try {
    text = await fs.readFile(oldCommitsFile(folder), "utf8");
  } catch {
    return;
  }
  const commits = parseCommitLines(text);
  await fs.mkdir(commitsDirOf(folder), { recursive: true });
  for (const [name, group] of byFile(commits)) await fs.writeFile(path.join(commitsDirOf(folder), name), commitLines(group));
  if ((await readCommitFiles(folder)).length !== commits.length) throw new Error("Couldn't split the workspace's history into its new files.");
  await fs.rm(oldCommitsFile(folder));
}

async function readCommitFiles(folder) {
  return readCommitFilesFrom(commitsDirOf(folder));
}

async function readCommitFilesFrom(dir) {
  const names = await fs.readdir(dir).catch(() => []);
  const commits = [];
  for (const name of names.filter((n) => n.endsWith(".jsonl")).sort(compareText)) {
    for (const commit of parseCommitLines(await fs.readFile(path.join(dir, name), "utf8"))) commits.push(commit);
  }
  return commits;
}

// Every commit of every file, in no particular order (the ledger sorts them).
export async function loadCommits(folder) {
  await recoverCommitDirectory(folder);
  await splitOldHistory(folder);
  return readCommitFiles(folder);
}

export async function appendCommits(folder, commits) {
  if (!commits.length) return;
  await recoverCommitDirectory(folder);
  await splitOldHistory(folder);
  await fs.mkdir(commitsDirOf(folder), { recursive: true });
  for (const [name, group] of byFile(commits)) await fs.appendFile(path.join(commitsDirOf(folder), name), commitLines(group));
}

export async function compactCommits(folder, hashes) {
  const remove = new Set(hashes);
  const commits = (await loadCommits(folder)).filter((commit) => !remove.has(commit.hash));
  const dir = commitsDirOf(folder);
  const previous = previousCommitsDirOf(folder);
  const next = compactingCommitsDirOf(folder);
  await fs.rm(previous, { recursive: true, force: true });
  await fs.rm(next, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.cp(dir, next, { recursive: true });
  const groups = new Map(byFile(commits));
  const names = (await fs.readdir(next)).filter((name) => name.endsWith(".jsonl"));
  for (const name of names) {
    await fs.rm(path.join(next, name), { force: true });
  }
  for (const [name, group] of groups) {
    const file = path.join(next, name);
    const temporary = `${file}.tmp`;
    await fs.writeFile(temporary, commitLines(group));
    await fs.rename(temporary, file);
  }
  if ((await readCommitFilesFrom(next)).length !== commits.length)
    throw new Error("Couldn't verify the compacted workspace history.");
  await fs.rename(dir, previous);
  try {
    await fs.rename(next, dir);
  } catch (error) {
    await fs.rename(previous, dir);
    throw error;
  }
  await fs.rm(previous, { recursive: true, force: true });
  if ((await readCommitFiles(folder)).length !== commits.length)
    throw new Error("Couldn't verify the compacted workspace history.");
}

export async function loadCheckpoint(folder) {
  try {
    return JSON.parse(await fs.readFile(checkpointFileOf(folder), "utf8"));
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

export async function saveCheckpoint(folder, checkpoint) {
  const file = checkpointFileOf(folder);
  await fs.mkdir(commitsDirOf(folder), { recursive: true });
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(checkpoint));
  await fs.rename(temporary, file);
}

export async function deleteCheckpoint(folder) {
  await fs.rm(checkpointFileOf(folder), { force: true });
}

// The registry file: workspaceId -> folder.
export async function readRegistry(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return {};
  }
}

export async function writeRegistry(file, registry) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(registry, null, 2));
}

// Copies a server's data folder (.makework) to another server folder and checks the copy: the same number of
// commits and every content file. The readable files are not copied: the app writes them again from the content.
export async function copyData(from, to) {
  await fs.cp(dataDir(from), dataDir(to), { recursive: true, errorOnExist: false, force: true });
  const [a, b] = [await loadCommits(from), await loadCommits(to)];
  if (a.length !== b.length) throw new Error("The copied history doesn't match; nothing was changed.");
  const files = (folder) => fs.readdir(contentDirOf(folder)).catch(() => []);
  const copied = new Set(await files(to));
  if ((await files(from)).some((name) => !copied.has(name))) throw new Error("Some files weren't copied; nothing was changed.");
}
