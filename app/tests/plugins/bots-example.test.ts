import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../src/api/client";
import botPlugin from "../../../examples/plugins/bots/client.js";
import type { BotContext } from "../../src/plugins/types";
import { MockBackend } from "../../src/system/backend";
import { MockTransport } from "../../src/mock/transport";

describe("example bot plugin", () => {
  afterEach(() => vi.useRealTimers());

  it("contributes the three example bot types", () => {
    expect(Object.keys(botPlugin.bots ?? {})).toEqual(["reply", "announcer", "tester"]);
  });

  it("does not replay existing messages on startup or restart, but handles new mentions", async () => {
    vi.useFakeTimers();
    const messages = vi.fn(async () => [
      { id: 10, author_id: 2, body: "<@90> old", thread_id: null, created_at: "" },
    ]);
    const send = vi.fn(async () => {});
    const context = createContext({ channel: 3 }, messages, send);
    const start = botPlugin.bots!.reply.start;

    const stop = start(context) as () => void;
    await flush();
    expect(send).not.toHaveBeenCalled();
    stop();

    const stopAgain = start(context) as () => void;
    await flush();
    expect(send).not.toHaveBeenCalled();

    messages.mockImplementation(async () => [
      { id: 10, author_id: 2, body: "<@90> old", thread_id: null, created_at: "" },
      { id: 11, author_id: 2, body: "<@90> hello", thread_id: null, created_at: "" },
    ]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(3, "olleh");
    stopAgain();
  });

  it("opens a mentioned workspace link with a quoted Markdown title", async () => {
    vi.useFakeTimers();
    let current = [] as Awaited<ReturnType<BotContext["messages"]>>;
    const messages = vi.fn(async () => current);
    const send = vi.fn(async () => {});
    const openLink = vi.fn(() => true);
    const context = createContext({ channel: 3 }, messages, send, openLink);
    const stop = botPlugin.bots!.tester.start(context) as () => void;
    await flush();

    current = [{
      id: 12,
      author_id: 2,
      body: '<@90> [tasks](makework://HUxek4GwbLVF_-SfQYmZzA/3668905281730353 "Test / general / tasks")',
      thread_id: null,
      created_at: "",
    }];
    await vi.advanceTimersByTimeAsync(2_000);

    expect(openLink).toHaveBeenCalledWith("makework://HUxek4GwbLVF_-SfQYmZzA/3668905281730353");
    expect(send).toHaveBeenLastCalledWith(3, "Opened makework://HUxek4GwbLVF_-SfQYmZzA/3668905281730353");
    stop();
  });

  it("waits out the interval since the last announcement instead of posting on every start", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
    const messages = vi.fn(async () => [
      { id: 20, author_id: 90, body: "Stand-up!", thread_id: null, created_at: "2026-10-14T11:59:00Z" },
    ]);
    const send = vi.fn(async () => {});
    const context = createContext({ channel: 3, message: "Stand-up!", repeat: 120 }, messages, send);
    const stop = await botPlugin.bots!.announcer.start(context) as () => void;
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledWith(3, "Stand-up!");
    stop();
  });
});

function createContext(
  config: Record<string, unknown>,
  messages: BotContext["messages"],
  send: BotContext["send"],
  openLink: BotContext["openLink"] = () => false,
): BotContext {
  return {
    workspaceId: "w",
    bot: { id: 90, type: "reply", nickname: "Archibald", config },
    api: new ApiClient(new MockTransport(new MockBackend())).plugin("bots"),
    userId: 2,
    channel: async (id) => ({ id, name: "general", type: "chat" }),
    messages,
    send,
    post: async () => 0,
    edit: async () => {},
    write: () => { throw new Error("not granted"); },
    granted: () => false,
    cursor: async () => {},
    typing: () => {},
    leave: () => {},
    undoWork: async () => ({ undone: 0, skipped: 0 }),
    createBot: async () => 0,
    renameBot: async () => {},
    secret: async () => null,
    log: async () => {},
    openChannel: () => {},
    openLink,
    channels: async () => [],
    inChannel: () => true,
    read: async () => [],
    onEvent: () => () => {},
    member: (id) => ({ id, displayName: `User ${id}`, username: `user${id}`, bot: false }),
    memory: { get: () => null, set: async () => {}, delete: async () => {}, keys: () => [] },
    mark: () => {},
    marks: () => [],
    library: { entries: async () => [], save: async () => {}, remove: async () => {} },
    online: () => [],
    call: { channelOf: () => null, current: () => null, join: async () => {}, leave: () => {} },
    can: () => false,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
