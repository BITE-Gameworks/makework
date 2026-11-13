// Raises the app version (first.second.third) in package.json and package-lock.json. By hand, from app/:
//   npm run bump_version -- minor    1.2.7 -> 1.3.0
//   npm run bump_version -- major    1.2.7 -> 2.0.0
// The third number is raised by .github/workflows/version.yml on every push to main (`patch --since <commit>`, which
// leaves the version alone when that push raised the first or second number by hand). Commits nothing itself.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./isMain.mjs";

export function nextVersion(version, part) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`"${version}" isn't first.second.third.`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (part === "major") return `${major + 1}.0.0`;
  if (part === "minor") return `${major}.${minor + 1}.0`;
  if (part === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Choose major or minor, not "${part}".`);
}

export function sameSeries(a, b) {
  return a.split(".").slice(0, 2).join(".") === b.split(".").slice(0, 2).join(".");
}

const appFolder = join(dirname(fileURLToPath(import.meta.url)), "..");

function rewriteJson(file, change) {
  const path = join(appFolder, file);
  const value = JSON.parse(readFileSync(path, "utf8"));
  change(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// The version at an earlier commit; null when that commit can't be read (a first push, a rewritten history).
function versionAt(commit) {
  try {
    const file = execFileSync("git", ["show", `${commit}:./package.json`], { cwd: appFolder, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(file).version;
  } catch {
    return null;
  }
}

function main([part, flag, commit]) {
  const current = JSON.parse(readFileSync(join(appFolder, "package.json"), "utf8")).version;
  if (flag === "--since") {
    const before = versionAt(commit);
    if (before && !sameSeries(before, current)) {
      console.log(`Left at ${current}: this push went from ${before} by hand.`);
      return;
    }
  }
  const next = nextVersion(current, part);
  rewriteJson("package.json", (pkg) => { pkg.version = next; });
  rewriteJson("package-lock.json", (lock) => {
    lock.version = next;
    lock.packages[""].version = next;
  });
  console.log(`${current} -> ${next}`);
}

if (isMain(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
