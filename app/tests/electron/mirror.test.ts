/// <reference types="node" />
// Real folders in the system temp folder: content moves between the store and readable folders.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlaces } from "../../electron/mirror.js";

let root: string;
let places: ReturnType<typeof createPlaces>;
const locations: Record<string, string> = {};
const server = "server-aaaaaaaaaaaaaaaa";
const store = () => path.join(root, "local", "content");
const tree = () => path.join(root, "home", "MakeWork", "Bite");
const read = (file: string) => fs.readFile(file, "utf8");
const exists = (file: string) => fs.access(file).then(() => true, () => false);

async function stored(text: string) {
  const hash = createHash("sha256").update(text).digest("hex");
  await fs.mkdir(store(), { recursive: true });
  await fs.writeFile(path.join(store(), hash), text);
  return hash;
}
const apply = (entries: ({ path: string[]; hash: string } | { path: string[]; text: string })[]) =>
  places.applyMirror(server, "Bite", entries);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mw-mirror-"));
  for (const key of Object.keys(locations)) delete locations[key];
  places = createPlaces({
    localDir: () => path.join(root, "local"),
    mirrorRoot: () => path.join(root, "home", "MakeWork"),
    locations: () => locations,
    contentDir: (id: string) => (locations[id] ? path.join(locations[id], ".makework", "content") : store()),
    sharedContentDir: store,
    allContentDirs: () => [...Object.values(locations).map((f) => path.join(f, ".makework", "content")), store()],
    trashLater: async () => {},
  });
});
afterEach(async () => {
  places.unwatch(server);
  await fs.rm(root, { recursive: true, force: true });
});

describe("readable folders hold the only copy", () => {
  it("renames the old artboard settings folder when it only contains unchanged app files", async () => {
    const old = ["channels", "Art", "Mood", ".refs", "board.json"];
    const current = ["channels", "Art", "Mood", ".artboard", "board.json"];
    const text = '{"items":[]}\n';
    await apply([{ path: old, text }]);
    expect(await read(path.join(tree(), ...old))).toBe(text);

    await apply([{ path: current, text }]);
    expect(await exists(path.join(tree(), ...old))).toBe(false);
    expect(await read(path.join(tree(), ...current))).toBe(text);
  });

  it("leaves a user-edited old artboard settings file in place during migration", async () => {
    const old = ["channels", "Art", "Mood", ".refs", "board.json"];
    const current = ["channels", "Art", "Mood", ".artboard", "board.json"];
    await apply([{ path: old, text: '{"items":[]}\n' }]);
    await fs.writeFile(path.join(tree(), ...old), "user edits");

    await apply([{ path: current, text: '{"items":[{"id":1}]}\n' }]);
    expect(await read(path.join(tree(), ...old))).toBe("user edits");
    expect(await read(path.join(tree(), ...current))).toBe('{"items":[{"id":1}]}\n');
  });

  it("moves content out of the store into its place and finds it there", async () => {
    const hash = await stored("picture");
    await apply([{ path: ["channels", "art", "a.png"], hash }, { path: ["channels", "wiki", "Page.md"], text: "# Hi" }]);
    const placed = path.join(tree(), "channels", "art", "a.png");
    expect(await read(placed)).toBe("picture");
    expect(await read(path.join(tree(), "channels", "wiki", "Page.md"))).toBe("# Hi");
    expect(await exists(path.join(store(), hash))).toBe(false);
    expect(await places.findContent(hash)).toBe(placed);
  });

  it("moves files along when their place changes, and back into the store when they have none", async () => {
    const hash = await stored("picture");
    await apply([{ path: ["channels", "art", "a.png"], hash }]);
    await apply([{ path: ["channels", "Art & Design", "a.png"], hash }]);
    const moved = path.join(tree(), "channels", "Art & Design", "a.png");
    expect(await read(moved)).toBe("picture");
    expect(await exists(path.join(tree(), "channels", "art"))).toBe(false);
    await apply([]);
    expect(await exists(moved)).toBe(false);
    expect(await read(path.join(store(), hash))).toBe("picture");
    expect(await places.findContent(hash)).toBe(path.join(store(), hash));
  });

  it("copies content that has two places, and keeps one when the other goes", async () => {
    const hash = await stored("picture");
    const a = ["channels", "one", "a.png"];
    const b = ["channels", "two", "b.png"];
    await apply([{ path: a, hash }, { path: b, hash }]);
    expect(await read(path.join(tree(), ...b))).toBe("picture");
    await apply([{ path: b, hash }]);
    expect(await exists(path.join(tree(), ...a))).toBe(false);
    expect(await exists(path.join(store(), hash))).toBe(false);
    expect(await places.findContent(hash)).toBe(path.join(tree(), ...b));
  });

  it("leaves a file changed on disk alone, and it no longer counts as the content", async () => {
    const hash = await stored("picture");
    const file = path.join(tree(), "channels", "art", "a.png");
    await apply([{ path: ["channels", "art", "a.png"], hash }]);
    await fs.writeFile(file, "painted over");
    expect(await places.findContent(hash)).toBeNull();
    await apply([]);
    expect(await read(file)).toBe("painted over");
  });

  it("keeps the old version's content in the store when a file gets a new version", async () => {
    const v1 = await stored("version 1");
    const v2 = await stored("version 2");
    const file = ["channels", "art", "a.png"];
    await apply([{ path: file, hash: v1 }]);
    await apply([{ path: file, hash: v2 }]);
    expect(await read(path.join(tree(), ...file))).toBe("version 2");
    expect(await read(path.join(store(), v1))).toBe("version 1");
  });

  it("finds placed content again after a restart", async () => {
    const hash = await stored("picture");
    await apply([{ path: ["channels", "art", "a.png"], hash }]);
    await places.loadPlacements();
    expect(await places.findContent(hash)).toBe(path.join(tree(), "channels", "art", "a.png"));
  });

  it("drops a store copy left over from before", async () => {
    const hash = await stored("picture");
    await apply([{ path: ["channels", "art", "a.png"], hash }]);
    await stored("picture");
    await apply([{ path: ["channels", "art", "a.png"], hash }]);
    expect(await exists(path.join(store(), hash))).toBe(false);
  });

  it("removePlaced takes unchanged placed copies and leaves files changed on disk", async () => {
    // Forgetting a channel frees its content: content:delete calls removePlaced, which removes the readable
    // folder's copies the app wrote and nobody changed. A file the user changed is left alone.
    const a = await stored("picture");
    const b = await stored("notes");
    const fileA = path.join(tree(), "channels", "art", "a.png");
    const fileB = path.join(tree(), "channels", "wiki", "b.png");
    await apply([{ path: ["channels", "art", "a.png"], hash: a }, { path: ["channels", "wiki", "b.png"], hash: b }]);
    await places.loadPlacements();
    await fs.writeFile(fileB, "painted over");
    await places.removePlaced(a);
    await places.removePlaced(b);
    expect(await exists(fileA)).toBe(false);
    expect(await read(fileB)).toBe("painted over");
  });
});

