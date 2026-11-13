import { describe, expect, it, vi } from "vitest";
import { matchEntries, indexPass } from "../../src/agents/library";
import type { LibraryEntry } from "../../src/plugins/types";
import { installAgentSource } from "./source";

installAgentSource();

const entry = (over: Partial<LibraryEntry>): LibraryEntry => ({ channelId: 1, kind: "page", ref: "page:1", title: "", summary: "", tags: [], sourceHash: "", ...over });

describe("matchEntries", () => {
  const entries = [
    entry({ ref: "a", title: "Release plan", summary: "Dates for the spring launch", tags: ["launch", "dates"] }),
    entry({ ref: "b", title: "Lunch", summary: "Where the team eats", tags: ["food"] }),
    entry({ ref: "c", title: "Notes", summary: "The launch checklist", tags: [] }),
  ];
  it("ranks tag and title hits above summary hits", () => {
    expect(matchEntries(entries, "when is the launch").map((e) => e.ref)).toEqual(["a", "c"]);
  });
  it("returns nothing for words that match nothing", () => {
    expect(matchEntries(entries, "zebra")).toEqual([]);
  });
});

vi.mock("../../src/core/llm", () => ({
  llmJson: vi.fn(async () => ({ value: { summary: " About the launch. ", tags: ["Launch"] }, reply: {} })),
}));

describe("indexPass", () => {
  it("summarizes new pages, skips unchanged ones and drops entries of deleted pages", async () => {
    const saved: LibraryEntry[] = [];
    const removed: string[] = [];
    let stored: LibraryEntry[] = [entry({ ref: "page:99", kind: "page" })];
    const context: any = {
      granted: (p: string) => p === "read:docs" || p === "memory",
      read: async () => [{ id: 1, channel_id: 5, title: "Plan", body: "Launch in spring" }],
      channels: async () => [{ id: 5, name: "plan", type: "docs" }],
      messages: async () => [],
      member: () => ({ displayName: "x" }),
      library: { entries: async () => stored, save: async (e: LibraryEntry) => { saved.push(e); stored = [...stored, e]; }, remove: async (r: string) => { removed.push(r); } },
    };
    const first = await indexPass(context, { baseUrl: "" }, 5);
    expect(first.written).toBe(1);
    expect(saved[0]).toMatchObject({ ref: "page:1", channelId: 5, summary: "About the launch.", tags: ["launch"] });
    expect(removed).toEqual(["page:99"]);
    expect((await indexPass(context, { baseUrl: "" }, 5)).written).toBe(0);
  });
});
