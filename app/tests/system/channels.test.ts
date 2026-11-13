// The channels plugin's ordering, through ApiClient.
import { describe, expect, it } from "vitest";
import { ApiClient, ApiRequestError } from "../../src/api/client";
import { MockBackend } from "../../src/system/backend";
import { channels } from "../../src/system/channels";
import { MockTransport } from "../../src/mock/transport";

describe("channels plugin", () => {
  it("moves channels within and between categories", async () => {
    const backend = new MockBackend();
    backend.load(channels);
    const api = new ApiClient(new MockTransport(backend, 0)).plugin("channels");
    const { id: a } = await api.call<{ id: number }>("add-category", { name: "A" });
    const { id: b } = await api.call<{ id: number }>("add-category", { name: "B" });
    const add = async (category: number, name: string) => (await api.call<{ id: number }>("add-channel", { category_id: category, name, type: "chat" })).id;
    const one = await add(a, "one");
    const two = await add(a, "two");
    const three = await add(a, "three");
    await add(b, "two");
    const order = async (category: number) => {
      const rows = await api.read("channels_channels", { category_id: category });
      return rows.sort((x, y) => Number(x.position) - Number(y.position)).map((r) => r.name);
    };
    await api.call("move-channel", { channel_id: three, category_id: a, before_id: one });
    expect(await order(a)).toEqual(["three", "one", "two"]);
    await api.call("move-channel", { channel_id: one, category_id: b });
    expect(await order(a)).toEqual(["three", "two"]);
    expect(await order(b)).toEqual(["two", "one"]);
    const code = await api.call("move-channel", { channel_id: two, category_id: b }).catch((e: ApiRequestError) => e.code);
    expect(code).toBe("invalid_request");
  });
});
