import { describe, expect, it } from "vitest";
import { checkPlan, chooseFiles, defaultCommand, detectBuild, isBinary } from "../../electron/release.js";

// Paths as main builds them (backslashes on Windows), compared with forward slashes.
const slashes = (p: string | undefined) => p?.replace(/\\/g, "/");

// A folder tree in memory, from file paths ("/repo/app/package.json") to their text (objects as JSON).
function tree(files: Record<string, unknown>) {
  const text = new Map(Object.entries(files).map(([file, value]) => [file, typeof value === "string" ? value : JSON.stringify(value)]));
  return {
    readText: async (file: string) => {
      const found = text.get(slashes(file)!);
      if (found === undefined) throw new Error("ENOENT");
      return found;
    },
    entries: async (dir: string) => {
      const prefix = `${slashes(dir)}/`;
      const names = new Map<string, boolean>();
      for (const file of text.keys()) {
        if (!file.startsWith(prefix)) continue;
        const [name, ...rest] = file.slice(prefix.length).split("/");
        names.set(name, names.get(name) || rest.length > 0);
      }
      return [...names].map(([name, isDir]) => ({ name, isDir }));
    },
  };
}

const app = { scripts: { "build:desktop": "npm run build:web && electron-builder" }, devDependencies: { "electron-builder": "^26" }, build: { directories: { output: "release" } } };
const linux = { platform: "linux" };
const windows = { platform: "win32" };

