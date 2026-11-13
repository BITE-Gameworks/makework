import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../src/api/client";
import { findEntries } from "../../src/agents/library";
import { allSkills } from "../../src/agents/skills";
import { MockTransport } from "../../src/mock/transport";
import type { BotContext, LibraryEntry } from "../../src/plugins/types";
import { MockBackend } from "../../src/system/backend";
import { docs } from "../../src/system/docs";
import { installAgentSource } from "./source";

installAgentSource();

const env = { server: { baseUrl: "http://localhost" }, imageSide: 512 };

afterEach(() => vi.unstubAllGlobals());

describe("decision and scratchpad notes", () => {
  it("appends dated lines to a page of the docs channel with that exact name", async () => {
    const backend = new MockBackend({ userId: 7 });
    backend.load(docs);
    const api = new ApiClient(new MockTransport(backend));
    const channelList = [{ id: 1, name: "decisions", type: "docs", category: "Team" }];
    const context = {
      workspaceId: "w", bot: { id: 1, nickname: "Bot" }, mark: () => {}, marks: () => [], member: () => ({ displayName: "x" }), cursor: async () => {},
      channels: async () => channelList, granted: () => true,
      read: async (plugin: string, table: string, where?: Record<string, never>) => api.plugin(plugin).read(table, where),
      write: (plugin: string) => api.plugin(plugin),
    } as unknown as BotContext;
    const run = (name: string, args: Record<string, string>) => allSkills().find((s) => s.name === name)!.run(context, args, env);
    await run("record_decision", { decision: "Ship on Friday" });
    await run("record_decision", { decision: "Use blue" });
    const [page] = await api.plugin("docs").read("docs_pages", { channel_id: 1 });
    expect(String(page.body)).toMatch(/^\d{4}-\d\d-\d\d - Ship on Friday\n\n\d{4}-\d\d-\d\d - Use blue$/);
    await expect(run("scratchpad", { note: "x" })).rejects.toThrow(/no bot scratchpad/);
    channelList.push({ id: 2, name: "notes", type: "docs", category: "Bot scratchpad" });
    await run("scratchpad", { note: "halfway" });
    const [pad] = await api.plugin("docs").read("docs_pages", { channel_id: 2 });
    expect(String(pad.body)).toMatch(/- Bot: halfway$/);
  });
});

describe("findEntries with an embedding server", () => {
  const entry = (ref: string, title: string, summary: string): LibraryEntry => ({ channelId: 1, kind: "page", ref, title, summary, tags: [], sourceHash: "" });
  it("ranks by meaning when no word matches, and falls back to keywords when the server fails", async () => {
    const vectors: Record<string, number[]> = { "when do we release": [1, 0], "Roadmap. Ship date is in spring": [0.9, 0.1], "Lunch. Pizza on fridays": [0, 1] };
    vi.stubGlobal("fetch", vi.fn(async (_: string, init: { body: string }) => {
      const { input } = JSON.parse(init.body) as { input: string[] };
      return { ok: true, json: async () => ({ data: input.map((t, index) => ({ index, embedding: vectors[t.trim()] ?? [0.5, 0.5] })) }) };
    }));
    const context = { bot: { config: { embedServer: "http://e" } }, secret: async () => null } as unknown as BotContext;
    const entries = [entry("a", "Roadmap", "Ship date is in spring"), entry("b", "Lunch", "Pizza on fridays")];
    expect((await findEntries(context, entries, "when do we release")).map((e) => e.ref)).toEqual(["a"]);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    expect((await findEntries(context, [entry("c", "Pizza", "friday")], "pizza")).map((e) => e.ref)).toEqual(["c"]);
  });
});
