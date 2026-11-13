// `npm run dev:desktop`: starts the Vite dev server, then Electron pointed at it.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { createServer } from "vite";
import { brandedElectron } from "./devExe.js";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Linux taskbars name and draw a window from the .desktop file matching its app id (`desktopName` in package.json).
// Installed packages bring one; without it the dev window shows up as "Electron". Never replaces one we didn't write.
function installDevDesktopEntry() {
  const marker = "X-MakeWork-Dev=true";
  const dir = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "applications");
  const file = path.join(dir, "makework.desktop");
  try {
    if (fs.existsSync(file) && !fs.readFileSync(file, "utf8").includes(marker)) return;
    const entry = [
      "[Desktop Entry]",
      "Type=Application",
      "Name=MakeWork",
      "Comment=MakeWork client (development)",
      `Exec="${electron}" --no-sandbox "${appDir}"`,
      `Icon=${path.join(appDir, "resources", "icon.png")}`,
      "StartupWMClass=makework",
      "NoDisplay=true",
      marker,
      "",
    ].join("\n");
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === entry) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, entry);
    for (const [command, ...args] of [["update-desktop-database", dir], ["kbuildsycoca6"]]) {
      spawnSync(command, args, { stdio: "ignore" });
    }
  } catch {
    // Only cosmetic.
  }
}

if (process.platform === "linux") installDevDesktopEntry();

// Windows: a copy of electron.exe with MakeWork's name and icon (Task Manager, taskbar; electron/devExe.js).
const binary = process.platform === "win32" ? await brandedElectron(electron, appDir) : electron;

// MAKEWORK_DEV_PORT runs a second copy next to one already on 1420 (automated checks).
const port = Number(process.env.MAKEWORK_DEV_PORT) || undefined;
const server = await createServer(port ? { server: { port } } : {});
await server.listen();
const url = server.resolvedUrls?.local[0] ?? "http://localhost:1420/";

// Ubuntu's AppArmor blocks Chromium's sandbox for an unpackaged Electron binary. Installed packages are fine.
// Extra arguments after `--` go to Electron (e.g. --remote-debugging-port for automated checks).
const args = [...(process.platform === "linux" ? [".", "--no-sandbox"] : ["."]), ...process.argv.slice(2)];
let child;
let restarting = false;

// Chromium's own log lines below FATAL (refused TURN permissions, closed data channels, ...) and WebGPU limit
// warnings flood the terminal in normal use. --log-level does not reach every child process, so they are dropped
// here. Passing --log-level (e.g. `npm run dev:desktop -- --log-level=0`) shows them again.
const showChromiumLogs = args.some((arg) => arg.startsWith("--log-level"));
const noise = /^(\[\d+:\d+\/\d+\.\d+:(VERBOSE\d*|INFO|WARNING|ERROR):|Warning: maxDynamic\w+PerPipelineLayout artificially reduced)/;

function forward(from, to) {
  let rest = "";
  from.setEncoding("utf8");
  from.on("data", (text) => {
    const lines = (rest + text).split("\n");
    rest = lines.pop();
    for (const line of lines) if (showChromiumLogs || !noise.test(line)) to.write(line + "\n");
  });
  from.on("end", () => rest && to.write(rest));
}

function start() {
  child = spawn(binary, args, { stdio: ["inherit", "pipe", "pipe"], env: { ...process.env, MAKEWORK_DEV_URL: url } });
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  child.on("exit", async (code) => {
    if (restarting) return;
    await server.close();
    process.exit(code ?? 0);
  });
}

// Vite reloads the page, but the main process and preload only load at start: restart Electron when they change,
// or the page calls IPC handlers the running main process doesn't have.
let timer;
for (const file of ["main.js", "preload.cjs", "files.js", "release.js", "storage.js", "shareAudio.js", "background.js", "mirror.js", "sharedBrowser.js", "adblock.js", "webLookup.js", "mediaSource.js", "windowsShortcut.js", "installed.js", "quitCheck.js"]) {
  fs.watch(path.join(appDir, "electron", file), () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      console.log(`[dev] ${file} changed, restarting Electron`);
      restarting = true;
      child.once("exit", () => {
        restarting = false;
        start();
      });
      child.kill();
    }, 300);
  });
}

start();
