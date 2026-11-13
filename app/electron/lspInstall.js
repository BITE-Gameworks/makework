// Language servers the app downloads for members who don't want to install them: each into its own folder under
// `baseDir`, with a server.json naming the program and its arguments. Downloads come from the projects' own
// releases (GitHub, npm); the rest go through the language's own tool (go, npm, dotnet), which must be installed.
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync, unzipSync } from "fflate";
import { isInside } from "./files.js";

const windows = process.platform === "win32";
const exe = (name) => (windows ? `${name}.exe` : name);

const rustTargets = {
  "linux-x64": "x86_64-unknown-linux-gnu.gz", "linux-arm64": "aarch64-unknown-linux-gnu.gz",
  "darwin-x64": "x86_64-apple-darwin.gz", "darwin-arm64": "aarch64-apple-darwin.gz",
  "win32-x64": "x86_64-pc-windows-msvc.zip", "win32-arm64": "aarch64-pc-windows-msvc.zip",
};
const clangdPlatforms = { "linux-x64": "linux", "darwin-x64": "mac", "darwin-arm64": "mac", "win32-x64": "windows" };
const platform = `${process.platform}-${process.arch}`;

// The last csharp-ls for each .NET it was built on (the newest needs .NET 10). An SDK newer than these
// gets the latest; add a line when csharp-ls moves to a newer .NET.
const csharpLsByDotnet = { 8: "0.16.0", 9: "0.20.0", 10: "0.28.0" };

// The csharp-ls version to install for `dotnet --list-sdks` output ("9.0.101 [C:\Program Files\dotnet\sdk]" per
// line): null for the latest. Throws when no SDK can run any of them (none at all: only the .NET runtime).
export function csharpLsVersion(sdkList) {
  const majors = String(sdkList).split(/\r?\n/).map((line) => Number(/^\s*(\d+)\./.exec(line)?.[1])).filter(Number.isFinite);
  const newest = Math.max(...majors, 0);
  const known = Object.keys(csharpLsByDotnet).map(Number);
  if (newest < Math.min(...known)) throw new Error(`Installing csharp-ls needs the .NET SDK ${Math.min(...known)} or newer (dotnet.microsoft.com/download).`);
  return newest > Math.max(...known) ? null : csharpLsByDotnet[newest];
}

// Where a download went wrong, said with its host rather than the whole address.
function downloadError(url, cause) {
  return new Error(`Couldn't download from ${new URL(url).host}: ${cause}`);
}

async function folderSize(dir) {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await folderSize(file);
    else if (entry.isFile()) total += (await fs.stat(file).catch(() => null))?.size ?? 0;
  }
  return total;
}

async function writeFiles(dir, files, strip = 0) {
  for (const [name, data] of files) {
    if (name.endsWith("/")) continue;
    // Either slash separates: Windows reads "..\x.exe" as leaving the folder.
    const parts = name.split(/[/\\]/).filter(Boolean).slice(strip);
    if (!parts.length || parts.includes("..")) continue;
    const file = path.join(dir, ...parts);
    if (!isInside(dir, file)) continue;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
  }
}

// Files of a tar archive (ustar, with pax and GNU long names), directories left out.
function untar(data) {
  const files = [];
  // Fields end at their first NUL.
  const untilNul = (value) => (value.includes("\0") ? value.slice(0, value.indexOf("\0")) : value);
  const text = (start, length) => untilNul(new TextDecoder().decode(data.subarray(start, start + length)));
  let longName = null;
  for (let at = 0; at + 512 <= data.length;) {
    if (data[at] === 0) break;
    const size = Number.parseInt(text(at + 124, 12).trim(), 8) || 0;
    const type = String.fromCodePoint(data[at + 156] || 48);
    const prefix = text(at + 345, 155);
    const own = text(at, 100);
    const body = data.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      longName = /(?:^|\n)\d+ path=([^\n]*)/.exec(new TextDecoder().decode(body))?.[1] ?? null;
      continue;
    }
    if (type === "L") {
      longName = untilNul(new TextDecoder().decode(body));
      continue;
    }
    const name = longName ?? (prefix ? `${prefix}/${own}` : own);
    longName = null;
    if (type === "0" || type === "7") files.push([name, body]);
  }
  return files;
}

