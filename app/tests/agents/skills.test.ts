import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { ApiClient } from "../../src/api/client";
import { allSkills } from "../../src/agents/skills";
import { fromBase64 } from "../../src/core/liveText";
import { MockTransport } from "../../src/mock/transport";
import type { BotContext } from "../../src/plugins/types";
import { MockBackend } from "../../src/system/backend";
import { code } from "../../src/system/code";
import { design } from "../../src/system/design";
import { installAgentSource } from "./source";

installAgentSource();

const env = { server: { baseUrl: "http://localhost" }, imageSide: 512 };

function setup() {
  const backend = new MockBackend({ userId: 7 });
  backend.load(code);
  backend.load(design);
  const api = new ApiClient(new MockTransport(backend));
  const context = {
    channels: async () => [{ id: 1, name: "code", type: "code" }, { id: 2, name: "refs", type: "design" }],
    read: async (plugin: string, table: string, where?: Record<string, never>) => api.plugin(plugin).read(table, where),
    write: (plugin: string) => api.plugin(plugin),
    cursor: async () => {},
    workspaceId: "w1", bot: { id: 9, nickname: "Bot" }, mark: () => {}, marks: () => [], member: () => ({ displayName: "x" }),
  } as unknown as BotContext;
  const skill = (name: string) => allSkills().find((s) => s.name === name)!;
  return { api, context, skill };
}

describe("agent skills", () => {
  it("writes, replaces and reads a code file, creating folders", async () => {
    const { api, context, skill } = setup();
    expect(await skill("code_write_file").run(context, { channel: "#code", path: "src/squares.py", content: "print(1)\n" }, env)).toMatch(/Created/);
    expect(await skill("code_write_file").run(context, { channel: "code", path: "src/squares.py", content: "print(2)\n" }, env)).toMatch(/Replaced/);
    expect(await skill("code_read_file").run(context, { channel: "code", path: "src/squares.py" }, env)).toBe("print(2)\n");
    expect(await skill("code_list_files").run(context, { channel: "code" }, env)).toBe("src/squares.py");
    const files = await api.plugin("code").read("code_files", { channel_id: 1 });
    const file = files.find((f) => f.kind === "file")!;
    const doc = new Y.Doc();
    for (const row of await api.plugin("code").read("code_updates", { file_id: file.id })) Y.applyUpdate(doc, fromBase64(String(row.data)));
    expect(doc.getText("body").toString()).toBe("print(2)\n");
    await expect(skill("code_write_file").run(context, { channel: "refs", path: "a.py", content: "" }, env)).rejects.toThrow(/not a code channel/);
  });

  it("arranges a design's pictures in a grid without overlap", async () => {
    const { api, context, skill } = setup();
    const nodes = ["a", "b", "c", "d"].map((name) => ({ kind: "image", name, x: 0, y: 0, width: 100, height: 50, url: "mwc:x", props: "{}" }));
    await api.plugin("design").call("add-nodes", { channel_id: 2, nodes: JSON.stringify(nodes) });
    expect(await skill("design_arrange").run(context, { channel: "refs", layers: "", layout: "grid" }, env)).toMatch(/4 layers/);
    const rows = await api.plugin("design").read("design_nodes", { channel_id: 2 });
    expect(new Set(rows.map((r) => `${r.x},${r.y}`)).size).toBe(4);
    await expect(skill("design_arrange").run(context, { channel: "refs", layers: "", layout: "spiral" }, env)).rejects.toThrow(/layout/);
  });

  it("adds a sticky note as a group of paper and text", async () => {
    const { api, context, skill } = setup();
    await skill("design_add_note").run(context, { channel: "refs", text: "Pick the blue one", x: 10, y: 20, color: "" }, env);
    const rows = await api.plugin("design").read("design_nodes", { channel_id: 2 });
    const group = rows.find((r) => r.kind === "group")!;
    expect(group).toMatchObject({ x: 10, y: 20 });
    expect(rows.filter((r) => r.parent_id === group.id).map((r) => r.kind).sort()).toEqual(["rect", "text"]);
  });
});
