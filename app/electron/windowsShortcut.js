// Windows: the id the taskbar and notifications know the app by, and the icon its taskbar button shows. Windows draws
// the button from the Start Menu shortcut carrying the window's AppUserModelID, not from the window's own icon, and
// Electron 44 makes such a shortcut by itself for its notifications (named after the exe, pointing at it, no icon of its
// own). So the themed icon goes onto that shortcut, or onto the installer's MakeWork.lnk: saved as an .ico
// under a new name each time (the shell caches icons by file name), then the shortcut is pointed at it. Linux does the
// same with its launcher file (launcherIcon.js). Until a shortcut exists, the button shows the window's own icon.
import { app, nativeImage, shell } from "electron";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { icoFromPngs } from "./ico.js";
import { installed } from "./installed.js";

const installedId = "com.makework.app";
// Dev runs have their own id, apart from an installed copy (like their profiles), so the shortcut Electron makes for
// one never takes over the other's taskbar button.
export const appUserModelId = installed ? installedId : `${installedId}.dev`;

const programsDir = () => path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs");
const iconDir = () => path.join(app.getPath("userData"), "launcher-icon");
const iconSizes = [16, 24, 32, 48, 64, 256];

function readLink(file) {
  try {
    return shell.readShortcutLink(file);
  } catch {
    return null;
  }
}

// The shortcuts in the user's Start Menu (its top level and one folder down) with their details.
async function startMenuLinks() {
  const root = programsDir();
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && /\.lnk$/i.test(entry.name)) files.push(full);
    if (!entry.isDirectory()) continue;
    for (const inner of await fs.readdir(full, { withFileTypes: true }).catch(() => [])) {
      if (inner.isFile() && /\.lnk$/i.test(inner.name)) files.push(path.join(full, inner.name));
    }
  }
  return files.map((file) => ({ file, link: readLink(file) })).filter((s) => s.link);
}

// Dev runs before 2026-11-09 used the installed id, so Electron's shortcut for them ("Electron.lnk", pointing into
// node_modules) would draw an installed copy's taskbar button with Electron's logo. Removed at a dev start.
export async function removeStaleDevShortcut() {
  if (process.platform !== "win32" || installed) return;
  const intoElectron = /[\\/]node_modules[\\/]electron[\\/]dist[\\/]/i;
  for (const { file, link } of await startMenuLinks()) {
    if (link.appUserModelId === installedId && intoElectron.test(link.target ?? "")) {
      await fs.rm(file, { force: true }).catch((e) => console.warn("Old dev shortcut not removed", e));
    }
  }
}

let wanted = null;
let timer = null;
let ours = [];

// Our shortcuts, looked up again while there are none yet (Electron makes its own with the first notification) or
// one went away.
async function ourShortcuts() {
  const known = ours.filter((file) => readLink(file)?.appUserModelId === appUserModelId);
  if (known.length && known.length === ours.length) return known;
  ours = (await startMenuLinks()).filter(({ link }) => link.appUserModelId === appUserModelId).map(({ file }) => file);
  return ours;
}

async function apply(png) {
  const shortcuts = await ourShortcuts();
  if (!shortcuts.length) return;
  const hash = createHash("sha256").update(png).digest("hex").slice(0, 16);
  const icon = path.join(iconDir(), `icon-${hash}.ico`);
  // A count change sends the same picture again: the file is only made when the picture changed.
  const made = await fs.access(icon).then(() => true, () => false);
  if (!made) {
    const image = nativeImage.createFromBuffer(png);
    const sized = (size) => image.resize({ width: size, height: size, quality: "best" }).toPNG();
    await fs.mkdir(iconDir(), { recursive: true });
    await fs.writeFile(icon, icoFromPngs(iconSizes.map((size) => ({ size, png: sized(size) }))));
  }
  for (const file of shortcuts) {
    const link = readLink(file);
    if (!link || (link.icon === icon && link.iconIndex === 0)) continue;
    if (!shell.writeShortcutLink(file, "update", { target: link.target, icon, iconIndex: 0 })) {
      console.warn("Shortcut icon not updated", file);
    }
  }
  for (const old of await fs.readdir(iconDir())) {
    if (old !== path.basename(icon) && old.endsWith(".ico")) await fs.rm(path.join(iconDir(), old), { force: true });
  }
}

// `png`: the icon without its badge (the badge is the button's overlay, main.js). Waits for a pause, so dragging a
// theme color doesn't rewrite the shortcut on every step.
export function setShortcutIcon(png) {
  if (process.platform !== "win32") return;
  wanted = png;
  clearTimeout(timer);
  timer = setTimeout(() => void apply(wanted).catch((e) => console.warn("Shortcut icon not updated", e)), 800);
}
