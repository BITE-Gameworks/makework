import { describe, expect, it } from "vitest";
import { ApiClient, ApiRequestError } from "../../src/api/client";
import { MockBackend } from "../../src/system/backend";
import { emoji } from "../../src/system/emoji";
import { MockTransport } from "../../src/mock/transport";

const ref = `mwc:${"a".repeat(64)}`;
const thumb = "data:image/webp;base64,AAAA";
const values = {
  name: "party_parrot", url: ref, thumb, mime: "image/png", size: 1000, width: 64, height: 64,
};

function setup() {
  const backend = new MockBackend({ userId: 7 });
  backend.load(emoji);
  return { backend, api: new ApiClient(new MockTransport(backend)).plugin("emoji") };
}

describe("emoji plugin", () => {
  it("adds an emoji as its author and lists it", async () => {
    const { api } = setup();
    const { id } = await api.call<{ id: number }>("add-emoji", values);
    const rows = await api.read("emoji_emojis");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, ...values, author_id: 7, deleted: false });
    expect(typeof rows[0].created_at).toBe("string");
  });

  it("removes only by hiding it and keeps its name reserved", async () => {
    const { api } = setup();
    const { id } = await api.call<{ id: number }>("add-emoji", values);
    expect(await api.call("remove-emoji", { id })).toEqual({ removed: true });
    expect((await api.read("emoji_emojis"))[0].deleted).toBe(true);
    await expect(api.call("add-emoji", values)).rejects.toThrow(/already/);
    await expect(api.call("remove-emoji", { id })).rejects.toThrow(/already/);
  });

  it("rejects malformed rows and names", async () => {
    const { api } = setup();
    const code = (args: Record<string, unknown>) =>
      api.call("add-emoji", { ...values, ...args }).catch((e: ApiRequestError) => e.message);
    expect(await code({ name: "smile" })).toMatch(/standard/);
    expect(await code({ name: "u1f600" })).toMatch(/standard/);
    expect(await code({ name: "X" })).toMatch(/2-32/);
    expect(await code({ url: "https://example.com/a.png" })).toMatch(/content/);
    expect(await code({ mime: "image/svg+xml" })).toMatch(/PNG/);
    expect(await code({ size: 600_000 })).toMatch(/512/);
    expect(await code({ width: 0 })).toMatch(/width/);
    expect(await code({ thumb: "nope" })).toMatch(/preview/);
  });
});
