import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../src/api/client";
import { findChannel } from "../../src/agents/skillKit";
import { allSkills } from "../../src/agents/skills";
import { MockTransport } from "../../src/mock/transport";
import type { BotContext } from "../../src/plugins/types";
import { MockBackend } from "../../src/system/backend";
import { channels as channelsPlugin } from "../../src/system/channels";
import { code } from "../../src/system/code";
import { docs } from "../../src/system/docs";
import { files } from "../../src/system/files";
import { sheets } from "../../src/system/sheets";
import { tasks } from "../../src/system/tasks";
import { installAgentSource } from "./source";

installAgentSource();

vi.mock("../../src/core/files", () => ({
  prepareUpload: async (file: File) => ({ file, url: `mwc:${"a".repeat(64)}`, existed: false }),
}));

const env = { server: { baseUrl: "http://localhost" }, imageSide: 512 };
const channelList = [
  { id: 1, name: "files", type: "files" }, { id: 2, name: "code", type: "code" }, { id: 3, name: "notes", type: "docs" },
  { id: 4, name: "board", type: "tasks" }, { id: 5, name: "numbers", type: "sheets" },
];

function setup() {
  const backend = new MockBackend({ userId: 7 });
  for (const plugin of [files, code, docs, tasks, sheets]) backend.load(plugin);
  const api = new ApiClient(new MockTransport(backend));
  const context = {
    workspaceId: "w", bot: { id: 1, nickname: "Bot" }, mark: () => {}, marks: () => [], channels: async () => channelList, granted: () => true, cursor: async () => {},
    read: async (plugin: string, table: string, where?: Record<string, never>) => api.plugin(plugin).read(table, where),
    write: (plugin: string) => api.plugin(plugin),
    messages: async () => [], member: () => ({ displayName: "x" }),
  } as unknown as BotContext;
  const run = (name: string, args: Record<string, string | number>) => allSkills().find((s) => s.name === name)!.run(context, args, env);
  return { api, context, run };
}

