import { describe, expect, it } from "vitest";
import { ApiClient, ApiRequestError } from "../../src/api/client";
import { MockTransport } from "../../src/mock/transport";
import { MockBackend } from "../../src/system/backend";
import { git } from "../../src/system/git";

describe("git plugin", () => {
  it("keeps a channel's build configurations, with the system they were written on", async () => {
    const backend = new MockBackend();
    backend.load(git);
    const api = new ApiClient(new MockTransport(backend, 0)).plugin("git");
    const fields = {
      channel_id: 1, name: "Desktop app", project: "UI/app", output: "release", system: "linux",
      steps: JSON.stringify(["npm ci", "npm run dist"]), collect: JSON.stringify({ kind: "binaries" }),
    };
    const { id } = await api.call<{ id: number }>("add-build", fields);
    await api.call("add-build", { ...fields, channel_id: 2, name: "Elsewhere" });
    const { channel_id: _, ...changed } = fields;
    await api.call("update-build", { ...changed, build_id: id, steps: JSON.stringify(["npm ci", "npm run dist:linux"]), system: "win32" });
    const rows = (await api.call<{ rows: Record<string, unknown>[] }>("list-builds", { channel_id: 1 })).rows;
    expect(rows.map((row) => [row.name, JSON.parse(String(row.steps)), row.system])).toEqual([["Desktop app", ["npm ci", "npm run dist:linux"], "win32"]]);
    await api.call("remove-build", { build_id: id });
    expect((await api.call<{ rows: unknown[] }>("list-builds", { channel_id: 1 })).rows).toEqual([]);
  });

  it("refuses a build configuration without a name, commands or a way to choose its files", async () => {
    const backend = new MockBackend();
    backend.load(git);
    const api = new ApiClient(new MockTransport(backend, 0)).plugin("git");
    const fields = { channel_id: 1, name: "App", project: ".", output: "dist", system: "linux", steps: JSON.stringify(["make"]), collect: JSON.stringify({ kind: "zip" }) };
    const code = (args: Record<string, string | number>) => api.call("add-build", args).then(() => "ok", (error: ApiRequestError) => error.code);
    expect(await code(fields)).toBe("ok");
    expect(await code({ ...fields, name: " " })).toBe("invalid_request");
    expect(await code({ ...fields, steps: JSON.stringify([" "]) })).toBe("invalid_request");
    expect(await code({ ...fields, steps: "make" })).toBe("invalid_request");
    expect(await code({ ...fields, collect: JSON.stringify({ kind: "everything" }) })).toBe("invalid_request");
    expect(await code({ ...fields, collect: JSON.stringify({ kind: "pattern", pattern: "" }) })).toBe("invalid_request");
    expect(await code({ ...fields, output: `${"deep/".repeat(60)}out` })).toBe("invalid_request");
    // Folders outside the repository fail on every member's computer at build time: refused when saved instead.
    expect(await code({ ...fields, project: "../other" })).toBe("invalid_request");
    expect(await code({ ...fields, output: "/etc" })).toBe("invalid_request");
    expect(await code({ ...fields, output: "C:\\Windows" })).toBe("invalid_request");
    expect(await code({ ...fields, system: "x".repeat(21) })).toBe("invalid_request");
  });
});
