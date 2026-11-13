// The workspace order a member arranges, kept under the signed-in account on this device and synced through the
// account's preferences (core/syncedPrefs.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({ state: { accountId: "a" as string | null } }));

vi.mock("../../src/core/account", () => ({
  account: () => (state.accountId === null ? null : { id: state.accountId }),
}));

import { mergeWorkspaceOrder, saveWorkspaceOrder, savedWorkspaceOrder } from "../../src/core/workspaceOrder";

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});

describe("savedWorkspaceOrder", () => {
  it("keeps a separate order per account and reloads it on a switch", () => {
    state.accountId = "one";
    savedWorkspaceOrder();
    saveWorkspaceOrder(["w2", "w1"]);

    state.accountId = "two";
    expect(savedWorkspaceOrder()).toEqual([]);
    saveWorkspaceOrder(["w3"]);

    state.accountId = "one";
    expect(savedWorkspaceOrder()).toEqual(["w2", "w1"]);
    state.accountId = "two";
    expect(savedWorkspaceOrder()).toEqual(["w3"]);
  });

  it("has no order to keep when nobody is signed in", () => {
    state.accountId = null;
    expect(savedWorkspaceOrder()).toEqual([]);
    saveWorkspaceOrder(["w1"]);
    expect(savedWorkspaceOrder()).toEqual([]);
  });
});

describe("mergeWorkspaceOrder", () => {
  it("puts the connected workspaces in their new order and leaves a closed one in its slot", () => {
    expect(mergeWorkspaceOrder(["w1", "gone", "w2"], ["w2", "w1"])).toEqual(["w2", "gone", "w1"]);
  });

  it("keeps a closed workspace's slot between the workspaces that are still connected", () => {
    expect(mergeWorkspaceOrder(["w1", "gone", "w2", "w3"], ["w1", "w3", "w2"])).toEqual(["w1", "gone", "w3", "w2"]);
  });

  it("appends a connected workspace the saved order does not know yet", () => {
    expect(mergeWorkspaceOrder(["w1"], ["w1", "w2"])).toEqual(["w1", "w2"]);
  });

  it("keeps a group tile in its place while workspaces move around it", () => {
    expect(mergeWorkspaceOrder(["w1", "group:g", "w2"], ["w2", "w1"])).toEqual(["w2", "group:g", "w1"]);
    expect(mergeWorkspaceOrder(["group:g", "gone", "w1"], ["w1"])).toEqual(["group:g", "gone", "w1"]);
  });

  it("returns the same list when nothing moves", () => {
    const saved = ["w1", "gone", "w2"];
    expect(mergeWorkspaceOrder(saved, ["w1", "w2"])).toBe(saved);
  });
});