describe("agent skills across channel types", () => {
  it("sends a text file to a files channel, and says so when a name points at the wrong kind of channel", async () => {
    const { api, run, context } = setup();
    expect(await run("files_write_text", { channel: "files", path: "notes/todo.txt", content: "buy milk" })).toMatch(/Created notes\/todo.txt/);
    expect(await run("files_list", { channel: "files" })).toBe("notes/\nnotes/todo.txt");
    expect((await api.plugin("files").read("files_entries")).find((e) => e.name === "todo.txt")).toMatchObject({ mime: "text/plain", size: 8 });
    await expect(run("files_write_text", { channel: "code", path: "a.txt", content: "x" })).rejects.toThrow(/#code is a code channel, not a files channel/);
    // An unknown name with a single files channel means that one.
    expect(await run("files_write_text", { channel: "the files channel", path: "b.txt", content: "y" })).toMatch(/in #files/);
    await expect(findChannel(context, "nope", "chat")).rejects.toThrow(/No chat channel/);
    // A specific name that isn't there is never taken to mean the only channel of the type.
    await expect(run("files_write_text", { channel: "secret-files", path: "c.txt", content: "z" })).rejects.toThrow(/No files channel named 'secret-files'/);
    expect((await findChannel(context, "", "files")).name).toBe("files");
    expect((await findChannel(context, "file", "files")).name).toBe("files");
  });

  it("writes docs pages, tasks and sheet cells, then finds them by search", async () => {
    const { run } = setup();
    await run("docs_write", { channel: "notes", title: "Launch plan", text: "Ship the zebra feature on Friday." });
    await run("docs_write", { channel: "notes", title: "Launch plan", text: "Ship the giraffe feature on Monday." });
    expect(await run("docs_read", { channel: "notes", title: "launch" })).toBe("Ship the giraffe feature on Monday.");
    await run("tasks_add", { channel: "board", title: "Buy giraffe food", notes: "hay", column: "" });
    await run("sheets_set", { channel: "numbers", sheet: "", cell: "B2", value: "42" });
    await run("sheets_set", { channel: "numbers", sheet: "", cell: "B3", value: "=B2*2" });
    expect(await run("sheets_read", { channel: "numbers", sheet: "" })).toMatch(/B2=42\nB3==B2\*2/);
    const found = await run("search", { words: "giraffe" });
    expect(found).toMatch(/docs #notes\] Launch plan/);
    expect(found).toMatch(/tasks #board\] Buy giraffe food/);
    expect(found).not.toMatch(/zebra/);
    expect(await run("search", { words: "nothingnamedthis" })).toBe("Nothing found.");
    const overview = await run("workspace_overview", {}) as string;
    expect(overview).toMatch(/#notes \(docs\): 1 pages: Launch plan/);
    expect(overview).toMatch(/#board \(tasks\): 1 tasks: Buy giraffe food/);
    expect(overview).toMatch(/#files \(files\): 0 files and folders/);
  });
});

describe("assigned tasks", () => {
  it("lists what is assigned to the agent and tags it when done", async () => {
    const { api, run } = setup();
    await run("tasks_add", { channel: "board", title: "Fix the jump", notes: "Feels floaty", column: "" });
    await run("tasks_add", { channel: "board", title: "Draw the boss", notes: "", column: "" });
    const [jump] = (await api.plugin("tasks").read("tasks_tasks")).filter((t) => t.title === "Fix the jump");
    expect(await run("tasks_assigned", {})).toBe("Nothing is assigned to you.");
    await api.plugin("tasks").call("assign-task", { task_id: jump.id, user_id: 1, assigned: true });
    const mine = await run("tasks_assigned", {}) as string;
    expect(mine).toMatch(/#board:\n- Fix the jump \(.+\)\n {2}Feels floaty/);
    expect(mine).not.toMatch(/Draw the boss/);

    expect(await run("tasks_tag", { channel: "board", task: "fix the jump", tag: "#needs-testing" })).toBe("Tagged 'Fix the jump' with #needs-testing.");
    expect(await run("tasks_assigned", {})).toMatch(/Fix the jump \(.+\) #needs-testing/);
    expect(await run("tasks_tag", { channel: "board", task: "Fix the jump", tag: "needs-testing" })).toBe("'Fix the jump' already has #needs-testing.");
    expect(await run("tasks_untag", { channel: "board", task: "Fix the jump", tag: "needs-testing" })).toBe("Took #needs-testing off 'Fix the jump'.");
    expect(await run("tasks_assigned", {})).not.toMatch(/#needs-testing/);
  });
});

describe("channel setup skills", () => {
  it("makes a category and a channel in it, then renames the channel", async () => {
    const backend = new MockBackend({ userId: 7 });
    backend.load(channelsPlugin);
    const api = new ApiClient(new MockTransport(backend));
    let list: { id: number; name: string; type: string; category?: string }[] = [];
    const refresh = async () => {
      const cats = await api.plugin("channels").read("channels_categories");
      list = (await api.plugin("channels").read("channels_channels")).map((c) => ({ id: Number(c.id), name: String(c.name), type: String(c.type), category: String(cats.find((k) => k.id === c.category_id)?.name) }));
    };
    const context = {
      channels: async () => { await refresh(); return list; }, granted: () => true,
      read: (plugin: string, table: string) => api.plugin(plugin).read(table), write: (plugin: string) => api.plugin(plugin),
    } as unknown as BotContext;
    const run = (name: string, args: Record<string, string | number>) => allSkills().find((s) => s.name === name)!.run(context, args, env);
    await run("channels_create", { name: "Road Map", type: "tasks", category: "Planning" });
    await run("channels_create", { name: "road map", type: "tasks", category: "planning" });
    await run("channels_rename", { channel: "road-map", name: "roadmap" });
    await refresh();
    expect(list.map((c) => `${c.category}/${c.name}:${c.type}`)).toEqual(["Planning/roadmap:tasks"]);
    await expect(run("channels_create", { name: "x", type: "bogus", category: "" })).rejects.toThrow("no channel type");
  });
});
