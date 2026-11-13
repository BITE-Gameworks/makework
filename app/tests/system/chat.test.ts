import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../src/api/client";
import { MockTransport } from "../../src/mock/transport";
import { MockBackend } from "../../src/system/backend";
import { chat } from "../../src/system/chat";

describe("chat plugin polls", () => {
  it("keeps votes on poll answers that are edited", async () => {
    const backend = new MockBackend();
    backend.load(chat);
    const api = new ApiClient(new MockTransport(backend)).plugin("chat");
    const { id } = await api.call<{ id: number }>("post-poll", {
      channel_id: 1, question: "Lunch?", options: "Pizza\nPasta", multiple: false, thread_id: null,
    });
    const initial = await api.call<{ message: { poll: { options: { id: number; label: string; users: number[] }[] } } }>(
      "get-message", { message_id: id },
    );
    const pizza = initial.message.poll.options[0];
    await api.call("vote", { option_id: pizza.id });

    await api.call("edit-poll", {
      message_id: id, question: "Lunch tomorrow?", multiple: true,
      options: JSON.stringify([{ id: pizza.id, label: "Pizza" }, { id: initial.message.poll.options[1].id, label: "Pasta" }, { label: "Salad" }]),
    });

    const edited = await api.call<{ message: {
      body: string; edited_at: string; poll: { multiple: boolean; options: { id: number; label: string; users: number[] }[] };
    } }>(
      "get-message", { message_id: id },
    );
    expect(edited.message.body).toBe("Lunch tomorrow?");
    expect(edited.message.edited_at).toBeTruthy();
    expect(edited.message.poll.multiple).toBe(true);
    expect(edited.message.poll.options).toHaveLength(3);
    expect(edited.message.poll.options[0].users).toHaveLength(1);
  });
});

describe("chat plugin bot steps and thread participants", () => {
  it("keeps a bot's operations on its message and lists who replied, most recent first", async () => {
    const backend = new MockBackend({ userId: 7 });
    backend.load(chat);
    const api = new ApiClient(new MockTransport(backend)).plugin("chat");
    const { id } = await api.call<{ id: number }>("post-message", {
      channel_id: 1, body: "Done.", thread_id: null, steps: "Looked: search weather\n  \nMoved a task to Done\n",
    });
    const { message } = await api.call<{ message: { steps: string; repliers: number[]; reply_count: number } }>("get-message", { message_id: id });
    expect(message.steps).toBe("Looked: search weather\nMoved a task to Done");
    expect(message.reply_count).toBe(0);
    await api.call("post-message", { channel_id: 1, body: "first", thread_id: id });
    const withReply = await api.call<{ message: { repliers: number[]; reply_count: number } }>("get-message", { message_id: id });
    expect(withReply.message.reply_count).toBe(1);
    expect(withReply.message.repliers).toEqual([7]);
  });
});

// Per-message lookups scanned whole tables: listing a 3,000-message channel took about 0.4 s on the main thread
// (mesh-test s15). The reads must not grow with the channel.
describe("listing a channel's messages", () => {
  it("reads each table a fixed number of times, however many messages there are", async () => {
    const { MockPluginData } = await import("../../src/system/data");
    const reads = async (count: number) => {
      const backend = new MockBackend();
      backend.load(chat);
      const api = new ApiClient(new MockTransport(backend)).plugin("chat");
      for (let i = 0; i < count; i++) {
        const { id } = await api.call<{ id: number }>("post-message", { channel_id: 1, body: `m${i}`, thread_id: null });
        if (i % 3 === 0) await api.call("react", { message_id: id, code: "smile" });
        if (i % 5 === 0) await api.call("post-message", { channel_id: 1, body: "reply", thread_id: id });
      }
      const spy = vi.spyOn(MockPluginData.prototype, "select");
      const { rows } = await api.call<{ rows: { reply_count: number; reactions: { code: string; count: number }[] }[] }>("list-messages", { channel_id: 1, thread_id: null });
      const n = spy.mock.calls.length;
      spy.mockRestore();
      expect(rows).toHaveLength(count);
      expect(rows[0].reply_count).toBe(1);
      expect(rows[0].reactions).toEqual([{ code: "smile", count: 1, users: expect.any(Array) }]);
      expect(rows[1].reply_count).toBe(0);
      return n;
    };
    expect(await reads(100)).toBe(await reads(10));
  });
});
