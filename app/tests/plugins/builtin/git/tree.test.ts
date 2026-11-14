import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitPreparedSubmodule } from "../../../../src/core/desktop";

// The desktop bridge: a folder's submodules as prepareSubmodules answers, and which folders were asked.
const asked: string[] = [];
const answers: Record<string, { origin: string; submodules: Partial<GitPreparedSubmodule>[] }> = {};
vi.mock("../../../../src/core/account", () => ({ account: () => ({ id: "acct-1" }) }));
vi.mock("../../../../src/core/desktop", async (original) => ({
  ...(await original<typeof import("../../../../src/core/desktop")>()),
  desktop: {
    git: {
      useAccount: async () => {},
      submodules: async (folder: string) => { asked.push(`read ${folder}`); return answers[folder] ?? { origin: "", submodules: [] }; },
      prepareSubmodules: async (folder: string) => { asked.push(`prepare ${folder}`); return answers[folder] ?? { origin: "", submodules: [] }; },
    },
  },
}));

const { localFolder, setLocalFolder, subFolders } = await import("../../../../src/plugins/builtin/git/data");
const { describePrepared, findSubFolders } = await import("../../../../src/plugins/builtin/git/tree");

beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  asked.length = 0;
  for (const key of Object.keys(answers)) delete answers[key];
});

const entry = (path: string, url: string, fields: Partial<GitPreparedSubmodule> = {}): Partial<GitPreparedSubmodule> =>
  ({ name: path, path, url, pinned: "abcdef1", branch: null, folder: null, cloned: false, onBranch: null, attached: false, ...fields });

describe("getting a folder's submodules ready", () => {
  it("walks into freshly cloned submodules, and remembers every folder", async () => {
    setLocalFolder("ws", 1, "/repo");
    answers["/repo"] = { origin: "https://github.com/o/main.git", submodules: [
      entry("lib", "../lib.git", { folder: "/repo/lib", cloned: true, onBranch: "main", attached: true }),
      entry("tool", "https://gitlab.com/g/tool.git", { folder: "/repo/tool", onBranch: "dev" }),
      entry("gone", "../gone.git", { error: "GitHub needs you to sign in.", auth: "github.com" }),
    ] };
    answers["/repo/lib"] = { origin: "https://github.com/o/lib.git", submodules: [
      entry("vendor/x", "https://github.com/o/x.git", { folder: "/repo/lib/vendor/x", left: "Its branch main is at another commit." }),
    ] };
    const { folders, prepared } = await findSubFolders("ws", 1, true);
    expect(asked).toEqual(["prepare /repo", "prepare /repo/lib", "prepare /repo/lib/vendor/x", "prepare /repo/tool"]);
    expect(folders).toEqual({
      lib: { folder: "/repo/lib" }, "lib/vendor/x": { folder: "/repo/lib/vendor/x" }, tool: { folder: "/repo/tool" },
    });
    expect(subFolders("ws", 1)).toEqual(folders);
    expect(localFolder("ws", 1, "lib/vendor/x")).toBe("/repo/lib/vendor/x");
    expect(prepared).toEqual({
      cloned: ["lib"], attached: [{ sub: "lib", branch: "main" }],
      left: [{ sub: "lib/vendor/x", reason: "Its branch main is at another commit." }],
      failed: [{ sub: "gone", reason: "GitHub needs you to sign in.", auth: "github.com" }],
    });
  });

  it("only reads without `prepare`, and does nothing without a folder here", async () => {
    expect(await findSubFolders("ws", 1, true)).toMatchObject({ folders: {} });
    expect(asked).toEqual([]);
    setLocalFolder("ws", 1, "/repo");
    await findSubFolders("ws", 1);
    expect(asked).toEqual(["read /repo"]);
  });

  it("says what it did in a few sentences", () => {
    expect(describePrepared({ cloned: [], attached: [], left: [], failed: [] })).toBe("");
    expect(describePrepared({
      cloned: ["lib", "tools/gen", "x"], attached: [{ sub: "lib", branch: "main" }, { sub: "x", branch: "dev" }],
      left: [{ sub: "vendor/y", reason: "Its branch main is at another commit." }],
      failed: [{ sub: "gone", reason: "Not found." }, { sub: "", reason: "Git isn't installed." }],
    })).toBe("Cloned lib, tools/gen and x into this folder. Put lib on main and x on dev. vendor/y: Its branch main is at another commit. "
      + "gone couldn't be cloned: Not found. The submodules couldn't be got ready: Git isn't installed.");
  });
});
