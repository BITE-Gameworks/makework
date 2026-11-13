// Dev runs on Windows (electron/dev.js): Task Manager names and draws a process from its executable, so dev runs start
// a copy of electron.exe that carries MakeWork's name and crow ("MakeWork Dev", apart from an installed copy) instead
// of Electron's. Electron's notification shortcut takes the name too (electron/windowsShortcut.js). The copy sits next
// to electron.exe, whose files it needs, and is made again when Electron or the icons change (a new Electron replaces
// the folder anyway). Not part of a build: packaged builds get their name and icon from electron-builder.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { icoFromPngs } from "./ico.js";

const name = "MakeWork Dev";
const fileName = "MakeWork-dev";
const sizes = [16, 32, 48, 64, 128, 256];

// `electron`: the path of electron.exe; `appDir`: app/, for its icons. The executable to start: the copy, or
// electron.exe itself when the copy can't be made.
export async function brandedElectron(electron, appDir) {
  const dist = path.dirname(electron);
  const exe = path.join(dist, `${fileName}.exe`);
  const stampFile = path.join(dist, `${fileName}.stamp`);
  try {
    const pngs = sizes.map((size) => fs.readFileSync(path.join(appDir, "resources", "icons", `${size}x${size}.png`)));
    const icons = createHash("sha256");
    for (const png of pngs) icons.update(png);
    const version = fs.readFileSync(path.join(dist, "version"), "utf8").trim();
    const stamp = JSON.stringify({ recipe: 1, electron: version, icons: icons.digest("hex") });
    if (fs.existsSync(exe) && fs.existsSync(stampFile) && fs.readFileSync(stampFile, "utf8") === stamp) return exe;
    const ResEdit = await import("resedit");
    const binary = ResEdit.NtExecutable.from(fs.readFileSync(electron), { ignoreCert: true });
    const resources = ResEdit.NtExecutableResource.from(binary);
    const [group] = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
    const ico = ResEdit.Data.IconFile.from(icoFromPngs(sizes.map((size, i) => ({ size, png: pngs[i] }))));
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, ico.icons.map((icon) => icon.data));
    const [info] = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
    const strings = { FileDescription: name, ProductName: name, InternalName: fileName, OriginalFilename: `${fileName}.exe` };
    for (const language of info.getAllLanguagesForStringValues()) info.setStringValues(language, strings);
    info.outputToResourceEntries(resources.entries);
    resources.outputResource(binary);
    fs.writeFileSync(`${exe}.tmp`, Buffer.from(binary.generate()));
    fs.renameSync(`${exe}.tmp`, exe);
    fs.writeFileSync(stampFile, stamp);
    console.log(`[dev] Made ${fileName}.exe (Electron with MakeWork's name and icon, for Task Manager and the taskbar)`);
    return exe;
  } catch (e) {
    // Only cosmetic: a copy still running (a second dev run) keeps its old icon, else Electron's own is used.
    console.warn(`[dev] ${fileName}.exe not made:`, e instanceof Error ? e.message : e);
    fs.rmSync(`${exe}.tmp`, { force: true });
    return fs.existsSync(exe) ? exe : electron;
  }
}
