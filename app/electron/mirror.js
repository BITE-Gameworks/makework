// Content kept in servers' readable folders (the "mirror"), and finding content on this computer: in a store
// (<userData>/local/content, <server folder>/.makework/content) or placed in a readable folder. No Electron imports,
// so tests can run it on temporary folders.
import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream, watch as watchFolder } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { caseFreePaths, removeOrDefer, safeSegment } from "./files.js";
import { dataDir, dataDirName } from "./storage.js";

const exists = (file) => fs.access(file).then(() => true, () => false);
export const checkHash = (hash) => {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("Not a content hash.");
  return hash;
};

// Files people leave behind while editing or downloading, never taken as new files.
const scratchName = /^(~\$|\.~|\.goutputstream)|(~|\.swp|\.swx|\.tmp|\.part|\.crdownload|\.kate-swp)$/i;
const textExtension = /\.(md|json|svg|txt)$/i;
const maxText = 4 * 1024 * 1024;

async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

// `locations()`: workspaceId -> folder of servers kept in a folder; `contentDir(workspaceId)` the store a server's new
// content goes to; `trashLater(file)` for files Windows can't delete yet; `onChanges(key, changes)` gets what
// changed in a readable folder since the app wrote it (see `scan`).
export function createPlaces({ localDir, mirrorRoot, locations, contentDir, sharedContentDir, allContentDirs, trashLater, onChanges = () => {} }) {
  // Content that has a place in a server's readable folder is kept only there (the mirror moves it out of the
  // store). Placed files by hash, from every mirror manifest: absolute file -> { hash, size, mtimeMs }. A placed file
  // counts only while its size and time are what the mirror wrote: one changed on disk is no longer that content.
  const placedFiles = new Map();
  const placedByHash = new Map();
  const placedOf = new Map();
  const baseOf = new Map();

  function setPlacements(manifestFile, base, files) {
    baseOf.set(manifestFile, base);
    for (const file of placedOf.get(manifestFile) ?? []) {
      placedByHash.get(placedFiles.get(file)?.hash)?.delete(file);
      placedFiles.delete(file);
    }
    const mine = [];
    for (const [relative, record] of Object.entries(files ?? {})) {
      if (typeof record?.hash !== "string" || record.hash.startsWith("text:")) continue;
      const file = path.join(base, ...relative.split("/"));
      placedFiles.set(file, record);
      (placedByHash.get(record.hash) ?? placedByHash.set(record.hash, new Set()).get(record.hash)).add(file);
      mine.push(file);
    }
    placedOf.set(manifestFile, mine);
  }

  // Every server's manifest: servers in the app's storage (their readable folder in ~/MakeWork) and in folders.
  async function loadPlacements() {
    placedFiles.clear();
    placedByHash.clear();
    placedOf.clear();
    baseOf.clear();
    const appManifests = path.join(localDir(), "mirror");
    for (const name of await fs.readdir(appManifests).catch(() => [])) {
      const file = path.join(appManifests, name);
      const manifest = await readManifestFile(file);
      if (manifest.folder) setPlacements(file, path.join(mirrorRoot(), manifest.folder), manifest.files);
    }
    for (const folder of Object.values(locations())) {
      const file = path.join(dataDir(folder), "mirror.json");
      setPlacements(file, folder, (await readManifestFile(file)).files);
    }
  }

  async function placedCopy(hash, except) {
    for (const file of placedByHash.get(hash) ?? []) {
      if (file !== except && await unchanged(file, placedFiles.get(file))) return file;
    }
    return null;
  }

  // Where a hash's content is: any server folder's store, the shared store, else a readable folder; null when it
  // isn't on this computer.
  const found = new Map();
  async function storedContent(hash) {
    const cached = found.get(hash);
    if (cached && await exists(cached)) return cached;
    found.delete(hash);
    for (const dir of allContentDirs()) {
      const file = path.join(dir, hash);
      if (await exists(file)) {
        found.set(hash, file);
        return file;
      }
    }
    return null;
  }
  async function findContent(hash) {
    checkHash(hash);
    return (await storedContent(hash)) ?? (await placedCopy(hash));
  }

  // A rename where it can be; across drives a checked copy, then the original goes.
  async function moveFile(from, to) {
    await fs.mkdir(path.dirname(to), { recursive: true });
    try {
      await fs.rename(from, to);
      return;
    } catch (e) {
      if (!["EXDEV", "EPERM", "EBUSY"].includes(e.code)) throw e;
    }
    await fs.copyFile(from, to, fsConstants.COPYFILE_FICLONE);
    if ((await fs.stat(to)).size !== (await fs.stat(from)).size) {
      await fs.rm(to, { force: true });
      throw new Error("A file wasn't copied fully.");
    }
    await removeOrDefer(from, { rm: fs.rm, later: trashLater });
  }

  // The readable folder of a server (src/p2p/diskView.ts: channels/<category>/<channel>/...) in ~/MakeWork/<server>/,
  // or in the server's own folder: kept content and text files written by the page. Content placed there is the only
  // copy on this computer: it is moved out of the store into its place, moved along when its place changes, and back
  // into the store when it has no place any more. The mirror only touches files it wrote itself: a file someone
  // changed on disk is never overwritten, moved or deleted (and no longer counts as that content).
  const manifestPath = (key) => locations()[key]
    ? path.join(dataDir(locations()[key]), "mirror.json")
    : path.join(localDir(), "mirror", `${key.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);

  // The ~/MakeWork folders other servers' manifests claim, lowercased, with the server key claiming each.
  async function claimedFolders(key) {
    const claims = new Map();
    const dir = path.join(localDir(), "mirror");
    for (const name of await fs.readdir(dir).catch(() => [])) {
      const file = path.join(dir, name);
      if (file === manifestPath(key)) continue;
      const { folder } = await readManifestFile(file);
      if (folder) claims.set(folder.toLowerCase(), name);
    }
    return claims;
  }

  async function holdsFiles(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!item.isDirectory() || await holdsFiles(path.join(dir, item.name))) return true;
    }
    return false;
  }

  // A server's ~/MakeWork folder: its name, numbered when another server's folder has it (two servers with the same
  // name in one folder would take each other's files for changes made on disk). Where two already share one, the
  // server whose manifest sorts first keeps it.
  async function folderFor(key, workspaceName) {
    const claims = await claimedFolders(key);
    const mine = (await readManifest(key)).folder?.toLowerCase();
    const ownFile = path.basename(manifestPath(key));
    const free = async (folder) => {
      const other = claims.get(folder.toLowerCase());
      if (other) return mine === folder.toLowerCase() && ownFile < other;
      // Files nobody here claims (another profile's, a reinstall's) would be taken for changes made on disk.
      return mine === folder.toLowerCase() || !(await holdsFiles(path.join(mirrorRoot(), folder)));
    };
    const name = safeSegment(workspaceName);
    for (let n = 1; ; n++) {
      const folder = n === 1 ? name : safeSegment(`${workspaceName} (${n})`);
      if (await free(folder)) return folder;
    }
  }

  const mirrorBase = async (key, workspaceName) => locations()[key] ?? path.join(mirrorRoot(), await folderFor(key, workspaceName));

  async function readManifestFile(file) {
    try {
      const manifest = JSON.parse(await fs.readFile(file, "utf8"));
      return { folder: manifest.folder ?? null, files: manifest.files ?? {} };
    } catch {
      return { folder: null, files: {} };
    }
  }
  const readManifest = (key) => readManifestFile(manifestPath(key));

  async function unchanged(file, record) {
    try {
      const stat = await fs.stat(file);
      return stat.size === record.size && Math.round(stat.mtimeMs) === record.mtimeMs;
    } catch {
      return false;
    }
  }

  const isText = (record) => record.hash.startsWith("text:");

  // A placed file leaving its place: into `store` when this computer has no other copy, else deleted. `placedNow`:
  // content placed in this pass, which the index doesn't know yet.
  async function retire(file, record, store, placedNow) {
    if (isText(record) || !store || placedNow.has(record.hash) || (await storedContent(record.hash)) || (await placedCopy(record.hash, file)))
      await fs.rm(file, { force: true, maxRetries: 3, retryDelay: 100 });
    else await moveFile(file, path.join(store, record.hash));
  }

  // Out of a folder another server's manifest claims too, into `base`: files only this server wrote move, files both
  // list as the same content are copied, the rest stay with the other server. Returns this server's records there.
  async function leaveShared(old, base, files, theirs) {
    const kept = {};
    for (const [relative, record] of Object.entries(files)) {
      const from = path.join(old, ...relative.split("/"));
      const to = path.join(base, ...relative.split("/"));
      if (!(await unchanged(from, record))) continue;
      const shared = theirs[relative]?.hash === record.hash;
      if (!shared && theirs[relative]) continue;
      try {
        await fs.mkdir(path.dirname(to), { recursive: true });
        if (shared) await fs.copyFile(from, to, fsConstants.COPYFILE_FICLONE);
        else {
          await moveFile(from, to);
          await removeEmptyParents(path.dirname(from), old);
        }
        const stat = await fs.stat(to);
        kept[relative] = { hash: record.hash, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
      } catch (e) {
        console.warn(`Readable copy of ${relative} not moved out of ${old}: ${e.message}`);
      }
    }
    return kept;
  }

  // One pass at a time: passes of two servers may move the same content.
  let mirrorQueue = Promise.resolve();
  const deduped = new Set();
  const applyMirror = (...args) => (mirrorQueue = mirrorQueue.catch(() => {}).then(() => mirrorPass(...args)));

  async function mirrorPass(key, workspaceName, entries) {
    const own = !!locations()[key];
    const folder = own ? null : await folderFor(key, workspaceName);
    const manifest = await readManifest(key);
    const base = own ? locations()[key] : path.join(mirrorRoot(), folder);
    const store = contentDir(key);
    // A renamed server's ~/MakeWork folder follows the name; a server folder stays where it was picked. A folder
    // another server has too stays with it, and this one starts over in its own.
    if (!own && manifest.folder && manifest.folder !== folder) {
      const old = path.join(mirrorRoot(), manifest.folder);
      const sharer = (await claimedFolders(key)).get(manifest.folder.toLowerCase());
      if (sharer) manifest.files = await leaveShared(old, base, manifest.files, (await readManifestFile(path.join(localDir(), "mirror", sharer))).files);
      else if (await exists(old) && !(await exists(base))) await fs.rename(old, base);
    }
    // Names that only differ in case would be one file on Windows: those get a number. Nothing may land in the server
    // folder's own data (.makework).
    const paths = caseFreePaths(entries.map((e) => e.path.map(safeSegment).map((s, i) => (i === 0 && s.toLowerCase() === dataDirName ? "_makework" : s))));
    await migrateArtboardFolders(base, paths, manifest);
    // Content by hash, or generated text (its record's hash is "text:" and the text's SHA-256).
    const wanted = new Map(entries.map((e, i) => [paths[i].join("/"), typeof e.text === "string"
      ? { hash: `text:${createHash("sha256").update(e.text).digest("hex")}`, text: e.text }
      : { hash: checkHash(e.hash) }]));
    const at = (relative) => path.join(base, ...relative.split("/"));

    // Placed content this pass doesn't want where it is: it moves to its new place (a renamed channel or folder)
    // before anything is copied.
    const leaving = new Map();
    for (const [relative, record] of Object.entries(manifest.files)) {
      if (isText(record) || wanted.get(relative)?.hash === record.hash) continue;
      (leaving.get(record.hash) ?? leaving.set(record.hash, []).get(record.hash)).push(relative);
    }
    const gone = new Set();
    const takeLeaving = async (hash) => {
      for (const relative of leaving.get(hash) ?? []) {
        if (gone.has(relative) || !(await unchanged(at(relative), manifest.files[relative]))) continue;
        gone.add(relative);
        return at(relative);
      }
      return null;
    };

    const files = {};
    const skipped = [];
    // Placed in this pass, before the index knows: the same content in a second place is copied from there.
    const placedNow = new Map();
    for (const [relative, entry] of wanted) {
      const target = at(relative);
      if (!target.startsWith(base + path.sep)) continue;
      const record = manifest.files[relative];
      if (record?.hash === entry.hash && await unchanged(target, record)) {
        files[relative] = record;
        // A store copy left from before (an earlier app, a download that raced the move) goes, once per session.
        if (!isText(record) && !deduped.has(record.hash)) {
          deduped.add(record.hash);
          const inStore = await storedContent(record.hash);
          if (inStore && [store, sharedContentDir()].includes(path.dirname(inStore))) {
            await removeOrDefer(inStore, { rm: fs.rm, later: trashLater });
            found.delete(record.hash);
          }
        }
        continue;
      }
      // Only replace what we wrote and nobody changed since.
      if (await exists(target)) {
        if (!(record && await unchanged(target, record))) {
          skipped.push(relative);
          if (record) files[relative] = record;
          continue;
        }
        // An older version of the file: it keeps its content in the store unless it is somewhere else too.
        if (!isText(record) && !gone.has(relative)) {
          gone.add(relative);
          await retire(target, record, store, placedNow);
        }
      }
      try {
        if (entry.text !== undefined) {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, entry.text);
        } else {
          // Only out of this server's store or the shared one: another server's folder keeps its own.
          const inStore = await storedContent(entry.hash);
          const stored = inStore && [store, sharedContentDir()].includes(path.dirname(inStore)) ? inStore : null;
          const moving = stored ?? (await takeLeaving(entry.hash));
          if (moving) {
            await moveFile(moving, target);
            if (moving === stored) found.delete(entry.hash);
            else await removeEmptyParents(path.dirname(moving), base);
          } else {
            // Kept in another place too (the same file in two channels, another server's folder): a copy.
            const source = inStore ?? placedNow.get(entry.hash) ?? (await placedCopy(entry.hash));
            if (!source) continue;
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.copyFile(source, target, fsConstants.COPYFILE_FICLONE);
          }
        }
      } catch (e) {
        console.warn(`Readable copy of ${relative} not written: ${e.message}`);
        continue;
      }
      const stat = await fs.stat(target);
      files[relative] = { hash: entry.hash, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
      reported.get(key)?.delete(relative);
      if (entry.text === undefined) placedNow.set(entry.hash, target);
    }
    // Placed files nothing wants: content back into the store (deleting a file or channel keeps its content, as
    // before; freeing it is content:delete's job), text deleted.
    for (const [relative, record] of Object.entries(manifest.files)) {
      if (wanted.has(relative) || gone.has(relative)) continue;
      const target = at(relative);
      if (await unchanged(target, record)) {
        // Open in another program (Windows can't delete it then): keep it listed, so the next pass tries again.
        try {
          await retire(target, record, store, placedNow);
        } catch {
          files[relative] = record;
          continue;
        }
        await removeEmptyParents(path.dirname(target), base);
      }
    }
    await fs.mkdir(path.dirname(manifestPath(key)), { recursive: true });
    await fs.writeFile(manifestPath(key), JSON.stringify({ folder, files }));
    setPlacements(manifestPath(key), base, files);
    await watchTree(key, workspaceName, base);
    return { folder: base, skipped };
  }

  async function migrateArtboardFolders(base, paths, manifest) {
    const oldName = safeSegment(".refs");
    const newName = safeSegment(".artboard");
    const folders = new Map();
    for (const segments of paths) {
      const index = segments.findIndex((segment) => segment.toLowerCase() === newName.toLowerCase());
      if (index < 0) continue;
      const next = segments.slice(0, index + 1).join("/");
      const previous = [...segments.slice(0, index), oldName].join("/");
      folders.set(previous, next);
    }
    for (const [previous, next] of folders) {
      const from = path.join(base, ...previous.split("/"));
      const to = path.join(base, ...next.split("/"));
      if (!(await exists(from)) || await exists(to)) continue;
      const entries = await fs.readdir(from, { withFileTypes: true }).catch(() => []);
      if (!entries.length || entries.some((entry) => !entry.isFile())) continue;
      const oldFiles = entries.map((entry) => `${previous}/${entry.name}`);
      const expected = Object.keys(manifest.files).filter((relative) => relative.startsWith(`${previous}/`));
      if (oldFiles.length !== expected.length) continue;
      let unchangedFiles = true;
      for (const relative of oldFiles) {
        const record = manifest.files[relative];
        if (!record || !expected.includes(relative) || !(await unchanged(path.join(base, ...relative.split("/")), record))) {
          unchangedFiles = false;
          break;
        }
      }
      if (!unchangedFiles) continue;
      try {
        await fs.rename(from, to);
        for (const relative of oldFiles) {
          const renamed = `${next}/${relative.slice(previous.length + 1)}`;
          manifest.files[renamed] = manifest.files[relative];
          delete manifest.files[relative];
        }
      } catch (e) {
        console.warn(`The old artboard folder ${from} was not renamed: ${e.message}`);
      }
    }
  }

  // Changes made in readable folders. Each server's channels/ folder is watched; a while after the last event (and
  // when the page asks, e.g. on focus) it is compared with the manifest: files the app wrote that are gone
  // ("removed") or differ ("changed"), and new files ("added"; not hidden ones, not editors' scratch files). Added
  // and changed files come with their hash and, for small text files, their text. Each state of a file is reported
  // once per session; the page answers with `adopt` (taken into the data) or leaves it.
  const watched = new Map();
  const reported = new Map();
  const quietMs = 1500;

  async function watchTree(key, workspaceName, base) {
    const current = watched.get(key);
    if (current?.base === base) return;
    current?.watcher?.close();
    const root = path.join(base, "channels");
    await fs.mkdir(root, { recursive: true });
    const entry = { base, workspaceName, watcher: null, timer: undefined };
    try {
      entry.watcher = watchFolder(root, { recursive: true }, () => {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => void requestScan(key), quietMs);
      });
      entry.watcher.on("error", () => {});
    } catch (e) {
      console.warn(`Not watching ${root}: ${e.message}`);
    }
    watched.set(key, entry);
    // What changed while the app wasn't running.
    void requestScan(key);
  }

  function unwatch(key) {
    const entry = watched.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.watcher?.close();
    watched.delete(key);
  }

  // In the pass queue: a pass moving files would look like files removed and added.
  const requestScan = (key) => (mirrorQueue = mirrorQueue.catch(() => {}).then(async () => {
    const entry = watched.get(key);
    if (!entry) return;
    const { changes, fresh } = await scan(key, entry.base);
    if (changes.length) onChanges(key, changes);
    if (fresh) {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => void requestScan(key), quietMs);
    }
  }));

  async function walk(dir, prefix, out) {
    for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const relative = `${prefix}/${item.name}`;
      if (item.isDirectory()) await walk(path.join(dir, item.name), relative, out);
      else if (item.isFile()) out.push(relative);
    }
    return out;
  }

  async function scan(key, base) {
    const manifest = await readManifest(key);
    const seen = reported.get(key) ?? reported.set(key, new Map()).get(key);
    const at = (relative) => path.join(base, ...relative.split("/"));
    const changes = [];
    let fresh = false;
    const report = async (relative, kind, record) => {
      const file = at(relative);
      if (kind === "removed") {
        if (seen.get(relative) === "removed") return;
        seen.set(relative, "removed");
        changes.push({ kind, path: relative.split("/"), base: record.hash });
        return;
      }
      const stat = await fs.stat(file).catch(() => null);
      if (!stat) return;
      const state = `${stat.size}:${Math.round(stat.mtimeMs)}:${Math.round(stat.ctimeMs)}`;
      if (seen.get(relative) === state) return;
      // Still being written (a download, a big copy): the next scan takes it. By the change time too: a copy often
      // gets its original's old modification time and its full size up front, and looked finished while half written.
      if (Date.now() - Math.max(stat.mtimeMs, stat.ctimeMs) < quietMs) {
        fresh = true;
        return;
      }
      const hash = await hashFile(file).catch(() => null);
      const after = await fs.stat(file).catch(() => null);
      if (!hash || after?.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) return;
      seen.set(relative, state);
      // Generated text is always returned as text, whatever its extension (code channels commonly use .ts, .rs, ...).
      const text = (textExtension.test(relative) || record?.hash?.startsWith("text:")) && stat.size <= maxText
        ? await fs.readFile(file, "utf8").catch(() => undefined)
        : undefined;
      changes.push({ kind, path: relative.split("/"), hash, text, size: stat.size, mtimeMs: Math.round(stat.mtimeMs), base: record?.hash });
    };
    for (const [relative, record] of Object.entries(manifest.files)) {
      if (await unchanged(at(relative), record)) continue;
      if (await exists(at(relative))) await report(relative, "changed", record);
      else await report(relative, "removed", record);
    }
    for (const relative of await walk(path.join(base, "channels"), "channels", [])) {
      if (manifest.files[relative]) continue;
      if (relative.split("/").some((segment) => segment.startsWith(".") || scratchName.test(segment))) continue;
      await report(relative, "added");
    }
    return { changes, fresh };
  }

  // Takes a file on disk as what the app wrote there, after its change went into the data: content (`hash`) is then
  // found there, text is compared with what the data gives next time. Only if it is still as it was reported.
  // `moveTo` (a path relative to the readable folder) moves it first: a conflicting edit becomes a file of its own.
  const adopt = (key, relative, { hash, size, mtimeMs }, moveTo) => (mirrorQueue = mirrorQueue.catch(() => {}).then(async () => {
    const entry = watched.get(key);
    if (!entry) return false;
    const manifest = await readManifest(key);
    let file = path.join(entry.base, ...relative.split("/"));
    if (!file.startsWith(entry.base + path.sep) || !(await unchanged(file, { size, mtimeMs }))) return false;
    let final = relative;
    if (moveTo) {
      const target = path.join(entry.base, ...moveTo.split("/"));
      if (!target.startsWith(entry.base + path.sep) || await exists(target)) return false;
      await moveFile(file, target);
      file = target;
      final = moveTo;
      delete manifest.files[relative];
    }
    const stat = await fs.stat(file);
    const recorded = hash ? checkHash(hash) : `text:${createHash("sha256").update(await fs.readFile(file)).digest("hex")}`;
    manifest.files[final] = { hash: recorded, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
    await fs.writeFile(manifestPath(key), JSON.stringify(manifest));
    setPlacements(manifestPath(key), entry.base, manifest.files);
    reported.get(key)?.delete(relative);
    return true;
  }));

  async function removeEmptyParents(dir, stop) {
    while (dir.startsWith(stop + path.sep)) {
      try {
        await fs.rmdir(dir);
      } catch {
        return;
      }
      dir = path.dirname(dir);
    }
  }

  // Readable files the mirror wrote and nobody changed since; then empty folders.
  async function removeMirrorFiles(base, manifest) {
    for (const [relative, record] of Object.entries(manifest.files ?? {})) {
      const target = path.join(base, ...relative.split("/"));
      if (await unchanged(target, record)) {
        await fs.rm(target, { force: true }).catch(() => {});
        await removeEmptyParents(path.dirname(target), base);
      }
    }
    await fs.rmdir(base).catch(() => {});
  }

  return {
    findContent, storedContent, placedCopy, loadPlacements, applyMirror, readManifest, manifestPath, mirrorBase,
    scan: requestScan, adopt, unwatch,
    unchanged, isText, moveFile, removeMirrorFiles, removeEmptyParents,
    // The store's cache of where content is.
    remember: (hash, file) => found.set(hash, file),
    forget: (hash) => (hash === undefined ? found.clear() : found.delete(hash)),
    // Readable copies of the content nobody changed. In the pass queue, and their manifests drop them at once: a scan
    // in between would take them for files the user deleted.
    removePlaced: (hash) => (mirrorQueue = mirrorQueue.catch(() => {}).then(async () => {
      const removed = new Set();
      for (const file of [...(placedByHash.get(hash) ?? [])]) {
        if (!(await unchanged(file, placedFiles.get(file)))) continue;
        await removeOrDefer(file, { rm: fs.rm, later: trashLater });
        if (!(await exists(file))) removed.add(file);
      }
      for (const [manifestFile, files] of placedOf) {
        if (!files.some((file) => removed.has(file))) continue;
        const base = baseOf.get(manifestFile);
        const manifest = await readManifestFile(manifestFile);
        for (const relative of Object.keys(manifest.files))
          if (removed.has(path.join(base, ...relative.split("/")))) delete manifest.files[relative];
        await fs.writeFile(manifestFile, JSON.stringify(manifest));
        setPlacements(manifestFile, base, manifest.files);
      }
    })),
  };
}
