// Code channels on desktop: a run folder per channel (a one-way copy of its files, so build output never flows back
// into the channel), language servers from a fixed list, and terminals (node-pty) that run in that folder.
// The page names a workspace and channel, never a path; commands come from the user's own Run click.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isInside, safeSegment } from "./files.js";
import { createLspInstaller } from "./lspInstall.js";

// Language servers the app may start, by id. A path set in the code plugin's settings replaces the command only;
// the arguments stay these.
const languageServers = {
  python: { label: "Python", commands: [["pyright-langserver", ["--stdio"]], ["basedpyright-langserver", ["--stdio"]], ["pylsp", []]] },
  rust: { label: "Rust", commands: [["rust-analyzer", []]] },
  go: { label: "Go", commands: [["gopls", []]] },
  c: { label: "C and C++", commands: [["clangd", []]] },
  java: { label: "Java", commands: [["jdtls", []]] },
  csharp: { label: "C#", commands: [["csharp-ls", []]] },
  shell: { label: "Shell", commands: [["bash-language-server", ["start"]]] },
};

const windows = process.platform === "win32";

// Apps started from a launcher get a short PATH (macOS especially): add where language tools usually live.
function searchPath() {
  const home = os.homedir();
  const extra = windows ? [] : [
    path.join(home, ".cargo", "bin"), path.join(home, "go", "bin"), path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"), "/usr/local/bin", "/opt/homebrew/bin", "/usr/local/go/bin",
  ];
  const parts = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return [...parts, ...extra.filter((dir) => !parts.includes(dir))].join(path.delimiter);
}

function findCommand(name) {
  const exts = windows ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of searchPath().split(path.delimiter)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext.toLowerCase());
      try {
        if (statSync(file).isFile()) return file;
      } catch {
        // Not in this folder.
      }
    }
  }
  return null;
}

function cleanEnv() {
  const env = { ...process.env, PATH: searchPath() };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MAKEWORK_DEV_URL;
  return env;
}

const projectFile = /\.(sln|slnx|csproj)$/i;
function hasProject(dir, depth = 3) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((e) => (e.isFile() ? projectFile.test(e.name)
    : e.isDirectory() && depth > 1 && !/^(bin|obj|node_modules|\.git)$/.test(e.name) && hasProject(path.join(dir, e.name), depth - 1)));
}

// csharp-ls stops at once in a folder without a project or solution. For loose .cs files the app writes a solution
// and project next to the run folder (never into it) that compile every .cs file there.
function looseCSharpSolution(root) {
  const dir = `${root}.csharp`;
  let major = 8;
  try {
    major = Number(/^(\d+)/.exec(execFileSync(findCommand("dotnet") ?? "dotnet", ["--version"], { env: cleanEnv(), encoding: "utf8", windowsHide: true }))?.[1]) || 8;
  } catch {
    // No SDK found; the server reports that itself.
  }
  const include = path.join(root, "**", "*.cs").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll("%", "%25").replaceAll(";", "%3B");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "Channel.csproj"), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net${major}.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="${include}" />
  </ItemGroup>
</Project>
`);
  writeFileSync(path.join(dir, "Channel.sln"), `Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Channel", "Channel.csproj", "{6F1D1B5E-0D8A-4C2B-9B1E-1A2B3C4D5E6F}"
EndProject
Global
EndGlobal
`);
  return path.join(dir, "Channel.sln");
}

// cmd.exe reads a batch file's command line itself: an argument with spaces or its own characters (& | < > ( ) ^)
// goes in double quotes, where they are plain text. % would still expand there, and " can't be in a Windows path,
// so those are refused rather than passed wrong.
export function cmdArg(arg) {
  const text = String(arg);
  if (/["%]/.test(text)) throw new Error(`This can't be passed to a batch file: ${text}`);
  return text === "" || /[\s&|<>()^!,;=]/.test(text) ? `"${text}"` : text;
}

// Batch files can only start through a shell on Windows.
const start = (spawn, file, args, options) => (windows && /\.(cmd|bat)$/i.test(file)
  ? spawn(`"${file}"`, args.map(cmdArg), { ...options, shell: true, windowsHide: true })
  : spawn(file, args, { ...options, windowsHide: true }));

// What a failed tool said: its first line naming an error, else one saying what failed (dotnet ends with a list of
// generic causes), else its last line.
export function toolFailure(output) {
  const lines = String(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /\berror\b/i.test(line)) ?? lines.find((line) => /\bfailed\b/i.test(line)) ?? lines.at(-1) ?? "";
}

