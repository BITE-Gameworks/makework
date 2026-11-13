import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";

class TestBattery extends EventTarget {
  level = 1;
  constructor(public charging: boolean) { super(); }
  plug(charging: boolean) {
    this.charging = charging;
    this.dispatchEvent(new Event("chargingchange"));
  }
}

// Each test gets a fresh module (its signals read storage when loaded) and its own storage.
let stored: Map<string, string>;
beforeEach(() => {
  stored = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
    removeItem: (k: string) => void stored.delete(k),
  });
  vi.resetModules();
});
afterEach(() => vi.unstubAllGlobals());

type Power = typeof import("../../src/core/power");

// Loads the module and starts it, on the browser's Battery API unless a source is given; the root's data-power is
// what the styles read.
async function start(battery?: TestBattery, source?: (power: Power) => import("../../src/core/power").PowerSource) {
  const power = await import("../../src/core/power");
  const root = { dataset: {} as Record<string, string> };
  const events = new EventTarget();
  const dispose = createRoot((dispose) => {
    power.initPower(root as unknown as HTMLElement,
      source?.(power) ?? power.batterySource(battery ? { getBattery: () => Promise.resolve(battery) } : {}),
      events as unknown as Window);
    return dispose;
  });
  await Promise.resolve();
  await Promise.resolve();
  return { power, root, events, dispose };
}

// The desktop app's bridge to the system's power source.
class TestDesktopPower {
  onBatteryNow = false;
  noted = 0;
  private handlers = new Set<(onBattery: boolean) => void>();
  onBattery() { return Promise.resolve(this.onBatteryNow); }
  onChange(handler: (onBattery: boolean) => void) {
    this.handlers.add(handler);
    return () => void this.handlers.delete(handler);
  }
  noteBattery() { this.noted++; }
  set(onBattery: boolean) {
    this.onBatteryNow = onBattery;
    for (const handler of this.handlers) handler(onBattery);
  }
}

describe("power saving", () => {
  it("follows the battery when automatic, and marks the root", async () => {
    const battery = new TestBattery(true);
    const { power, root, dispose } = await start(battery);
    expect(power.powerSaving()).toBe(false);
    expect(root.dataset.power).toBeUndefined();
    battery.plug(false); // unplugged
    expect(power.powerSaving()).toBe(true);
    expect(root.dataset.power).toBe("saving");
    battery.plug(true);
    expect(root.dataset.power).toBeUndefined();
    dispose();
  });

  it("is always on or always off when chosen so, whatever the battery", async () => {
    const battery = new TestBattery(false);
    const { power, root, dispose } = await start(battery);
    power.setPowerSavingChoice("off");
    expect(root.dataset.power).toBeUndefined();
    power.setPowerSavingChoice("on");
    battery.plug(true);
    expect(root.dataset.power).toBe("saving");
    dispose();
  });

  it("counts as plugged in where the browser doesn't tell", async () => {
    const { power, root, dispose } = await start();
    expect(power.powerSaving()).toBe(false);
    expect(root.dataset.power).toBeUndefined();
    dispose();
  });

  // Started on battery, it saves power from the first frame, before the browser answers.
  it("starts from the battery as last seen", async () => {
    stored.set("mw.power.onBattery", "true");
    const power = await import("../../src/core/power");
    expect(power.powerSaving()).toBe(true);
  });

  it("remembers the battery for the next start", async () => {
    const battery = new TestBattery(false);
    const { dispose } = await start(battery);
    expect(stored.get("mw.power.onBattery")).toBe("true");
    battery.plug(true);
    expect(stored.get("mw.power.onBattery")).toBe("false");
    dispose();
  });

  // A laptop plugged in but held at a charge limit isn't charging: the desktop app asks the system's power source.
  it("follows the system's power source in the desktop app, whatever the battery says", async () => {
    const system = new TestDesktopPower();
    const heldAtLimit = Object.assign(new TestBattery(false), { level: 0.8 });
    const { power, root, dispose } = await start(undefined,
      (p) => p.desktopSource(system, { getBattery: () => Promise.resolve(heldAtLimit) }));
    expect(power.powerSaving()).toBe(false);
    system.set(true); // unplugged
    expect(root.dataset.power).toBe("saving");
    system.set(false);
    expect(root.dataset.power).toBeUndefined();
    dispose();
  });

  // For the graphics choice: a battery below full charge tells the desktop app this is a laptop.
  it("tells the desktop app it has a battery when the battery isn't full", async () => {
    const system = new TestDesktopPower();
    const charging = Object.assign(new TestBattery(true), { level: 0.23 });
    const { dispose } = await start(undefined, (p) => p.desktopSource(system, { getBattery: () => Promise.resolve(charging) }));
    expect(system.noted).toBe(1);
    dispose();

    const desktopPc = new TestDesktopPower();
    const none = Object.assign(new TestBattery(true), { level: 1 });
    const again = await start(undefined, (p) => p.desktopSource(desktopPc, { getBattery: () => Promise.resolve(none) }));
    expect(desktopPc.noted).toBe(0);
    again.dispose();
  });

  // A view window is its own copy of the app: it hears the choice through storage events.
  it("follows a choice made in another window", async () => {
    const { power, root, events, dispose } = await start(new TestBattery(true));
    const change = Object.assign(new Event("storage"), { key: "mw.powerSaving", newValue: JSON.stringify("on") });
    events.dispatchEvent(change);
    expect(power.powerSavingChoice()).toBe("on");
    expect(root.dataset.power).toBe("saving");
    dispose();
  });
});