describe("servers with the same name", () => {
  const other = "server-bbbbbbbbbbbbbbbb";
  afterEach(() => places.unwatch(other));

  it("get folders of their own", async () => {
    const one = await stored("one");
    const two = await stored("two");
    await apply([{ path: ["channels", "a.png"], hash: one }]);
    await places.applyMirror(other, "Bite", [{ path: ["channels", "b.png"], hash: two }]);
    expect(await read(path.join(tree(), "channels", "a.png"))).toBe("one");
    expect(await exists(path.join(tree(), "channels", "b.png"))).toBe(false);
    expect(await read(path.join(root, "home", "MakeWork", "Bite (2)", "channels", "b.png"))).toBe("two");
    expect((await places.readManifest(other)).folder).toBe("Bite (2)");
  });

  it("stay out of a folder holding files no server here claims", async () => {
    const leftover = path.join(root, "home", "MakeWork", "Bite", "channels");
    await fs.mkdir(leftover, { recursive: true });
    await fs.writeFile(path.join(leftover, "old.png"), "old");
    await apply([{ path: ["channels", "a.png"], hash: await stored("one") }]);
    expect((await places.readManifest(server)).folder).toBe("Bite (2)");
    await apply([{ path: ["channels", "a.png"], hash: await stored("one") }]);
    expect((await places.readManifest(server)).folder).toBe("Bite (2)");
  });

  it("that already shared one folder: the second moves its own files out and copies the common ones", async () => {
    const one = await stored("one");
    const two = await stored("two");
    await apply([{ path: ["channels", "a.png"], hash: one }]);
    // An earlier version wrote the second server into the same folder.
    const placed = path.join(tree(), "channels", "b.png");
    await fs.writeFile(placed, "two");
    await fs.rm(path.join(store(), two));
    const stat = await fs.stat(placed);
    const first = await places.readManifest(server);
    const record = (hash: string, size: number, mtimeMs: number) => ({ hash, size, mtimeMs });
    await fs.writeFile(places.manifestPath(other), JSON.stringify({ folder: "Bite", files: {
      "channels/b.png": record(two, stat.size, Math.round(stat.mtimeMs)), "channels/a.png": first.files["channels/a.png"],
    } }));
    await places.loadPlacements();
    await places.applyMirror(other, "Bite", [{ path: ["channels", "a.png"], hash: one }, { path: ["channels", "b.png"], hash: two }]);
    const second = path.join(root, "home", "MakeWork", "Bite (2)", "channels");
    expect(await read(path.join(second, "b.png"))).toBe("two");
    expect(await read(path.join(second, "a.png"))).toBe("one");
    expect(await exists(placed)).toBe(false);
    expect(await read(path.join(tree(), "channels", "a.png"))).toBe("one");
  });
});

