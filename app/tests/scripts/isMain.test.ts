import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// A probe script in a temporary folder, reached directly and through a symlinked folder (like /home -> /var/home on
// Fedora Atomic), that prints what isMain says about itself.
const helper = pathToFileURL(path.resolve(import.meta.dirname, "../../scripts/isMain.mjs")).href;
const dir = mkdtempSync(path.join(tmpdir(), "makework-ismain-"));
mkdirSync(path.join(dir, "real"));
symlinkSync(path.join(dir, "real"), path.join(dir, "link"), process.platform === "win32" ? "junction" : "dir");
writeFileSync(
  path.join(dir, "real", "probe.mjs"),
  `import { isMain } from ${JSON.stringify(helper)};\nconsole.log(isMain(import.meta.url));\n`,
);
writeFileSync(path.join(dir, "real", "importer.mjs"), `import "./probe.mjs";\n`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const started = (file: string) => {
  const run = spawnSync(process.execPath, [file], { encoding: "utf8" });
  return run.stdout.trim() || run.stderr.trim();
};

describe("isMain", () => {
  it("is true for the script node was started with", () => {
    expect(started(path.join(dir, "real", "probe.mjs"))).toBe("true");
  });

  it("is true when the script's path goes through a symlink", () => {
    expect(started(path.join(dir, "link", "probe.mjs"))).toBe("true");
  });

  it("is false in a module another script imports", () => {
    expect(started(path.join(dir, "real", "importer.mjs"))).toBe("false");
  });
});
