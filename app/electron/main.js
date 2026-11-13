// Desktop shell: one frameless window running the web build.
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, nativeImage, net, protocol, safeStorage, screen, session, shell } from "electron";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, statSync, constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isInside, removeOrDefer, safeSegment } from "./files.js";
import { trimEnd } from "./text.js";
import { installed } from "./installed.js";
import { loopbackOnce } from "./loopback.js";
import {
  appendCommits, compactCommits, contentDirOf, copyData, dataDir, deleteCheckpoint, describeFolder, folderState, loadCheckpoint, loadCommits,
  partialDirOf, prepareFolder, readRegistry, readServerFile, saveCheckpoint, writeRegistry,
} from "./storage.js";
import { startShareAudio, stopShareAudio } from "./shareAudio.js";
import { build as buildRelease, checkPlan, detectBuild, uploadAsset } from "./release.js";
import * as gitOps from "./gitOps.js";
import { checkHash, createPlaces } from "./mirror.js";
import { setLauncherIcon } from "./launcherIcon.js";
import { appUserModelId, removeStaleDevShortcut, setShortcutIcon } from "./windowsShortcut.js";
import { applyGpuChoice, hideOnClose, isQuitting, setTrayIcon, setUpBackground, startedHidden } from "./background.js";
import { allowSharedBrowser, serveBrowserProxy, setExtensionConfirm, takeBrowserCapture } from "./sharedBrowser.js";
import { loadKeptEngine } from "./adblock.js";
import { connectPublic, createLookup } from "./webLookup.js";
import { createMediaSource } from "./mediaSource.js";
import { createCodeTools } from "./codeTools.js";
import { commandText, createCommandApproval } from "./commandApproval.js";
import * as videoTools from "./videoTools.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// A dev run (not packaged) keeps its own profile, so it can run next to an installed copy like a second computer:
// two copies on one profile can't both open IndexedDB, and would sign as the same account and replica.
// An explicit --user-data-dir (test instances) still wins.
if (!installed && !app.commandLine.hasSwitch("user-data-dir")) app.setPath("userData", path.join(app.getPath("appData"), "makework-dev"));
const distDir = path.join(here, "..", "dist");
// Settings for dev runs and automated checks; an installed app takes its page and paths from no one's environment.
const testEnv = (name) => (installed ? undefined : process.env[name]);
const devUrl = testEnv("MAKEWORK_DEV_URL");

const appOrigin = devUrl ? new URL(devUrl).origin : "app://makework";

