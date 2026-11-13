// Workspace groups a member arranges in the workspace bar: personal, kept under the signed-in account on this
// device and synced through the account's preferences (core/syncedPrefs.ts), never in the signed log.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
  state: { accountId: "acct" as string | null, order: [] as string[], saves: 0 },
}));

vi.mock("../../src/core/account", () => ({
  account: () => (state.accountId === null ? null : { id: state.accountId }),
}));

vi.mock("../../src/core/workspaceOrder", async (importOriginal) => ({
  mergeWorkspaceOrder: (await importOriginal<typeof import("../../src/core/workspaceOrder")>()).mergeWorkspaceOrder,
  savedWorkspaceOrder: () => state.order,
  saveWorkspaceOrder: (ids: string[]) => {
    state.order = ids;
    state.saves += 1;
  },
}));

import {
  addToGroup, barEntries, createGroup, dissolveGroup, flattenedOrder, groupOfWorkspace, groupToken,
  isGroupOpen, moveTopLevel, normalizeWorkspaceGroups, removeFromGroup, renameGroup, reorderGroupMembers,
  setWorkspaceGroups, toggleGroupOpen, workspaceGroupsSnapshot,
  type WorkspaceGroup,
} from "../../src/core/workspaceGroups";

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  // Sign out and back in so the module reloads the (empty) store, then start each test with no order.
  state.accountId = null;
  workspaceGroupsSnapshot();
  state.accountId = "acct";
  state.order = [];
  state.saves = 0;
});

describe("normalizeWorkspaceGroups", () => {
  it("keeps well-formed groups, trims names, and ignores malformed entries", () => {
    const groups = normalizeWorkspaceGroups([
      { id: "g1", name: "  Work  ", workspaceIds: ["w1", "w2"] },
      { id: "g1", name: "Duplicate", workspaceIds: ["w3"] },
      { id: "g2", name: "", workspaceIds: ["w3"] },
      { id: "g3", name: "Empty", workspaceIds: [] },
      { id: "g4", workspaceIds: ["w4"] },
      { id: "", name: "No id", workspaceIds: ["w5"] },
      "nope",
      null,
    ]);

    expect(groups).toEqual([
      { id: "g1", name: "Work", workspaceIds: ["w1", "w2"] },
      { id: "g2", name: "Group", workspaceIds: ["w3"] },
      { id: "g4", name: "Group", workspaceIds: ["w4"] },
    ]);
  });

  it("never puts a workspace in two groups and refuses group tokens as members", () => {
    const groups = normalizeWorkspaceGroups([
      { id: "g1", name: "One", workspaceIds: ["w1", groupToken("g2"), "w1"] },
      { id: "g2", name: "Two", workspaceIds: ["w1", "w2"] },
    ]);

    expect(groups).toEqual([
      { id: "g1", name: "One", workspaceIds: ["w1"] },
      { id: "g2", name: "Two", workspaceIds: ["w2"] },
    ]);
  });
});

describe("workspace groups storage", () => {
  it("keeps the groups per account and reloads them on a switch", () => {
    state.accountId = "one";
    setWorkspaceGroups([{ id: "g1", name: "One", workspaceIds: ["w1"] }]);
    expect(workspaceGroupsSnapshot()).toEqual([{ id: "g1", name: "One", workspaceIds: ["w1"] }]);

    state.accountId = "two";
    expect(workspaceGroupsSnapshot()).toEqual([]);
    setWorkspaceGroups([{ id: "g2", name: "Two", workspaceIds: ["w2"] }]);

    state.accountId = "one";
    expect(workspaceGroupsSnapshot()).toEqual([{ id: "g1", name: "One", workspaceIds: ["w1"] }]);
  });

  it("has nowhere to keep groups when nobody is signed in", () => {
    state.accountId = null;
    setWorkspaceGroups([{ id: "g1", name: "One", workspaceIds: ["w1"] }]);
    expect(workspaceGroupsSnapshot()).toEqual([]);
  });
});