describe("folders written by earlier versions", () => {
  it("moves content to the new layout without leaving a copy in the store", async () => {
    const hash = await stored("picture");
    const old = path.join(tree(), "art", "a.png");
    await fs.mkdir(path.dirname(old), { recursive: true });
    await fs.copyFile(path.join(store(), hash), old);
    const stat = await fs.stat(old);
    await fs.mkdir(path.join(root, "local", "mirror"), { recursive: true });
    await fs.writeFile(places.manifestPath(server), JSON.stringify({
      folder: "Bite", files: { "art/a.png": { hash, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) } },
    }));
    await places.loadPlacements();
    await apply([{ path: ["channels", "Art", "art", "a.png"], hash }]);
    expect(await read(path.join(tree(), "channels", "Art", "art", "a.png"))).toBe("picture");
    expect(await exists(old)).toBe(false);
    expect(await exists(path.join(store(), hash))).toBe(false);
  });
});

describe("changes made on disk", () => {
  const scanned = async () => {
    const changes: { kind: string; path: string[]; hash?: string; text?: string; base?: string; size?: number; mtimeMs?: number }[] = [];
    places = createPlaces({
      localDir: () => path.join(root, "local"),
      mirrorRoot: () => path.join(root, "home", "MakeWork"),
      locations: () => locations,
      contentDir: () => store(),
      sharedContentDir: store,
      allContentDirs: () => [store()],
      trashLater: async () => {},
      onChanges: (_key: string, found: typeof changes) => changes.push(...found),
    });
    return changes;
  };
  // Files written "now" count as still being written. Setting the times back also changes the change time, which can't
  // be set, so the clock moves on instead.
  const realNow = Date.now.bind(Date);
  const settle = async (file: string) => {
    const past = new Date(realNow() - 10_000);
    await fs.utimes(file, past, past);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 10_000);
  };
  afterEach(() => vi.restoreAllMocks());

  it("waits for a copy that kept its original's old modification time", async () => {
    const changes = await scanned();
    await apply([{ path: ["channels", "art", "b.txt"], hash: await stored("notes") }]);
    const file = path.join(tree(), "channels", "art", "copied.png");
    await fs.writeFile(file, "half");
    const old = new Date(realNow() - 60_000);
    await fs.utimes(file, old, old);
    await places.scan(server);
    expect(changes).toEqual([]);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 10_000);
    await places.scan(server);
    expect(changes.map((c) => c.path.join("/"))).toEqual(["channels/art/copied.png"]);
  });

  it("reports added, changed and removed files once, and takes what the data adopted", async () => {
    const changes = await scanned();
    const a = await stored("picture");
    const b = await stored("notes");
    await apply([{ path: ["channels", "art", "a.png"], hash: a }, { path: ["channels", "art", "b.txt"], hash: b }, { path: ["channels", "wiki", "P.md"], text: "# P" }]);
    const dir = path.join(tree(), "channels");
    await fs.writeFile(path.join(dir, "art", "a.png"), "painted");
    await settle(path.join(dir, "art", "a.png"));
    await fs.rm(path.join(dir, "art", "b.txt"));
    await fs.writeFile(path.join(dir, "art", "new.png"), "new");
    await settle(path.join(dir, "art", "new.png"));
    await fs.writeFile(path.join(dir, "art", "new.png~"), "backup");
    await fs.mkdir(path.join(dir, "art", ".hidden"));
    await fs.writeFile(path.join(dir, "art", ".hidden", "x"), "x");
    await places.scan(server);
    const byKind = Object.fromEntries(changes.map((c) => [c.path.join("/"), c]));
    expect(Object.keys(byKind).sort()).toEqual(["channels/art/a.png", "channels/art/b.txt", "channels/art/new.png"]);
    expect(byKind["channels/art/a.png"]).toMatchObject({ kind: "changed", base: a, hash: createHash("sha256").update("painted").digest("hex") });
    expect(byKind["channels/art/b.txt"]).toMatchObject({ kind: "removed", base: b });
    expect(byKind["channels/art/new.png"]).toMatchObject({ kind: "added" });

    changes.length = 0;
    await places.scan(server);
    expect(changes).toEqual([]);

    const changed = byKind["channels/art/a.png"];
    expect(await places.adopt(server, "channels/art/a.png", { hash: changed.hash, size: changed.size!, mtimeMs: changed.mtimeMs! })).toBe(true);
    expect(await places.findContent(changed.hash!)).toBe(path.join(dir, "art", "a.png"));
    // The data now wants the new version there: the pass leaves it.
    await apply([{ path: ["channels", "art", "a.png"], hash: changed.hash! }]);
    expect(await read(path.join(dir, "art", "a.png"))).toBe("painted");
  });

  it("moves a conflicting file to its own name when adopting it there", async () => {
    const changes = await scanned();
    const a = await stored("picture");
    await apply([{ path: ["channels", "art", "a.png"], hash: a }]);
    const file = path.join(tree(), "channels", "art", "a.png");
    await fs.writeFile(file, "mine");
    await settle(file);
    await places.scan(server);
    const [change] = changes;
    expect(await places.adopt(server, "channels/art/a.png", { hash: change.hash, size: change.size!, mtimeMs: change.mtimeMs! }, "channels/art/a (conflict).png")).toBe(true);
    expect(await read(path.join(tree(), "channels", "art", "a (conflict).png"))).toBe("mine");
  });
});
