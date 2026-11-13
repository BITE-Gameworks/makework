import { describe, expect, it } from "vitest";
import { ApiClient } from "../../src/api/client";
import { MockTransport } from "../../src/mock/transport";
import { bots } from "../../src/system/bots";
import { MockBackend } from "../../src/system/backend";

describe("bots plugin", () => {
  it("assigns per-type handles and a generated name when the nickname is blank", async () => {
    const backend = new MockBackend();
    backend.load(bots);
    const api = new ApiClient(new MockTransport(backend)).plugin("bots");

    const first = await api.call<{ username: string; bot_number: number; nickname: string }>("create", {
      user_id: 100, type: "reply", nickname: "",
    });
    const second = await api.call<{ username: string; bot_number: number; nickname: string }>("create", {
      user_id: 101, type: "reply", nickname: "Archibald",
    });

    expect(first).toMatchObject({ username: "reply", bot_number: 1 });
    expect(first.nickname).toBeTruthy();
    expect(second).toMatchObject({ username: "reply", bot_number: 2, nickname: "Archibald" });
  });

  it("preserves the bot name and host fields when only settings are saved", async () => {
    const backend = new MockBackend();
    backend.load(bots);
    const api = new ApiClient(new MockTransport(backend)).plugin("bots");
    const created = await api.call<{ id: number }>("create", {
      user_id: 200, type: "announcer", nickname: "Archibald", config: "{}",
    });

    await api.call("update", { id: created.id, config: JSON.stringify({ channel: 7, message: "Hello" }) });
    const [row] = await api.read("bots_bots", { id: created.id });

    expect(row).toMatchObject({
      username: "announcer", nickname: "Archibald", config: JSON.stringify({ channel: 7, message: "Hello" }),
    });
    expect(row.host).not.toBe(0);
  });
});

describe("bots plugin workspace index", () => {
  it("writes an entry for a channel and replaces it by reference", async () => {
    const backend = new MockBackend({ userId: 7 });
    backend.load(bots);
    const api = new ApiClient(new MockTransport(backend)).plugin("bots");
    const { id: botId } = await api.call<{ id: number }>("create", { user_id: 90, type: "agent", nickname: "A", config: "{}" });
    await api.call("context-set", { bot_id: botId, ref: "page:1", kind: "page", title: "Plan", summary: "one", tags: "a,b", channel_id: 12, source_hash: "h1" });
    await api.call("context-set", { bot_id: botId, ref: "page:1", kind: "page", title: "Plan", summary: "two", tags: "a", channel_id: 12, source_hash: "h2" });
    const rows = await api.read("bots_context");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel_id: 12, summary: "two", source_hash: "h2" });
  });
});

describe("bots plugin workspace defaults", () => {
  it("sets, replaces and removes a default, and refuses odd names", async () => {
    const backend = new MockBackend({ userId: 7 });
    backend.load(bots);
    const api = new ApiClient(new MockTransport(backend)).plugin("bots");
    await api.call("set-default", { key: "maxSteps", value: "20" });
    await api.call("set-default", { key: "maxSteps", value: "25" });
    expect((await api.read("bots_defaults")).map((r) => [r.key, r.value])).toEqual([["maxSteps", "25"]]);
    await api.call("set-default", { key: "maxSteps", value: "" });
    expect(await api.read("bots_defaults")).toEqual([]);
    await expect(api.call("set-default", { key: "bad key!", value: "1" })).rejects.toThrow(/not valid/);
  });
});
