import { describe, expect, it, vi } from "vitest";

const logs: string[] = [];
vi.mock("../../../../src/core/desktop", () => ({
  desktopError: (e: unknown) => e,
  desktop: {
    git: {
      branches: async () => ({ current: "main", branches: [{ name: "main", head: "c2" }] }),
      remoteHeads: async () => ({ main: "c2", "feature/x": "f1" }),
      log: async (_folder: string, from: string) => {
        logs.push(from);
        return [{ sha: "c2", parents: ["c1"], author_name: "Ann", author_email: "a@x", authored_at: "2026-01-01T00:00:00Z", message: "two" }];
      },
    },
  },
}));

const { cloneReader } = await import("../../../../src/plugins/builtin/git/providers");

describe("reading a fresh clone as its remote", () => {
  it("lists origin's branches and reads them at origin's refs, commit ids as they are", async () => {
    const reader = cloneReader("/home/me/MakeWork/Repositories/r", "main");
    expect(await reader.defaultBranch()).toBe("main");
    expect(await reader.branches()).toEqual([{ name: "main", head: "c2" }, { name: "feature/x", head: "f1" }]);
    await reader.history("feature/x", 1000, () => false);
    const sha = "a".repeat(40);
    await reader.history(sha, 1000, () => false);
    expect(logs).toEqual(["refs/remotes/origin/feature/x", sha]);
  });
});
