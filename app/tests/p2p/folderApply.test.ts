// Changes made on disk, applied by the files and docs disk layouts through the real plugins.
import { describe, expect, it } from "vitest";
import { ApiClient } from "../../src/api/client";
import { MockTransport } from "../../src/mock/transport";
import { diskChannels, livingRows, sha256Text } from "../../src/p2p/diskView";
import { docsDisk } from "../../src/plugins/builtin/docs/disk";
import { filesDisk } from "../../src/plugins/builtin/files/disk";
import type { DiskApplyContext, DiskChange, DiskLayout } from "../../src/plugins/types";
import { MockBackend } from "../../src/system/backend";
import { docs } from "../../src/system/docs";
import { files } from "../../src/system/files";

const h = (n: number) => n.toString(16).padStart(64, "0");

function setup(type: string, layout: DiskLayout, exportFile?: (url: string, format: string) => Promise<{ name: string; blob: Blob } | null>) {
  const backend = new MockBackend();
  backend.load(files);
  backend.load(docs);
  const client = new ApiClient(new MockTransport(backend, 0));
  const adopted: { path: string; moveTo?: string; text?: boolean }[] = [];
  const problems: string[] = [];
  // Whether adopting works: it doesn't when the file changed on disk after it was reported.
  const state = { adoptOk: true };
  const view = async () => {
    const [found] = diskChannels({
      categories: [], channels: [{ id: 1, name: "chan", type, categoryId: 0, position: 0 }], layoutFor: () => layout,
      rows: (plugin, table) => backend.data(plugin).select(table), kept: () => true, fileExtension: () => "",
      exportFile,
    });
    await found.layout.entries(found.context);
    const context: DiskApplyContext = {
      ...found.context,
      api: (plugin) => client.plugin(plugin),
      adopt: async (change, moveTo, text) => {
        adopted.push({ path: change.path.join("/"), moveTo: moveTo?.join("/"), text });
        return state.adoptOk;
      },
      imageInfo: async () => ({ thumb: null, width: null, height: null }),
      problem: (_change, message) => problems.push(message),
    };
    return { layout: found.layout, context };
  };
  const apply = async (changes: DiskChange[]) => {
    const { layout, context } = await view();
    await layout.apply!(changes, context);
  };
  const rows = (plugin: string, table: string) => livingRows(backend.data(plugin).select(table));
  return { client, view, apply, rows, adopted, problems, state };
}

describe("files changed on disk", () => {
  it("adds new files with their folders, takes new versions, and keeps both when both sides changed", async () => {
    const t = setup("files", filesDisk);
    const api = t.client.plugin("files");
    const { id } = await api.call<{ id: number }>("add-file", { channel_id: 1, name: "a.png", mime: "image/png", size: 1, url: `mwc:${h(1)}` });
    await t.apply([
      { kind: "added", path: ["new", "deep", "b.txt"], hash: h(2), size: 5, mtimeMs: 1 },
      { kind: "changed", path: ["a.png"], hash: h(3), base: h(1), size: 7, mtimeMs: 1 },
    ]);
    const all = t.rows("files", "files_entries");
    expect(all.map((e) => e.name).sort()).toEqual(["a.png", "b.txt", "deep", "new"]);
    expect(all.find((e) => e.id === id)?.url).toBe(`mwc:${h(3)}`);

    // Someone else's version arrived meanwhile: the one from disk becomes "a (conflict).png".
    await api.call("set-content", { entry_id: id, mime: "image/png", size: 2, url: `mwc:${h(4)}` });
    await t.apply([{ kind: "changed", path: ["a.png"], hash: h(5), base: h(3), size: 7, mtimeMs: 2 }]);
    const after = t.rows("files", "files_entries");
    expect(after.find((e) => e.id === id)?.url).toBe(`mwc:${h(4)}`);
    expect(after.find((e) => e.name === "a (conflict).png")?.url).toBe(`mwc:${h(5)}`);
    expect(t.adopted.at(-1)).toEqual({ path: "a.png", moveTo: "a (conflict).png", text: undefined });
    expect(t.problems).toEqual([]);
  });

  it("takes a file reported again before it could be adopted as the same file, not a conflict", async () => {
    const t = setup("files", filesDisk);
    t.state.adoptOk = false;
    await t.apply([{ kind: "added", path: ["big.zip"], hash: h(7), size: 100, mtimeMs: 1 }]);
    t.state.adoptOk = true;
    await t.apply([{ kind: "added", path: ["big.zip"], hash: h(8), size: 100, mtimeMs: 2 }]);
    const all = t.rows("files", "files_entries");
    expect(all.map((e) => e.name)).toEqual(["big.zip"]);
    expect(all[0].url).toBe(`mwc:${h(8)}`);
    expect(t.adopted.at(-1)).toEqual({ path: "big.zip", moveTo: undefined, text: undefined });
  });

  it("moves and renames files moved on disk, and removes a folder whose files were all deleted", async () => {
    const t = setup("files", filesDisk);
    const api = t.client.plugin("files");
    const { id: folder } = await api.call<{ id: number }>("add-folder", { channel_id: 1, name: "old" });
    const { id: file } = await api.call<{ id: number }>("add-file", { channel_id: 1, parent_id: folder, name: "a.png", mime: "image/png", size: 1, url: `mwc:${h(1)}` });
    await api.call("add-file", { channel_id: 1, parent_id: folder, name: "b.png", mime: "image/png", size: 1, url: `mwc:${h(2)}` });
    await t.apply([{ kind: "moved", from: ["old", "a.png"], path: ["new", "renamed.png"], hash: h(1), base: h(1), size: 1, mtimeMs: 1 }]);
    const moved = t.rows("files", "files_entries").find((e) => e.id === file)!;
    expect(moved.name).toBe("renamed.png");
    expect(t.rows("files", "files_entries").find((e) => e.id === Number(moved.parent_id))?.name).toBe("new");

    const { layout, context } = await t.view();
    const removal = (await layout.removal!([{ kind: "removed", path: ["old", "b.png"], base: h(2) }], context))!;
    expect(removal.what).toBe("1 file was");
    await removal.remove();
    expect(t.rows("files", "files_entries").map((e) => e.name).sort()).toEqual(["new", "renamed.png"]);
  });
});

