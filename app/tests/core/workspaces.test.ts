import { createEffect, createMemo, createRenderEffect, createRoot, mapArray } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../src/api/client";

vi.mock("../../src/core/account", () => ({ account: () => ({ id: "acct" }) }));

import { createGroup, setWorkspaceGroups } from "../../src/core/workspaceGroups";
import { addWorkspace, moveWorkspace, removeWorkspace, setWorkspaceOrder, workspaceList, workspaces } from "../../src/core/workspaces";

beforeEach(() => setWorkspaceGroups([]));

// A server whose channels plugin answers with its name once `ready` is called, like a ledger catching up.
function fakeServer(name: string) {
  let info: Record<string, unknown>[] = [];
  const listeners: (() => void)[] = [];
  const channels = {
    read: async (table: string) => (table === "channels_workspace" ? info : []),
    onEvent: (fn: () => void) => {
      listeners.push(fn);
      return () => {};
    },
    call: async () => ({}),
  };
  const client = { plugin: () => channels, close: () => {} } as unknown as ApiClient;
  return { client, ready: () => { info = [{ id: 1, name, short: "", color: "", icon: name }]; listeners.forEach((fn) => fn()); } };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("servers", () => {
  it("keeps each server's info apart when both started out joining", async () => {
    const a = fakeServer("First");
    const b = fakeServer("Second");
    addWorkspace("a", a.client);
    addWorkspace("b", b.client);
    await settle();
    a.ready();
    await settle();
    b.ready();
    await settle();
    expect(workspaces.byId.a.info.name).toBe("First");
    expect(workspaces.byId.a.info.icon).toBe("First");
    expect(workspaces.byId.b.info.name).toBe("Second");
    removeWorkspace("a");
    removeWorkspace("b");
  });
});

describe("workspace order", () => {
  const ids = () => workspaceList().map((workspace) => workspace.id);

  it("shows the saved order, appends a new workspace, and gives a rejoined one its old place back", async () => {
    addWorkspace("oa", fakeServer("A").client);
    addWorkspace("ob", fakeServer("B").client);
    await settle();
    setWorkspaceOrder(["ob", "oa"]);
    expect(ids()).toEqual(["ob", "oa"]);

    removeWorkspace("oa");
    expect(ids()).toEqual(["ob"]);

    addWorkspace("oa", fakeServer("A again").client);
    await settle();
    expect(ids()).toEqual(["ob", "oa"]);

    addWorkspace("oc", fakeServer("C").client);
    await settle();
    expect(ids()).toEqual(["ob", "oa", "oc"]);

    for (const id of ["oa", "ob", "oc"]) removeWorkspace(id);
  });

  it("keeps a left workspace's slot when another one is moved", async () => {
    for (const id of ["ka", "kb", "kc"]) addWorkspace(id, fakeServer(id).client);
    await settle();
    setWorkspaceOrder(["ka", "kb", "kc"]);
    removeWorkspace("kb");

    moveWorkspace("kc", "ka");
    expect(ids()).toEqual(["kc", "ka"]);

    addWorkspace("kb", fakeServer("B again").client);
    await settle();
    expect(ids()).toEqual(["kc", "kb", "ka"]);

    for (const id of ["ka", "kb", "kc"]) removeWorkspace(id);
  });

  it("moves a workspace before another one or to the end", async () => {
    for (const id of ["ma", "mb", "mc"]) addWorkspace(id, fakeServer(id).client);
    await settle();
    setWorkspaceOrder(["ma", "mb", "mc"]);

    moveWorkspace("mc", "ma");
    expect(ids()).toEqual(["mc", "ma", "mb"]);

    moveWorkspace("mc", null);
    expect(ids()).toEqual(["ma", "mb", "mc"]);

    moveWorkspace("ma", "ma");
    expect(ids()).toEqual(["ma", "mb", "mc"]);

    for (const id of ["ma", "mb", "mc"]) removeWorkspace(id);
  });

  it("brings a group's workspaces together at the tile's place, and keeps a left one in its slot", async () => {
    for (const id of ["ga", "gb", "gc", "gd"]) addWorkspace(id, fakeServer(id).client);
    await settle();
    setWorkspaceOrder(["ga", "gb", "gc", "gd"]);

    createGroup(["gd", "gb"]);
    expect(ids()).toEqual(["ga", "gd", "gb", "gc"]);

    // A top-level move cannot pull a member out of its group.
    moveWorkspace("gd", "gc");
    expect(ids()).toEqual(["ga", "gd", "gb", "gc"]);

    removeWorkspace("gb");
    expect(ids()).toEqual(["ga", "gd", "gc"]);

    addWorkspace("gb", fakeServer("B again").client);
    await settle();
    expect(ids()).toEqual(["ga", "gd", "gb", "gc"]);

    for (const id of ["ga", "gb", "gc", "gd"]) removeWorkspace(id);
  });

  // Like the workspace bar: one view per listed workspace that reads its data, the list kept in a store by an effect.
  // A leave once removed the data while the list still named it; the view threw, and Solid dropped every effect still
  // queued, the order's own included, so the list stayed frozen (a later join never showed).
  it("keeps following after a workspace that views read leaves", async () => {
    for (const id of ["va", "vb"]) addWorkspace(id, fakeServer(id).client);
    await settle();
    setWorkspaceOrder(["va", "vb"]);
    const dispose = createRoot((dispose) => {
      const [shown, setShown] = createStore<string[]>(ids());
      createEffect(() => setShown(reconcile(ids())));
      const names = createMemo(mapArray(() => shown, (id) => createMemo(() => workspaces.byId[id].info.name)));
      createRenderEffect(() => names().forEach((name) => name()));
      return dispose;
    });

    expect(() => removeWorkspace("va")).not.toThrow();
    expect(ids()).toEqual(["vb"]);
    addWorkspace("vc", fakeServer("vc").client);
    await settle();
    expect(ids()).toEqual(["vb", "vc"]);

    dispose();
    for (const id of ["vb", "vc"]) removeWorkspace(id);
  });
});