// A packaged build has no terminal, so the renderer's console (the "[sync] ..." connection lines included) is
// mirrored to <userData>/logs/main.log, rotated at 2 MB. MAKEWORK_LOG=1 turns it on for a dev run too.
const logFile = path.join(app.getPath("userData"), "logs", "main.log");
const logging = installed || process.env.MAKEWORK_LOG === "1";
function logLine(...parts) {
  if (!logging) return;
  const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === "string" ? p : String(p))).join(" ")}\n`;
  try {
    mkdirSync(path.dirname(logFile), { recursive: true });
    if (statSync(logFile).size > 2 * 1024 * 1024) writeFileSync(logFile, "");
    appendFileSync(logFile, line);
  } catch { /* logging must never take the window down */ }
}
// A crashed page can't say so itself: the next start offers to report it (core/crashReports.ts).
const lastCrashFile = path.join(app.getPath("userData"), "last-crash.json");
function noteCrash({ reason, exitCode }) {
  try {
    writeFileSync(lastCrashFile, JSON.stringify({ reason, exitCode, version: app.getVersion(), at: new Date().toISOString() }));
  } catch { /* only the offer to report it is lost */ }
}
if (logging) {
  process.on("uncaughtException", (e) => logLine("[main] uncaught:", e?.stack ?? e));
  process.on("unhandledRejection", (e) => logLine("[main] rejection:", e?.stack ?? e));
  logLine(`[main] started ${app.getVersion()} (${app.getPath("userData")})`);
}

// Served from a custom scheme instead of file:// so the app has a real, secure origin.
// mwc://content/<hash> serves file content straight from disk, so the page never loads a whole file to show it.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: "mwc", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  { scheme: "mwmedia", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  { scheme: "mwbrowser", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

function serveDist() {
  protocol.handle("app", (request) => {
    const { pathname } = new URL(request.url);
    const file = path.normalize(path.join(distDir, decodeURIComponent(pathname)));
    if (!file.startsWith(distDir + path.sep)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(pathname === "/" ? path.join(distDir, "index.html") : file).toString());
  });
}

// Peers on the same network connect over their real local addresses. Chromium hides them behind mDNS names by
// default, which often don't resolve between Linux machines, and many routers can't loop back to their own public
// address, so two members at the same place could not reach each other.
app.commandLine.appendSwitch("disable-features", "WebRtcHideLocalIpsWithMdns");

// Chromium's own error lines flood the terminal in normal use: every TURN permission the relay refuses for a peer's
// local address, every closed data channel. Pass --log-level=0 to see them again.
if (!app.commandLine.hasSwitch("log-level")) app.commandLine.appendSwitch("log-level", "3");

// Which graphics card to draw with on computers with two (Settings > Application > Graphics, electron/background.js),
// set before the app is ready: Chromium picks it when it starts.
applyGpuChoice(app.commandLine);

const grantedPermissions = new Set(["media", "display-capture", "fullscreen", "notifications", "clipboard-sanitized-write"]);

// Sandboxed server UI (iframes) gets nothing; the app's own window gets what voice and chat need.
function allowed(permission, url, isMainFrame) {
  return isMainFrame && isAppUrl(url) && grantedPermissions.has(permission);
}

// Compared as text: Node gives custom schemes like app:// a "null" origin.
function isAppUrl(url) {
  return url === appOrigin || url.startsWith(appOrigin + "/");
}

function setUpSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(allowed(permission, details.requestingUrl, details.isMainFrame));
  });
  ses.setPermissionCheckHandler((_contents, permission, origin, details) =>
    allowed(permission, origin, details.isMainFrame));

  // Video embeds in chat: the app:// page sends no referrer, and YouTube refuses to play without one.
  ses.webRequest.onBeforeSendHeaders({ urls: ["https://www.youtube-nocookie.com/*", "https://player.vimeo.com/*"] }, (details, callback) => {
    if (!details.requestHeaders.Referer) details.requestHeaders.Referer = "https://makework.dev/";
    callback({ requestHeaders: details.requestHeaders });
  });

  // On Wayland this opens the desktop portal picker, which hands back the one source chosen there. Elsewhere the
  // page shows its own picker first (`screen-share:sources`) and names the source with `screen-share:choose`.
  // No source means the picker was cancelled; the page hears that first, since the error it then gets
  // looks like any other failure.
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const page = takeBrowserCapture(request.frame);
    if (page) return callback({ video: page, audio: page, enableLocalEcho: true });
    const choice = chosenSource;
    chosenSource = null;
    try {
      const asked = Date.now();
      console.info("Screen share: asking the system for sources");
      const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
      console.info(`Screen share: ${sources.length} source(s) after ${Date.now() - asked} ms`);
      const source = (choice && sources.find((s) => s.id === choice.id)) ?? sources.find((s) => s.id.startsWith("screen:")) ?? sources[0];
      if (!source) {
        request.frame?.send("screen-share:cancelled");
        return callback({});
      }
      const loopback = process.platform === "win32" && request.audioRequested && choice?.audio !== false;
      callback(loopback ? { video: source, audio: "loopback" } : { video: source });
    } catch {
      callback({});
    }
  });
}

const usesPortalPicker = process.platform === "linux" && (process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY);
let chosenSource = null;

// Screens and windows for the page's picker; null where the system shows its own (Wayland portal).
ipcMain.handle("screen-share:sources", async () => {
  if (usesPortalPicker) return null;
  const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 } });
  return sources.map((s) => ({ id: s.id, name: s.name, screen: s.id.startsWith("screen:"), thumbnail: s.thumbnail.isEmpty() ? "" : s.thumbnail.toDataURL() }));
});

// The source the next screen share request gets, and whether it records system sound (Windows).
ipcMain.handle("screen-share:choose", (_event, id, audio) => {
  chosenSource = { id: String(id), audio: audio !== false };
});

// The window's last size, place and maximized state, kept in <userData>/window-state.json. Wayland decides window
// positions itself, so there only the size and maximized state come back.
const windowStatePath = () => path.join(app.getPath("userData"), "window-state.json");

function savedWindowState() {
  try {
    const state = JSON.parse(readFileSync(windowStatePath(), "utf8"));
    const { x, y, width, height } = state.bounds ?? {};
    if (![width, height].every(Number.isFinite)) return null;
    // A place on a screen that is gone (unplugged monitor) is dropped; the size is kept.
    const onScreen = Number.isFinite(x) && Number.isFinite(y) && screen.getAllDisplays().some(({ workArea: a }) =>
      x < a.x + a.width - 100 && x + width > a.x + 100 && y >= a.y - 10 && y < a.y + a.height - 100);
    return { bounds: onScreen ? { x, y, width, height } : { width, height }, maximized: state.maximized === true };
  } catch {
    return null;
  }
}

function rememberWindowState(win) {
  let timer;
  // Never while hidden (in the tray, or quitting: background.js hides it at once): a hidden window can say it isn't
  // maximized (Linux drops the state). It was saved while shown: on each change, on close, and as a quit starts.
  const save = () => {
    clearTimeout(timer);
    if (win.isDestroyed() || !win.isVisible() || win.isMinimized() || win.isFullScreen()) return;
    try {
      writeFileSync(windowStatePath(), JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }));
    } catch (e) {
      console.warn("Window state not saved:", e);
    }
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 500);
  };
  win.on("resize", later);
  win.on("move", later);
  win.on("maximize", later);
  win.on("unmaximize", later);
  win.on("close", save);
  app.on("before-quit", save);
  win.once("closed", () => app.off("before-quit", save));
}

const iconPath = path.join(here, "..", "resources", "icon.png");
const crashReloads = 3;
const crashReloadWindowMs = 5 * 60_000;
// On Linux maximize() also shows the window, so a window started hidden maximizes when first shown.
let maximizeOnShow = false;

// The main window (bars, tabs, calls, notifications), the view windows tabs were popped out into, and the terminal
// windows code channels' terminals were popped out into (by terminal id). Neither of the last two ever becomes the
// main one, so account-wide effects have a single owner.
let mainWindow = null;
const popouts = new Map();
const terminalWindows = new Map();

// Any window but the main one (a view window or a terminal window).
function isPopoutWindow(win) {
  return !!win && (popouts.has(win) || [...terminalWindows.values()].includes(win));
}

function mainWindowOf() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  return BrowserWindow.getAllWindows().find((win) => !isPopoutWindow(win)) ?? null;
}

function showWindow(win) {
  if (maximizeOnShow) win.maximize();
  maximizeOnShow = false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Everything a window's page gets regardless of what the window shows: the log mirror, the hidden developer tools
// key, links leaving for the system browser, the window never navigating away, and its uploads and share ending
// with it. The main window's own extras (window state, tray, hide-on-close) stay in createWindow.
function secureWindow(win) {
  allowSharedBrowser(win.webContents);

  // Mirror the page's console to the log file, so a packaged build's "[sync] ..." lines can be read after the fact.
  win.webContents.on("console-message", (event) => {
    logLine(`[page:${event.level}]`, event.message, `(${event.sourceId}:${event.lineNumber})`);
  });
  // A crashed or killed page comes back by itself: it rejoins its call, tells the others which connection it replaces
  // (src/core/lastRun.ts) and offers the crash report (a kill isn't one). At most `crashReloads` times in
  // `crashReloadWindowMs`, so a page that crashes on start doesn't spin.
  const crashes = [];
  win.webContents.on("render-process-gone", (_event, details) => {
    logLine("[renderer gone]", JSON.stringify(details));
    if (details.reason === "clean-exit") return;
    if (details.reason !== "killed") noteCrash(details);
    if (isQuitting()) return;
    const now = Date.now();
    while (crashes.length > 0 && now - crashes[0] > crashReloadWindowMs) crashes.shift();
    if (crashes.length >= crashReloads) return logLine("[renderer gone] not reloaded: crashed too often");
    crashes.push(now);
    setTimeout(() => !win.isDestroyed() && win.webContents.reload(), 1000);
  });

  // Hidden: Ctrl+Shift+I opens the developer tools (the app has no menu bar), for diagnosing connection problems.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.control && input.shift && input.key.toLowerCase() === "i") {
      event.preventDefault();
      win.webContents.toggleDevTools();
    }
  });

  // A reload or crash ends any screen share, so its audio source goes too.
  win.webContents.on("did-start-navigation", (details) => details.isMainFrame && !details.isSameDocument && stopShareAudio());
  win.webContents.on("render-process-gone", () => stopShareAudio());

  // Links leave the app for the system browser; the window itself never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:\/\/|mailto:)/.test(url)) openInBrowser(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  const contentsId = win.webContents.id;
  win.webContents.on("did-start-navigation", ({ isMainFrame, isSameDocument }) => {
    if (isMainFrame && !isSameDocument) { closePartsOf(contentsId); endDragFrom(win); }
  });
  win.webContents.on("destroyed", () => {
    closePartsOf(contentsId);
    endDragFrom(win);
    if (mainWindow === win) mainWindow = null;
  });

  // The frameless window's own buttons draw their state from the page, so it is told when the window maximizes.
  const sendMaximized = () => win.webContents.send("window:maximized", win.isMaximized());
  win.on("maximize", sendMaximized);
  win.on("unmaximize", sendMaximized);
}

function createWindow() {
  // Large by default, but never past the screen's edges (Linux doesn't keep it on screen for us).
  const area = screen.getPrimaryDisplay().workAreaSize;
  const saved = savedWindowState();
  const win = new BrowserWindow({
    title: "MakeWork",
    width: Math.min(2560, area.width),
    height: Math.min(1600, area.height),
    ...saved?.bounds,
    minWidth: 800,
    minHeight: 500,
    frame: false,
    show: false,
    backgroundColor: "#08071d",
    icon: iconPath,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      // Browser channels; guests are locked down in sharedBrowser.js.
      webviewTag: true,
    },
  });
  secureWindow(win);
  mainWindow = win;

  // Starts as it was left (maximized the first time); the size above is what restore returns to. Started with the
  // computer, it waits in the tray until opened.
  maximizeOnShow = saved?.maximized ?? true;
  win.once("ready-to-show", () => {
    if (!startedHidden()) showWindow(win);
    rememberWindowState(win);
  });
  hideOnClose(win);

  void win.loadURL(devUrl ?? "app://makework/");
}

// A view window: one tab on its own, frameless like the main window since the user arranges it themselves. It
// shares the session, so the account and the content are right there. Its place is not remembered (view windows
// don't come back after a restart) and it is closed, not hidden.
const popoutKey = (place) =>
  JSON.stringify({ w: place?.workspaceId ?? "", c: place?.channelId ?? null, p: place?.peer ?? null, t: place?.target ?? null });

function popoutUrl(place) {
  const url = new URL(devUrl ?? "app://makework/");
  url.searchParams.set("popout", JSON.stringify(place ?? {}));
  return url.toString();
}

function findPopout(place) {
  const key = popoutKey(place);
  for (const [win, stored] of popouts) if (!win.isDestroyed() && popoutKey(stored) === key) return win;
  return null;
}

function showPopoutWindow(win) {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// A frameless window of the app's own (a view window, a terminal window) opened at a point on the screen (where a
// tab was dropped, else the cursor), kept inside that display's work area, shown once it has drawn.
function placedWindow(at, { width: wide, height: tall, minWidth, minHeight, webviewTag = false }) {
  const point = at ?? screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(point).workArea;
  const width = Math.max(minWidth, Math.min(wide, area.width));
  const height = Math.max(minHeight, Math.min(tall, area.height));
  const clamp = (value, min, max) => Math.round(Math.min(Math.max(value, min), max));
  const win = new BrowserWindow({
    title: "MakeWork",
    width,
    height,
    x: clamp(point.x - width / 2, area.x, area.x + area.width - width),
    y: clamp(point.y - 24, area.y, area.y + area.height - height),
    minWidth,
    minHeight,
    frame: false,
    show: false,
    backgroundColor: "#08071d",
    icon: iconPath,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      // Browser channels; guests are locked down in sharedBrowser.js.
      ...(webviewTag ? { webviewTag: true } : {}),
    },
  });
  secureWindow(win);
  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });
  return win;
}

function createPopoutWindow(place, at) {
  const win = placedWindow(at, { width: 1100, height: 750, minWidth: 420, minHeight: 320, webviewTag: true });
  popouts.set(win, place ?? null);
  win.on("closed", () => popouts.delete(win));
  void win.loadURL(popoutUrl(place));
  logLine("[popout] opened", popoutKey(place));
  return win;
}

// A terminal window: one code channel terminal popped out of its panel. Its page opens no workspace; it takes the
// running terminal over (codeTools adoptTerminal), and closing it returns the terminal to the page it came from.
function createTerminalWindow(id, at) {
  const win = placedWindow(at, { width: 800, height: 500, minWidth: 320, minHeight: 200 });
  terminalWindows.set(id, win);
  win.on("closed", () => terminalWindows.delete(id));
  const url = new URL(devUrl ?? "app://makework/");
  url.searchParams.set("terminal", String(id));
  void win.loadURL(url.toString());
  return win;
}

// A view window asking the main window to take something it can't hold itself: a tab back, or a new tab for a
// link that points elsewhere. The main window comes forward, since what was asked for is now there.
function sendToMain(channel, ...args) {
  const main = mainWindowOf();
  if (!main) return false;
  main.webContents.send(channel, ...args);
  showWindow(main);
  return true;
}

// `at`: where on the screen a dragged tab was dropped, so the window opens there; the cursor otherwise.
ipcMain.handle("popout:open", (_event, place, at) => {
  if (!place?.workspaceId) return;
  const point = Number.isFinite(at?.x) && Number.isFinite(at?.y) ? { x: Math.round(at.x), y: Math.round(at.y) } : undefined;
  const win = findPopout(place);
  if (win) showPopoutWindow(win);
  else createPopoutWindow(place, point);
});

// A tab handed back to the main window ("Move to main window"), or a link opened there: the same thing for main.
const toMain = (_event, place) => sendToMain("window:tab-received", { location: place, activate: true });
ipcMain.handle("popout:return", toMain);
ipcMain.handle("popout:open-in-main", toMain);

// Dragging a tab between windows. The page captures the pointer and reports the cursor's screen position, so what
// is under it (and whether that means a new view window) is decided here, in one place per pointer move.
let dragSession = null;

function windowAtScreenPoint(x, y) {
  const wins = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
  for (let i = wins.length - 1; i >= 0; i--) {
    const { x: wx, y: wy, width, height } = wins[i].getContentBounds();
    if (x >= wx && x < wx + width && y >= wy && y < wy + height) return wins[i];
  }
  return null;
}

function sendTabDragOver(win, point) {
  if (!win || win.isDestroyed()) return;
  const { x, y } = win.getContentBounds();
  win.webContents.send("window:tab-drag-over", { x: point.x - x, y: point.y - y });
}

function sendTabDragLeave(win) {
  if (win && !win.isDestroyed()) win.webContents.send("window:tab-drag-leave");
}

// A window whose page is reloaded or closed can't finish its drag; the session goes with it.
function endDragFrom(win) {
  if (!dragSession || dragSession.source !== win) return;
  const over = dragSession.over;
  dragSession = null;
  sendTabDragLeave(over);
}

ipcMain.on("popout:drag-start", (event, place) => {
  const win = windowOf(event);
  if (win) dragSession = { source: win, place, over: null };
});

ipcMain.on("popout:drag-move", (event, x, y) => {
  if (dragSession?.source.webContents.id !== event.sender.id) return;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const target = windowAtScreenPoint(x, y);
  const source = dragSession.source;
  const hover = target && target !== source ? target : null;
  if (hover !== dragSession.over) {
    sendTabDragLeave(dragSession.over);
    dragSession.over = hover;
  }
  event.sender.send("popout:drag-state", !target ? "desktop" : target === source ? "self" : target === mainWindowOf() ? "main" : "popout");
  if (hover) sendTabDragOver(hover, { x, y });
});

ipcMain.handle("popout:drag-end", (event, _place, x, y) => {
  const session = dragSession;
  if (session?.source.webContents.id !== event.sender.id) return "none";
  dragSession = null;
  sendTabDragLeave(session.over);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return "none";
  const main = mainWindowOf();
  const target = windowAtScreenPoint(x, y);
  if (target === main) {
    // Dropped back on the main window: it takes the tab. A tab that started there just snaps back.
    if (session.source === main) return "none";
    main.webContents.send("window:tab-received", { location: session.place, activate: true });
    showWindow(main);
    return "returned";
  }
  if (!target && session.source === main) {
    // Released over the desktop: the tab gets its own window there. Already having one brings that forward.
    const existing = findPopout(session.place);
    if (existing) showPopoutWindow(existing);
    else createPopoutWindow(session.place, { x, y });
    return "created";
  }
  // Anywhere else (over another view window, or the edge of the screen with no window): the tab snaps back.
  return "none";
});

ipcMain.on("popout:drag-cancel", (event) => {
  if (dragSession?.source.webContents.id !== event.sender.id) return;
  const over = dragSession.over;
  dragSession = null;
  sendTabDragLeave(over);
});

// On Linux Electron's shell.openExternal and shell.openPath can report success without opening anything (seen on
// KDE), so xdg-open is run directly. Resolves like shell.openPath: "" when it started, else the problem. xdg-open
// may wait for the program it starts, so no word after a moment counts as started.
function xdgOpen(target) {
  console.info(`Opening ${target} with xdg-open`);
  return new Promise((resolve) => {
    const child = spawn("xdg-open", [target], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    const timer = setTimeout(() => resolve(""), 1500);
    child.stderr.on("data", (chunk) => (errors += chunk));
    child.on("error", (e) => {
      clearTimeout(timer);
      console.warn(`xdg-open could not start: ${e.message}`);
      resolve(`Couldn't open it: ${e.message}`);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code) console.warn(`xdg-open exited with ${code}: ${errors.trim()}`);
      resolve(code ? `Couldn't open it: ${errors.trim() || `xdg-open exited with ${code}`}` : "");
    });
    child.unref();
  });
}

