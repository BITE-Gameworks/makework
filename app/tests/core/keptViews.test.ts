import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../src/api/client";
import { registerBuiltIn } from "../../src/plugins/registry";
import type { ClientPlugin } from "../../src/plugins/types";
import { addWorkspace, removeWorkspace, suspendWorkspace } from "../../src/core/workspaces";
import { loadRoles } from "../../src/core/roles";
import { closeTabs, openChannel, openInNewTabAt, tabLocation, tabs } from "../../src/core/navigation";
import { dropKept, kept, keepsAlive, leaveKept, showKept } from "../../src/core/keptViews";

// Channel types only these tests use: a plain kept type, one with a timeout (like the browser) and one that
// opted out.
const chat = "cache_chat";
const browser = "cache_browser";
const never = "cache_never";

registerBuiltIn({
  manifest: {
    id: "cache-test", name: "Cache test", version: "1.0.0",
    contributes: {
      channelTypes: [
        { id: chat, label: "Chat", icon: "channel-chat" },
        { id: browser, label: "Browser", icon: "channel-browser", keepAlive: 600 },
        { id: never, label: "Never", icon: "channel-other", keepAlive: false },
      ],
    },
  },
} as ClientPlugin);

function fakeClient(channels: { id: number; type: string }[]): ApiClient {
  const tables: Record<string, unknown[]> = {
    channels_workspace: [{ id: 1, name: "W", short: "w", color: "", icon: "", welcome_channel_id: null }],
    channels_categories: [{ id: 1, name: "General", position: 0 }],
    channels_channels: channels.map((c) => ({ id: c.id, category_id: 1, name: `c${c.id}`, type: c.type, position: c.id, slow_mode: 0 })),
    channels_visibility: [],
    roles_roles: [], roles_members: [], roles_bans: [], roles_mutes: [],
  };
  const plugin = {
    read: async (table: string) => tables[table] ?? [],
    call: async () => ({ user_id: 1 }),
    onEvent: () => () => {},
  };
  return { plugin: () => plugin, close: () => {} } as unknown as ApiClient;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

// A tab for the channel sitting in the background (it does not become the active tab), so the view's channel is
// exempt without being the shown one. Returns the tab's id to close it.
function openBackgroundTab(workspaceId: string, channelId: number): number {
  openInNewTabAt({ workspaceId, channelId }, null, false);
  const tab = tabs().find((t) => {
    const at = tabLocation(t);
    return at?.workspaceId === workspaceId && at.channelId === channelId;
  });
  return tab!.id;
}

// A connected workspace whose member sees the channels, like a ledger caught up.
async function seed(workspaceId: string, channels: { id: number; type: string }[]): Promise<void> {
  const client = fakeClient(channels);
  addWorkspace(workspaceId, client);
  await loadRoles(workspaceId, client, () => null);
  await settle();
}

afterEach(() => {
  vi.useRealTimers();
  for (const view of [...kept()]) dropKept(view.key);
});

describe("which views are kept", () => {
  it("keeps every type by default; a type that opted out is never kept", async () => {
    await seed("w-policy", [{ id: 1, type: chat }, { id: 2, type: never }]);
    expect(keepsAlive(chat)).toBe(true);
    expect(keepsAlive(browser)).toBe(true);
    expect(keepsAlive(never)).toBe(false);

    showKept("w-policy", 1, chat);
    expect(kept().map((v) => v.channelId)).toEqual([1]);
    showKept("w-policy", 2, never);
    expect(kept().map((v) => v.channelId)).toEqual([1]);
  });
});

describe("timeouts", () => {
  it("lets a timed type go that many seconds after it was last shown; an untimed one stays", async () => {
    await seed("w-timeout", [{ id: 1, type: browser }, { id: 2, type: chat }]);
    vi.useFakeTimers();
    showKept("w-timeout", 1, browser);
    showKept("w-timeout", 2, chat);
    const [timed, untimed] = kept();
    leaveKept(timed, browser);
    leaveKept(untimed, chat);

    vi.advanceTimersByTime(599_000);
    expect(kept().map((v) => v.channelId)).toEqual([1, 2]);
    vi.advanceTimersByTime(1_000);
    expect(kept().map((v) => v.channelId)).toEqual([2]);
    vi.advanceTimersByTime(600_000);
    expect(kept().map((v) => v.channelId)).toEqual([2]);
  });

  it("showing a timed view again stops its timeout", async () => {
    await seed("w-timeout-again", [{ id: 1, type: browser }]);
    vi.useFakeTimers();
    showKept("w-timeout-again", 1, browser);
    leaveKept(kept()[0], browser);
    vi.advanceTimersByTime(400_000);
    showKept("w-timeout-again", 1, browser);
    vi.advanceTimersByTime(600_000);
    expect(kept().map((v) => v.channelId)).toEqual([1]);
  });

  // A channel open in a tab is never let go (spec: kept views); its timeout starts counting again if the tab
  // closes before it, and only what is left of the type's time then lets it go.
  it("keeps a hidden view whose channel has an open tab past its timeout", async () => {
    await seed("w-tab-timeout", [{ id: 1, type: browser }]);
    vi.useFakeTimers();
    openBackgroundTab("w-tab-timeout", 1);
    showKept("w-tab-timeout", 1, browser);
    leaveKept(kept()[0], browser);

    vi.advanceTimersByTime(700_000);
    expect(keys()).toEqual(["w-tab-timeout:1"]);
  });

  it("starts a hidden view's timeout again when its tab closes before it", async () => {
    await seed("w-tab-again", [{ id: 1, type: browser }]);
    vi.useFakeTimers();
    const tab = openBackgroundTab("w-tab-again", 1);
    showKept("w-tab-again", 1, browser);
    leaveKept(kept()[0], browser);

    vi.advanceTimersByTime(300_000);
    closeTabs([tab]);
    expect(keys()).toEqual(["w-tab-again:1"]);
    vi.advanceTimersByTime(299_000);
    expect(keys()).toEqual(["w-tab-again:1"]);
    vi.advanceTimersByTime(1_000);
    expect(kept()).toEqual([]);
  });

  it("lets a hidden view go when its tab closes after its timeout passed", async () => {
    await seed("w-tab-expired", [{ id: 1, type: browser }]);
    vi.useFakeTimers();
    const tab = openBackgroundTab("w-tab-expired", 1);
    showKept("w-tab-expired", 1, browser);
    leaveKept(kept()[0], browser);

    vi.advanceTimersByTime(700_000);
    expect(keys()).toEqual(["w-tab-expired:1"]);
    closeTabs([tab]);
    expect(kept()).toEqual([]);
  });
});

const channelsOf = (...ids: number[]) => ids.map((id) => ({ id, type: chat }));
const ids = () => kept().map((v) => v.channelId);

describe("the bound and its exemptions", () => {
  it("holds at most eight views that are not exempt, letting go of the least recently shown", async () => {
    await seed("w-bound", channelsOf(1, 2, 3, 4, 5, 6, 7, 8, 9));
    for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9]) showKept("w-bound", id, chat);
    expect(ids()).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("does not count the shown view or views with an open tab toward the bound", async () => {
    await seed("w-exempt", channelsOf(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11));
    openInNewTabAt({ workspaceId: "w-exempt", channelId: 5 }, null, false);
    openChannel("w-exempt", 9);
    for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9]) showKept("w-exempt", id, chat);
    expect(ids()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    showKept("w-exempt", 10, chat);
    showKept("w-exempt", 11, chat);
    expect(ids()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("counts a view toward the bound again when its tab closes", async () => {
    await seed("w-tab-bound", channelsOf(1, 2, 3, 4, 5, 6, 7, 8, 9, 10));
    const tab = openBackgroundTab("w-tab-bound", 5);
    for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) showKept("w-tab-bound", id, chat);
    expect(ids()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);

    closeTabs([tab]);
    expect(ids()).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("showing a kept view makes it the most recent, so the next eviction takes the least recently shown", async () => {
    await seed("w-order", channelsOf(1, 2, 3, 4, 5, 6, 7, 8, 9));
    for (const id of [1, 2, 3, 4, 5, 6, 7, 8]) showKept("w-order", id, chat);
    expect(ids()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    showKept("w-order", 1, chat);
    expect(ids()).toEqual([2, 3, 4, 5, 6, 7, 8, 1]);

    showKept("w-order", 9, chat);
    expect(ids()).toEqual([3, 4, 5, 6, 7, 8, 1, 9]);
  });
});

const keys = () => kept().map((v) => v.key);

describe("letting go when a workspace or channel goes", () => {
  it("lets go of a workspace's views when it is suspended", async () => {
    await seed("w-suspend", channelsOf(1, 2));
    await seed("w-stays", channelsOf(1));
    showKept("w-suspend", 1, chat);
    showKept("w-suspend", 2, chat);
    showKept("w-stays", 1, chat);

    suspendWorkspace("w-suspend");
    expect(keys()).toEqual(["w-stays:1"]);
  });

  it("lets go of a workspace's views when it is removed", async () => {
    await seed("w-remove", channelsOf(1, 2));
    showKept("w-remove", 1, chat);
    showKept("w-remove", 2, chat);

    removeWorkspace("w-remove");
    expect(kept()).toEqual([]);
  });

  it("lets go of a view whose channel disappeared, without the shown view changing", async () => {
    await seed("w-gone", channelsOf(1, 2));
    openChannel("w-gone", 1);
    showKept("w-gone", 1, chat);
    showKept("w-gone", 2, chat);
    expect(keys()).toEqual(["w-gone:1", "w-gone:2"]);

    await seed("w-gone", channelsOf(1));
    expect(keys()).toEqual(["w-gone:1"]);
  });
});
