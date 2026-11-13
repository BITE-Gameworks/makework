import { describe, expect, it } from "vitest";
import { ApiClient } from "../../src/api/client";
import { allSkills } from "../../src/agents/skills";
import { releaseAll } from "../../src/agents/locks";
import { MockTransport } from "../../src/mock/transport";
import type { BotContext } from "../../src/plugins/types";
import { MockBackend } from "../../src/system/backend";
import { design } from "../../src/system/design";
import { installAgentSource } from "./source";

installAgentSource();

const env = { server: { baseUrl: "http://localhost" }, imageSide: 512 };

describe("design change skills", () => {
  it("moves, colors and aligns layers by name and refuses a layer another bot holds", async () => {
    const backend = new MockBackend({ userId: 7 });
    backend.load(design);
    const api = new ApiClient(new MockTransport(backend));
    const make = (id: number) => ({
      workspaceId: "w1", bot: { id, nickname: `Bot ${id}` }, mark: () => {}, marks: () => [], member: () => ({ displayName: "x" }),
      channels: async () => [{ id: 1, name: "logo", type: "design" }], granted: () => true, cursor: async () => {},
      read: async (plugin: string, table: string, where?: Record<string, never>) => api.plugin(plugin).read(table, where),
      write: (plugin: string) => api.plugin(plugin),
    }) as unknown as BotContext;
    const one = make(1);
    const two = make(2);
    const run = (context: BotContext, name: string, args: Record<string, string | number>) => allSkills().find((s) => s.name === name)!.run(context, args, env);
    await run(one, "design_add", { channel: "logo", kind: "rect", name: "A", x: 0, y: 0, width: 100, height: 50, color: "#ff0000" });
    await run(one, "design_add", { channel: "logo", kind: "rect", name: "B", x: 300, y: 200, width: 40, height: 20, color: "#00ff00" });
    await run(one, "design_move", { channel: "logo", layer: "A", x: 10, y: 20 });
    await expect(run(two, "design_move", { channel: "logo", layer: "A", x: 0, y: 0 })).rejects.toThrow(/being changed by Bot 1/);
    await run(one, "design_align", { channel: "logo", layers: "A, B", edge: "left" });
    await run(one, "design_set_color", { channel: "logo", layer: "B", color: "#0000ff" });
    releaseAll(one);
    const nodes = await api.plugin("design").call<{ rows: Record<string, unknown>[] }>("list-nodes", { channel_id: 1 });
    const b = nodes.rows.find((r) => r.name === "B")!;
    expect(b.x).toBe(10);
    expect(String(b.props)).toContain("#0000ff");
    await expect(run(one, "design_set_color", { channel: "logo", layer: "A", color: "not-a-color" })).rejects.toThrow(/not a color/);
  });

  it("draws paths with the pen and regular shapes", async () => {
    const backend = new MockBackend({ userId: 7 });
    backend.load(design);
    const api = new ApiClient(new MockTransport(backend));
    const context = {
      workspaceId: "w2", bot: { id: 5, nickname: "Bot" }, mark: () => {}, marks: () => [], member: () => ({ displayName: "x" }),
      channels: async () => [{ id: 1, name: "logo", type: "design" }], granted: () => true, cursor: async () => {},
      read: async (plugin: string, table: string, where?: Record<string, never>) => api.plugin(plugin).read(table, where),
      write: (plugin: string) => api.plugin(plugin),
    } as unknown as BotContext;
    const run = (name: string, args: Record<string, string | number>) => allSkills().find((s) => s.name === name)!.run(context, args, env);
    await run("design_draw_path", { channel: "logo", name: "Roof", points: "100,200 200,100 300,200", closed: 1, smooth: 0, line_color: "#000000", fill_color: "#aa3300", line_width: 3 });
    await run("design_draw_polygon", { channel: "logo", name: "Sun", x: 500, y: 100, radius: 40, sides: 5, star: 1, line_color: "none", fill_color: "#ffcc00" });
    await expect(run("design_draw_path", { channel: "logo", name: "Bad", points: "5,5", closed: 0, smooth: 0, line_color: "#000000", fill_color: "none", line_width: 1 })).rejects.toThrow(/at least two points/);
    const { rows } = await api.plugin("design").call<{ rows: Record<string, unknown>[] }>("list-nodes", { channel_id: 1 });
    const roof = rows.find((r) => r.name === "Roof")!;
    expect(roof).toMatchObject({ kind: "path", x: 100, y: 100, width: 200, height: 100 });
    expect(String(roof.props)).toContain("#aa3300");
    const sun = rows.find((r) => r.name === "Sun")!;
    expect(JSON.parse(String(sun.props)).vector.paths[0].points).toHaveLength(10);
  });

  it("groups layers, marks the group for export and returns an embed for the answer", async () => {
    const backend = new MockBackend({ userId: 7 });
    backend.load(design);
    const api = new ApiClient(new MockTransport(backend));
    const context = {
      workspaceId: "w3", bot: { id: 6, nickname: "Bot" }, mark: () => {}, marks: () => [], member: () => ({ displayName: "x" }),
      channels: async () => [{ id: 1, name: "logo", type: "design" }], granted: () => true, cursor: async () => {},
      read: async (plugin: string, table: string, where?: Record<string, never>) => api.plugin(plugin).read(table, where),
      write: (plugin: string) => api.plugin(plugin),
    } as unknown as BotContext;
    const run = (name: string, args: Record<string, string | number>) => allSkills().find((s) => s.name === name)!.run(context, args, env);
    await run("design_add", { channel: "logo", kind: "rect", name: "Body", x: 100, y: 100, width: 50, height: 80, color: "#ffffff" });
    await run("design_add", { channel: "logo", kind: "ellipse", name: "Lamp", x: 90, y: 60, width: 70, height: 40, color: "#ffcc00" });
    expect(await run("design_group", { channel: "logo", layers: "Body, Lamp", name: "Lighthouse", kind: "group" })).toMatch(/Grouped 2 layers as group "Lighthouse"/);
    const shown = await run("design_show_in_chat", { channel: "logo", layer: "Lighthouse" });
    expect(shown).toMatchObject({ embeds: [expect.stringMatching(/^!\[Lighthouse\]\(makework:\/\/w\d\/1\/export\/\d+\)$/)] });
    const { rows } = await api.plugin("design").call<{ rows: Record<string, unknown>[] }>("list-nodes", { channel_id: 1 });
    const group = rows.find((r) => r.name === "Lighthouse")!;
    expect(group).toMatchObject({ kind: "group", x: 90, y: 60, width: 70, height: 120 });
    expect(JSON.parse(String(group.props)).exports).toHaveLength(1);
    expect(rows.find((r) => r.name === "Body")).toMatchObject({ parent_id: group.id, x: 10, y: 40 });
  });

  it("draws a whole scene from lines, skips bad lines, and replaces shapes drawn again by name", async () => {
    const backend = new MockBackend({ userId: 7 });
    backend.load(design);
    const api = new ApiClient(new MockTransport(backend));
    const context = {
      workspaceId: "w4", bot: { id: 8, nickname: "Bot" }, mark: () => {}, marks: () => [], member: () => ({ displayName: "x" }),
      channels: async () => [{ id: 1, name: "logo", type: "design" }], granted: () => true, cursor: async () => {},
      read: async (plugin: string, table: string, where?: Record<string, never>) => api.plugin(plugin).read(table, where),
      write: (plugin: string) => api.plugin(plugin),
    } as unknown as BotContext;
    const run = (name: string, args: Record<string, string | number>) => allSkills().find((s) => s.name === name)!.run(context, args, env);
    const first = await run("design_draw_scene", { channel: "logo", shapes: [
      "trapezoid|tower|100|100|80|200|white|-|15", "triangle|roof|90|60|100|50|dark-gray|-", "ellipse|lamp|120|80|40|20|yellow|-",
      "rect|sea|0|300|300|60|blue", "polygon|bad|1,1|red|-", "dance|x",
    ].join("\n") });
    expect(first).toMatch(/Drew 4 new shapes/);
    expect(first).toMatch(/Skipped.*line 5 \(polygon\).*line 6 \(dance\)/);
    const second = await run("design_draw_scene", { channel: "logo", shapes: "triangle|roof|90|50|100|60|navy|-\nrect|door|130|250|20|50|brown|-|2" });
    expect(second).toMatch(/Drew 1 new shapes and replaced 1/);
    const { rows } = await api.plugin("design").call<{ rows: Record<string, unknown>[] }>("list-nodes", { channel_id: 1 });
    expect(rows.map((r) => r.name).sort()).toEqual(["door", "lamp", "roof", "sea", "tower"]);
    expect(rows.find((r) => r.name === "roof")).toMatchObject({ y: 50, height: 60 });
    expect(String(rows.find((r) => r.name === "roof")!.props)).toContain("#1b2a4a");
    expect(await run("design_delete", { channel: "logo", layers: "door, sea" })).toMatch(/Deleted 2 layers/);
  });
});