function openInBrowser(url) {
  if (process.platform === "linux") void xdgOpen(url);
  else shell.openExternal(url).catch((e) => console.warn(`Opening ${url} in the browser failed: ${e.message}`));
}

const openPath = (target) => (process.platform === "linux" ? xdgOpen(target) : shell.openPath(target));

function windowOf(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

ipcMain.on("window:minimize", (event) => windowOf(event)?.minimize());
ipcMain.on("window:toggle-maximize", (event) => {
  const win = windowOf(event);
  if (win) win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on("window:close", (event) => windowOf(event)?.close());
// A clicked notification brings the window forward.
ipcMain.on("window:focus", (event) => {
  const win = windowOf(event);
  if (win) showWindow(win);
});
// The page's icon in the theme's colors, with its mention badge drawn on, plus the macOS dock's own badge. Linux
// taskbars take the launcher's icon, so it gets the badged icon too (KDE draws no count from setBadgeCount). Windows
// draws the taskbar button from our Start Menu shortcut (windowsShortcut.js), so the shortcut and the windows get the
// icon without the badge (`extra.plain`) and the count goes over the button as an overlay (`extra.badge`): drawn in
// as well, it would show twice while no shortcut exists yet.
const pngUrl = (url) => typeof url === "string" && url.startsWith("data:image/png;base64,");
const pngImage = (url) => {
  const image = pngUrl(url) ? nativeImage.createFromDataURL(url) : null;
  return image && !image.isEmpty() ? image : null;
};
ipcMain.on("window:set-icon", (event, dataUrl, count, extra) => {
  // Only the main window owns the icon and the badge; a view window's page doesn't draw them.
  if (isPopoutWindow(windowOf(event))) return;
  const image = pngImage(dataUrl);
  if (!image) return;
  setLauncherIcon(image.toPNG());
  if (process.platform === "win32") {
    const plain = pngImage(extra?.plain) ?? image;
    const badge = pngImage(extra?.badge);
    for (const win of BrowserWindow.getAllWindows()) win.setIcon?.(plain);
    mainWindowOf()?.setOverlayIcon(badge, badge ? `${count} unread` : "");
    setShortcutIcon(plain.toPNG());
  } else {
    for (const win of BrowserWindow.getAllWindows()) win.setIcon?.(image);
  }
  if (process.platform === "darwin") app.dock?.setIcon(image);
  setTrayIcon(image);
  if (process.platform === "darwin" && Number.isInteger(count) && count >= 0) app.setBadgeCount(count);
});
ipcMain.handle("window:is-maximized", (event) => windowOf(event)?.isMaximized() ?? false);
// Here and not in the page, so the download site needs no CORS rules (core/updates.ts).
ipcMain.handle("app:latest-version", async () => {
  try {
    const response = await net.fetch("https://makework.dev/download/latest.json", { cache: "no-store" });
    return response.ok ? (await response.json()).version ?? null : null;
  } catch {
    return null;
  }
});
ipcMain.handle("app:take-last-crash", () => {
  try {
    const crash = JSON.parse(readFileSync(lastCrashFile, "utf8"));
    rmSync(lastCrashFile, { force: true });
    return crash;
  } catch {
    return null;
  }
});

// Google sign-in for installed apps: the system browser signs in and redirects to a one-off loopback server
// here; the code is exchanged with PKCE. Resolves with Google's ID and access tokens.
let googleSignIn = null;
async function signInWithGoogle({ clientId, clientSecret, nonce, scope, loginHint }) {
  googleSignIn?.cancel();
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  let redirectUri = "";
  const flow = loopbackOnce({
    path: "/",
    accept: (url) => url.searchParams.get("state") === state,
    page: (url) => url.searchParams.get("code")
      ? { ok: true, title: "Signed in with Google", message: "You can close this tab and go back to MakeWork." }
      : { ok: false, title: "Sign-in cancelled", message: "Nothing changed. Go back to MakeWork to try again." },
    timeoutMs: 5 * 60_000,
    open: (base) => {
      redirectUri = base;
      const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      auth.search = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
        prompt: "select_account", state, nonce,
        ...(loginHint ? { login_hint: loginHint } : {}),
      }).toString();
      openInBrowser(auth.toString());
    },
  });
  googleSignIn = flow;
  let url;
  try {
    url = await flow.promise;
  } finally {
    if (googleSignIn === flow) googleSignIn = null;
  }
  const code = url.searchParams.get("code");
  if (!code) throw new Error("Sign-in was cancelled.");
  const token = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret, code_verifier: verifier,
      grant_type: "authorization_code", redirect_uri: redirectUri,
    }),
  }).then((r) => r.json());
  if (!token.id_token) throw new Error(token.error_description ?? token.error ?? "Google sent no ID token.");
  return { idToken: token.id_token, accessToken: token.access_token };
}
ipcMain.handle("google:sign-in", (_event, options) => signInWithGoogle(options));

// GitHub sign-in through the user server: the system browser goes to GitHub, and the user server sends it back to a
// one-off loopback port here with a one-time code. Only this computer's browser can reach that port, so a sign-in
// link someone else started can't hand them this person's answer. Resolves with the code; the app then fetches the
// answer with it and its session id.
let githubSignIn = null;
async function signInWithGitHub({ server, session }) {
  const base = new URL(String(server));
  if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error("Not a user server address.");
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(String(session))) throw new Error("Bad session.");
  githubSignIn?.cancel();
  const flow = loopbackOnce({
    path: "/github",
    accept: (url) => /^[A-Za-z0-9_-]{16,64}$/.test(url.searchParams.get("once") ?? ""),
    page: (url) => url.searchParams.get("status") === "error"
      ? { ok: false, title: "GitHub sign-in didn't finish", message: "Go back to MakeWork to see why and try again." }
      : { ok: true, title: "Signed in with GitHub", message: "You can close this tab and go back to MakeWork to finish." },
    timeoutMs: 10 * 60_000,
    open: (_base, port) => {
      const start = new URL(`${trimEnd(base.href, "/")}/github/start`);
      start.search = new URLSearchParams({ session, port: String(port) }).toString();
      openInBrowser(start.toString());
    },
  });
  githubSignIn = flow;
  try {
    return (await flow.promise).searchParams.get("once");
  } finally {
    if (githubSignIn === flow) githubSignIn = null;
  }
}
ipcMain.handle("github:sign-in", (_event, options) => signInWithGitHub(options ?? {}));
ipcMain.handle("github:cancel", () => githubSignIn?.cancel());

// Server file content, one file per SHA-256 (hex). Servers in the app's storage share <userData>/local/content;
// a server in a folder of its own keeps its content in <folder>/.makework/content (electron/storage.js). Written only
// when the data matches its hash, so a file is always exactly what its name says, wherever it is.
const localDir = () => path.join(app.getPath("userData"), "local");
const exists = (file) => fs.access(file).then(() => true, () => false);

const checkServerId = (id) => {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id ?? "")) throw new Error("Not a workspace id.");
  return id;
};

// workspaceId -> its folder, for servers kept in a folder of their own (loaded at start).
const registryFile = () => path.join(app.getPath("userData"), "server-locations.json");
// No prototype: ids come from the page, and "__proto__" or "constructor" must not find Object.prototype's members.
let locations = Object.create(null);
const sharedContentDir = () => path.join(localDir(), "content");
const contentDir = (workspaceId) => (workspaceId && locations[workspaceId] ? contentDirOf(locations[workspaceId]) : sharedContentDir());
const partialDir = (workspaceId) => (workspaceId && locations[workspaceId] ? partialDirOf(locations[workspaceId]) : path.join(localDir(), "content-partial"));
const allContentDirs = () => [...Object.values(locations).map(contentDirOf), sharedContentDir()];
const allPartialDirs = () => [...Object.values(locations).map(partialDirOf), path.join(localDir(), "content-partial")];

// Dev runs are another computer (their own profile): their readable folders never mix with the installed app's.
const mirrorRoot = () => path.join(app.getPath("home"), installed ? "MakeWork" : "MakeWork-dev");
const {
  findContent, loadPlacements, applyMirror, readManifest, manifestPath, mirrorBase, unchanged, isText, removeMirrorFiles,
  remember, forget, removePlaced, scan: scanMirror, adopt: adoptMirrorFile, unwatch: unwatchMirror,
} = createPlaces({
  localDir, mirrorRoot, locations: () => locations, contentDir, sharedContentDir, allContentDirs, trashLater: (file) => trashLater(file),
  onChanges: (key, changes) => BrowserWindow.getAllWindows().forEach((win) => win.webContents.send("mirror:changes", key, changes)),
});

async function requireContent(hash) {
  const file = await findContent(hash);
  if (!file) throw new Error("That file isn't on this computer.");
  return file;
}

// Never whole files over IPC: Chromium kills the page for messages over about 128 MB. Content comes in and
// goes out one chunk at a time; uploads build up in content-temp (emptied at start), downloads in
// content-partial/<hash>.part, kept until finished so they can resume.
const partialPath = (hash, workspaceId) => path.join(partialDir(workspaceId), `${checkHash(hash)}.part`);
const tempDir = () => path.join(localDir(), "content-temp");
const parts = new Map();

