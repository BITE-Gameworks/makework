// Building a project's release files and uploading them to GitHub, in the desktop app's main process.
// The chosen branch is checked out into a temporary git worktree (the user's working copy is left alone) and its
// build configuration run there: the one the channel saved, or the usual build of the project found in it. The
// files are copied out before the worktree is removed.
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { Zip, ZipDeflate } from "fflate";
import { trimEnd } from "./text.js";

const binaryPattern = /\.(appimage|deb|rpm|flatpak|snap|exe|msi|msix|appx|pkg|zip|7z|dmg|tar\.gz|tar\.xz|jar|war|whl|nupkg|apk|aab)$/i;
export const isBinary = (name) => binaryPattern.test(name);

const hasElectronBuilder = (pkg) => !!(pkg?.devDependencies?.["electron-builder"] || pkg?.dependencies?.["electron-builder"]);
const hasTauri = (pkg) => !!(pkg?.devDependencies?.["@tauri-apps/cli"] || pkg?.dependencies?.["@tauri-apps/cli"]);

// The package manager a JavaScript project's lock file names, and how it installs and runs a script.
function packageManager(names) {
  if (names.has("pnpm-lock.yaml")) return { tool: "pnpm", install: "pnpm install --frozen-lockfile", run: (script) => `pnpm run ${script}` };
  if (names.has("yarn.lock")) return { tool: "yarn", install: "yarn install --frozen-lockfile", run: (script) => `yarn run ${script}` };
  return { tool: "npm", install: names.has("package-lock.json") ? "npm ci" : "npm install", run: (script) => `npm run ${script}` };
}

// The usual builds, most specific first. `match` gets the folder's entries (names, and which are folders), its
// package.json if any, the host and a reader; it returns the build or nothing. `weak` ones (a bare script, a
// Makefile) count only when no folder holds a specific one: a monorepo's root script mustn't hide its desktop app.
const detectors = [
  {
    label: "Electron (electron-builder)",
    match: ({ names, pkg, host }) => pkg?.build && hasElectronBuilder(pkg) && (() => {
      const pm = packageManager(names);
      return { tools: [pm.tool], steps: [pm.install, defaultCommand(pkg, host)], output: pkg.build.directories?.output ?? "dist",
        collect: { kind: "binaries" }, note: buildNote(host) };
    })(),
  },
  {
    label: "Tauri",
    match: ({ names, dirs, pkg }) => pkg && (hasTauri(pkg) || dirs.has("src-tauri")) && (() => {
      const pm = packageManager(names);
      return { tools: [pm.tool, "cargo"], steps: [pm.install, pm.tool === "npm" ? "npx tauri build" : `${pm.tool} tauri build`],
        output: "src-tauri/target/release/bundle", collect: { kind: "installers" } };
    })(),
  },
  {
    label: "Rust (Cargo)",
    match: ({ names }) => names.has("Cargo.toml") && { tools: ["cargo"], steps: ["cargo build --release"], output: "target/release", collect: { kind: "binaries" } },
  },
  {
    label: "Go",
    match: ({ names }) => names.has("go.mod") && { tools: ["go"], steps: ["go build -o dist/ ./..."], output: "dist", collect: { kind: "binaries" } },
  },
  {
    label: ".NET",
    match: ({ names }) => [...names].some((n) => /\.(sln|csproj|fsproj|vbproj)$/i.test(n)) &&
      { tools: ["dotnet"], steps: ["dotnet publish -c Release -o dist"], output: "dist", collect: { kind: "zip" } },
  },
  {
    label: "Java (Gradle)",
    match: ({ names, host }) => {
      if (!names.has("build.gradle") && !names.has("build.gradle.kts") && !names.has("settings.gradle") && !names.has("settings.gradle.kts")) return null;
      const wrapper = host.platform === "win32" ? names.has("gradlew.bat") && "gradlew.bat" : names.has("gradlew") && "./gradlew";
      // Every module's jars: a multi-module build writes them to app/build/libs, lib/build/libs, not the root's.
      return { tools: wrapper ? ["java"] : ["gradle"], steps: [`${wrapper || "gradle"} build -x test`], output: ".",
        collect: { kind: "pattern", pattern: "**/build/libs/*.jar" } };
    },
  },
  {
    label: "Java (Maven)",
    match: ({ names }) => names.has("pom.xml") &&
      { tools: ["mvn"], steps: ["mvn -B package -DskipTests"], output: ".", collect: { kind: "pattern", pattern: "**/target/*.jar" } },
  },
  {
    label: "Python (PyInstaller)",
    match: ({ names }) => {
      // RPM packages have .spec files too: only one next to Python is PyInstaller's.
      const python = [...names].some((n) => n.endsWith(".py") || n === "pyproject.toml" || n === "requirements.txt" || n === "setup.cfg");
      // The name goes into a shell command (sh or cmd): plain names as they are, spaces in double quotes (the same
      // in both), anything with other shell characters is never used.
      const spec = python && [...names].find((n) => n.endsWith(".spec") && /^[\w .@+-]+$/.test(n));
      const arg = spec && (/\s/.test(spec) ? `"${spec}"` : spec);
      return spec && { tools: ["pyinstaller"], steps: [`pyinstaller --noconfirm ${arg}`], output: "dist", collect: { kind: "binaries" },
        note: "A one-folder build is a folder: choose Zip the whole folder for it." };
    },
  },
  {
    label: "Python package",
    match: ({ names, host }) => {
      if (!names.has("pyproject.toml") && !names.has("setup.py")) return null;
      const python = host.platform === "win32" ? "python" : "python3";
      return { tools: [python], steps: [`${python} -m build`], output: "dist", collect: { kind: "binaries" }, note: "Needs the build package (pip install build)." };
    },
  },
  {
    label: "Swift",
    match: ({ names }) => names.has("Package.swift") && { tools: ["swift"], steps: ["swift build -c release"], output: ".build/release", collect: { kind: "binaries" } },
  },
  {
    label: "C/C++ (CMake)",
    match: ({ names, host }) => names.has("CMakeLists.txt") && {
      tools: ["cmake"], steps: ["cmake -S . -B build -DCMAKE_BUILD_TYPE=Release", "cmake --build build --config Release"],
      output: host.platform === "win32" ? "build/Release" : "build", collect: { kind: "binaries" },
    },
  },
  {
    label: "Make",
    weak: true,
    match: ({ names }) => (names.has("Makefile") || names.has("makefile") || names.has("GNUmakefile")) && {
      tools: ["make"], steps: ["make"], output: ".", collect: { kind: "binaries" }, note: "Make has no usual output folder: check where its files land.",
    },
  },
  {
    label: "JavaScript (build script)",
    weak: true,
    match: ({ names, pkg }) => {
      const script = pkg?.scripts?.dist ? "dist" : pkg?.scripts?.build ? "build" : null;
      if (!script) return null;
      const pm = packageManager(names);
      return { tools: [pm.tool], steps: [pm.install, pm.run(script)], output: "dist", collect: { kind: "zip" } };
    },
  },
];

