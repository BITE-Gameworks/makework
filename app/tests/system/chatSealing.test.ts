import { describe, expect, it } from "vitest";
import { MockBackend, type ChatSealer } from "../../src/system/backend";
import { chat } from "../../src/system/chat";
import { ApiClient } from "../../src/api/client";
import { MockTransport } from "../../src/mock/transport";

// Seals by reversing the text; a guest (user 9) joined at noon.
const sealer: ChatSealer = {
  seal: (_c, _a, text) => `mwe1.1.${[...text].reverse().join("")}`,
  open: (_c, _a, text) => (text.startsWith("mwe1.") ? [...text.slice(5 + 2)].reverse().join("") : text),
  guestSince: (user) => (user === 9 ? Date.parse("2026-10-28T12:00:00Z") : null),
};

describe("chat with a sealer", () => {
  it("stores sealed text and lists it opened", async () => {
    const backend = new MockBackend({ userId: 2, services: { chat: sealer } });
    backend.load(chat);
    const api = new ApiClient(new MockTransport(backend)).plugin("chat");
    const { id } = await api.call<{ id: number }>("post-message", { channel_id: 50, body: "hello" });
    expect(backend.data("chat").select("chat_messages", { id })[0].body).toBe("mwe1.1.olleh");
    const { rows } = await api.call<{ rows: { body: string }[] }>("list-messages", { channel_id: 50 });
    expect(rows[0].body).toBe("hello");
    expect((await api.read("chat_messages", { id }))[0].body).toBe("hello");
  });

  it("leaves out messages from before a guest joined", async () => {
    const backend = new MockBackend({ userId: 9, services: { chat: sealer } });
    backend.load(chat);
    backend.data("chat").insert("chat_messages", { channel_id: 50, author_id: 2, kind: "message", body: "old", created_at: "2026-10-28T11:00:00Z" });
    backend.data("chat").insert("chat_messages", { channel_id: 50, author_id: 2, kind: "message", body: "new", created_at: "2026-10-28T13:00:00Z" });
    const { rows } = await new ApiClient(new MockTransport(backend)).plugin("chat").call<{ rows: { body: string }[] }>("list-messages", { channel_id: 50 });
    expect(rows.map((r) => r.body)).toEqual(["new"]);
  });
});