ipcMain.handle("content:has", async (_event, hash) => !!(await findContent(hash)));
ipcMain.handle("content:size", async (_event, hash) => {
  try {
    return (await fs.stat(await requireContent(hash))).size;
  } catch {
    return null;
  }
});
ipcMain.handle("content:read-range", async (_event, hash, start, end) => {
  let handle;
  try {
    handle = await fs.open(await requireContent(hash), "r");
  } catch {
    return null;
  }
  try {
    const bytes = new Uint8Array(Math.max(0, end - start));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
    return bytesRead === bytes.length ? bytes : bytes.slice(0, bytesRead);
  } finally {
    await handle.close();
  }
});

// `workspaceId`: the server the content is for; it lands in that server's store.
ipcMain.handle("content:part-open", async (event, resumeHash, workspaceId) => {
  const file = resumeHash ? partialPath(resumeHash, workspaceId) : path.join(tempDir(), `${randomBytes(8).toString("hex")}.part`);
  for (const [id, part] of parts) if (part.file === file) await closePart(id, false);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const hash = createHash("sha256");
  let size = 0;
  if (resumeHash && await exists(file)) {
    for await (const chunk of createReadStream(file)) {
      hash.update(chunk);
      size += chunk.length;
    }
  }
  const id = randomBytes(8).toString("hex");
  parts.set(id, { file, handle: await fs.open(file, resumeHash ? "a" : "w"), hash, size, owner: event.sender.id, workspaceId, keep: !!resumeHash });
  return { id, size };
});
ipcMain.handle("content:part-append", async (_event, id, data) => {
  const part = parts.get(id);
  if (!part) throw new Error("No such upload or download.");
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  await part.handle.write(bytes);
  part.hash.update(bytes);
  part.size += bytes.length;
  return part.size;
});
// Moves finished content into the store under its hash; content that doesn't match `expected` is thrown away.
// `existed`: the store already had it (then the part is dropped).
ipcMain.handle("content:part-finish", async (_event, id, expected) => {
  const part = parts.get(id);
  if (!part) throw new Error("No such upload or download.");
  parts.delete(id);
  await part.handle.close();
  const hash = part.hash.digest("hex");
  if (expected && hash !== expected) {
    await fs.rm(part.file, { force: true });
    throw new Error("Content does not match its hash.");
  }
  const file = path.join(contentDir(part.workspaceId), hash);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Also when it is only in a readable folder: a second copy in the store would never go.
  const existed = !!(await findContent(hash));
  if (existed) await fs.rm(part.file, { force: true });
  else {
    await fs.rename(part.file, file);
    remember(hash, file);
  }
  return { hash, existed };
});
ipcMain.handle("content:part-close", (_event, id, discard) => closePart(id, discard));
// Removes the content from every store: nothing on this computer wants it any more. A download still writing the
// part has it open: close that first. Content a video still streams can't be deleted on Windows yet; it goes to
// the trash list and is removed at the next start.
ipcMain.handle("content:delete", async (_event, hash) => {
  checkHash(hash);
  for (const [id, part] of parts) if (path.basename(part.file) === `${hash}.part`) await closePart(id, false);
  const files = [...allContentDirs().map((dir) => path.join(dir, hash)), ...allPartialDirs().map((dir) => path.join(dir, `${hash}.part`))];
  for (const file of files) await removeOrDefer(file, { rm: fs.rm, later: trashLater });
  // Readable copies too, unless someone changed them.
  await removePlaced(hash);
  forget(hash);
});
// Only the shared store's copy: after a server moved its content into its own folder.
ipcMain.handle("content:delete-shared", async (_event, hash) => {
  await removeOrDefer(path.join(sharedContentDir(), checkHash(hash)), { rm: fs.rm, later: trashLater });
  forget(hash);
});

const trashFile = () => path.join(localDir(), "content-trash.json");
async function readTrash() {
  try {
    return JSON.parse(await fs.readFile(trashFile(), "utf8"));
  } catch {
    return [];
  }
}
async function trashLater(file) {
  const trash = await readTrash();
  if (!trash.includes(file)) await fs.writeFile(trashFile(), JSON.stringify([...trash, file]));
}
// At start nothing has the files open any more.
async function emptyTrash() {
  const left = [];
  for (const file of await readTrash()) await fs.rm(file, { force: true }).catch(() => left.push(file));
  if (left.length) await fs.writeFile(trashFile(), JSON.stringify(left));
  else await fs.rm(trashFile(), { force: true });
}

async function closePart(id, discard) {
  const part = parts.get(id);
  if (!part) return;
  parts.delete(id);
  await part.handle.close().catch(() => {});
  if (discard || !part.keep)
    await removeOrDefer(part.file, { rm: fs.rm, later: trashLater });
}

// Parts a page left open when it reloaded or closed.
function closePartsOf(contentsId) {
  for (const [id, part] of parts) if (part.owner === contentsId) void closePart(id, false);
}

function serveContent() {
  // Content has no type, and browsers sniff every image type but SVG, which only shows as image/svg+xml. By hash, so
  // the answer never changes.
  const svgStart = /^\uFEFF?\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i;
  const svgByHash = new Map();
  const isSvg = async (hash, file) => {
    if (!svgByHash.has(hash)) {
      const handle = await fs.open(file);
      try {
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(1024), 0, 1024, 0);
        svgByHash.set(hash, svgStart.test(buffer.subarray(0, bytesRead).toString("utf8")));
      } finally {
        await handle.close();
      }
    }
    return svgByHash.get(hash);
  };
  protocol.handle("mwc", async (request) => {
    const { hostname, pathname } = new URL(request.url);
    const name = pathname.slice(1);
    // mwc://converted/<name>: video converted with the computer's ffmpeg (videoTools.js).
    if (hostname === "converted") {
      if (!videoTools.isConvertedName(name)) return new Response("Not found", { status: 404 });
      const file = path.join(convertedDir(), name);
      const size = await fs.stat(file).then((stat) => stat.size, () => null);
      if (size === null) return new Response("Not found", { status: 404 });
      const type = name.endsWith(".m4a") ? "audio/mp4" : "video/mp4";
      return serveFile(request, file, size, { "Access-Control-Allow-Origin": appOrigin, "Accept-Ranges": "bytes", "Cache-Control": "no-store", "Content-Type": type });
    }
    // mwc://sound/<hash>?t=<seconds>: a content file's sound, decoded by the computer's ffmpeg as it plays.
    if (hostname === "sound") {
      if (!/^[0-9a-f]{64}$/.test(name)) return new Response("Not found", { status: 404 });
      const input = await findContent(name);
      if (!input) return new Response("Not found", { status: 404 });
      const { stream, stop } = await videoTools.streamSound(input, Number(new URL(request.url).searchParams.get("t")) || 0);
      request.signal?.addEventListener("abort", stop);
      return new Response(Readable.toWeb(stream), {
        status: 200, headers: { "Access-Control-Allow-Origin": appOrigin, "Cache-Control": "no-store", "Content-Type": "audio/aac" },
      });
    }
    const hash = name;
    if (hostname !== "content" || !/^[0-9a-f]{64}$/.test(hash)) return new Response("Not found", { status: 404 });
    let size;
    let file;
    try {
      file = await requireContent(hash);
      size = (await fs.stat(file)).size;
    } catch {
      return new Response("Not found", { status: 404 });
    }
    const headers = { "Access-Control-Allow-Origin": appOrigin, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
    // An SVG opened on its own must not run its scripts.
    if (await isSvg(hash, file).catch(() => false))
      Object.assign(headers, { "Content-Type": "image/svg+xml", "Content-Security-Policy": "script-src 'none'" });
    return serveFile(request, file, size, headers);
  });
}

// A file from disk, in ranges when asked (video and audio seek with them).
function serveFile(request, file, size, headers) {
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (range && size > 0 && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    const body = Readable.toWeb(createReadStream(file, { start, end }));
    return new Response(body, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) } });
  }
  const body = Readable.toWeb(createReadStream(file));
  return new Response(body, { status: 200, headers: { ...headers, "Content-Length": String(size) } });
}

// Video the page's player can't decode, converted with the computer's ffmpeg (videoTools.js), kept in local/converted.
const convertedDir = () => path.join(localDir(), "converted");
const conversions = new Map();
ipcMain.handle("video:has-ffmpeg", async () => !!(await videoTools.findFfmpeg()));
ipcMain.handle("video:probe-sound", async (_event, hash) => videoTools.probeSound(await requireContent(checkHash(hash))));
ipcMain.handle("video:cached", (_event, hash, kind) => videoTools.cachedConversion(convertedDir(), checkHash(hash), kind === "sound" ? "sound" : "video"));
// Resolves with the result's name or "none"; progress goes to the page as "video:progress" (id, 0..1).
ipcMain.handle("video:convert", async (event, id, hash, kind) => {
  const controller = new AbortController();
  conversions.set(id, controller);
  try {
    return await videoTools.convert({
      dir: convertedDir(), hash: checkHash(hash), kind: kind === "sound" ? "sound" : "video", input: await requireContent(checkHash(hash)),
      signal: controller.signal, onProgress: (value) => !event.sender.isDestroyed() && event.sender.send("video:progress", id, value),
    });
  } finally {
    conversions.delete(id);
  }
});
ipcMain.on("video:cancel", (_event, id) => conversions.get(id)?.abort());

ipcMain.handle("mirror:apply", (_event, key, workspaceName, entries) => applyMirror(key, workspaceName, entries));
ipcMain.handle("mirror:scan", (_event, key) => scanMirror(key));
ipcMain.handle("mirror:adopt", (_event, key, relative, stats, moveTo) => adoptMirrorFile(key, relative, stats, moveTo));

// Saving files and folders to the computer. The user picks a folder (or a file name) in a dialog; the page then
// writes content there through a token, never to paths of its own choosing. Inside a picked folder nothing is
// overwritten: a taken name becomes "name (2)". MAKEWORK_TEST_SAVE_DIR replaces the dialog in automated checks.
const saveTargets = new Map();

ipcMain.handle("save:choose", async (event, kind, suggestedName) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const testDir = testEnv("MAKEWORK_TEST_SAVE_DIR");
  let dir;
  let file = null;
  if (testDir) {
    dir = testDir;
    if (kind === "file") file = await freePath(path.join(dir, safeSegment(suggestedName)));
  } else if (kind === "folder") {
    const picked = await dialog.showOpenDialog(win, { title: "Save to folder", properties: ["openDirectory", "createDirectory"] });
    if (picked.canceled || !picked.filePaths[0]) return null;
    dir = picked.filePaths[0];
  } else {
    const picked = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath("downloads"), safeSegment(suggestedName)) });
    if (picked.canceled || !picked.filePath) return null;
    file = picked.filePath;
    dir = path.dirname(file);
  }
  // Dialogs can hand back "/home/me/Downloads/"; normalized, so paths built from it compare cleanly.
  dir = path.resolve(dir);
  const id = randomBytes(8).toString("hex");
  saveTargets.set(id, { dir, file });
  return { id, where: file ?? dir };
});

