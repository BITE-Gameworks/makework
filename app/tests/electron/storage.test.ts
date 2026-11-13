/// <reference types="node" />
// Real folders in the system temp folder: these are file system rules.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendCommits, commitFileName, commitLines, compactCommits, commitsDirOf, contentDirOf, copyData, dataDir, folderState, loadCommits, parseCommitLines, prepareFolder,
  deleteCheckpoint, describeFolder, loadCheckpoint, readRegistry, readServerFile, saveCheckpoint, writeRegistry,
} from "../../electron/storage.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mw-storage-"));
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe("server folders", () => {
  it("keeps commits as lines and skips a half-written last one", () => {
    const commits = [{ hash: "a", seq: 0 }, { hash: "b", seq: 1, text: "line\nbreak" }];
    const text = commitLines(commits);
    expect(text.split("\n")).toHaveLength(3);
    expect(parseCommitLines(text)).toEqual(commits);
    expect(parseCommitLines(`${text}{"hash":"c",`)).toEqual(commits);
  });

  it("accepts an empty or missing folder, or one that is already the same server's", async () => {
    const folder = path.join(root, "server");
    expect(await folderState(folder, "id1")).toBe("empty");
    await fs.mkdir(folder);
    expect(await folderState(folder, "id1")).toBe("empty");
    await prepareFolder(folder, "id1", { name: "Studio" });
    expect(await folderState(folder, "id1")).toBe("same");
  });

  it("refuses another server's folder and a folder with other things in it", async () => {
    const folder = path.join(root, "server");
    await prepareFolder(folder, "id1", { name: "Studio" });
    expect(await folderState(folder, "id2")).toBe("other");
    expect(await folderState(folder, undefined)).toBe("other");
    await fs.writeFile(path.join(root, "notes.txt"), "mine");
    expect(await folderState(root, "id1")).toBe("used");
  });

  it("keeps what is needed to open the folder again, and doesn't lose it on a later write", async () => {
    const folder = path.join(root, "server");
    await prepareFolder(folder, "id1", { name: "Studio", secret: "s3cret" });
    await describeFolder(folder, "id1", { name: "Renamed" });
    expect(await readServerFile(folder)).toEqual({ id: "id1", name: "Renamed", secret: "s3cret" });
    expect(await readServerFile(root)).toBeNull();
  });

  it("appends to the history and reads it back", async () => {
    const folder = path.join(root, "server");
    await prepareFolder(folder, "id1");
    expect(await loadCommits(folder)).toEqual([]);
    await appendCommits(folder, [{ hash: "a", action: "chat.post" }]);
    await appendCommits(folder, [{ hash: "b", action: "chat.post" }, { hash: "c", action: "chat.edit" }]);
    expect(await loadCommits(folder)).toEqual([
      { hash: "a", action: "chat.post" }, { hash: "b", action: "chat.post" }, { hash: "c", action: "chat.edit" },
    ]);
  });

  it("compacts the folder history as one recoverable directory swap", async () => {
    const folder = path.join(root, "server");
    await prepareFolder(folder, "id1");
    const commits = [
      { hash: "keep", action: "chat.post" }, { hash: "remove", action: "files.upload" },
      { hash: "also-keep", action: "chat.edit" },
    ];
    await appendCommits(folder, commits);
    await compactCommits(folder, ["remove"]);
    expect(await loadCommits(folder)).toEqual([commits[0], commits[2]]);

    expect((await loadCommits(folder)).map((commit) => (commit as { hash: string }).hash))
      .toEqual(["keep", "also-keep"]);

    const interrupted = path.join(root, "interrupted");
    await prepareFolder(interrupted, "id2");
    await appendCommits(interrupted, commits);
    const dir = commitsDirOf(interrupted);
    await fs.rename(dir, `${dir}.previous`);
    await fs.mkdir(`${dir}.compacting`);
    expect((await loadCommits(interrupted)).map((commit) => (commit as { hash: string }).hash))
      .toEqual(["keep", "also-keep", "remove"]);
    await expect(fs.access(`${dir}.compacting`)).rejects.toThrow();
    await expect(fs.access(`${dir}.previous`)).rejects.toThrow();
  });

  it("saves checkpoints atomically beside the folder's commit files", async () => {
    const folder = path.join(root, "server");
    await prepareFolder(folder, "id1");
    const checkpoint = { version: 1, index: 256, hash: "anchor", tables: [] };
    expect(await loadCheckpoint(folder)).toBeNull();
    await saveCheckpoint(folder, checkpoint);
    expect(await loadCheckpoint(folder)).toEqual(checkpoint);
    expect((await fs.readdir(commitsDirOf(folder))).sort()).toEqual(["checkpoint.json"]);
    await deleteCheckpoint(folder);
    expect(await loadCheckpoint(folder)).toBeNull();
  });

  it("keeps each plugin's commits in its own file", async () => {
    const folder = path.join(root, "server");
    await prepareFolder(folder, "id1");
    const commits = [
      { hash: "a", action: "chat.post" }, { hash: "b", action: "git.import-commits" },
      { hash: "c", action: "chat.edit" }, { hash: "d", action: "artboard.add" },
    ];
    await appendCommits(folder, commits);
    expect((await fs.readdir(commitsDirOf(folder))).sort()).toEqual(["artboard.jsonl", "chat.jsonl", "git.jsonl"]);
    const chat = await fs.readFile(path.join(commitsDirOf(folder), "chat.jsonl"), "utf8");
    expect(parseCommitLines(chat).map((c) => (c as { hash: string }).hash)).toEqual(["a", "c"]);
    const hashes = (await loadCommits(folder)).map((c) => (c as { hash: string }).hash).sort();
    expect(hashes).toEqual(["a", "b", "c", "d"]);
  });

  it("names files only after plain plugin names", () => {
    expect(commitFileName({ action: "git.import-commits" })).toBe("git.jsonl");
    expect(commitFileName({ action: "../evil.post" })).toBe("other.jsonl");
    expect(commitFileName({ action: "a/b.post" })).toBe("other.jsonl");
    expect(commitFileName({ action: "Chat.post" })).toBe("other.jsonl");
    expect(commitFileName({ action: "nodot" })).toBe("other.jsonl");
    expect(commitFileName({})).toBe("other.jsonl");
    expect(commitFileName({ action: "con.post" })).toBe("con_.jsonl");
  });

  it("splits an old single history file, also after a crash midway", async () => {
    const folder = path.join(root, "server");
    await prepareFolder(folder, "id1");
    const commits = [{ hash: "a", action: "chat.post" }, { hash: "b", action: "files.upload" }, { hash: "c", action: "chat.edit" }];
    const old = path.join(dataDir(folder), "commits.jsonl");
    await fs.writeFile(old, `${commitLines(commits)}{"hash":"d",`);
    // A crash after one new file was written: it is written again, not doubled.
    await fs.writeFile(path.join(commitsDirOf(folder), "chat.jsonl"), commitLines([commits[0], commits[2]]));
    const hashes = async () => (await loadCommits(folder)).map((c) => (c as { hash: string }).hash).sort();
    expect(await hashes()).toEqual(["a", "b", "c"]);
    await expect(fs.access(old)).rejects.toThrow();
    expect((await fs.readdir(commitsDirOf(folder))).sort()).toEqual(["chat.jsonl", "files.jsonl"]);
    await appendCommits(folder, [{ hash: "e", action: "chat.post" }]);
    expect(await hashes()).toEqual(["a", "b", "c", "e"]);
  });

  it("splits the old history before appending to it", async () => {
    const folder = path.join(root, "server");
    await prepareFolder(folder, "id1");
    await fs.writeFile(path.join(dataDir(folder), "commits.jsonl"), commitLines([{ hash: "a", action: "chat.post" }]));
    await appendCommits(folder, [{ hash: "b", action: "chat.post" }]);
    expect((await loadCommits(folder)).map((c) => (c as { hash: string }).hash)).toEqual(["a", "b"]);
  });

  it("copies a server's data folder and checks it", async () => {
    const from = path.join(root, "from");
    const to = path.join(root, "to");
    await prepareFolder(from, "id1");
    await appendCommits(from, [{ hash: "a", action: "chat.post" }, { hash: "b", action: "git.import-commits" }]);
    await fs.writeFile(path.join(contentDirOf(from), "f".repeat(64)), "content");
    await fs.writeFile(path.join(from, "readable.txt"), "a mirror file");
    await copyData(from, to);
    expect(await loadCommits(to)).toHaveLength(2);
    expect(await fs.readFile(path.join(contentDirOf(to), "f".repeat(64)), "utf8")).toBe("content");
    // Readable files are written again by the app, not copied.
    await expect(fs.access(path.join(to, "readable.txt"))).rejects.toThrow();
    expect(await folderState(to, "id1")).toBe("same");
    await expect(fs.access(dataDir(from))).resolves.toBeUndefined();
  });

  it("keeps the registry of folders", async () => {
    const file = path.join(root, "profile", "server-locations.json");
    expect(await readRegistry(file)).toEqual({});
    await writeRegistry(file, { id1: "/home/me/Studio" });
    expect(await readRegistry(file)).toEqual({ id1: "/home/me/Studio" });
  });
});
