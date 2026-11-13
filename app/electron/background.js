// Running in the background: closing the window hides it to the tray (unless the user chose to quit instead), and
// starting with the computer; also which graphics card the app draws with, and the power source for the page's power
// saving. Settings in <userData>/desktop-settings.json.
// Quitting (the tray, Ctrl+Q, the window closing for good, shutdown, a signal) says goodbye first: the main window's
// page leaves its call and tells every member it reaches (src/core/farewell.ts), so they see it leave at once instead
// of a connection that looks lost. The window hides right away; the quit waits for the page `farewellWaitMs` at most.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerMonitor, Tray } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installed } from "./installed.js";
import { createQuitCheck } from "./quitCheck.js";

// `hasBattery`: seen on battery or below full charge once (a laptop), for the "auto" graphics choice.
const defaults = { closeToTray: true, launchAtStartup: false, gpu: "auto", hasBattery: false };
const gpuChoices = new Set(["auto", "integrated", "discrete"]);
const settingsPath = () => path.join(app.getPath("userData"), "desktop-settings.json");
// Given to the copy the system starts at login, which then stays in the tray.
export const hiddenArg = "--hidden";

let settings = { ...defaults };
let tray = null;
let quitting = false;
const farewellWaitMs = 1500;
// The main window's goodbye: asked once per main window, settled when the page answered or the wait ran out.
let farewell = null;
let farewellDone = false;
// A deliberate quit asks first while new uploads haven't reached a node (quitCheck.js).
const quitCheckWaitMs = 1500;
const quitCheck = createQuitCheck({
  ask: (win) => askUndelivered(win),
  show: (win, options) => {
    const parent = win && !win.isDestroyed() && win.isVisible() ? win : null;
    return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  },
});

function loadSettings() {
  try {
    settings = { ...defaults, ...JSON.parse(readFileSync(settingsPath(), "utf8")) };
  } catch {
    settings = { ...defaults };
  }
  if (!gpuChoices.has(settings.gpu)) settings.gpu = defaults.gpu;
  settings.hasBattery = settings.hasBattery === true;
}

// The graphics card a choice draws with: "integrated" (the low-power one, on computers with two), "discrete", or
// "system" (no switch: Chromium and the driver decide). "auto" takes the integrated one on a computer with a battery:
// Chromium had picked a laptop's NVIDIA card while its screen hangs off the integrated GPU, so every frame was drawn
// there, copied across and composited again, and the card stayed powered on battery. Elsewhere it leaves
// the choice to the system: a desktop's monitor is usually on its graphics card, and drawing on the CPU's integrated
// GPU would copy every frame the other way.
const gpuFor = (s) => (s.gpu === "auto" ? (s.hasBattery ? "integrated" : "system") : s.gpu);
let gpuAtStart = "system";

// Called by main.js before the app is ready: Chromium picks its GPU when it starts, so a change applies at the next
// start. A switch given on the command line wins.
export function applyGpuChoice(commandLine) {
  loadSettings();
  if (commandLine.hasSwitch("force_high_performance_gpu")) gpuAtStart = "discrete";
  else if (commandLine.hasSwitch("force_low_power_gpu")) gpuAtStart = "integrated";
  else {
    gpuAtStart = gpuFor(settings);
    if (gpuAtStart === "integrated") commandLine.appendSwitch("force_low_power_gpu");
    if (gpuAtStart === "discrete") commandLine.appendSwitch("force_high_performance_gpu");
  }
}

// The computer has a battery: kept, so "auto" takes the integrated GPU from the next start on.
function noteBattery() {
  if (settings.hasBattery) return;
  settings.hasBattery = true;
  saveSettings();
}

