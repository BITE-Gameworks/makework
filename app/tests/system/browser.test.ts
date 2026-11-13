// The browser plugin, through ApiClient.
import { describe, expect, it } from "vitest";
import { ApiClient, ApiRequestError } from "../../src/api/client";
import { MockBackend } from "../../src/system/backend";
import { browser } from "../../src/system/browser";
import { MockTransport } from "../../src/mock/transport";

describe("browser plugin", () => {
  it("keeps one current page per channel and its bookmarks", async () => {
    const backend = new MockBackend();
    backend.load(browser);
    const api = new ApiClient(new MockTransport(backend, 0)).plugin("browser");
    expect(await api.call("get-page", { channel_id: 1 })).toEqual({ url: null, title: null });
    await api.call("set-page", { channel_id: 1, url: "https://example.com/", title: "Example" });
    await api.call("set-page", { channel_id: 1, url: "https://example.org/", title: "Other" });
    expect(await api.call("get-page", { channel_id: 1 })).toEqual({ url: "https://example.org/", title: "Other" });
    expect(backend.data("browser").select("browser_pages")).toHaveLength(1);
    const code = await api.call("set-page", { channel_id: 1, url: "file:///etc/passwd" }).catch((e: ApiRequestError) => e.code);
    expect(code).toBe("invalid_request");

    const { id } = await api.call<{ id: number }>("add-bookmark", { channel_id: 1, url: "https://example.com/", title: "Example" });
    await api.call("add-bookmark", { channel_id: 1, url: "https://example.org/" });
    await api.call("remove-bookmark", { bookmark_id: id });
    const list = async () => (await api.call<{ rows: { url: string }[] }>("list-bookmarks", { channel_id: 1 })).rows.map((r) => r.url);
    expect(await list()).toEqual(["https://example.org/"]);
    await api.call("restore-bookmark", { bookmark_id: id });
    expect(await list()).toEqual(["https://example.com/", "https://example.org/"]);
  });

  it("keeps a history of settled pages that can be cleared, and closes the page", async () => {
    const backend = new MockBackend();
    backend.load(browser);
    const api = new ApiClient(new MockTransport(backend, 0)).plugin("browser");
    const history = async () => (await api.call<{ rows: { url: string; title: string }[] }>("list-history", { channel_id: 1 })).rows
      .map((r) => `${r.title} ${r.url}`);
    await api.call("set-page", { channel_id: 1, url: "https://example.com/", title: "" });
    await api.call("set-page", { channel_id: 1, url: "https://example.com/", title: "Example" });
    await api.call("set-page", { channel_id: 1, url: "https://example.org/", title: "Other" });
    await api.call("set-page", { channel_id: 2, url: "https://example.net/", title: "Elsewhere" });
    expect(await history()).toEqual(["Other https://example.org/", "Example https://example.com/"]);
    await api.call("clear-history", { channel_id: 1 });
    expect(await history()).toEqual([]);
    expect(backend.data("browser").select("browser_history")).toHaveLength(1);
    await api.call("clear-page", { channel_id: 1 });
    expect(await api.call("get-page", { channel_id: 1 })).toEqual({ url: null, title: null });
  });

  it("keeps Chrome Web Store extensions in the workspace and enables them per channel", async () => {
    const backend = new MockBackend();
    backend.load(browser);
    const api = new ApiClient(new MockTransport(backend, 0)).plugin("browser");
    const extension_id = "abcdefghijklmnopabcdefghijklmnop";
    await api.call("install-extension", { extension_id, name: "Example", version: "1.2.3" });
    expect((await api.call<{ rows: { extension_id: string }[] }>("list-extensions")).rows).toEqual([{ extension_id,
      name: "Example", version: "1.2.3", author_id: 1, created_at: expect.any(String), deleted: false, id: expect.any(Number) }]);
    await api.call("set-channel-extension", { channel_id: 5, extension_id, enabled: true });
    expect((await api.call<{ rows: { extension_id: string; enabled: boolean }[] }>("list-channel-extensions", { channel_id: 5 })).rows)
      .toMatchObject([{ extension_id, enabled: true }]);
    await api.call("remove-extension", { extension_id });
    expect((await api.call<{ rows: unknown[] }>("list-extensions")).rows).toEqual([]);
  });
});