// A folder under the picked one; with `free`, its last name is made free first. Returns the names it got.
ipcMain.handle("save:mkdir", async (_event, id, segments, free) => {
  const target = saveTargets.get(id);
  if (!target) throw new Error("Choose where to save first.");
  let folder = inside(target.dir, segments);
  if (free) folder = await freePath(folder);
  await fs.mkdir(folder, { recursive: true });
  return path.relative(target.dir, folder).split(path.sep);
});

// Copies content to `segments` under the picked folder, or to the picked file (the dialog already asked about
// replacing it).
ipcMain.handle("save:write", async (_event, id, segments, hash) => {
  const target = saveTargets.get(id);
  if (!target) throw new Error("Choose where to save first.");
  const file = target.file ?? await freePath(inside(target.dir, segments));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.copyFile(await requireContent(hash), file, fsConstants.COPYFILE_FICLONE);
  return file;
});
ipcMain.handle("save:done", (_event, id) => void saveTargets.delete(id));

// Local git repositories for version control channels. Only folders the user picked in the dialog (remembered
// in <userData>/git-folders.json) can be read; git runs without a shell and never asks for credentials.
const gitFoldersFile = () => path.join(app.getPath("userData"), "git-folders.json");
const readGitFolders = async () => {
  try {
    return new Set(JSON.parse(await fs.readFile(gitFoldersFile(), "utf8")));
  } catch {
    return new Set();
  }
};

function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 30_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout, stderr) => {
        // Git comes with Linux development setups, not with Windows.
        if (error?.code === "ENOENT") reject(new Error("Git isn't installed. Install it from git-scm.com and try again."));
        else if (error) reject(new Error((stderr || error.message).trim()));
        else resolve(stdout);
      });
  });
}

async function pickedFolder(folder) {
  if (!(await readGitFolders()).has(folder)) throw new Error("Pick the folder again: it isn't one this app may read.");
  return folder;
}

// MAKEWORK_TEST_GIT_FOLDER replaces the dialog in automated checks.
ipcMain.handle("git:pick-folder", async (event) => {
  const testFolder = testEnv("MAKEWORK_TEST_GIT_FOLDER");
  const picked = testFolder ? { canceled: false, filePaths: [testFolder] }
    : await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { title: "Choose a git repository", properties: ["openDirectory"] });
  if (picked.canceled || !picked.filePaths[0]) return null;
  let root;
  try {
    root = (await runGit(picked.filePaths[0], ["rev-parse", "--show-toplevel"])).trim();
  } catch (e) {
    throw new Error(String(e.message).startsWith("Git isn't installed") ? e.message : "That folder isn't a git repository.");
  }
  const origin = (await runGit(root, ["remote", "get-url", "origin"]).catch(() => "")).trim();
  const folders = await readGitFolders();
  folders.add(root);
  await fs.writeFile(gitFoldersFile(), JSON.stringify([...folders]));
  return { path: root, name: path.basename(root), origin };
});

ipcMain.handle("git:branches", async (_event, folder) => {
  const cwd = await pickedFolder(folder);
  const out = await runGit(cwd, ["for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/heads"]);
  const branches = out.split("\n").filter(Boolean).map((line) => {
    const [name, head] = line.split("\t");
    return { name, head };
  });
  const current = (await runGit(cwd, ["symbolic-ref", "--short", "HEAD"]).catch(() => "")).trim() || branches[0]?.name || "";
  return { current, branches };
});

// Commits reachable from `from`, newest first. Fields split by unit separators, commits by record separators.
ipcMain.handle("git:log", async (_event, folder, from, skip, max) => {
  const cwd = await pickedFolder(folder);
  if (!/^[\w./-]+$/.test(from) || from.startsWith("-")) throw new Error("Not a branch or commit.");
  const out = await runGit(cwd, ["log", `--skip=${Number(skip) || 0}`, `--max-count=${Number(max) || 100}`,
    "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%B%x1e", from, "--"]);
  return out.split("\x1e").map((record) => record.replace(/^\n/, "")).filter(Boolean).map((record) => {
    const [sha, parents, author_name, author_email, authored_at, message] = record.split("\x1f");
    return { sha, parents: parents.split(" ").filter(Boolean), author_name, author_email, authored_at, message: trimEnd(message.replace(/\r\n?/g, "\n"), "\n") };
  });
});

// Reading and changing a picked repository: one handler per operation, all in gitOps.js with its safety checks (no
// forcing or history rewriting anywhere). The page never gets a general way to run git.
const gitRunner = gitOps.createGit();
// Changes to one folder (commits, branches, fetch, push, merge) run one after another, never interleaved.
const gitQueues = new Map();
const gitSerial = (folder, action) => {
  const next = (gitQueues.get(folder) ?? Promise.resolve()).then(action, action);
  gitQueues.set(folder, next.catch(() => {}));
  return next;
};
const gitRead = (channel, fn) => ipcMain.handle(channel, async (_event, folder, ...args) => fn(await pickedFolder(folder), ...args));
const gitWrite = (channel, fn) => ipcMain.handle(channel, async (_event, folder, ...args) => {
  const cwd = await pickedFolder(folder);
  return gitSerial(cwd, () => fn(cwd, ...args));
});
// The signed-in MakeWork account, whose host connections (kept as the secrets "<account>:<host>" and
// "<account>:<host>#<id>", as core/secrets.ts names them) are the only credentials fetch, pull and push get for those
// hosts, and which connection each working copy's channel uses (`credentials`: folder -> key, "" for none; see
// plugins/builtin/git/connections.ts). The tokens stay here.
const accountPattern = /^[\w-]{1,128}$/;
const connectionPattern = /^$|^[a-z0-9.-]+(#[a-z0-9]+)?$/;
let gitAccount = null;
let gitCredentials = new Map();
ipcMain.handle("git:account", (_event, id, credentials) => {
  gitAccount = typeof id === "string" && accountPattern.test(id) ? id : null;
  gitCredentials = new Map(Object.entries(credentials && typeof credentials === "object" ? credentials : {})
    .filter(([folder, key]) => typeof folder === "string" && typeof key === "string" && connectionPattern.test(key)));
});
const gitNetwork = (channel, fn) => ipcMain.handle(channel, async (_event, folder, ...args) => {
  const account = gitAccount;
  const chosen = gitCredentials.get(folder);
  const git = gitOps.withCredentials(gitRunner, (host) => {
    const name = gitOps.credentialName(host, chosen);
    return account && name ? readSecret(`${account}:${name}`) : null;
  });
  const cwd = await pickedFolder(folder);
  return gitSerial(cwd, () => fn(git, cwd, ...args));
});
gitRead("git:status", async (cwd) => ({ ...(await gitOps.repoState(gitRunner, cwd)), files: await gitOps.status(gitRunner, cwd) }));
gitRead("git:working-diff", (cwd, file) => gitOps.workingDiff(gitRunner, cwd, file));
gitRead("git:show", (cwd, sha) => gitOps.showCommit(gitRunner, cwd, sha));
gitRead("git:files", (cwd, rev) => gitOps.listFiles(gitRunner, cwd, rev));
gitRead("git:blame", (cwd, rev, file) => gitOps.blame(gitRunner, cwd, rev, file));
gitRead("git:branch-list", (cwd) => gitOps.branches(gitRunner, cwd));
gitRead("git:graph", (cwd, options) => gitOps.graph(gitRunner, cwd, { max: options?.max, skip: options?.skip }));
gitRead("git:remote-heads", (cwd) => gitOps.remoteHeads(gitRunner, cwd));
gitWrite("git:branch-create", (cwd, name, from) => gitOps.createBranch(gitRunner, cwd, name, from));
gitWrite("git:branch-delete", (cwd, name, protectedNames) =>
  gitOps.deleteBranch(gitRunner, cwd, name, Array.isArray(protectedNames) ? protectedNames.filter((n) => typeof n === "string") : []));
gitWrite("git:switch", (cwd, name) => gitOps.switchBranch(gitRunner, cwd, name));
gitWrite("git:commit", (cwd, options) => gitOps.commit(gitRunner, cwd, {
  paths: options?.paths, message: options?.message, allowMassDelete: options?.allowMassDelete === true,
}));
gitNetwork("git:fetch", (git, cwd) => gitOps.fetchRemote(git, cwd));
gitNetwork("git:push-check", (git, cwd, branch) => gitOps.pushCheck(git, cwd, typeof branch === "string" ? branch : null));
gitNetwork("git:push", (git, cwd, options) => gitOps.push(git, cwd, {
  allowMassDelete: options?.allowMassDelete === true, branch: typeof options?.branch === "string" ? options.branch : null,
}));
// Pull: the remote's new commits on the current branch, merged only when clean.
gitNetwork("git:merge", (git, cwd) => gitOps.mergeRemote(git, cwd));

// Signing in to GitHub for repositories with the device flow: the user enters a code on github.com in their browser,
// this polls until they approved, and the token goes straight into the secrets file for "<account>:github.com".
// From here because github.com's OAuth endpoints don't answer pages (no CORS). Scopes: repo (private repositories,
// pushing, releases) and workflow (pushes that touch .github/workflows are refused without it).
const deviceFlows = new Map();
const githubForm = (url, body) => net.fetch(url, {
  method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "MakeWork" }, body: JSON.stringify(body),
}).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollDeviceFlow(clientId, code, key, flow) {
  let interval = Math.max(5, Number(code.interval) || 5);
  const deadline = Date.now() + (Number(code.expires_in) || 900) * 1000;
  while (!flow.cancelled && Date.now() < deadline) {
    await pause(interval * 1000);
    if (flow.cancelled) break;
    let answer;
    try {
      answer = (await githubForm("https://github.com/login/oauth/access_token", {
        client_id: clientId, device_code: code.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      })).body;
    } catch {
      continue; // Offline for a moment: ask again at the next interval.
    }
    if (answer.access_token) {
      await writeSecret(key, answer.access_token);
      const user = await net.fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${answer.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "MakeWork" },
      }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
      return { ok: true, login: typeof user.login === "string" ? user.login : null };
    }
    if (answer.error === "slow_down") interval = Number(answer.interval) || interval + 5;
    else if (answer.error === "access_denied") return { ok: false, reason: "denied" };
    else if (answer.error === "expired_token") return { ok: false, reason: "expired" };
    else if (answer.error !== "authorization_pending") return { ok: false, reason: "failed", message: answer.error_description ?? answer.error ?? "no answer" };
  }
  return { ok: false, reason: flow.cancelled ? "cancelled" : "expired" };
}

