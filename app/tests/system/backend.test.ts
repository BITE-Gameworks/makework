// Requests of every kind, run against the in-app plugins (system/backend.ts) through ApiClient.
import { describe, expect, it } from "vitest";
import { ApiClient, ApiRequestError } from "../../src/api/client";
import type { ServerEvent } from "../../src/api/types";
import { MockTransport } from "../../src/mock/transport";

function setup() {
  const transport = new MockTransport();
  return { transport, api: new ApiClient(transport), example: new ApiClient(transport).plugin("example") };
}

async function errorCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    return (e as ApiRequestError).code;
  }
  throw new Error("expected an error");
}

describe("mock backend", () => {
  it("describes the example plugin", async () => {
    const [ext] = await setup().api.describe();
    expect(ext.name).toBe("example");
    expect(ext.functions.map((f) => f.name)).toEqual(["add-note", "insert", "list-notes", "read", "tag-note", "update"]);
    expect(ext.tables[1]).toMatchObject({ name: "example_note_tags", parent: "example_notes" });
    expect(ext.tables[0].columns[0]).toEqual({ name: "id", type: "bigint", jsonType: "number", writable: false });
  });

  it("runs plugin functions", async () => {
    const { example } = setup();
    const { id } = await example.call<{ id: number }>("add-note", { note: "buy milk" });
    await example.call("tag-note", { note_id: String(id), tag: "errand" });
    const { rows } = await example.call<{ rows: { note: string; tags: string[] }[] }>("list-notes");
    expect(rows[0]).toMatchObject({ note: "buy milk", tags: ["errand"] });
    expect(await errorCode(example.call("tag-note", { note_id: id }))).toBe("invalid_request");
    expect(await errorCode(example.call("tag-note", { note_id: 999, tag: "x" }))).toBe("invalid_request");
  });

  it("reads, inserts and updates rows", async () => {
    const { example } = setup();
    const id = await example.insert("example_notes", { note: "call mom", created_at: "2026-10-05T10:00:00Z" });
    expect(await example.update("example_notes", { note: "call dad" }, { id })).toBe(1);
    expect(await example.read("example_notes", { id })).toEqual([
      { id, note: "call dad", created_at: "2026-10-05T10:00:00Z" },
    ]);
  });

  it("maps errors to codes", async () => {
    const { api, example } = setup();
    expect(await errorCode(example.read("users"))).toBe("access_denied");
    expect(await errorCode(example.call("delete-everything"))).toBe("no_handler");
    expect(await errorCode(api.plugin("nope").read("x"))).toBe("unknown_plugin");
    expect(await errorCode(example.update("example_notes", { note: "x" }, {}))).toBe("invalid_request");
    expect(await errorCode(example.insert("example_notes", { nope: 1 }))).toBe("failed");
    expect(await errorCode(example.insert("example_notes", { note: "hi \u{1F600}" }))).toBe("invalid_request");
  });

  it("answers malformed JSON with invalid_request and echoes the request id", () => {
    const { transport } = setup();
    expect(JSON.parse(transport.backend.handle("{"))).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(JSON.parse(transport.backend.handle('{"requestId":"e","plugin":"example"}')))
      .toMatchObject({ requestId: "e", error: { code: "invalid_request" } });
  });

  it("sends change events", async () => {
    const { example } = setup();
    const events: ServerEvent[] = [];
    example.onEvent((e) => events.push(e));
    const id = await example.insert("example_notes", { note: "a" });
    await Promise.resolve();
    expect(events).toEqual([{ plugin: "example", table: "example_notes", change: "insert", ids: [id] }]);
  });
});
