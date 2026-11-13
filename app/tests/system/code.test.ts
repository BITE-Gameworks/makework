import { describe, expect, it } from "vitest";
import { ApiClient, ApiRequestError } from "../../src/api/client";
import { MockTransport } from "../../src/mock/transport";
import { MockBackend } from "../../src/system/backend";
import { code } from "../../src/system/code";

describe("code plugin", () => {
  it("keeps a case-insensitive file tree and soft-deletes folders", async () => {
    const backend = new MockBackend();
    backend.load(code);
    const api = new ApiClient(new MockTransport(backend, 0)).plugin("code");
    const add = async (action: "add-file" | "add-folder", name: string, parent_id?: number) =>
      (await api.call<{ id: number }>(action, { channel_id: 1, name, parent_id: parent_id ?? null })).id;
    const source = await add("add-folder", "src");
    const index = await add("add-file", "index.ts", source);
    expect(await add("add-file", "INDEX.ts", source).catch((error: ApiRequestError) => error.code)).toBe("invalid_request");
    expect(await api.call<{ rows: { hash: string | null }[] }>("list-files", { channel_id: 1 })).toHaveProperty("rows.length", 2);
    expect(await api.call("move", { file_id: source, parent_id: index }).catch((error: ApiRequestError) => error.code)).toBe("invalid_request");
    await api.call("remove", { file_id: source });
    expect((await api.call<{ rows: unknown[] }>("list-files", { channel_id: 1 })).rows).toEqual([]);
    await api.call("restore", { file_id: source });
    expect((await api.call<{ rows: { id: number }[] }>("list-files", { channel_id: 1 })).rows.map((row) => row.id)).toEqual([source, index]);
  });

  it("keeps run configurations and refuses empty commands", async () => {
    const backend = new MockBackend();
    backend.load(code);
    const api = new ApiClient(new MockTransport(backend, 0)).plugin("code");
    const { id } = await api.call<{ id: number }>("add-run", { channel_id: 1, name: "Tests", command: "npm test" });
    expect(await api.call("add-run", { channel_id: 1, name: "Empty", command: " " }).catch((error: ApiRequestError) => error.code)).toBe("invalid_request");
    await api.call("update-run", { run_id: id, name: "Tests", command: "npm test -- --watch=false" });
    expect((await api.call<{ rows: { command: string }[] }>("list-runs", { channel_id: 1 })).rows.map((row) => row.command)).toEqual(["npm test -- --watch=false"]);
    await api.call("remove-run", { run_id: id });
    expect((await api.call<{ rows: unknown[] }>("list-runs", { channel_id: 1 })).rows).toEqual([]);
  });
});
