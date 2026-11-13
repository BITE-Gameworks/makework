// A code channel's files reach the readable folder through a full content pass.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContentLink } from "../../src/p2p/content";
import type { WorkspaceSync } from "../../src/p2p/sync";
import { MockBackend } from "../../src/system/backend";
import { code } from "../../src/system/code";
import { codeDisk } from "../../src/plugins/builtin/code/disk";

vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
const hash = "b".repeat(64);
const mocks = vi.hoisted(() => ({
  apply: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock("../../src/core/desktop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/desktop")>();
  return { ...actual, desktop: { mirror: { apply: mocks.apply, onChanges: () => () => {} } } };
});
vi.mock("../../src/core/content", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/content")>();
  return { ...actual, hasContent: async () => true, contentBlob: async () => new Blob(["hello"]) };
});
vi.mock("../../src/plugins/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/plugins/registry")>();
  return { ...actual, diskLayoutFor: (type: string) => (type === "code" ? codeDisk : undefined) };
});
vi.mock("../../src/core/workspaces", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/workspaces")>();
  return { ...actual, workspaces: { byId: { s: { status: "ready", info: { name: "S" }, categories: [{ id: 1, name: "General", position: 0 }],
    channels: [{ id: 7, name: "code", type: "code", categoryId: 1, position: 0 }] } } } };
});

describe("code channel in the readable folder", () => {
  afterEach(() => vi.clearAllMocks());
  it("writes empty and saved files", async () => {
    const backend = new MockBackend({ userId: 1 });
    backend.load(code);
    const sync = { room: null, onPeers: () => () => {} } as unknown as WorkspaceSync;
    const link = new ContentLink("s", backend, sync, 1, "test-code-mirror");
    const data = backend.data("code");
    data.insert("code_files", { channel_id: 7, parent_id: null, kind: "file", name: "empty.txt", hash: null, size: 0, language: null, author_id: 1, deleted: false });
    data.insert("code_files", { channel_id: 7, parent_id: null, kind: "file", name: "Test.cs", hash: `mwc:${hash}`, size: 5, language: null, author_id: 1, deleted: false });
    expect([...link.wanted()]).toEqual([hash]);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const calls = mocks.apply.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const entries = calls.at(-1)![2] as { path: string[] }[];
    expect(entries.map((e) => e.path.at(-1)).sort()).toEqual(["Test.cs", "empty.txt"]);
    link.close();
  });
});