ipcMain.handle("github:device-start", async (_event, clientId, account) => {
  if (typeof clientId !== "string" || !/^[\w.-]{8,64}$/.test(clientId)) throw new Error("No GitHub app is set up for MakeWork on this user server.");
  if (typeof account !== "string" || !accountPattern.test(account)) throw new Error("Sign in to MakeWork first.");
  if (!safeStorage.isEncryptionAvailable()) throw new Error("This system has no keychain to keep the GitHub sign-in encrypted.");
  const { status, body: code } = await githubForm("https://github.com/login/device/code", { client_id: clientId, scope: "repo workflow" });
  if (!code.device_code) {
    throw new Error(code.error === "device_flow_disabled"
      ? "MakeWork's GitHub app doesn't allow this sign-in yet: tick \"Enable Device Flow\" in its settings on GitHub."
      : `GitHub refused the sign-in: ${code.error_description ?? code.error ?? `HTTP ${status}`}`);
  }
  const handle = randomBytes(8).toString("hex");
  const flow = { cancelled: false };
  flow.result = pollDeviceFlow(clientId, code, `${account}:github.com`, flow)
    .catch((e) => ({ ok: false, reason: "failed", message: e.message }))
    .finally(() => setTimeout(() => deviceFlows.delete(handle), 60_000));
  deviceFlows.set(handle, flow);
  // Only GitHub's own page, whatever the answer named.
  const verificationUri = "https://github.com/login/device";
  openInBrowser(verificationUri);
  return { handle, userCode: String(code.user_code ?? ""), verificationUri, expiresIn: Number(code.expires_in) || 900 };
});
ipcMain.handle("github:device-wait", (_event, handle) => deviceFlows.get(handle)?.result ?? { ok: false, reason: "expired" });
ipcMain.handle("github:device-cancel", (_event, handle) => {
  const flow = deviceFlows.get(handle);
  if (flow) flow.cancelled = true;
});
ipcMain.handle("github:open-device-page", () => openInBrowser("https://github.com/login/device"));
// Web lookups for agents (electron/webLookup.js): public sites only, answered as plain text.
// Through a configured proxy only Chromium's connection gets out, and the proxy picks the address anyway.
const readPage = async (url, init) =>
  ((await session.defaultSession.resolveProxy(url)) === "DIRECT" ? connectPublic(url, init) : net.fetch(url, init));
const webLookup = createLookup({ fetch: readPage, searchFetch: (url, init) => net.fetch(url, init) });
ipcMain.handle("web:read", (_event, address) => webLookup.read(String(address)));
ipcMain.handle("web:search", (_event, query) => webLookup.search(String(query)));
// Media for the media bot (electron/mediaSource.js): yt-dlp finds the streams, mwmedia://stream/<token> hands them to the page.
const mediaSource = createMediaSource({
  spawn, fetch: (url, init) => net.fetch(url, init), toolDir: path.join(app.getPath("userData"), "tools"),
  // yt-dlp runs this app's own binary as Node for YouTube's scripts.
  runtime: { path: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } },
});
ipcMain.handle("media:resolve", (_event, address, audioOnly) => mediaSource.resolve(String(address), audioOnly === true));
ipcMain.handle("media:list", (_event, address) => mediaSource.list(String(address)));
ipcMain.handle("media:release", (_event, session) => mediaSource.release(String(session)));

// Code channels: run folders, language servers and terminals (electron/codeTools.js). node-pty is a native module;
// without it there are no terminals, the rest still works.
let ptyModule;
const loadPty = () => (ptyModule ??= import("@lydell/node-pty").then((m) => m.default ?? m, (e) => { console.warn("No terminals:", e.message); return null; }));
const commandApproval = createCommandApproval({
  file: path.join(app.getPath("userData"), "approved-commands.json"),
  ask: ({ event, message, detail, confirm }) => dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
    type: "warning", buttons: [confirm, "Cancel"], defaultId: 1, cancelId: 1, noLink: true, message, detail,
  }).then(({ response }) => response === 0),
});
const approvalFor = (event) => ({ require: (what, question) => commandApproval.require(what, { ...question, event }) });
const codeTools = createCodeTools({
  baseDir: path.join(app.getPath("userData"), "code"), serversDir: path.join(app.getPath("userData"), "language-servers"),
  findContent, spawn, loadPty, fetch: (url, init) => net.fetch(url, init),
});
ipcMain.handle("code:sync", (_event, workspaceId, channelId, entries) => codeTools.sync(workspaceId, channelId, entries));
ipcMain.handle("code:open-folder", async (_event, workspaceId, channelId) => {
  const folder = codeTools.folder(workspaceId, channelId);
  await fs.mkdir(folder, { recursive: true });
  return openPath(folder);
});
setExtensionConfirm((event, partition, extension) => approvalFor(event).require(["browser extension", partition, extension.id], {
  message: `Turn on the extension ${extension.name} in this browser channel?`, confirm: "Turn on",
  detail: "A member of this workspace chose it. Extensions can see and change every page opened in the channel, including where you are signed in.",
}));
ipcMain.handle("lsp:start", (event, serverId, workspaceId, channelId, override) =>
  codeTools.startServer(event.sender, String(serverId), workspaceId, channelId, override, ({ label, program }) =>
    approvalFor(event).require(["language server", workspaceId, channelId, String(serverId), program], {
      message: `Start the ${label} language server for this channel?`, confirm: "Start",
      detail: `${program}\n\nLanguage servers read the channel's files, and some run code from them (build scripts, project files). Start it only if you trust everyone who can edit this channel.`,
    })));
ipcMain.handle("lsp:install", (_event, serverId) => codeTools.installServer(String(serverId)));
ipcMain.handle("lsp:installed", () => codeTools.installedServers());
ipcMain.handle("lsp:uninstall", (_event, serverId) => codeTools.uninstallServer(String(serverId)));
ipcMain.on("lsp:send", (_event, id, text) => codeTools.sendServer(id, text));
ipcMain.on("lsp:stop", (_event, id) => codeTools.stopServer(id));
ipcMain.handle("term:start", async (event, options) => {
  const { workspaceId, channelId, command, shell } = options ?? {};
  const run = typeof command === "string" && command.trim();
  await approvalFor(event).require(["terminal", workspaceId, channelId, shell ?? null, run || null], run
    ? { message: "Run this command on your computer?", detail: `${commandText(command)}${shell ? `\n\nWith ${commandText(shell)}` : ""}`, confirm: "Run" }
    : { message: "Open a terminal for this channel?", detail: commandText(shell || "Your default shell, in the channel's run folder."), confirm: "Open" });
  return codeTools.startTerminal(event.sender, options ?? {});
});
ipcMain.handle("term:available", async () => !!(await loadPty()));
ipcMain.on("term:write", (_event, id, data) => codeTools.writeTerminal(id, data));
ipcMain.on("term:resize", (_event, id, cols, rows) => codeTools.resizeTerminal(id, cols, rows));
ipcMain.on("term:kill", (_event, id) => codeTools.killTerminal(id));
ipcMain.handle("term:restart", (_event, id) => codeTools.restartTerminal(Number(id)));
// Closing a terminal for good also closes its window, if it has one.
ipcMain.on("term:close", (_event, id) => {
  codeTools.closeTerminal(Number(id));
  terminalWindows.get(Number(id))?.destroy();
});
// Pops a terminal out (at a screen point, else the cursor), or brings its window forward if it has one.
ipcMain.handle("term:popout", (_event, id, at) => {
  id = Number(id);
  if (!codeTools.terminalOwner(id)) throw new Error("That terminal has ended.");
  const open = terminalWindows.get(id);
  if (open && !open.isDestroyed()) return showPopoutWindow(open);
  const point = Number.isFinite(at?.x) && Number.isFinite(at?.y) ? { x: Math.round(at.x), y: Math.round(at.y) } : undefined;
  createTerminalWindow(id, point);
});
ipcMain.handle("term:adopt", (event, id) => codeTools.adoptTerminal(event.sender, Number(id)));
// Returns a popped-out terminal to its panel: closing its window does that (codeTools hands it back).
ipcMain.on("term:return", (_event, id) => terminalWindows.get(Number(id))?.close());
gitWrite("git:merge-branch", (cwd, source) => gitOps.mergeBranch(gitRunner, cwd, source));
gitWrite("git:merge-into", (cwd, target) => gitOps.mergeCurrentInto(gitRunner, cwd, target));
// Resolving a merge that would conflict: reading it (nothing is touched), then the merge with the user's choices.
const mergeTarget = (t) => (t?.kind === "pull" ? { kind: "pull" }
  : t?.kind === "branch" && typeof t.source === "string" ? { kind: "branch", source: t.source }
    : t?.kind === "into" && typeof t.target === "string" ? { kind: "into", target: t.target } : null);
const fileVersion = (v) => (typeof v?.oid === "string" && typeof v?.mode === "string" ? { oid: v.oid, mode: v.mode } : null);
const resolution = (f) => (typeof f?.path !== "string" ? null
  : typeof f.content === "string" ? { path: f.path, content: f.content }
    : f.side === "receiving" || f.side === "incoming" ? { path: f.path, side: f.side }
      : f.delete === true ? { path: f.path, delete: true } : null);
gitRead("git:merge-conflicts", (cwd, target) => gitOps.mergeConflicts(gitRunner, cwd, mergeTarget(target)));
gitRead("git:merge-file", (cwd, versions) => gitOps.mergeFile(gitRunner, cwd,
  { base: fileVersion(versions?.base), receiving: fileVersion(versions?.receiving), incoming: fileVersion(versions?.incoming) }));
gitRead("git:merge-diff", (cwd, receiving, tree, file) => gitOps.mergeDiff(gitRunner, cwd, receiving, tree, file));
gitWrite("git:merge-resolved", (cwd, options) => gitOps.mergeResolved(gitRunner, cwd, {
  target: mergeTarget(options?.target), receiving: options?.receiving, incoming: options?.incoming,
  message: typeof options?.message === "string" ? options.message : "",
  files: Array.isArray(options?.files) ? options.files.map(resolution) : [],
}));
gitRead("git:stash-list", (cwd) => gitOps.stashList(gitRunner, cwd));
gitWrite("git:stash-push", (cwd, options) => gitOps.stashPush(gitRunner, cwd, {
  paths: Array.isArray(options?.paths) ? options.paths.filter((p) => typeof p === "string") : [],
  message: typeof options?.message === "string" ? options.message : "", includeUntracked: options?.includeUntracked !== false,
}));
gitWrite("git:stash-restore", (cwd, sha) => gitOps.stashRestore(gitRunner, cwd, sha));
gitWrite("git:stash-delete", (cwd, sha) => gitOps.stashDelete(gitRunner, cwd, sha));
gitWrite("git:revert-to", (cwd, sha, options) => gitOps.restoreCommit(gitRunner, cwd, sha, { allowMassDelete: options?.allowMassDelete === true }));

