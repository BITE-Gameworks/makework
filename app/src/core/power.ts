// Power saving: on a laptop on battery (or when chosen in Settings > Application) the app leaves out what costs work
// on every frame without being needed: the fading edges of scrolling areas (a mask redrawn while scrolling), endless
// decorations (typing dots, loading pulses), the Nodes globe doesn't turn by
// itself, bots don't blink and the sound visualizer draws half as often. One-off transitions stay, so views still
// slide and fade. Per device: a desktop and a laptop signed in to the same account want different choices.
import { createEffect, createSignal } from "solid-js";
import { desktop, type DesktopPower } from "./desktop";
import { readJson, writeJson } from "./storage";

export type PowerSavingChoice = "auto" | "on" | "off";

const key = "mw.powerSaving";
// The battery as last seen, so a start on battery saves power from the first frame instead of switching a moment
// later, once the browser has answered.
const batteryKey = "mw.power.onBattery";
const choices: ReadonlySet<PowerSavingChoice> = new Set(["auto", "on", "off"]);
const parse = (value: unknown): PowerSavingChoice =>
  choices.has(value as PowerSavingChoice) ? (value as PowerSavingChoice) : "auto";
const [choice, setChoice] = createSignal<PowerSavingChoice>(parse(readJson<unknown>(key, "auto")));
const [onBattery, setOnBattery] = createSignal(readJson<unknown>(batteryKey, false) === true);

export const powerSavingChoice = choice;
export const powerSaving = () => choice() === "on" || (choice() === "auto" && onBattery());

export function setPowerSavingChoice(value: PowerSavingChoice): void {
  setChoice(value);
  writeJson(key, value);
}

interface Battery extends EventTarget {
  charging: boolean;
  level: number;
}
type BatteryNavigator = { getBattery?: () => Promise<Battery> };

// Where "on battery" comes from: a source calls `handler` with the state now and on every change.
export type PowerSource = (handler: (onBattery: boolean) => void) => void;

// The desktop app: the system's power source (Electron's), not the Battery API, whose `charging` is also false on a
// laptop plugged in but held at a charge limit. The Battery API still tells it that the computer has a battery when
// that is below full charge (a laptop charging on AC), for the "auto" graphics choice (electron/background.js).
export function desktopSource(power: DesktopPower, nav: BatteryNavigator = navigator as never): PowerSource {
  return (handler) => {
    power.onChange(handler);
    power.onBattery().then(handler, () => {});
    nav.getBattery?.().then((battery) => {
      if (battery.level < 1 || !battery.charging) power.noteBattery();
    }).catch(() => {});
  };
}

// In the browser: the Battery API, `charging` false taken as on battery (Chromium reports it from the power line on
// Windows and macOS). A computer without a battery, and a browser that doesn't tell, count as plugged in.
export function batterySource(nav: BatteryNavigator = navigator as never): PowerSource {
  return (handler) => {
    nav.getBattery?.().then((battery) => {
      const update = () => handler(!battery.charging);
      update();
      battery.addEventListener("chargingchange", update);
    }).catch(() => {});
  };
}

const defaultSource = (): PowerSource => (desktop?.power ? desktopSource(desktop.power) : batterySource());

// Call once inside the app's render root: follows the power source and the choice made in another window of the app
// (a view window), and marks <html> with data-power="saving" for the styles.
export function initPower(
  root: HTMLElement = document.documentElement,
  source: PowerSource = defaultSource(),
  events: Pick<Window, "addEventListener"> | undefined = typeof window === "undefined" ? undefined : window,
): void {
  createEffect(() => {
    if (powerSaving()) root.dataset.power = "saving";
    else delete root.dataset.power;
  });
  events?.addEventListener("storage", (e) => {
    if (e.key !== key) return;
    try {
      setChoice(parse(e.newValue === null ? "auto" : JSON.parse(e.newValue)));
    } catch {
      setChoice("auto");
    }
  });
  source((battery) => {
    setOnBattery(battery);
    writeJson(batteryKey, battery);
  });
}
