// Linux taskbars (KDE, GNOME) draw a window with the icon of the .desktop file matching its app id and ignore the
// icon the window sets. To show the themed icon there, the icon is saved as a new file and our own launcher file in
// the user's applications folder points at it. A launcher file we didn't write (an installed package's) is copied
// there first with only the icon changed; files we didn't write are never edited.
import { app } from "electron";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const fileName = "makework.desktop";
const markers = ["X-MakeWork-Dev=true", "X-MakeWork-Icon=true"];
const userDir = () => path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "applications");
const systemDirs = () => (process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(Boolean)
  .map((dir) => path.join(dir, "applications"));
const iconDir = () => path.join(app.getPath("userData"), "launcher-icon");

const read = (file) => fs.readFile(file, "utf8").catch(() => null);

// The launcher text with the icon swapped, or null when there is no launcher of ours to change.
async function launcherWith(icon) {
  const own = await read(path.join(userDir(), fileName));
  if (own !== null) return markers.some((m) => own.includes(m)) ? own.replace(/^Icon=.*$/m, `Icon=${icon}`) : null;
  for (const dir of systemDirs()) {
    const installed = await read(path.join(dir, fileName));
    if (installed !== null) return `${installed.replace(/^Icon=.*$/m, `Icon=${icon}`).trimEnd()}\n${markers[1]}\n`;
  }
  // No launcher at all (a plain AppImage): the window's own icon is used.
  return null;
}

// Desktops read launchers from a cache; KDE's needs a rebuild, the others watch the folder.
function refreshCaches() {
  for (const [command, ...args] of [["kbuildsycoca6"], ["kbuildsycoca5"]]) {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  }
}

let wanted = null;
let timer = null;
let lastHash = "";

async function apply(png) {
  const hash = createHash("sha256").update(png).digest("hex").slice(0, 16);
  if (hash === lastHash) return;
  // A new name each time: taskbars keep the old picture of a file that only changed inside.
  const icon = path.join(iconDir(), `icon-${hash}.png`);
  const entry = await launcherWith(icon);
  if (entry === null) return;
  await fs.mkdir(iconDir(), { recursive: true });
  await fs.writeFile(icon, png);
  await fs.mkdir(userDir(), { recursive: true });
  await fs.writeFile(path.join(userDir(), fileName), entry);
  lastHash = hash;
  for (const old of await fs.readdir(iconDir())) {
    if (old !== path.basename(icon)) await fs.rm(path.join(iconDir(), old), { force: true });
  }
  refreshCaches();
}

// `png`: the icon as PNG bytes. Waits for a pause, so dragging a theme color doesn't rebuild caches on every step.
// Not in a Flatpak: its launcher is exported by Flatpak itself, and the home folder it can reach is the user's real one,
// where a launcher of ours would show up as a second app.
export function setLauncherIcon(png) {
  if (process.platform !== "linux" || process.env.FLATPAK_ID) return;
  wanted = png;
  clearTimeout(timer);
  timer = setTimeout(() => void apply(wanted).catch((e) => console.warn("Launcher icon not updated", e)), 800);
}