// `fetch`: the app passes Electron's net.fetch, which goes through the system's proxy and certificates (Node's fetch
// doesn't, and failed on Windows). `run(file, args, env)` resolves with the program's output.
export function createLspInstaller({ baseDir, findCommand, run, fetch = globalThis.fetch }) {
  const dirOf = (id) => path.join(baseDir, id);
  const get = async (url) => {
    let response;
    try {
      response = await fetch(url, { headers: { "User-Agent": "MakeWork" } });
    } catch (e) {
      throw downloadError(url, e instanceof Error ? e.message : String(e));
    }
    if (!response.ok) throw downloadError(url, `the server answered ${response.status}.`);
    return response;
  };
  const download = async (url) => new Uint8Array(await (await get(url)).arrayBuffer());
  const needs = (tool) => {
    const file = findCommand(tool);
    if (!file) throw new Error(`Installing this server needs ${tool}, which isn't on this computer.`);
    return file;
  };

  const recipes = {
    python: {
      from: "pyright from npm",
      async install(dir) {
        const meta = await (await get("https://registry.npmjs.org/pyright/latest")).json();
        await writeFiles(dir, untar(gunzipSync(await download(meta.dist.tarball))), 1);
        return { node: true, file: "langserver.index.js", args: ["--stdio"] };
      },
    },
    rust: rustTargets[platform] && {
      from: "rust-analyzer from GitHub",
      async install(dir) {
        const asset = rustTargets[platform];
        const data = await download(`https://github.com/rust-lang/rust-analyzer/releases/latest/download/rust-analyzer-${asset}`);
        if (asset.endsWith(".zip")) await writeFiles(dir, Object.entries(unzipSync(data)));
        else await fs.writeFile(path.join(dir, "rust-analyzer"), gunzipSync(data), { mode: 0o700 });
        return { file: exe("rust-analyzer"), args: [] };
      },
    },
    c: clangdPlatforms[platform] && {
      from: "clangd from GitHub",
      async install(dir) {
        // The latest release's page address names its version (…/releases/tag/23.1.0); GitHub's API would allow only
        // 60 asks an hour from one address.
        const latest = await get("https://github.com/clangd/clangd/releases/latest");
        const version = /\/releases\/tag\/([^/?#]+)/.exec(latest.url)?.[1];
        if (!version) throw new Error("The latest clangd version wasn't found on GitHub.");
        const name = `clangd-${clangdPlatforms[platform]}-${version}.zip`;
        await writeFiles(dir, Object.entries(unzipSync(await download(`https://github.com/clangd/clangd/releases/download/${version}/${name}`))), 1);
        if (!windows) await fs.chmod(path.join(dir, "bin", "clangd"), 0o700);
        return { file: path.join("bin", exe("clangd")), args: [] };
      },
    },
    go: {
      from: "gopls with go install",
      async install(dir) {
        await run(needs("go"), ["install", "golang.org/x/tools/gopls@latest"], { GOBIN: dir });
        return { file: exe("gopls"), args: [] };
      },
    },
    shell: {
      from: "bash-language-server with npm",
      async install(dir) {
        await run(needs("npm"), ["install", "--prefix", dir, "--no-save", "--no-audit", "--no-fund", "bash-language-server"]);
        return { file: path.join("node_modules", ".bin", windows ? "bash-language-server.cmd" : "bash-language-server"), args: ["start"] };
      },
    },
    csharp: {
      from: "csharp-ls with dotnet",
      async install(dir) {
        const dotnet = needs("dotnet");
        const version = csharpLsVersion(await run(dotnet, ["--list-sdks"]).catch(() => ""));
        await run(dotnet, ["tool", "install", "csharp-ls", "--tool-path", dir, ...(version ? ["--version", version] : [])]);
        return { file: exe("csharp-ls"), args: [] };
      },
    },
  };

  const installing = new Map();
  // Windows keeps a program just written busy for a moment (virus scanners read it), so removing it is tried again.
  const remove = (dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

  const installed = (id) => {
    try {
      const dir = dirOf(id);
      const server = JSON.parse(readFileSync(path.join(dir, "server.json"), "utf8"));
      const file = path.join(dir, server.file);
      if (!existsSync(file)) return null;
      // Node servers run on the app's own runtime.
      return server.node ? [process.execPath, [file, ...server.args], { ELECTRON_RUN_AS_NODE: "1" }] : [file, server.args, {}];
    } catch {
      return null;
    }
  };

  return {
    installed,
    // Every server the app can install here, with the space an installed one takes.
    async list() {
      return Promise.all(Object.keys(recipes).filter((id) => recipes[id]).map(async (id) => ({
        id, from: recipes[id].from, installing: installing.has(id),
        size: installed(id) ? await folderSize(dirOf(id)) : null,
      })));
    },
    async uninstall(id) {
      if (!recipes[id]) return;
      await remove(dirOf(id));
    },
    // What would be installed, or null when the app can't install this server here.
    source: (id) => recipes[id]?.from ?? null,
    install(id) {
      const recipe = recipes[id];
      if (!recipe) throw new Error("The app can't install this language server here.");
      if (installing.has(id)) return installing.get(id);
      const dir = dirOf(id);
      const task = (async () => {
        await remove(dir);
        await fs.mkdir(dir, { recursive: true });
        try {
          const server = await recipe.install(dir);
          await fs.writeFile(path.join(dir, "server.json"), JSON.stringify(server));
        } catch (e) {
          await remove(dir).catch(() => {});
          throw e;
        }
      })().finally(() => installing.delete(id));
      installing.set(id, task);
      return task;
    },
  };
}
