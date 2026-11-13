// The nodes plugin's names, through ApiClient.
import { describe, expect, it } from "vitest";
import { ApiClient } from "../../src/api/client";
import { MockTransport } from "../../src/mock/transport";
import { MockBackend } from "../../src/system/backend";
import { nodes } from "../../src/system/nodes";

describe("nodes plugin", () => {
  it("never gives a new node the name of one still here, also after a removal", async () => {
    const backend = new MockBackend();
    backend.load(nodes);
    const api = new ApiClient(new MockTransport(backend, 0)).plugin("nodes");
    const add = async (user_id: number) => (await api.call<{ name: string }>("add", { user_id, key_x: "x", key_y: "y", page: "" })).name;
    expect(await add(1)).toBe("node#1");
    expect(await add(2)).toBe("node#2");
    await api.call("remove", { user_id: 1 });
    expect(await add(3)).toBe("node#3");
  });
});