const skippedFolders = new Set(["node_modules", "target", "build", "dist", "release", "out", "bin", "obj", "vendor", "__pycache__"]);

async function readEntries(dir) {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return [];
  }
}

// The nearest folder (up to 3 levels down) whose build is known, as { label, tools, note, plan } with the plan's
// project relative to root ("/" between folders, "." for root), or null. `readText` and `entries` stand in for
// the disk in tests.
export async function detectBuild(root, { platform = process.platform, wine = false, readText = (file) => fs.readFile(file, "utf8"), entries = readEntries } = {}) {
  const host = { platform, wine };
  let weak = null;
  let level = [root];
  for (let depth = 0; depth <= 3 && level.length; depth++) {
    const next = [];
    for (const dir of level) {
      const listed = await entries(dir);
      const names = new Set(listed.filter((e) => !e.isDir).map((e) => e.name));
      const dirs = new Set(listed.filter((e) => e.isDir).map((e) => e.name));
      let pkg = null;
      if (names.has("package.json")) {
        try {
          pkg = JSON.parse(await readText(path.join(dir, "package.json")));
        } catch {
          // Not readable as JSON: no JavaScript build.
        }
      }
      for (const detector of detectors) {
        if (detector.weak && weak) continue;
        const found = detector.match({ names, dirs, pkg, host });
        if (!found) continue;
        const project = path.relative(root, dir).split(path.sep).join("/") || ".";
        const { tools, note, ...rest } = found;
        const result = { label: detector.label, tools, note: note ?? null, plan: { project, ...rest } };
        if (!detector.weak) return result;
        weak = result;
        break;
      }
      next.push(...[...dirs].filter((name) => !name.startsWith(".") && !skippedFolders.has(name)).map((name) => path.join(dir, name)));
    }
    level = next;
  }
  return weak;
}