// Whether the computer runs on battery, for the page's power saving (src/core/power.ts): Electron's own power source,
// since the Battery API's `charging` is also false on a laptop plugged in but held at a charge limit.
function setUpPowerSource() {
  const send = () => {
    const onBattery = powerMonitor.isOnBatteryPower();
    if (onBattery) noteBattery();
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send("power:changed", onBattery);
  };
  powerMonitor.on("on-battery", send);
  powerMonitor.on("on-ac", send);
  ipcMain.handle("power:on-battery", () => {
    const onBattery = powerMonitor.isOnBatteryPower();
    if (onBattery) noteBattery();
    return onBattery;
  });
  // The page saw a battery below full charge (a laptop charging on AC).
  ipcMain.on("power:has-battery", noteBattery);
}

function saveSettings() {
  try {
    writeFileSync(settingsPath(), JSON.stringify(settings));
  } catch (e) {
    console.warn("Desktop settings not saved:", e);
  }
}

// Only installed builds can be started by the system; a dev run needs its dev server.
const startupAvailable = () => installed;

// In a Flatpak, XDG_CONFIG_HOME is the sandbox's own folder, which the desktop never reads: the file goes in the
// user's real ~/.config/autostart (reachable through --filesystem=home) and starts the app through `flatpak run`.
const flatpakId = process.env.FLATPAK_ID;
const autostartFile = () =>
  path.join(flatpakId ? path.join(os.homedir(), ".config") : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "autostart", "makework.desktop");

async function applyStartup(on) {
  if (!startupAvailable()) return;
  if (process.platform !== "linux") {
    app.setLoginItemSettings({ openAtLogin: on, args: [hiddenArg] });
    return;
  }
  // AppImages run from a temporary mount; APPIMAGE is the file itself.
  const exec = process.env.APPIMAGE || process.execPath;
  const command = flatpakId ? `flatpak run ${flatpakId}` : `"${exec.replace(/(["`$\\])/g, String.raw`\$1`)}"`;
  if (!on) {
    await fs.rm(autostartFile(), { force: true });
    return;
  }
  await fs.mkdir(path.dirname(autostartFile()), { recursive: true });
  await fs.writeFile(autostartFile(), [
    "[Desktop Entry]",
    "Type=Application",
    "Name=MakeWork",
    `Exec=${command} ${hiddenArg}`,
    `Icon=${flatpakId ?? "makework"}`,
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n"));
}

export function startedHidden() {
  if (!settings.closeToTray) return false;
  return process.argv.includes(hiddenArg) || (process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin);
}

export function isQuitting() {
  return quitting;
}

// The icon the page drew (theme colors, mention badge); the tray uses it from then on.
let trayImage = null;
const traySize = () => (process.platform === "darwin" ? 16 : 32);

export function setTrayIcon(image) {
  trayImage = image;
  tray?.setImage(image.resize({ width: traySize(), height: traySize() }));
}

function updateTray(getWindow, showWindow, iconPath) {
  if (!settings.closeToTray) {
    tray?.destroy();
    tray = null;
    return;
  }
  if (tray) return;
  const size = traySize();
  tray = new Tray((trayImage ?? nativeImage.createFromPath(iconPath)).resize({ width: size, height: size }));
  tray.setToolTip("MakeWork");
  const open = () => {
    const win = getWindow();
    if (win) showWindow(win);
  };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open MakeWork", click: open },
    { type: "separator" },
    { label: "Quit MakeWork", click: () => app.quit() },
  ]));
  tray.on("click", open);
}

// The page's goodbye (src/core/farewell.ts), once: a window gone or crashed has nothing to say.
function sayFarewell(win) {
  farewell ??= askFarewell(win).finally(() => (farewellDone = true));
  return farewell;
}

function askFarewell(win) {
  if (!win || win.isDestroyed() || win.webContents.isCrashed?.()) return Promise.resolve();
  const contents = win.webContents;
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      ipcMain.off("app:farewell-done", answered);
      contents.off("render-process-gone", finish);
      contents.off("destroyed", finish);
      resolve();
    };
    const answered = (event) => event.sender === contents && finish();
    const timer = setTimeout(finish, farewellWaitMs);
    ipcMain.on("app:farewell-done", answered);
    contents.on("render-process-gone", finish);
    contents.on("destroyed", finish);
    // After the event that asked (a close's other handlers save the window's size and place while it is shown).
    setImmediate(() => !win.isDestroyed() && win.hide());
    contents.send("app:farewell");
  });
}

