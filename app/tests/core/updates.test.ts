import { beforeEach, describe, expect, it, vi } from "vitest";

const latestVersion = vi.fn<() => Promise<string | null>>();
vi.mock("../../src/core/desktop", () => ({ desktop: { latestVersion } }));

async function load() {
  vi.resetModules();
  const updates = await import("../../src/core/updates");
  const { notices } = await import("../../src/core/notices");
  const { setUserServerOffline } = await import("../../src/core/userServer");
  return { ...updates, notices, setUserServerOffline };
}

describe("update check", () => {
  beforeEach(() => {
    latestVersion.mockReset();
  });

  it("offers a newer version once, and keeps showing it as available", async () => {
    const { checkForUpdate, notices, updateAvailable } = await load();
    latestVersion.mockResolvedValue("999.0.0");
    await checkForUpdate();
    await checkForUpdate();
    expect(updateAvailable()).toBe("999.0.0");
    expect(notices()).toHaveLength(1);
    expect(notices()[0].title).toBe("MakeWork 999.0.0 is available");
  });

  it.each([["0.0.1"], ["not a version"], [null]])("stays quiet about %s", async (latest) => {
    const { checkForUpdate, notices, updateAvailable } = await load();
    latestVersion.mockResolvedValue(latest);
    await checkForUpdate();
    expect(updateAvailable()).toBeNull();
    expect(notices()).toHaveLength(0);
  });

  it("stays quiet when the check fails", async () => {
    const { checkForUpdate, notices } = await load();
    latestVersion.mockRejectedValue(new Error("no network"));
    await checkForUpdate();
    expect(notices()).toHaveLength(0);
  });

  it("doesn't ask at all in offline mode", async () => {
    const { checkForUpdate, setUserServerOffline } = await load();
    setUserServerOffline(true);
    await checkForUpdate();
    expect(latestVersion).not.toHaveBeenCalled();
  });
});