describe("recognizing a project's build", () => {
  it("finds the desktop app in a nested folder, even under a root with its own build script", async () => {
    const found = await detectBuild("/repo", { ...linux, ...tree({
      "/repo/package.json": { name: "root", scripts: { build: "turbo build" } },
      "/repo/UI/package.json": { name: "ui" },
      "/repo/UI/app/package.json": app,
      "/repo/UI/app/package-lock.json": "{}",
    }) });
    expect(found).toMatchObject({ label: "Electron (electron-builder)", tools: ["npm"] });
    expect(found?.plan).toEqual({
      project: "UI/app",
      steps: ["npm ci", "npm run build:desktop -- --linux --win zip --publish never -c.win.signAndEditExecutable=false"],
      output: "release",
      collect: { kind: "binaries" },
    });
  });

  it("knows the usual build of each kind of project", async () => {
    const plan = async (files: Record<string, unknown>, host: { platform: string } = linux) => (await detectBuild("/p", { ...host, ...tree(files) }))?.plan;
    expect(await plan({ "/p/Cargo.toml": "[package]" })).toMatchObject({ steps: ["cargo build --release"], output: "target/release", collect: { kind: "binaries" } });
    expect(await plan({ "/p/go.mod": "module x" })).toMatchObject({ steps: ["go build -o dist/ ./..."], output: "dist" });
    expect(await plan({ "/p/Tool.csproj": "<Project/>" })).toMatchObject({ steps: ["dotnet publish -c Release -o dist"], collect: { kind: "zip" } });
    // Jars from every module (app/build/libs, lib/target), not only the root's.
    expect(await plan({ "/p/gradlew": "", "/p/build.gradle.kts": "" })).toMatchObject({ steps: ["./gradlew build -x test"], output: ".", collect: { kind: "pattern", pattern: "**/build/libs/*.jar" } });
    expect(await plan({ "/p/gradlew.bat": "", "/p/build.gradle": "" }, windows)).toMatchObject({ steps: ["gradlew.bat build -x test"] });
    expect(await plan({ "/p/pom.xml": "<project/>" })).toMatchObject({ steps: ["mvn -B package -DskipTests"], output: ".", collect: { kind: "pattern", pattern: "**/target/*.jar" } });
    expect(await plan({ "/p/app.spec": "", "/p/pyproject.toml": "" })).toMatchObject({ steps: ["pyinstaller --noconfirm app.spec"], output: "dist" });
    expect(await plan({ "/p/pyproject.toml": "" })).toMatchObject({ steps: ["python3 -m build"], output: "dist" });
    expect(await plan({ "/p/pyproject.toml": "" }, windows)).toMatchObject({ steps: ["python -m build"] });
    expect(await plan({ "/p/Package.swift": "" })).toMatchObject({ steps: ["swift build -c release"], output: ".build/release" });
    expect(await plan({ "/p/CMakeLists.txt": "" })).toMatchObject({
      steps: ["cmake -S . -B build -DCMAKE_BUILD_TYPE=Release", "cmake --build build --config Release"], output: "build",
    });
    expect(await plan({ "/p/CMakeLists.txt": "" }, windows)).toMatchObject({ output: "build/Release" });
    // An RPM spec isn't a PyInstaller one: no Python next to it.
    expect(await plan({ "/p/CMakeLists.txt": "", "/p/tool.spec": "Name: tool" })).toMatchObject({ steps: ["cmake -S . -B build -DCMAKE_BUILD_TYPE=Release", "cmake --build build --config Release"] });
    expect(await plan({ "/p/app.spec": "", "/p/main.py": "" })).toMatchObject({ steps: ["pyinstaller --noconfirm app.spec"] });
    // The spec's name goes into a shell command: one with shell characters gets quoted, never run as written.
    expect(await plan({ "/p/my app.spec": "", "/p/main.py": "" })).toMatchObject({ steps: ['pyinstaller --noconfirm "my app.spec"'] });
    expect(JSON.stringify(await plan({ "/p/x;rm -rf ~.spec": "", "/p/main.py": "" }) ?? null)).not.toContain("x;rm");
    expect(await plan({ "/p/Makefile": "all:" })).toMatchObject({ steps: ["make"], output: "." });
    expect(await plan({ "/p/package.json": { scripts: { build: "vite build" } }, "/p/yarn.lock": "" })).toMatchObject({
      steps: ["yarn install --frozen-lockfile", "yarn run build"], output: "dist", collect: { kind: "zip" },
    });
    expect(await plan({ "/p/README.md": "hello" })).toBeUndefined();
  });

  it("prefers Tauri over the plain script of its package.json, and names the tools a build needs", async () => {
    const found = await detectBuild("/p", { ...linux, ...tree({
      "/p/package.json": { scripts: { build: "vite build" }, devDependencies: { "@tauri-apps/cli": "^2" } },
      "/p/src-tauri/Cargo.toml": "[package]",
      "/p/src-tauri/tauri.conf.json": "{}",
    }) });
    expect(found).toMatchObject({ label: "Tauri", tools: ["npm", "cargo"] });
    expect(found?.plan).toEqual({ project: ".", steps: ["npm install", "npx tauri build"], output: "src-tauri/target/release/bundle", collect: { kind: "installers" } });
  });

  it("builds what this machine can, with the project's own script when it has one", () => {
    // Linux without wine: the Windows installer needs wine, so a portable zip.
    expect(defaultCommand(app, { platform: "linux" })).toBe("npm run build:desktop -- --linux --win zip --publish never -c.win.signAndEditExecutable=false");
    expect(defaultCommand(app, { platform: "linux", wine: true })).toBe("npm run build:desktop -- --linux --win --publish never -c.win.signAndEditExecutable=false");
    expect(defaultCommand(app, { platform: "win32" })).toBe("npm run build:desktop -- --win --publish never");
    expect(defaultCommand({ build: {} }, { platform: "linux" })).toBe("npx electron-builder --linux --win zip --publish never -c.win.signAndEditExecutable=false");
  });

  it("knows which files are installers and packages", () => {
    expect(["MakeWork-1.0.0.AppImage", "makework_1.0.0_amd64.deb", "MakeWork Setup 1.0.0.exe", "app.tar.gz",
      "MakeWork-1.0.0-x86_64.flatpak", "MakeWork-1.0.0-arm64.dmg", "tool-1.0.jar", "tool-1.0-py3-none-any.whl"].every(isBinary)).toBe(true);
    expect(["MakeWork Setup 1.0.0.exe.blockmap", "latest.yml", "builder-debug.yml", "linux-unpacked"].some(isBinary)).toBe(false);
  });
});