// A program a build wrote: an .exe on Windows; elsewhere a file with an executable bit that isn't a script or a
// library (Cargo and CMake leave those next to the program).
const notPrograms = /\.(sh|bash|py|pl|rb|js|bat|cmd|ps1|so|dylib|dll|a|o|d|rlib|pdb|cmake|txt|json)$/i;
const isProgram = (name, mode, platform) => platform === "win32" ? /\.exe$/i.test(name) : (mode & 0o111) !== 0 && !notPrograms.test(name);

// A pattern for paths inside the output folder: `*` within one folder, `**/` any folders (none included).
function patternRegex(pattern) {
  const source = pattern.split("/").map((part) => part === "**" ? "\u0000" : part.replace(/[.+^${}()|[\]\\?]/g, String.raw`\$&`).replaceAll("*", "[^/]*")).join("/");
  return new RegExp(`^${source.replaceAll("\u0000/", "(?:[^/]+/)*").replaceAll("\u0000", ".*")}$`);
}

// Of an output folder's entries ({ path relative to it with "/", isFile, mtimeMs, mode }), the release files a
// build configuration takes, by path. Binaries and installers must be new or changed since `before` (the folder's
// paths and change times before the commands ran), so older builds and files the branch holds stay out: the
// checkout wrote those moments before, so a start time can't tell them apart. A pattern takes whatever matches.
export function chooseFiles(entries, collect, { platform = process.platform, before = new Map() } = {}) {
  const fresh = (e) => before.get(e.path) !== e.mtimeMs;
  const name = (e) => e.path.split("/").at(-1);
  const files = entries.filter((e) => e.isFile);
  switch (collect.kind) {
    case "binaries":
      return files.filter((e) => !e.path.includes("/") && fresh(e) && (isBinary(e.path) || isProgram(e.path, e.mode, platform))).map((e) => e.path);
    case "installers":
      return files.filter((e) => fresh(e) && isBinary(name(e))).map((e) => e.path);
    case "pattern": {
      const regex = patternRegex(collect.pattern);
      return files.filter((e) => regex.test(e.path)).map((e) => e.path);
    }
    default:
      return [];
  }
}

// A folder inside the repository, "/" between folders ("." for its root); throws for one that leaves it.
function insidePath(value, what) {
  const text = trimEnd(String(value ?? "").trim().replaceAll("\\", "/"), "/");
  if (!text || text === ".") return ".";
  if (text.startsWith("/") || /^[a-z]:/i.test(text) || text.split("/").includes("..")) throw new Error(`The ${what} must be inside the repository.`);
  return text.replace(/^\.\//, "");
}

// A build configuration as the page or the channel's data gave it, checked before anything runs: folders inside
// the repository, 1 to 20 commands of up to 2000 characters, and a known way to choose the files.
export function checkPlan(plan) {
  const steps = (Array.isArray(plan?.steps) ? plan.steps : []).map((s) => String(s ?? "").trim()).filter(Boolean);
  if (steps.length === 0) throw new Error("A build needs at least one command.");
  if (steps.length > 20) throw new Error("A build can have up to 20 commands.");
  if (steps.some((s) => s.length > 2000)) throw new Error("A build command can be up to 2000 characters.");
  const kind = plan?.collect?.kind;
  let collect;
  if (kind === "binaries" || kind === "installers" || kind === "zip") collect = { kind };
  else if (kind === "pattern") {
    const pattern = String(plan.collect.pattern ?? "").trim();
    if (!pattern || pattern.length > 200) throw new Error("Enter a pattern for the files, like *.jar.");
    insidePath(pattern.replaceAll("*", "x"), "files' pattern");
    collect = { kind, pattern };
  } else throw new Error("Choose which files the build makes.");
  return { project: insidePath(plan.project, "project folder"), steps, output: insidePath(plan.output, "output folder"), collect };
}

// What this machine can build. Linux builds its packages and Windows': the installer (NSIS) only with wine, else a
// portable .zip (signAndEditExecutable=false: the .exe keeps Electron's icon and details). Windows builds its
// installer; Linux packages can't be built there.
export function defaultCommand(pkg, { platform = process.platform, wine = false } = {}) {
  const targets = platform === "win32" ? "--win" : wine ? "--linux --win" : "--linux --win zip";
  const flags = `${targets} --publish never${platform === "win32" ? "" : " -c.win.signAndEditExecutable=false"}`;
  return pkg?.scripts?.["build:desktop"] ? `npm run build:desktop -- ${flags}` : `npx electron-builder ${flags}`;
}

// What defaultCommand chose, in words, for the page.
export function buildNote({ platform = process.platform, wine = false } = {}) {
  if (platform === "win32") return "Builds the Windows installer. Linux packages have to be built on Linux.";
  if (wine) return "Builds the Linux packages and the Windows installer (through wine). The .exe keeps Electron's icon.";
  return "Builds the Linux packages and a portable Windows .zip. A Windows installer needs wine or a Windows machine.";
}

// Runs a command line in a shell (so npm works on Windows too), line by line into onLog; abort kills it all.
function run(command, cwd, onLog, signal) {
  return new Promise((resolve, reject) => {
    onLog(`$ ${command}`);
    const child = spawn(command, {
      cwd, shell: true, detached: process.platform !== "win32",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", FORCE_COLOR: "0" },
    });
    const lines = (chunk) => String(chunk).split(/\r?\n/).filter((l) => l.trim()).forEach((line) => onLog(line));
    child.stdout.on("data", lines);
    child.stderr.on("data", lines);
    const stop = () => killTree(child);
    signal?.addEventListener("abort", stop, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) reject(new Error("Build stopped."));
      else if (code === 0) resolve();
      else reject(new Error(`"${command}" failed (exit code ${code}); see the log.`));
    });
  });
}

