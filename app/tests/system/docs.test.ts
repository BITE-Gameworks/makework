// The docs plugin, through ApiClient.
import { describe, expect, it } from "vitest";
import { ApiClient, ApiRequestError } from "../../src/api/client";
import { MockBackend } from "../../src/system/backend";
import { docs } from "../../src/system/docs";
import { MockTransport } from "../../src/mock/transport";

describe("docs plugin", () => {
  it("keeps a tree of pages with their text", async () => {
    const backend = new MockBackend();
    backend.load(docs);
    const api = new ApiClient(new MockTransport(backend, 0)).plugin("docs");
    const add = async (title: string, parent_id?: number) =>
      (await api.call<{ id: number }>("add-page", { channel_id: 1, title, parent_id: parent_id ?? null })).id;
    const guide = await add("Guide");
    const start = await add("Start", guide);
    await api.call("update-page", { page_id: start, body: "# Hello" });
    const { page } = await api.call<{ page: { body: string; title: string } }>("get-page", { page_id: start });
    expect([page.title, page.body]).toEqual(["Start", "# Hello"]);
    const { rows } = await api.call<{ rows: Record<string, unknown>[] }>("list-pages", { channel_id: 1 });
    expect(rows.map((r) => r.parent_id)).toEqual([null, guide]);
    expect("body" in rows[0]).toBe(false);
    const code = await api.call("move-page", { page_id: guide, parent_id: start, z: 1 }).catch((e: ApiRequestError) => e.code);
    expect(code).toBe("invalid_request");
    await api.call("remove-pages", { ids: JSON.stringify([guide, start]) });
    expect((await api.call<{ rows: unknown[] }>("list-pages", { channel_id: 1 })).rows).toEqual([]);
  });

  it("refuses an id list that isn't one", async () => {
    const backend = new MockBackend();
    backend.load(docs);
    const api = new ApiClient(new MockTransport(backend, 0)).plugin("docs");
    for (const ids of ["not json", "{}", "[1.5]", "[\"a\"]"]) {
      const code = await api.call("remove-pages", { ids }).catch((e: ApiRequestError) => e.code);
      expect(code, ids).toBe("invalid_request");
    }
  });
});
