// Leaving well (src/core/farewell.ts): a deliberate quit leaves the call like Disconnect, says bye and closes the
// workspaces; a page going away (a reload) only says bye and keeps the call to rejoin.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const steps = vi.hoisted(() => [] as string[]);
vi.mock("trystero", () => ({ selfId: "peer-now" }));
vi.mock("../../src/voice/state", () => ({
  leaveVoice: async (sound: boolean) => void steps.push(`leave call (sound ${sound})`),
  stopRejoining: () => void steps.push("stop rejoining"),
}));
vi.mock("../../src/core/serverless", () => ({
  sayGoodbyeEverywhere: async () => void steps.push("bye"),
  closeAllWorkspaces: async () => void steps.push("close workspaces"),
}));

let stored: Map<string, string>;
let farewell: (() => void) | undefined;
const farewellDone = vi.fn();

beforeEach(() => {
  steps.length = 0;
  stored = new Map();
  farewell = undefined;
  farewellDone.mockClear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
  const page = Object.assign(new EventTarget(), {
    location: { search: "" },
    makeworkDesktop: {
      platform: "win32",
      onFarewell: (handler: () => void) => ((farewell = handler), () => {}),
      farewellDone,
    },
  });
  vi.stubGlobal("window", page);
  vi.resetModules();
});
afterEach(() => vi.unstubAllGlobals());

const run = () => JSON.parse(stored.get("mw.run") ?? "null") as { peer: string; clean: boolean } | null;

describe("farewell", () => {
  it("leaves the call for good, says bye and closes the workspaces when the app quits, then answers", async () => {
    const { watchFarewell } = await import("../../src/core/farewell");
    watchFarewell();
    expect(run()).toEqual({ peer: "peer-now", clean: false });
    farewell!();
    await vi.waitFor(() => expect(farewellDone).toHaveBeenCalledOnce());
    expect(steps).toEqual(["stop rejoining", "leave call (sound false)", "bye", "close workspaces"]);
    expect(run()).toEqual({ peer: "peer-now", clean: true });
  });

  it("only says bye when the page goes away, so a reload rejoins the call", async () => {
    const { watchFarewell } = await import("../../src/core/farewell");
    watchFarewell();
    window.dispatchEvent(new Event("beforeunload"));
    await Promise.resolve();
    expect(steps).toEqual(["bye"]);
    expect(run()?.clean).toBe(true);
  });

  it("quits once, however often it is asked", async () => {
    const { quitApp } = await import("../../src/core/farewell");
    await Promise.all([quitApp(), quitApp()]);
    expect(steps.filter((step) => step === "close workspaces")).toHaveLength(1);
  });
});