function killTree(child) {
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
  else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

// A folder's files and folders as chooseFiles reads them, down to `depth` levels (0: only its own entries),
// without dependency and git folders. Links are left out: one could lead out of the repository or round in a loop.
// Fails past `limit` entries rather than go on with part of the folder (a zip missing files would look complete).
async function listTree(dir, depth, limit = 50_000) {
  const found = [];
  const walk = async (folder, prefix, level) => {
    let entries;
    try {
      entries = await fs.readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= limit) throw new Error(`The output folder has more than ${limit.toLocaleString("en")} files and folders: choose a narrower one.`);
      // `.git` is a file in a worktree (the temporary copy): it names the user's own repository's path.
      if (e.isSymbolicLink() || e.name === ".git" || (e.isDirectory() && e.name === "node_modules")) continue;
      const full = path.join(folder, e.name);
      const stat = await fs.lstat(full).catch(() => null);
      if (!stat || stat.isSymbolicLink()) continue;
      const relative = prefix ? `${prefix}/${e.name}` : e.name;
      found.push({ path: relative, isFile: stat.isFile(), mtimeMs: stat.mtimeMs, mode: stat.mode });
      if (stat.isDirectory() && level < depth) await walk(full, relative, level + 1);
    }
  };
  await walk(dir, "", 0);
  return found;
}

// Packs a folder's files into one zip at `target`, a file at a time (outputs can be hundreds of MB). Keeps the
// executable bits, so programs in it still run once unpacked.
async function zipFolder(dir, target, signal) {
  const files = (await listTree(dir, 30, 500_000)).filter((e) => e.isFile);
  if (files.length === 0) return false;
  const out = createWriteStream(target);
  let failed = null;
  out.on("error", (error) => (failed ??= error));
  const zip = new Zip((error, chunk, final) => {
    if (error) failed ??= error;
    else out.write(chunk);
    if (final || error) out.end();
  });
  try {
    for (const entry of files) {
      const file = new ZipDeflate(entry.path, { level: 6 });
      if (process.platform !== "win32") Object.assign(file, { os: 3, attrs: (entry.mode & 0o777 | 0o100000) << 16 });
      zip.add(file);
      for await (const chunk of createReadStream(path.join(dir, ...entry.path.split("/")))) {
        file.push(chunk);
        if (failed) throw failed;
        // Reading and packing outrun the disk: wait for it rather than holding the zip in memory.
        // A failed write never drains, and Stop must work here too: either ends the wait.
        if (out.writableNeedDrain) await new Promise((resolve) => {
          const done = () => {
            out.off("drain", done).off("error", done).off("close", done);
            signal?.removeEventListener("abort", done);
            resolve();
          };
          out.on("drain", done).on("error", done).on("close", done);
          signal?.addEventListener("abort", done);
        });
        if (failed) throw failed;
        if (signal?.aborted) throw new Error("Build stopped.");
      }
      file.push(new Uint8Array(0), true);
    }
    zip.end();
    if (!out.writableFinished) await new Promise((resolve) => out.once("close", resolve));
    if (failed) throw failed;
  } catch (e) {
    zip.terminate();
    out.destroy();
    await fs.rm(target, { force: true }).catch(() => {});
    throw e;
  }
  return true;
}

const systemName = (platform) => ({ win32: "windows", darwin: "macos" })[platform] ?? platform;