// Releases: building a picked folder's project (its chosen branch, in a temporary worktree) and uploading files to a
// GitHub release. Only files the build produced or the user picked in the dialog can be uploaded.
const uploadable = new Set();
let building = null;

// Wine lets Linux build the Windows installer too.
const hasWine = () => new Promise((resolve) => execFile("wine", ["--version"], { timeout: 5000 }, (error) => resolve(!error)));
const buildHost = async () => ({ platform: process.platform, wine: process.platform !== "win32" && await hasWine() });
// Whether a command a build needs can be found. Only a warning on the page: a build may set up its own PATH.
const hasTool = (name) => new Promise((resolve) => process.platform === "win32"
  ? execFile("where", [name], { timeout: 5000, windowsHide: true }, (error) => resolve(!error))
  : execFile("sh", ["-c", 'command -v "$1"', "sh", name], { timeout: 5000 }, (error) => resolve(!error)));

// The usual build of the project in a picked folder (its working copy), and the tools for it this computer lacks.
ipcMain.handle("release:inspect", async (_event, folder) => {
  const found = await detectBuild(await pickedFolder(folder), await buildHost());
  if (!found) return null;
  const missing = [];
  for (const tool of found.tools) if (!(await hasTool(tool))) missing.push(tool);
  return { label: found.label, note: found.note, plan: found.plan, missing };
});

// `plan` is a build configuration, or null for the usual build of the project the branch holds.
ipcMain.handle("release:build", async (event, folder, branch, plan) => {
  await pickedFolder(folder);
  // The branch name comes from server data: never let it look like an option.
  if (!/^[\w./-]+$/.test(branch) || branch.startsWith("-")) throw new Error("Not a branch name.");
  const checked = plan === null ? null : checkPlan(plan);
  if (building) throw new Error("A build is already running.");
  await approvalFor(event).require(["build", folder, branch, checked], {
    message: `Build ${path.basename(folder)} (${branch}) on your computer?`, confirm: "Build",
    detail: checked ? commandText(checked.steps.join("\n")) : "This runs the project's usual build, which runs the project's own code.",
  });
  if (building) throw new Error("A build is already running.");
  building = new AbortController();
  try {
    const files = await buildRelease({
      folder, branch, plan, host: await buildHost(), signal: building.signal, git: runGit,
      onLog: (line) => !event.sender.isDestroyed() && event.sender.send("release:log", line),
    });
    files.forEach((f) => uploadable.add(f.path));
    return files;
  } finally {
    building = null;
  }
});
ipcMain.on("release:stop", () => building?.abort());

// MAKEWORK_TEST_PICK_FILES (paths split by the path delimiter) replaces the dialog in automated checks.
ipcMain.handle("release:pick-files", async (event) => {
  const testFiles = testEnv("MAKEWORK_TEST_PICK_FILES");
  const picked = testFiles ? { canceled: false, filePaths: testFiles.split(path.delimiter) }
    : await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { title: "Add files to the release", properties: ["openFile", "multiSelections"] });
  if (picked.canceled) return [];
  return Promise.all(picked.filePaths.map(async (file) => {
    uploadable.add(file);
    return { path: file, name: path.basename(file), size: (await fs.stat(file)).size };
  }));
});

// `target` is where the release host wants the file: { method, url, headers } (an https URL, text headers).
ipcMain.handle("release:upload", async (event, target, file, name) => {
  if (!uploadable.has(file)) throw new Error("Add the file again: it isn't one this app may upload.");
  const headers = target?.headers;
  if (!["POST", "PUT"].includes(target?.method) || !String(target?.url).startsWith("https://")
    || typeof headers !== "object" || !Object.values(headers ?? {}).every((v) => typeof v === "string")) throw new Error("Not an upload this app makes.");
  return uploadAsset({
    target: { method: target.method, url: String(target.url), headers }, file, name, base: testEnv("MAKEWORK_TEST_GITHUB_UPLOADS"),
    onProgress: (done) => !event.sender.isDestroyed() && event.sender.send("release:progress", file, done),
  });
});

// Secrets (personal access tokens) on this device, encrypted with the system keychain. Never sent anywhere.
const secretsFile = () => path.join(app.getPath("userData"), "secrets.json");
const readSecrets = async () => {
  try {
    return JSON.parse(await fs.readFile(secretsFile(), "utf8"));
  } catch {
    return {};
  }
};
const readSecret = async (key) => {
  const stored = (await readSecrets())[key];
  if (!stored || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(stored, "base64"));
  } catch {
    return null;
  }
};
const writeSecret = async (key, value) => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("This system has no keychain to keep it encrypted.");
  const secrets = await readSecrets();
  secrets[key] = safeStorage.encryptString(String(value)).toString("base64");
  await fs.writeFile(secretsFile(), JSON.stringify(secrets), { mode: 0o600 });
};
ipcMain.handle("secret:available", () => safeStorage.isEncryptionAvailable());
ipcMain.handle("secret:get", (_event, key) => readSecret(key));
ipcMain.handle("secret:set", (_event, key, value) => writeSecret(key, value));
ipcMain.handle("secret:delete", async (_event, key) => {
  const secrets = await readSecrets();
  delete secrets[key];
  await fs.writeFile(secretsFile(), JSON.stringify(secrets), { mode: 0o600 });
});

function inside(dir, segments) {
  const file = path.join(dir, ...segments.map(safeSegment));
  if (!isInside(dir, file)) throw new Error("Not inside the chosen folder.");
  return file;
}

// "a.txt" -> "a (2).txt" while the name is taken.
async function freePath(file) {
  if (!(await exists(file))) return file;
  const ext = path.extname(file);
  const base = file.slice(0, file.length - ext.length);
  for (let n = 2; ; n++) if (!(await exists(`${base} (${n})${ext}`))) return `${base} (${n})${ext}`;
}
// `inner` (segments from the readable folder, e.g. a channel's folder) opens that folder, made when the app hasn't
// written anything there yet (files put there join the channel).
ipcMain.handle("mirror:open", async (_event, key, workspaceName, inner) => {
  const base = await mirrorBase(key, workspaceName);
  const segments = Array.isArray(inner) ? inner.filter((s) => typeof s === "string" && s).map(safeSegment) : [];
  let folder = path.join(base, ...segments);
  if (!isInside(base, folder)) folder = base;
  await fs.mkdir(folder, { recursive: true });
  return openPath(folder);
});

// A git working copy picked in the dialog before.
ipcMain.handle("git:open-folder", async (_event, folder) => openPath(await pickedFolder(folder)));

// Where serverless servers are kept (electron/storage.js). A folder only becomes a server's after the user picked
// it in the dialog here (`storage:pick` hands out a token); the page never names paths itself.
// MAKEWORK_TEST_STORAGE_DIR replaces the dialog in automated checks (a new subfolder of it per pick).
const pickedStorage = new Map();
const saveRegistry = async () => {
  await writeRegistry(registryFile(), locations);
  await loadPlacements();
};

// Picks a folder for a server. `workspaceId` is known for moves and joins (then a folder that is already this
// server's is accepted); a new server has no id yet. Returns { token, folder } or null.
ipcMain.handle("storage:pick", async (event, workspaceId) => {
  const folder = await chooseStorageFolder(event, "Choose a folder for the workspace");
  if (!folder) return null;
  await checkFolder(folder, workspaceId);
  return { token: handOut(folder), folder };
});

// Picks a folder that already holds a server (one left with its data kept, or a copy from elsewhere), to import it.
// Returns { token, folder, id, name, secret } (secret only when the folder has it) or null.
ipcMain.handle("storage:pick-existing", async (event) => {
  const folder = await chooseStorageFolder(event, "Choose a workspace's folder");
  if (!folder) return null;
  const marker = await readServerFile(folder);
  if (!marker) throw new Error("That folder doesn't hold a MakeWork workspace (no .makework folder in it).");
  checkServerId(marker.id);
  await checkFolder(folder, marker.id);
  return { token: handOut(folder), folder, id: marker.id, name: marker.name ?? "", secret: marker.secret ?? null, v: marker.v === 3 ? 3 : 2 };
});

async function chooseStorageFolder(event, title) {
  const testDir = testEnv("MAKEWORK_TEST_STORAGE_DIR");
  if (testDir) return path.resolve(testDir, testEnv("MAKEWORK_TEST_STORAGE_NAME") ?? `server-${randomBytes(3).toString("hex")}`);
  const picked = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title, properties: ["openDirectory", "createDirectory"],
  });
  return picked.canceled || !picked.filePaths[0] ? null : path.resolve(picked.filePaths[0]);
}

function handOut(folder) {
  const token = randomBytes(8).toString("hex");
  pickedStorage.set(token, folder);
  return token;
}

async function checkFolder(folder, workspaceId) {
  if (Object.entries(locations).some(([id, f]) => f === folder && id !== workspaceId)) throw new Error("Another workspace is already stored in that folder.");
  const state = await folderState(folder, workspaceId);
  if (state === "other") throw new Error("That folder already holds another workspace. Choose an empty folder.");
  if (state === "used") throw new Error("That folder isn't empty. Choose an empty folder or make a new one.");
  return state;
}

// Makes a picked folder the server's, before the server writes anything there. `fields`: { name, secret }.
ipcMain.handle("storage:assign", async (_event, token, workspaceId, fields) => {
  const folder = pickedStorage.get(token);
  if (!folder) throw new Error("Choose a folder first.");
  checkServerId(workspaceId);
  await checkFolder(folder, workspaceId);
  pickedStorage.delete(token);
  await prepareFolder(folder, workspaceId, fields);
  locations[workspaceId] = folder;
  await saveRegistry();
  return folder;
});

// The server's folder, or null when it is in the app's storage.
ipcMain.handle("storage:location", (_event, workspaceId) => locations[workspaceId] ?? null);
ipcMain.handle("storage:locations", () => ({ ...locations }));

// Keeps server.json current ({ name, secret }), so the folder can be imported again on its own.
ipcMain.handle("storage:describe", async (_event, workspaceId, fields) => {
  const folder = locations[workspaceId];
  if (folder) await describeFolder(folder, workspaceId, fields);
});

ipcMain.handle("storage:commits-load", async (_event, workspaceId) => {
  const folder = locations[workspaceId];
  if (!folder) throw new Error("This workspace isn't stored in a folder.");
  return loadCommits(folder);
});