describe("creating and changing groups", () => {
  it("makes a group at the first member's place and takes its members out of the top level", () => {
    state.order = ["w1", "w2", "w3"];
    const group = createGroup(["w1", "w3"]);

    expect(state.order).toEqual([groupToken(group.id), "w2"]);
    expect(workspaceGroupsSnapshot()).toEqual([{ id: group.id, name: "New group", workspaceIds: ["w1", "w3"] }]);
    expect(isGroupOpen(group.id)).toBe(true);
  });

  it("adds a workspace to a group and removes the old group when it empties", () => {
    state.order = ["w1", "w2", "w3"];
    const first = createGroup(["w1"]);
    const second = createGroup(["w2"]);

    addToGroup(first.id, ["w2"]);

    expect(state.order).toEqual([groupToken(first.id), "w3"]);
    expect(workspaceGroupsSnapshot()).toEqual([{ id: first.id, name: "New group", workspaceIds: ["w1", "w2"] }]);
    expect(second.id).not.toBe(first.id);
  });

  it("puts a removed workspace right after its group and deletes a group that becomes empty", () => {
    state.order = ["w1", "w2", "w3"];
    const group = createGroup(["w1", "w2"]);

    removeFromGroup(group.id, "w1");
    expect(state.order).toEqual([groupToken(group.id), "w1", "w3"]);
    expect(workspaceGroupsSnapshot()).toEqual([{ id: group.id, name: "New group", workspaceIds: ["w2"] }]);

    removeFromGroup(group.id, "w2");
    expect(state.order).toEqual(["w2", "w1", "w3"]);
    expect(workspaceGroupsSnapshot()).toEqual([]);
  });

  it("ungroups by putting every member back where the tile was", () => {
    state.order = ["w1", "w2", "w3"];
    const group = createGroup(["w1", "w3"]);

    dissolveGroup(group.id);

    expect(state.order).toEqual(["w1", "w3", "w2"]);
    expect(workspaceGroupsSnapshot()).toEqual([]);
  });

  it("renames and reorders members without touching the top level", () => {
    state.order = ["w1", "w2", "w3", "w4"];
    const group = createGroup(["w1", "w2", "w3"]);

    renameGroup(group.id, "  Work  ");
    reorderGroupMembers(group.id, "w3", "w1");

    expect(state.order).toEqual([groupToken(group.id), "w4"]);
    expect(workspaceGroupsSnapshot()).toEqual([{ id: group.id, name: "Work", workspaceIds: ["w3", "w1", "w2"] }]);
  });

  const shown = (...ids: string[]) => barEntries(state.order, workspaceGroupsSnapshot(), ids);

  it("moves a workspace past a group tile", () => {
    state.order = ["w1", "w2", "w3"];
    const group = createGroup(["w2"]);
    expect(state.order).toEqual(["w1", groupToken(group.id), "w3"]);

    moveTopLevel("w3", groupToken(group.id), shown("w1", "w2", "w3"));
    expect(state.order).toEqual(["w1", "w3", groupToken(group.id)]);
  });

  it("does nothing when a move would not change the order", () => {
    state.order = ["w1", "w2"];
    const group = createGroup(["w1"]);
    const saves = state.saves;

    moveTopLevel(groupToken(group.id), "w2", shown("w1", "w2"));
    addToGroup(group.id, ["w1"]);

    expect(state.order).toEqual([groupToken(group.id), "w2"]);
    expect(state.saves).toBe(saves);
  });

  it("moves a group tile among the top-level workspaces", () => {
    state.order = ["w1", "w2", "w3"];
    const group = createGroup(["w2"]);

    moveTopLevel(groupToken(group.id), "w1", shown("w1", "w2", "w3"));
    expect(state.order).toEqual([groupToken(group.id), "w1", "w3"]);

    moveTopLevel(groupToken(group.id), null, shown("w1", "w2", "w3"));
    expect(state.order).toEqual(["w1", "w3", groupToken(group.id)]);
  });
});

describe("the bar's entries", () => {
  const group = (id: string, workspaceIds: string[]): WorkspaceGroup => ({ id, name: id, workspaceIds });

  it("shows groups in place and their connected members inside them", () => {
    state.order = ["w1", groupToken("g1"), "w2"];
    const groups = [group("g1", ["w3", "gone", "w4"])];

    expect(barEntries(state.order, groups, ["w1", "w2", "w3", "w4"])).toEqual([
      { kind: "workspace", id: "w1" },
      { kind: "group", id: groupToken(groups[0].id), group: groups[0], workspaceIds: ["w3", "w4"] },
      { kind: "workspace", id: "w2" },
    ]);
    expect(flattenedOrder(barEntries(state.order, groups, ["w1", "w2", "w3", "w4"]))).toEqual([
      "w1", "w3", "w4", "w2",
    ]);
  });

  it("appends connected workspaces the order does not know and groups missing from it", () => {
    state.order = ["w1", groupToken("missing")];
    const groups = [group("g1", ["w3"])];

    expect(barEntries(state.order, groups, ["w2", "w1", "w3"])).toEqual([
      { kind: "workspace", id: "w1" },
      { kind: "workspace", id: "w2" },
      { kind: "group", id: groupToken(groups[0].id), group: groups[0], workspaceIds: ["w3"] },
    ]);
  });

  it("skips a group with no connected member but keeps its place", () => {
    state.order = ["w1", groupToken("g1"), "w2"];
    const groups = [group("g1", ["gone"])];

    expect(barEntries(state.order, groups, ["w1", "w2"])).toEqual([
      { kind: "workspace", id: "w1" },
      { kind: "workspace", id: "w2" },
    ]);
  });
});

describe("open groups", () => {
  it("keeps the open state per account on this device", () => {
    state.accountId = "one";
    toggleGroupOpen("g1");
    expect(isGroupOpen("g1")).toBe(true);

    state.accountId = "two";
    expect(isGroupOpen("g1")).toBe(false);

    state.accountId = "one";
    expect(isGroupOpen("g1")).toBe(true);
    toggleGroupOpen("g1");
    expect(isGroupOpen("g1")).toBe(false);
  });

  it("finds which group a workspace is in", () => {
    state.accountId = "one";
    state.order = ["w1"];
    const group = createGroup(["w1"]);
    expect(groupOfWorkspace("w1")?.id).toBe(group.id);
    expect(groupOfWorkspace("w9")).toBeUndefined();
  });
});
