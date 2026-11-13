import { describe, expect, it } from "vitest";
import type { SyncMark } from "../../../../src/core/content";
import type { SaveTarget } from "../../../../src/core/save";
import type { Entry } from "../../../../src/plugins/builtin/files/data";
import { saveTo, type SaveDeps } from "../../../../src/plugins/builtin/files/save";

let nextId = 1;
const entry = (kind: Entry["kind"], name: string, parentId: number | null, size = 10): Entry => ({
  id: nextId++, parentId, kind, name, mime: "", size, url: kind === "file" ? `mwc:${name}-hash` : null,
  thumb: null, width: null, height: null, authorId: 1, createdAt: "",
});

// photos/ { a.jpg, 2024/ { b.json }, empty/ }
function tree() {
  const photos = entry("folder", "photos", null);
  const y2024 = entry("folder", "2024", photos.id);
  const empty = entry("folder", "empty", photos.id);
  const a = entry("file", "a.jpg", photos.id, 100);
  const b = entry("file", "b.json", y2024.id, 50);
  const all = [photos, y2024, empty, a, b];
  return { photos, a, b, list: async (folderId: number) => all.filter((e) => e.parentId === folderId) };
}

// A target folder that already has a "photos".
function target(fail?: string) {
  const folders: string[][] = [];
  const writes: string[] = [];
  const t: SaveTarget = {
    where: "/target",
    async folder(segments, free) {
      const named = free && segments.at(-1) === "photos" ? [...segments.slice(0, -1), "photos (2)"] : segments;
      folders.push(named);
      return named;
    },
    async write(segments, hash) {
      if (segments.at(-1) === fail) throw new Error("disk full");
      writes.push(`${segments.join("/")} <- ${hash}`);
    },
    done: () => {},
  };
  return { t, folders, writes };
}

function deps(list: SaveDeps["list"]) {
  const unmarked: SyncMark[] = [];
  const d: SaveDeps = { list, ensureLocal: async () => true, unmark: (mark) => unmarked.push(mark) };
  return { d, unmarked };
}

describe("saving to the computer", () => {
  it("writes a folder with its subfolders, empty ones too, under a free name", async () => {
    const { photos, list } = tree();
    const { t, folders, writes } = target();
    const { d, unmarked } = deps(list);
    const progress: [number, string | null][] = [];
    await saveTo(t, photos, "copy", d, (p) => progress.push([p.bytes / p.totalBytes, p.currentUrl]));
    expect(folders).toEqual([["photos (2)"], ["photos (2)", "2024"], ["photos (2)", "empty"]]);
    expect(writes).toEqual(["photos (2)/2024/b.json <- b.json-hash", "photos (2)/a.jpg <- a.jpg-hash"]);
    // Each file is named while it downloads and is written, so the bar can follow its download.
    expect(progress).toEqual([[0, null], [0, "mwc:b.json-hash"], [50 / 150, null], [50 / 150, "mwc:a.jpg-hash"], [1, null]]);
    expect(unmarked).toEqual([]);
  });

  it("names the file being saved with its size until it is written", async () => {
    const { a, list } = tree();
    const seen: { currentUrl: string | null; currentSize: number; written: number }[] = [];
    const { t, writes } = target();
    await saveTo(t, a, "copy", deps(list).d, (p) => seen.push({ currentUrl: p.currentUrl, currentSize: p.currentSize, written: writes.length }));
    expect(seen).toEqual([
      { currentUrl: null, currentSize: 0, written: 0 },
      { currentUrl: "mwc:a.jpg-hash", currentSize: 100, written: 0 },
      { currentUrl: null, currentSize: 0, written: 1 },
    ]);
  });

  it("a cancel during a download ends the save at once as cancelled, writing nothing", async () => {
    const { a, list } = tree();
    const { t, writes } = target();
    const controller = new AbortController();
    // A download that only ends when the save is cancelled (what core/content.ts ensureLocal does with the signal),
    // cancelled while it waits.
    const waiting: SaveDeps = {
      ...deps(list).d,
      ensureLocal: (_file, signal) => new Promise((resolve) => {
        signal?.addEventListener("abort", () => resolve(false));
        setTimeout(() => controller.abort());
      }),
    };
    const saving = saveTo(t, a, "copy", waiting, () => {}, controller.signal);
    await expect(saving).rejects.toMatchObject({ name: "AbortError" });
    expect(writes).toEqual([]);
  });

  it("leaves files sent without their content out of the total, so the bar fills", async () => {
    const { photos, list } = tree();
    const bare = { ...entry("file", "bare.txt", photos.id, 1000), url: null };
    const withBare = async (folderId: number) => [...(await list(folderId)), ...(bare.parentId === folderId ? [bare] : [])];
    const { t, writes } = target();
    let last = { bytes: -1, totalBytes: -1 };
    await saveTo(t, photos, "copy", deps(withBare).d, (p) => (last = p));
    expect(writes).not.toContainEqual(expect.stringContaining("bare.txt"));
    expect(last).toMatchObject({ bytes: 150, totalBytes: 150 });
  });

  it("a move lets go of the folder and its files once everything is written", async () => {
    const { photos, a, b, list } = tree();
    const { d, unmarked } = deps(list);
    await saveTo(target().t, photos, "move", d, () => {});
    expect(unmarked).toEqual([{ kind: "folder", id: photos.id }, { kind: "file", id: b.id }, { kind: "file", id: a.id }]);
  });

  it("a failed move keeps everything", async () => {
    const { photos, list } = tree();
    const { d, unmarked } = deps(list);
    await expect(saveTo(target("a.jpg").t, photos, "move", d, () => {})).rejects.toThrow("disk full");
    expect(unmarked).toEqual([]);
  });

  it("saves a single file as itself", async () => {
    const { a, list } = tree();
    const { t, folders, writes } = target();
    const { d, unmarked } = deps(list);
    await saveTo(t, a, "move", d, () => {});
    expect(folders).toEqual([]);
    expect(writes).toEqual(["a.jpg <- a.jpg-hash"]);
    expect(unmarked).toEqual([{ kind: "file", id: a.id }]);
  });
});