// Builds `branch` of the repository at `folder` with a build configuration (`plan`), or with the usual build of
// the project the branch holds when there is none. Resolves with the release files, copied to a temporary folder.
export async function build({ folder, branch, plan, host = {}, onLog, signal, git }) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "makework-build-"));
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "makework-release-"));
  onLog(`Checking out ${branch} into a temporary copy`);
  try {
    try {
      await git(folder, ["worktree", "add", "--detach", work, branch]);
    } catch {
      // Not a local branch: the remote's.
      await git(folder, ["fetch", "origin", branch]);
      await git(folder, ["worktree", "add", "--detach", work, "FETCH_HEAD"]);
    }
    if (!plan) {
      const found = await detectBuild(work, host);
      if (!found) throw new Error(`The build of branch ${branch} isn't recognized. Enter the commands that build it.`);
      onLog(`Recognized ${found.label}`);
      plan = found.plan;
    }
    const { project, steps, output, collect } = checkPlan(plan);
    const dir = path.join(work, ...project.split("/"));
    const from = path.join(dir, ...output.split("/"));
    const shown = path.posix.join(project, output);
    onLog(`Building in ${project === "." ? "the repository root" : project}`);
    const depth = collect.kind === "binaries" ? 0 : 8;
    const before = collect.kind === "zip" ? new Map() : new Map((await listTree(from, depth)).map((e) => [e.path, e.mtimeMs]));
    for (const step of steps) await run(step, dir, onLog, signal);
    const files = [];
    if (collect.kind === "zip") {
      const name = `${path.basename(project === "." ? folder : dir)}-${systemName(host.platform ?? process.platform)}-${process.arch}.zip`;
      const target = path.join(out, name);
      if (await zipFolder(from, target, signal)) files.push({ path: target, name, size: (await fs.stat(target)).size });
    } else {
      const taken = new Set();
      for (const relative of chooseFiles(await listTree(from, depth), collect, { platform: host.platform ?? process.platform, before })) {
        // Files of the same name in different folders keep their folder in the name.
        let name = relative.split("/").at(-1);
        if (taken.has(name)) name = relative.replaceAll("/", "-");
        // Still taken (a file already named "rpm-app.deb"): a number before the extension until it's free.
        for (let n = 2; taken.has(name); n++) name = relative.replaceAll("/", "-").replace(/(\.[^.]+)?$/, (ext) => `-${n}${ext}`);
        taken.add(name);
        const target = path.join(out, name);
        await fs.copyFile(path.join(from, ...relative.split("/")), target);
        files.push({ path: target, name, size: (await fs.stat(target)).size });
      }
    }
    if (files.length === 0) throw new Error(`The build finished but left no release files in ${shown === "." ? "the repository root" : shown}.`);
    onLog(`Built ${files.map((f) => f.name).join(", ")}`);
    return files;
  } catch (e) {
    await fs.rm(out, { recursive: true, force: true }).catch(() => {});
    throw e;
  } finally {
    await git(folder, ["worktree", "remove", "--force", work]).catch(() => {});
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

// Streams a file to its host: `target` ({ method, url, headers }) says where, as the page's release host made it
// (GitHub's release upload URL, GitLab's package registry). `base` replaces the host in tests.
export async function uploadAsset({ target, file, name, onProgress, base }) {
  let url = new URL(target.url);
  if (base) url = new URL(`${url.pathname}${url.search}`, base);
  const { size } = await fs.stat(file);
  const client = url.protocol === "http:" ? http : https;
  return new Promise((resolve, reject) => {
    const request = client.request(url, {
      method: target.method,
      headers: { ...target.headers, "User-Agent": "MakeWork", "Content-Type": "application/octet-stream", "Content-Length": size },
    }, (response) => {
      let text = "";
      response.on("data", (chunk) => (text += chunk));
      response.on("end", () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          // A host that answers success with something other than JSON still uploaded the file.
          try {
            resolve(JSON.parse(text || "{}"));
          } catch {
            resolve({});
          }
        } else {
          let message = text;
          try {
            message = JSON.parse(text).message ?? text;
          } catch {
            // Plain text.
          }
          reject(new Error(`Uploading ${name} failed (${response.statusCode}): ${message}`));
        }
      });
    });
    request.on("error", (e) => reject(new Error(`Uploading ${name} failed: ${e.message}`)));
    let sent = 0;
    const stream = createReadStream(file);
    stream.on("data", (chunk) => {
      sent += chunk.length;
      onProgress?.(sent / size);
    });
    stream.on("error", (e) => {
      // A file that can't be read any more: the half-sent request goes too, instead of waiting open.
      request.destroy();
      reject(new Error(`Uploading ${name} failed: ${e.message}`));
    });
    stream.pipe(request);
  });
}
