import { beforeEach, describe, expect, it } from "vitest";
import { forgetToken, getToken, setToken, tokenRevision } from "../../src/core/secrets";

// core/storage reads localStorage, which node doesn't have.
beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
  };
});

describe("host connections on this computer", () => {
  it("say when a token is added or forgotten, so views check what it may do again", async () => {
    const start = tokenRevision();
    await setToken("gitlab.example.com", "t");
    expect(await getToken("GitLab.example.com")).toBe("t");
    const added = tokenRevision();
    expect(added).not.toBe(start);
    await forgetToken("gitlab.example.com");
    expect(await getToken("gitlab.example.com")).toBeNull();
    expect(tokenRevision()).not.toBe(added);
  });
});