// History and checkpoints are written in order per workspace.
const commitWrites = new Map();
const queueCommitWrite = (workspaceId, write) => {
  const next = (commitWrites.get(workspaceId) ?? Promise.resolve()).catch(() => {}).then(write);
  commitWrites.set(workspaceId, next);
  return next;
};
ipcMain.handle("storage:commits-add", (_event, workspaceId, commits) => {
  const folder = locations[workspaceId];
  if (!folder) throw new Error("This workspace isn't stored in a folder.");
  return queueCommitWrite(workspaceId, () => appendCommits(folder, commits));
});
ipcMain.handle("storage:commits-compact", (_event, workspaceId, hashes) => {
  const folder = locations[workspaceId];
  if (!folder) throw new Error("This workspace isn't stored in a folder.");
  return queueCommitWrite(workspaceId, () => compactCommits(folder, hashes));
});

ipcMain.handle("storage:checkpoint-load", async (_event, workspaceId) => {
  const folder = locations[workspaceId];
  if (!folder) throw new Error("This workspace isn't stored in a folder.");
  return loadCheckpoint(folder);
});
ipcMain.handle("storage:checkpoint-save", (_event, workspaceId, checkpoint) => {
  const folder = locations[workspaceId];
  if (!folder) throw new Error("This workspace isn't stored in a folder.");
  return queueCommitWrite(workspaceId, () => saveCheckpoint(folder, checkpoint));
});
ipcMain.handle("storage:checkpoint-delete", (_event, workspaceId) => {
  const folder = locations[workspaceId];
  if (!folder) throw new Error("This workspace isn't stored in a folder.");
  return queueCommitWrite(workspaceId, () => deleteCheckpoint(folder));
});

// Moves a closed server to a picked folder. From app storage the page sends its commits and the hashes it uses;
// from a folder the data folder is copied. The copy is checked, then the registry switched; only then is the old
// place cleared (old data folder, readable files nobody changed). Progress goes to the page as
// "storage:move-progress" { workspaceId, stage, done, total }.
ipcMain.handle("storage:move", async (event, workspaceId, token, { name, secret, v, commits, hashes } = {}) => {
  const to = pickedStorage.get(token);
  if (!to) throw new Error("Choose a folder first.");
  checkServerId(workspaceId);
  const from = locations[workspaceId] ?? null;
  if (from === to) throw new Error("The workspace is already stored there.");
  const state = await checkFolder(to, workspaceId);
  const progress = (stage, done, total) => event.sender.send("storage:move-progress", { workspaceId, stage, done, total });
  await (commitWrites.get(workspaceId) ?? Promise.resolve()).catch(() => {});
  try {
    if (from) {
      progress("copying", 0, 1);
      await copyData(from, to);
      // Content kept only in the readable folder goes into the new folder's store; the app places it again there.
      const placed = Object.entries((await readManifest(workspaceId)).files).filter(([, record]) => !isText(record));
      for (let i = 0; i < placed.length; i++) {
        progress("copying", i, placed.length);
        const [relative, record] = placed[i];
        const source = path.join(from, ...relative.split("/"));
        const target = path.join(contentDirOf(to), checkHash(record.hash));
        if (!(await unchanged(source, record)) || await exists(target)) continue;
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(source, target, fsConstants.COPYFILE_FICLONE);
        if ((await fs.stat(target)).size !== record.size) throw new Error("A file wasn't copied fully; nothing was changed.");
      }
    } else {
      // A folder that is already this server's (a copy brought back) may hold commits: the ledger skips repeats.
      await prepareFolder(to, workspaceId, { name, secret, v });
      const before = (await loadCommits(to)).length;
      await appendCommits(to, commits ?? []);
      if ((await loadCommits(to)).length !== before + (commits ?? []).length) throw new Error("The copied history doesn't match; nothing was changed.");
      const list = hashes ?? [];
      for (let i = 0; i < list.length; i++) {
        progress("copying", i, list.length);
        const source = await findContent(list[i]);
        if (!source) continue;
        const target = path.join(contentDirOf(to), checkHash(list[i]));
        await fs.copyFile(source, target, fsConstants.COPYFILE_FICLONE);
        if ((await fs.stat(target)).size !== (await fs.stat(source)).size) throw new Error("A file wasn't copied fully; nothing was changed.");
      }
    }
  } catch (e) {
    pickedStorage.delete(token);
    // Only what this move wrote: a folder that was already this server's keeps its data.
    if (state === "empty") await fs.rm(dataDir(to), { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  pickedStorage.delete(token);
  const oldManifestFile = manifestPath(workspaceId);
  const oldManifest = await readManifest(workspaceId);
  const oldBase = await mirrorBase(workspaceId, name ?? "");
  locations[workspaceId] = to;
  unwatchMirror(workspaceId);
  await saveRegistry();
  forget();
  progress("cleaning", 0, 1);
  // The readable files are written again in the new folder by the app; the old ones nobody changed go.
  await removeMirrorFiles(oldBase, oldManifest);
  if (from) {
    await fs.rm(dataDir(from), { recursive: true, force: true }).catch(() => {});
    await fs.rmdir(from).catch(() => {});
  } else await fs.rm(oldManifestFile, { force: true }).catch(() => {});
  await loadPlacements();
  return to;
});

ipcMain.handle("storage:show", async (_event, workspaceId) => {
  const folder = locations[workspaceId];
  if (!folder) throw new Error("This workspace is in the app's storage.");
  return openPath(folder);
});

// After leaving a server kept in a folder: its data and the readable files nobody changed go, the folder is
// forgotten. Files the user changed or added stay.
ipcMain.handle("storage:forget", async (_event, workspaceId) => {
  const folder = locations[workspaceId];
  if (!folder) return;
  unwatchMirror(workspaceId);
  await removeMirrorFiles(folder, await readManifest(workspaceId));
  await fs.rm(dataDir(folder), { recursive: true, force: true }).catch(() => {});
  await fs.rmdir(folder).catch(() => {});
  delete locations[workspaceId];
  await saveRegistry();
  forget();
});

// After leaving a server but keeping its data: the folder and everything in it stay, only this app stops using it.
ipcMain.handle("storage:release", async (_event, workspaceId) => {
  if (!locations[workspaceId]) return;
  unwatchMirror(workspaceId);
  await (commitWrites.get(workspaceId) ?? Promise.resolve()).catch(() => {});
  delete locations[workspaceId];
  await saveRegistry();
  forget();
});

// Windows shows notifications only for an app with an id (the appId in package.json; dev runs have their own).
if (process.platform === "win32") app.setAppUserModelId(appUserModelId);

// One running copy per profile (the lock is per userData folder): a second start (common on Windows: taskbar and
// start menu) would fail to open IndexedDB. It hands over to the running one instead. Dev and installed copies have
// different profiles, so they don't block each other; neither do test instances with their own --user-data-dir.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on("second-instance", (_event, argv) => {
  const link = linkIn(argv);
  if (link) receiveLink(link);
  const win = mainWindowOf();
  if (win) showWindow(win);
});

// makework:// links opened anywhere on the system come to this app: on Windows and Linux in the command line of a
// new start (handed over above), on macOS as open-url. They wait here until the page takes them (core/openLinks.ts).
// Only installed copies register, so a dev run never takes links from the installed app.
const linkScheme = "makework";
const waitingLinks = [];
const linkIn = (argv) => argv.find((arg) => typeof arg === "string" && arg.startsWith(`${linkScheme}://`));
function receiveLink(url) {
  if (waitingLinks.length >= 20) waitingLinks.shift();
  waitingLinks.push(url);
  const win = mainWindowOf();
  if (!win) return;
  win.webContents.send("app:open-links");
  showWindow(win);
}
if (installed && primary) app.setAsDefaultProtocolClient(linkScheme);
app.on("open-url", (event, url) => {
  event.preventDefault();
  if (url.startsWith(`${linkScheme}://`)) receiveLink(url);
});
{
  const link = primary && linkIn(process.argv);
  if (link) waitingLinks.push(link);
}
ipcMain.handle("app:take-open-links", (event) => (event.sender === mainWindowOf()?.webContents ? waitingLinks.splice(0) : []));

app.whenReady().then(async () => {
  if (!primary) return;
  // Automated checks in containers have no keychain; secrets are then kept without encryption (never set otherwise).
  if (testEnv("MAKEWORK_TEST_PLAIN_SECRETS") && process.platform === "linux") safeStorage.setUsePlainTextEncryption(true);
  if (!devUrl) serveDist();
  serveContent();
  protocol.handle("mwmedia", (request) => mediaSource.proxy(request));
  serveBrowserProxy();
  await fs.rm(tempDir(), { recursive: true, force: true }).catch(() => {});
  await emptyTrash().catch(() => {});
  void removeStaleDevShortcut().catch(() => {});
  locations = Object.assign(Object.create(null), await readRegistry(registryFile()));
  await loadPlacements();
  setUpSession();
  void loadKeptEngine();
  setUpBackground({ getWindow: mainWindowOf, showWindow, iconPath });
  createWindow();
  app.on("activate", () => {
    const win = mainWindowOf();
    if (win) showWindow(win);
    else createWindow();
  });
}).catch((e) => {
  // Left running without a window, the process would keep the single-instance lock and the app couldn't be started
  // again until it was killed.
  console.error("Startup failed:", e);
  logLine("[main] startup failed:", e?.stack ?? e);
  dialog.showErrorBox("MakeWork couldn't start", String(e?.message ?? e));
  app.exit(1);
});

ipcMain.handle("share-audio:start", () => startShareAudio());
ipcMain.handle("share-audio:stop", () => stopShareAudio());
app.on("will-quit", () => stopShareAudio());

const playableName = /\.(mp4|m4v|mkv|mov|webm|avi|wmv|flv|mpg|mpeg|ogv|3gp|mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i;

// Plays a file from the content store in the system's own player (formats Chromium can't decode here, like HEVC
// on Linux without VA-API). The player gets a copy with the file's name, since players go by the extension.
ipcMain.handle("content:open-external", async (_event, hash, name) => {
  // The name is another member's choice, and the system would run a program or script as readily as it plays a video.
  if (!playableName.test(String(name))) return "This file type can't be opened in a player.";
  const file = await findContent(hash);
  if (!file) return "Not on this computer yet.";
  const dir = path.join(app.getPath("temp"), "makework-open", hash.slice(0, 16));
  await fs.mkdir(dir, { recursive: true });
  const copy = path.join(dir, safeSegment(name));
  if (!(await exists(copy))) await fs.copyFile(file, copy);
  return openPath(copy);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