// How many new uploads haven't reached a node, from the main window's page (src/core/farewell.ts); 0 when it doesn't
// answer in time or goes away meanwhile (a page that hangs or crashes never holds a quit back), like `askFarewell`.
function askUndelivered(win) {
  if (!win || win.isDestroyed() || win.webContents.isCrashed?.()) return Promise.resolve(0);
  const contents = win.webContents;
  return new Promise((resolve) => {
    const finish = (count) => {
      clearTimeout(timer);
      ipcMain.off("app:quit-check-done", answered);
      contents.off("render-process-gone", gone);
      contents.off("destroyed", gone);
      resolve(count);
    };
    const answered = (event, count) => event.sender === contents && finish(Number(count) || 0);
    const gone = () => finish(0);
    const timer = setTimeout(gone, quitCheckWaitMs);
    ipcMain.on("app:quit-check-done", answered);
    contents.on("render-process-gone", gone);
    contents.on("destroyed", gone);
    contents.send("app:quit-check");
  });
}

// A quit nobody can answer a question for (shutdown, a signal, the session ending).
function quitNow() {
  quitCheck.force();
  app.quit();
}

// `getWindow` returns the main window, `showWindow` brings it forward.
export function setUpBackground({ getWindow, showWindow, iconPath }) {
  loadSettings();
  app.on("before-quit", (event) => {
    if (farewellDone) {
      quitting = true;
      return;
    }
    event.preventDefault();
    void quitCheck.confirm(getWindow()).then((go) => {
      if (!go) return;
      quitting = true;
      void sayFarewell(getWindow()).then(() => app.quit());
    });
  });
  // Shutting down (macOS, Linux; Windows ends the session on the window, `hideOnClose`) or a signal (a terminal's
  // Ctrl+C, `kill`): a quit like any other, the system waiting for it a moment.
  powerMonitor.on("shutdown", (event) => {
    event.preventDefault();
    quitNow();
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, quitNow);
  updateTray(getWindow, showWindow, iconPath);

  setUpPowerSource();

  // `gpuRestart`: the graphics choice as saved now would draw on another card than this run does.
  const current = () => ({ ...settings, startupAvailable: startupAvailable(), gpuRestart: gpuFor(settings) !== gpuAtStart });
  ipcMain.handle("background:get", current);
  ipcMain.handle("background:set", async (_event, changes) => {
    if (typeof changes?.closeToTray === "boolean") settings.closeToTray = changes.closeToTray;
    if (gpuChoices.has(changes?.gpu)) settings.gpu = changes.gpu;
    if (typeof changes?.launchAtStartup === "boolean" && startupAvailable()) {
      await applyStartup(changes.launchAtStartup);
      settings.launchAtStartup = changes.launchAtStartup;
    }
    saveSettings();
    updateTray(getWindow, showWindow, iconPath);
    return current();
  });
}

// Closing the window hides it while the tray is on (the app and its call stay); quitting from the tray (or the system)
// closes it for real, as does closing it with the tray off, after the page said goodbye.
export function hideOnClose(win) {
  // A new main window (macOS opens one again after the last closed) says its own goodbye.
  farewell = null;
  farewellDone = false;
  // Windows ends the session (shutdown, log off): quit for real, the tray must not keep the window.
  win.on("session-end", quitNow);
  win.on("close", (event) => {
    if (!quitting && settings.closeToTray) {
      event.preventDefault();
      win.hide();
      return;
    }
    if (farewellDone) return;
    event.preventDefault();
    // Closing it with the tray off is quitting: the same question first.
    void quitCheck.confirm(win).then((go) => {
      if (go) void sayFarewell(win).then(() => !win.isDestroyed() && win.close());
    });
  });
}