describe("docs changed on disk", () => {
  it("merges an edited page, adds new pages under their folder's page, and renames moved ones", async () => {
    const t = setup("docs", docsDisk);
    const api = t.client.plugin("docs");
    const { id } = await api.call<{ id: number }>("add-page", { channel_id: 1, title: "Guide", body: "Hello" });
    const written = "Hello";
    await t.apply([
      { kind: "changed", path: ["Guide.md"], text: "Hello there", base: `text:${await sha256Text(written)}`, size: 1, mtimeMs: 1 },
      { kind: "added", path: ["Guide", "Sub.md"], text: "Sub text", size: 1, mtimeMs: 1 },
      { kind: "added", path: ["Notes", "Todo.md"], text: "- one", size: 1, mtimeMs: 1 },
    ]);
    const pages = t.rows("docs", "docs_pages");
    expect(pages.find((p) => p.id === id)?.body).toBe("Hello there");
    expect(pages.find((p) => p.title === "Sub")?.parent_id).toBe(id);
    const notes = pages.find((p) => p.title === "Notes")!;
    expect(pages.find((p) => p.title === "Todo")?.parent_id).toBe(notes.id);

    await t.apply([{ kind: "moved", from: ["Guide.md"], path: ["Manual.md"], text: "Hello there", size: 1, mtimeMs: 2 }]);
    expect(t.rows("docs", "docs_pages").find((p) => p.id === id)?.title).toBe("Manual");
    expect(t.problems).toEqual([]);
  });

  it("keeps a page edited on disk and in the app as a page of its own", async () => {
    const t = setup("docs", docsDisk);
    const api = t.client.plugin("docs");
    const { id } = await api.call<{ id: number }>("add-page", { channel_id: 1, title: "Guide", body: "Hello" });
    await api.call("update-page", { page_id: id, body: "Hello from the app" });
    await t.apply([{ kind: "changed", path: ["Guide.md"], text: "Hello from disk", base: `text:${await sha256Text("Hello")}`, size: 1, mtimeMs: 1 }]);
    const pages = t.rows("docs", "docs_pages");
    expect(pages.find((p) => p.id === id)?.body).toBe("Hello from the app");
    expect(pages.find((p) => p.title === "Guide (conflict)")?.body).toBe("Hello from disk");
    expect(t.adopted.at(-1)).toEqual({ path: "Guide.md", moveTo: "Guide (conflict).md", text: true });
  });

  it("turns a local SVG export path back into its live Markdown embed on edits", async () => {
    const url = "makework://work/5/export/7";
    const t = setup("docs", docsDisk, async () => ({ name: "star", blob: new Blob(["<svg/>"], { type: "image/svg+xml" }) }));
    const api = t.client.plugin("docs");
    const { id } = await api.call<{ id: number }>("add-page", { channel_id: 1, title: "Guide", body: `![Star](${url})` });
    const { layout, context } = await t.view();
    const written = (await layout.entries(context)).find((entry) => entry.path.join("/") === "Guide.md") as { text: string };
    expect(written.text).toBe("![Star](_assets/star.svg)");
    await layout.apply!([{
      kind: "changed", path: ["Guide.md"], base: `text:${await sha256Text(written.text)}`,
      text: "![A better star](_assets/star.svg)",
    }], context);
    const [page] = await api.read("docs_pages", { id });
    expect(page.body).toBe(`![A better star](${url})`);
  });
});
