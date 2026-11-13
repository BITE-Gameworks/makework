// The record of this run's peer id (src/core/lastRun.ts): a run that ended without saying bye is named by the next one
// for its first minute, so the others drop its old connection at once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const peer = vi.hoisted(() => ({ id: "peer-1" }));
// Read at each call: the mocked module may outlive a reset of the others.
vi.mock("trystero", () => ({
  get selfId() {
    return peer.id;
  },
}));

type Stored = Storage & { values: Map<string, string> };
function storage(): Stored {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  } as unknown as Stored;
}

let local: Stored;
let session: Stored;
beforeEach(() => {
  local = storage();
  session = storage();
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("sessionStorage", session);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// A run of the app with this peer id: the desktop app or a browser tab, the main window or a view window.
async function run(id: string, { desktopApp = true, popout = false } = {}) {
  peer.id = id;
  vi.stubGlobal("window", { location: { search: popout ? "?popout=x" : "" }, ...(desktopApp && { makeworkDesktop: { platform: "win32" } }) });
  vi.resetModules();
  const lastRun = await import("../../src/core/lastRun");
  lastRun.startRun();
  return lastRun;
}

describe("the last run's connection", () => {
  it("names the run before when it ended without saying bye, for the first minute only", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    expect((await run("p1")).replacedPeer()).toBeNull();
    const second = await run("p2");
    expect(second.replacedPeer()).toBe("p1");
    vi.advanceTimersByTime(60_000);
    expect(second.replacedPeer()).toBeNull();
  });

  it("names nothing after a run that said bye", async () => {
    (await run("p1")).endRunCleanly();
    expect((await run("p2")).replacedPeer()).toBeNull();
  });

  // A duplicated tab gets a copy of the tab's own storage: it named the original tab's live connection as the one it
  // replaces, and the others took the member out of the call.
  it("keeps no record in a browser tab, so a duplicated tab replaces nothing", async () => {
    await run("p1", { desktopApp: false });
    expect(local.values.size).toBe(0);
    expect(session.values.size).toBe(0);
    expect((await run("p2", { desktopApp: false })).replacedPeer()).toBeNull();
  });

  it("leaves the record alone in a view window, a peer of its own", async () => {
    await run("p1");
    expect((await run("w1", { popout: true })).replacedPeer()).toBeNull();
    expect((await run("p2")).replacedPeer()).toBe("p1");
  });
});
