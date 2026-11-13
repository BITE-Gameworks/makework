// Language servers the app downloads (electron/lspInstall.js), with downloads and tools faked: the version of
// csharp-ls each .NET SDK can run, clangd and rust-analyzer laid out as on Windows, and errors that say what went wrong
// (on Windows they all read "Could not reach the server" before 2026-10-30).
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toolFailure } from "../../electron/codeTools.js";
import { csharpLsVersion } from "../../electron/lspInstall.js";

const real = { platform: process.platform, arch: process.arch };
const dirs: string[] = [];

afterEach(async () => {
  Object.defineProperty(process, "platform", { value: real.platform });
  Object.defineProperty(process, "arch", { value: real.arch });
  vi.resetModules();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

// The installer as on 64-bit Windows, with `fetch` answering from `answers` (url -> body, or a status number).
type Run = (file: string, args: string[]) => Promise<string>;
async function windowsInstaller(answers: Record<string, Uint8Array | number>, run: Run = vi.fn(async () => "")) {
  Object.defineProperty(process, "platform", { value: "win32" });
  Object.defineProperty(process, "arch", { value: "x64" });
  vi.resetModules();
  const { createLspInstaller } = await import("../../electron/lspInstall.js");
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "mw-lsp-"));
  dirs.push(baseDir);
  const asked: string[] = [];
  const fetch = async (url: string) => {
    asked.push(url);
    if (url === "https://github.com/clangd/clangd/releases/latest")
      return { ok: true, status: 200, url: "https://github.com/clangd/clangd/releases/tag/23.1.0" };
    const answer = answers[url];
    if (answer === undefined) throw new Error("getaddrinfo ENOTFOUND");
    if (typeof answer === "number") return { ok: false, status: answer, url };
    return { ok: true, status: 200, url, arrayBuffer: async () => answer.slice().buffer };
  };
  const installer = createLspInstaller({ baseDir, findCommand: (name: string) => (name === "dotnet" ? "C:\\dotnet\\dotnet.exe" : null), run, fetch: fetch as never });
  return { installer, baseDir, asked, run };
}

describe("csharpLsVersion", () => {
  const sdks = (...versions: string[]) => versions.map((v) => `${v} [C:\\Program Files\\dotnet\\sdk]`).join("\r\n");

  it("picks the last csharp-ls the newest SDK can run", () => {
    expect(csharpLsVersion(sdks("8.0.404"))).toBe("0.16.0");
    expect(csharpLsVersion(sdks("8.0.404", "9.0.101"))).toBe("0.20.0");
    expect(csharpLsVersion(sdks("10.0.100"))).toBe("0.28.0");
    expect(csharpLsVersion(sdks("9.0.101", "11.0.100-preview.1"))).toBeNull();
  });

  it("asks for an SDK when there is none or only an old one", () => {
    expect(() => csharpLsVersion("")).toThrow(/needs the \.NET SDK 8 or newer/);
    expect(() => csharpLsVersion(sdks("6.0.428"))).toThrow(/needs the \.NET SDK 8 or newer/);
  });
});

describe("installing on Windows", () => {
  it("writes rust-analyzer.exe from the Windows zip", async () => {
    const zip = zipSync({ "rust-analyzer.exe": new Uint8Array([1, 2, 3]), "rust_analyzer.pdb": new Uint8Array([4]) });
    const { installer, baseDir } = await windowsInstaller({
      "https://github.com/rust-lang/rust-analyzer/releases/latest/download/rust-analyzer-x86_64-pc-windows-msvc.zip": zip,
    });
    await installer.install("rust");
    expect(readFileSync(path.join(baseDir, "rust", "rust-analyzer.exe"))).toEqual(Buffer.from([1, 2, 3]));
    expect(installer.installed("rust")?.[0]).toBe(path.join(baseDir, "rust", "rust-analyzer.exe"));
  });

  it("finds clangd's version from the latest release's address, without GitHub's API", async () => {
    const zip = zipSync({ "clangd_23.1.0/bin/clangd.exe": new Uint8Array([7]), "clangd_23.1.0/lib/clang/23/include/stddef.h": new Uint8Array([8]) });
    const { installer, baseDir, asked } = await windowsInstaller({
      "https://github.com/clangd/clangd/releases/download/23.1.0/clangd-windows-23.1.0.zip": zip,
    });
    await installer.install("c");
    expect(existsSync(path.join(baseDir, "c", "bin", "clangd.exe"))).toBe(true);
    expect(asked.some((url) => url.includes("api.github.com"))).toBe(false);
  });

  it("installs the csharp-ls the SDK can run", async () => {
    const run = vi.fn<Run>(async (_file, args) => (args[0] === "--list-sdks" ? "9.0.101 [C:\\dotnet\\sdk]\r\n" : ""));
    const { installer } = await windowsInstaller({}, run);
    await installer.install("csharp");
    expect(run).toHaveBeenLastCalledWith("C:\\dotnet\\dotnet.exe", expect.arrayContaining(["tool", "install", "csharp-ls", "--version", "0.20.0"]));
  });

  it("says which host failed and why, and leaves nothing behind", async () => {
    const { installer, baseDir } = await windowsInstaller({
      "https://github.com/rust-lang/rust-analyzer/releases/latest/download/rust-analyzer-x86_64-pc-windows-msvc.zip": 403,
    });
    await expect(installer.install("rust")).rejects.toThrow("Couldn't download from github.com: the server answered 403.");
    expect(existsSync(path.join(baseDir, "rust"))).toBe(false);
    await expect(installer.install("python")).rejects.toThrow("Couldn't download from registry.npmjs.org: getaddrinfo ENOTFOUND");
  });
});

describe("toolFailure", () => {
  it("takes the line naming an error over dotnet's list of generic causes", () => {
    expect(toolFailure("Tool 'csharp-ls' failed to install. This failure may have been caused by:\r\n\r\n* You mistyped the name of the tool.\r\n"))
      .toBe("Tool 'csharp-ls' failed to install. This failure may have been caused by:");
    expect(toolFailure("Restoring...\nerror NU1101: Unable to find package csharp-ls.\nTool 'csharp-ls' failed to install."))
      .toBe("error NU1101: Unable to find package csharp-ls.");
    expect(toolFailure("one\ntwo\n")).toBe("two");
  });
});