// rustup puts a proxy for rust-analyzer on PATH (~/.cargo/bin) even when the component isn't installed; that proxy
// only says "Unknown binary". A program next to rustup counts only when rustup knows it.
const rustupChecked = new Map();
function usableCommand(name, file) {
  if (!file) return null;
  const rustup = path.join(path.dirname(file), windows ? "rustup.exe" : "rustup");
  if (!existsSync(rustup) || path.resolve(rustup) === path.resolve(file)) return file;
  if (!rustupChecked.has(file)) {
    try {
      execFileSync(rustup, ["which", name], { env: cleanEnv(), stdio: "ignore", timeout: 5000, windowsHide: true });
      rustupChecked.set(file, true);
    } catch {
      rustupChecked.set(file, false);
    }
  }
  return rustupChecked.get(file) ? file : null;
}

export function createCodeTools({ baseDir, serversDir, findContent, spawn, loadPty, fetch }) {
  // Runs an installer's tool (go, npm, dotnet) to its end; resolves with what it printed.
  const run = (file, args, env = {}) => new Promise((resolve, reject) => {
    const child = start(spawn, file, args, { env: { ...cleanEnv(), ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => (output = (output + chunk.toString()).slice(-20_000)));
    child.stderr.on("data", (chunk) => (errors = (errors + chunk.toString()).slice(-4000)));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(output)
      : reject(new Error(toolFailure(errors) || toolFailure(output) || `${path.basename(file)} failed.`))));
  });
  const installer = createLspInstaller({ baseDir: serversDir, findCommand, run, ...(fetch ? { fetch } : {}) });

  const rootOf = (workspaceId, channelId) => {
    const channel = Number(channelId);
    if (!Number.isSafeInteger(channel)) throw new Error("Not a channel.");
    return path.join(baseDir, safeSegment(String(workspaceId)), String(channel));
  };
  const manifestOf = (root) => `${root}.json`;
  const inside = (root, segments) => {
    const file = path.join(root, ...segments.map(safeSegment));
    if (!isInside(root, file)) throw new Error("A file path left the run folder.");
    return file;
  };
  const syncing = new Map();

  // Writes the channel's files into its run folder: changed ones again, removed ones away. Files the app didn't
  // write (build output, installed packages) are left alone. Returns the folder and how many weren't on this device.
  async function sync(workspaceId, channelId, entries) {
    const root = rootOf(workspaceId, channelId);
    const previous = syncing.get(root) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => write(root, Array.isArray(entries) ? entries : []));
    syncing.set(root, task);
    return task;
  }

  async function write(root, entries) {
    await fs.mkdir(root, { recursive: true });
    let manifest = {};
    try {
      manifest = JSON.parse(await fs.readFile(manifestOf(root), "utf8"));
    } catch {
      // A first sync.
    }
    const next = {};
    let missing = 0;
    for (const entry of entries) {
      if (!Array.isArray(entry?.path) || !entry.path.length) continue;
      const file = inside(root, entry.path.map(String));
      const relative = path.relative(root, file);
      const sig = typeof entry.text === "string" ? `text:${createHash("sha256").update(entry.text).digest("hex")}` : String(entry.hash ?? "");
      const known = manifest[relative];
      const stats = await fs.stat(file).catch(() => null);
      if (known?.sig === sig && stats && stats.size === known.size && stats.mtimeMs === known.mtimeMs) {
        next[relative] = known;
        continue;
      }
      if (typeof entry.text !== "string") {
        const source = entry.hash ? await findContent(String(entry.hash)) : null;
        if (!source) {
          missing++;
          if (known) next[relative] = known;
          continue;
        }
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.copyFile(source, file);
      } else {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, entry.text);
      }
      const written = await fs.stat(file);
      next[relative] = { sig, size: written.size, mtimeMs: written.mtimeMs };
    }
    for (const relative of Object.keys(manifest)) {
      if (next[relative]) continue;
      const file = path.join(root, relative);
      await fs.rm(file, { force: true }).catch(() => {});
      for (let dir = path.dirname(file); dir.startsWith(root) && dir !== root; dir = path.dirname(dir)) {
        if (await fs.rmdir(dir).then(() => false, () => true)) break;
      }
    }
    await fs.writeFile(manifestOf(root), JSON.stringify(next));
    return { folder: root, missing };
  }

  // Language servers: one process per start, messages framed as LSP over stdio and passed through as JSON text.
  const servers = new Map();
  let nextId = 1;

  function serverCommand(serverId, override) {
    const known = languageServers[serverId];
    if (!known) throw new Error("Unknown language server.");
    if (typeof override === "string" && override.trim()) {
      const file = override.trim();
      if (!path.isAbsolute(file) || !existsSync(file)) throw new Error(`${file} isn't a program on this computer.`);
      const base = path.basename(file).replace(/\.(exe|cmd|bat)$/i, "");
      return [file, (known.commands.find(([name]) => name === base) ?? known.commands[0])[1], {}];
    }
    for (const [name, args] of known.commands) {
      const file = usableCommand(name, findCommand(name));
      if (file) return [file, args, {}];
    }
    return installer.installed(serverId);
  }

  // `confirm` rejects unless the user agrees: the run folder holds files other members wrote.
  async function startServer(sender, serverId, workspaceId, channelId, override, confirm) {
    const command = serverCommand(serverId, override);
    if (!command) return { ok: false, missing: languageServers[serverId].commands.map(([name]) => name), install: installer.source(serverId) };
    await confirm({ label: languageServers[serverId].label, program: command[0] });
    const root = rootOf(workspaceId, channelId);
    if (serverId === "csharp" && !hasProject(root)) command[1] = [...command[1], "--solution", looseCSharpSolution(root)];
    const child = start(spawn, command[0], command[1], { cwd: existsSync(root) ? root : os.homedir(), env: { ...cleanEnv(), ...command[2] }, stdio: ["pipe", "pipe", "pipe"] });
    const id = nextId++;
    let buffer = Buffer.alloc(0);
    let errors = "";
    const send = (channel, ...args) => !sender.isDestroyed() && sender.send(channel, id, ...args);
    child.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const length = Number(/content-length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString("ascii"))?.[1]);
        if (!Number.isFinite(length)) {
          buffer = buffer.subarray(end + 4);
          continue;
        }
        if (buffer.length < end + 4 + length) return;
        send("lsp:message", buffer.subarray(end + 4, end + 4 + length).toString("utf8"));
        buffer = buffer.subarray(end + 4 + length);
      }
    });
    let crash = "";
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      crash ||= /^.*(unhandled exception|panicked|fatal error).*$/im.exec(text)?.[0].trim() ?? "";
      errors = (errors + text).slice(-2000);
    });
    child.on("error", (e) => (errors += e.message));
    // Writing to a server that is exiting fails with EPIPE; unheard, that error would take the whole main process down.
    child.stdin.on("error", (e) => (errors += e.message));
    child.on("exit", (code) => {
      servers.delete(id);
      send("lsp:exit", code, crash || errors);
    });
    servers.set(id, { child, owner: sender.id, serverId });
    sender.once("destroyed", () => stopServer(id));
    return { ok: true, id, command: command[0] };
  }

  function sendServer(id, text) {
    const server = servers.get(id);
    if (!server) return;
    const body = Buffer.from(String(text), "utf8");
    server.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    server.child.stdin.write(body);
  }

  function stopServer(id) {
    const server = servers.get(id);
    if (!server) return;
    servers.delete(id);
    server.child.stdin.end();
    setTimeout(() => server.child.exitCode === null && server.child.kill(), 2000);
  }

  // Terminals: a shell in the run folder, or one command through the shell (a Run). Each is shown by one page, its
  // owner: the page that started it (its origin), or a terminal window it was popped out into. The last output is
  // kept (`backlog`) so a page taking the terminal over shows what was there. When a terminal window closes, its
  // terminal returns to its origin; when no page is left to show it, it ends.
  const terminals = new Map();
  const backlogLimit = 256 * 1024;
  const watchedPages = new WeakSet();

  function defaultShell() {
    if (windows) return findCommand("pwsh") ?? findCommand("powershell") ?? process.env.COMSPEC ?? "cmd.exe";
    return process.env.SHELL || (existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh");
  }

  const sendTo = (page, channel, id, ...args) => page && !page.isDestroyed() && page.send(channel, id, ...args);

  // What a page needs to show the terminal: where it belongs, its tab, its state and its last output.
  const stateOf = (t) => ({
    workspaceId: t.options.workspaceId, channelId: t.options.channelId, title: t.options.title, command: t.options.command,
    running: t.process !== null, exitCode: t.exitCode, backlog: t.backlog,
  });

  // A page gone: terminals it showed go back to their origin if they were away, else they end; terminals that
  // started there and sit in a terminal window stay with that window, which then has nowhere to return them.
  function watchPage(page) {
    if (watchedPages.has(page)) return;
    watchedPages.add(page);
    page.once("destroyed", () => {
      for (const [id, t] of terminals) {
        if (t.owner === page && t.origin && t.origin !== page && !t.origin.isDestroyed()) {
          t.owner = t.origin;
          sendTo(t.origin, "term:returned", id, stateOf(t));
        } else if (t.owner === page) closeTerminal(id);
        else if (t.origin === page) t.origin = null;
      }
    });
  }

  async function spawnTerminal(id) {
    const t = terminals.get(id);
    const pty = await loadPty();
    if (!pty) throw new Error("Terminals aren't available in this build.");
    const { workspaceId, channelId, command, shell } = t.options;
    const root = rootOf(workspaceId, channelId);
    const program = typeof shell === "string" && shell.trim() ? shell.trim() : defaultShell();
    const powershell = /(pwsh|powershell)(\.exe)?$/i.test(program);
    const cmd = /cmd(\.exe)?$/i.test(program);
    const args = typeof command !== "string" || !command.trim() ? []
      : powershell ? ["-NoLogo", "-Command", command] : cmd ? ["/d", "/s", "/c", command] : ["-c", command];
    const proc = pty.spawn(program, args, {
      name: "xterm-256color", cols: t.cols, rows: t.rows,
      cwd: existsSync(root) ? root : os.homedir(), env: { ...cleanEnv(), TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
    t.process = proc;
    t.exitCode = null;
    proc.onData((data) => {
      if (t.process !== proc) return;
      t.backlog = (t.backlog + data).slice(-backlogLimit);
      sendTo(t.owner, "term:data", id, data);
    });
    proc.onExit(({ exitCode }) => {
      if (t.process !== proc) return;
      t.process = null;
      t.exitCode = exitCode;
      sendTo(t.owner, "term:exit", id, exitCode);
    });
  }

  async function startTerminal(sender, { workspaceId, channelId, command, shell, title, cols, rows }) {
    const id = nextId++;
    terminals.set(id, {
      owner: sender, origin: sender, process: null, exitCode: null, backlog: "",
      cols: Math.max(2, Number(cols) || 80), rows: Math.max(1, Number(rows) || 24),
      options: { workspaceId, channelId, command: typeof command === "string" && command.trim() ? command : null, shell, title: String(title ?? "Terminal") },
    });
    watchPage(sender);
    try {
      await spawnTerminal(id);
    } catch (e) {
      terminals.delete(id);
      throw e;
    }
    return id;
  }

  // A terminal window's page takes the terminal over; returns what it needs to show it.
  function adoptTerminal(sender, id) {
    const t = terminals.get(id);
    if (!t) throw new Error("That terminal has ended.");
    t.owner = sender;
    watchPage(sender);
    return stateOf(t);
  }

  // Runs a Run's command (or the shell) again under the same id.
  async function restartTerminal(id) {
    const t = terminals.get(id);
    if (!t) return;
    killTerminal(id);
    // Let go of the stopped process at once: if the new one can't start, the terminal shows as stopped, not running.
    t.process = null;
    t.backlog = "";
    await spawnTerminal(id);
  }

  // Stops the terminal's program (its exit is reported as usual); the terminal stays, so it can run again.
  function killTerminal(id) {
    const proc = terminals.get(id)?.process;
    if (!proc) return;
    try {
      proc.kill();
    } catch {
      // Already gone.
    }
  }

  function closeTerminal(id) {
    killTerminal(id);
    terminals.delete(id);
  }

  return {
    sync,
    folder: (workspaceId, channelId) => rootOf(workspaceId, channelId),
    startServer, sendServer, stopServer,
    installServer: (serverId) => installer.install(serverId),
    // Installed servers, and which program on this computer is used before the installed one.
    async installedServers() {
      return (await installer.list()).map((server) => ({
        ...server, label: languageServers[server.id].label,
        found: languageServers[server.id].commands.map(([name]) => usableCommand(name, findCommand(name))).find(Boolean) ?? null,
      }));
    },
    async uninstallServer(serverId) {
      for (const server of servers.values()) if (server.serverId === serverId) server.child.kill();
      await installer.uninstall(serverId);
    },
    startTerminal, adoptTerminal, restartTerminal, killTerminal, closeTerminal,
    // The page that shows the terminal now (a terminal window's, or its origin's).
    terminalOwner: (id) => terminals.get(id)?.owner ?? null,
    terminalOrigin: (id) => terminals.get(id)?.origin ?? null,
    writeTerminal: (id, data) => terminals.get(id)?.process?.write(String(data)),
    resizeTerminal(id, cols, rows) {
      const t = terminals.get(id);
      if (!t) return;
      t.cols = Math.max(2, Number(cols) || 80);
      t.rows = Math.max(1, Number(rows) || 24);
      t.process?.resize(t.cols, t.rows);
    },
  };
}