describe("choosing a build's release files", () => {
  const file = (filePath: string, { mtimeMs = 2_000, mode = 0o644 } = {}) => ({ path: filePath, isFile: true, mtimeMs, mode });
  // The output folder before the commands ran: the branch's own files and older builds, by path and change time.
  // (Their times can be later than the build's start: the checkout writes them just before.)
  const before = new Map([["MakeWork-1.0.0.AppImage", 1_000], ["build.sh", 1_900], ["configure", 1_900], ["MakeWork-0.1.1-win.zip", 1_500]]);

  it("takes what this build wrote: installers, packages and programs, not files that were there or build leftovers", () => {
    const entries = [
      file("MakeWork-0.1.1.AppImage", { mode: 0o755 }),
      file("MakeWork-1.0.0.AppImage", { mtimeMs: 1_000, mode: 0o755 }),
      file("MakeWork-0.1.1-win.zip"),
      file("MakeWork-0.1.1-win.zip.blockmap"),
      file("latest.yml"),
      file("tool", { mode: 0o755 }),
      file("tool.d"),
      file("libtool.rlib"),
      file("build.sh", { mtimeMs: 1_900, mode: 0o755 }),
      file("configure", { mtimeMs: 1_900, mode: 0o755 }),
      file("deps/tool-3f2a", { mode: 0o755 }),
      { path: "linux-unpacked", isFile: false, mtimeMs: 2_000, mode: 0o755 },
    ];
    expect(chooseFiles(entries, { kind: "binaries" }, { platform: "linux", before })).toEqual(["MakeWork-0.1.1.AppImage", "MakeWork-0.1.1-win.zip", "tool"]);
  });

  it("takes .exe programs on Windows, where nothing has an executable bit", () => {
    expect(chooseFiles([file("tool.exe"), file("tool.pdb"), file("README")], { kind: "binaries" }, { platform: "win32", before })).toEqual(["tool.exe"]);
  });

  it("looks through subfolders for installers (Tauri's bundle folder)", () => {
    const entries = [file("deb/app_1.0_amd64.deb"), file("appimage/app_1.0.AppImage", { mode: 0o755 }), file("appimage/app.AppDir/usr/bin/app", { mode: 0o755 })];
    expect(chooseFiles(entries, { kind: "installers" }, { platform: "linux", before })).toEqual(["deb/app_1.0_amd64.deb", "appimage/app_1.0.AppImage"]);
  });

  it("takes every file matching a pattern, there before or not", () => {
    const entries = [file("tool-1.0.jar"), file("MakeWork-1.0.0.AppImage", { mtimeMs: 1_000 }), file("classes/A.class"), file("lib/extra.jar")];
    expect(chooseFiles(entries, { kind: "pattern", pattern: "*.jar" }, { platform: "linux", before })).toEqual(["tool-1.0.jar"]);
    expect(chooseFiles(entries, { kind: "pattern", pattern: "*.AppImage" }, { platform: "linux", before })).toEqual(["MakeWork-1.0.0.AppImage"]);
    expect(chooseFiles(entries, { kind: "pattern", pattern: "**/*.jar" }, { platform: "linux", before })).toEqual(["tool-1.0.jar", "lib/extra.jar"]);
  });
});

describe("checking a build configuration before it runs", () => {
  const good = { project: "UI/app", steps: ["npm ci", "npm run dist"], output: "release", collect: { kind: "binaries" } };

  it("keeps a sound one, trimmed and with blank steps left out", () => {
    expect(checkPlan({ ...good, project: " UI/app/ ", steps: [" npm ci ", "", "npm run dist"] })).toEqual(good);
    expect(checkPlan({ ...good, project: "", output: "" })).toMatchObject({ project: ".", output: "." });
  });

  it("refuses folders outside the repository and commands that aren't there", () => {
    expect(() => checkPlan({ ...good, project: "../other" })).toThrow("inside the repository");
    expect(() => checkPlan({ ...good, output: "/etc" })).toThrow("inside the repository");
    expect(() => checkPlan({ ...good, output: "C:\\Windows" })).toThrow("inside the repository");
    expect(() => checkPlan({ ...good, output: "out/../../x" })).toThrow("inside the repository");
    expect(() => checkPlan({ ...good, steps: ["", " "] })).toThrow("at least one command");
    expect(() => checkPlan({ ...good, steps: Array(21).fill("make") })).toThrow("20 commands");
    expect(() => checkPlan({ ...good, steps: ["x".repeat(2001)] })).toThrow("2000 characters");
    expect(() => checkPlan({ ...good, collect: { kind: "pattern", pattern: "../*.jar" } })).toThrow("inside the repository");
    expect(() => checkPlan({ ...good, collect: { kind: "pattern", pattern: " " } })).toThrow("pattern");
    expect(() => checkPlan({ ...good, collect: { kind: "everything" } })).toThrow("Choose which files");
  });
});
