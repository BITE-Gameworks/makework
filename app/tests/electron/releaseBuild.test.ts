// A release build against a real repository: the chosen branch is built in a temporary copy, with its build
// configuration's commands, and the release files come back while the user's working copy stays as it was.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGit } from "../../electron/gitOps.js";
import { build } from "../../electron/release.js";

let root: string;
let repo: string;
let env: NodeJS.ProcessEnv;
let git: ReturnType<typeof createGit>;

const sh = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
// A build command that works in every shell: node writes the files.
const writes = (files: Record<string, string>) => `node -e "${Object.entries(files).map(([file, text]) =>
  `require('fs').mkdirSync(require('path').dirname('${file}'),{recursive:true});require('fs').writeFileSync('${file}','${text}');`).join("")}"`;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mw-release-"));
  const config = path.join(root, "gitconfig");
  fs.writeFileSync(config, "[user]\n\tname = Tester\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n");
  env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" };
  git = createGit({ env });
  repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  sh("init", "-q");
  fs.writeFileSync(path.join(repo, "README.md"), "main\n");
  sh("add", ".");
  sh("commit", "-qm", "main");
  sh("checkout", "-qb", "feature");
  fs.mkdirSync(path.join(repo, "tool"));
  fs.writeFileSync(path.join(repo, "tool", "VERSION"), "2.0\n");
  fs.mkdirSync(path.join(repo, "tool", "out"));
  fs.writeFileSync(path.join(repo, "tool", "out", "tool-1.0.zip"), "an older build, committed");
  sh("add", ".");
  sh("commit", "-qm", "feature");
  sh("checkout", "-q", "main");
  fs.writeFileSync(path.join(repo, "README.md"), "changed, not committed\n");
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const run = (plan: unknown) => build({ folder: repo, branch: "feature", plan, onLog: () => {}, git });

describe("building a release", () => {
  it("runs the commands in the branch's project folder and takes the files that match", async () => {
    const files = await run({
      project: "tool", output: "out", collect: { kind: "pattern", pattern: "*.jar" },
      steps: [writes({ "out/tool-2.0.jar": "jar" }), writes({ "out/notes.txt": "notes" })],
    });
    expect(files.map((f) => f.name)).toEqual(["tool-2.0.jar"]);
    expect(fs.readFileSync(files[0].path, "utf8")).toBe("jar");
    expect(files[0].size).toBe(3);
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("changed, not committed\n");
    expect(fs.existsSync(path.join(repo, "tool"))).toBe(false);
    expect(sh("worktree", "list").split("\n")).toHaveLength(1);
  });

  it("leaves out installers the branch holds, though the checkout just wrote them", async () => {
    const files = await run({ project: "tool", output: "out", collect: { kind: "binaries" }, steps: [writes({ "out/tool-2.0.zip": "new" })] });
    expect(files.map((f) => f.name)).toEqual(["tool-2.0.zip"]);
  });

  it("packs an output folder into one zip", async () => {
    const [zip, ...more] = await run({
      project: "tool", output: "publish", collect: { kind: "zip" },
      steps: [writes({ "publish/tool.dll": "dll", "publish/runtimes/x/native.so": "so" })],
    });
    expect(more).toEqual([]);
    expect(zip.name).toMatch(/^tool-(linux|windows|macos)-[\w]+\.zip$/);
    const unpacked = unzipSync(fs.readFileSync(zip.path));
    expect(Object.keys(unpacked).sort()).toEqual(["runtimes/x/native.so", "tool.dll"]);
    expect(new TextDecoder().decode(unpacked["tool.dll"])).toBe("dll");
  });

  it("leaves the temporary copy's .git file out of a zip of the whole repository", async () => {
    const [zip] = await run({ project: ".", output: ".", collect: { kind: "zip" }, steps: [writes({ "dist/app.js": "js" })] });
    const names = Object.keys(unzipSync(fs.readFileSync(zip.path)));
    expect(names).toContain("dist/app.js");
    expect(names.some((name) => name === ".git" || name.startsWith(".git/"))).toBe(false);
  });

  it("gives files of the same name distinct names, also against one already named like that", async () => {
    const files = await run({
      project: "tool", output: "out", collect: { kind: "pattern", pattern: "**/*.deb" },
      steps: [writes({ "out/deb/app.deb": "a", "out/rpm/app.deb": "b", "out/rpm-app.deb": "c" })],
    });
    const names = files.map((f) => f.name);
    expect(new Set(names).size).toBe(3);
    expect(new Set(files.map((f) => fs.readFileSync(f.path, "utf8")))).toEqual(new Set(["a", "b", "c"]));
  });

  it("says so when a command fails, when nothing matches, and when the branch's build isn't recognized", async () => {
    await expect(run({ project: ".", output: ".", collect: { kind: "binaries" }, steps: ["node -e \"process.exit(3)\""] })).rejects.toThrow("exit code 3");
    await expect(run({ project: ".", output: "out", collect: { kind: "pattern", pattern: "*.jar" }, steps: [writes({ "out/a.txt": "a" })] }))
      .rejects.toThrow("left no release files in out");
    await expect(run(null)).rejects.toThrow("isn't recognized");
    expect(sh("worktree", "list").split("\n")).toHaveLength(1);
  });
});
