import { describe, expect, it } from "vitest";
import { diskEntries, type DiskSource } from "../../../../src/p2p/diskView";
import { codeDisk } from "../../../../src/plugins/builtin/code/disk";

const hash = "a".repeat(64);
const row = (values: Record<string, unknown>) => ({ channel_id: 7, parent_id: null, deleted: false, hash: null, size: 0, ...values });

describe("code disk layout", () => {
  it("lists files with and without content", async () => {
    const rows = [row({ id: 1, kind: "folder", name: "src" }), row({ id: 2, kind: "file", name: "empty.txt", parent_id: 1 }),
      row({ id: 3, kind: "file", name: "Test.cs", hash: `mwc:${hash}`, size: 5 })];
    const source: DiskSource = {
      categories: [{ id: 1, name: "General", position: 0 }], channels: [{ id: 7, name: "code", type: "code", categoryId: 1, position: 0 }],
      layoutFor: (type: string) => (type === "code" ? codeDisk : undefined), rows: (_plugin: string, table: string) => (table === "code_files" ? rows : []),
      kept: (value: string) => value === hash, fileExtension: () => "",
    } as unknown as DiskSource;
    const entries = await diskEntries(source);
    expect(entries.map((entry) => entry.path.slice(-2).join("/")).sort()).toEqual(["code/Test.cs", "src/empty.txt"]);
  });
});
