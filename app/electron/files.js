// File names and file removal that work on every system the app ships for. Windows is the strictest: it refuses
// some names, drops trailing dots and spaces, treats names that differ only in case as one file, and can't delete
// a file something still has open. No Electron imports, so tests can load this.
import path from "node:path";
import { trimEnd } from "./text.js";

const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

// One path segment that is a valid, faithful file or folder name everywhere.
export function safeSegment(name) {
  let cleaned = trimEnd(String(name).replace(/[/\\:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 200), ". ");
  if (cleaned === "") return "_";
  const device = reserved.exec(cleaned);
  if (device) cleaned = `${device[1]}_${device[2] ?? ""}`;
  return cleaned;
}

// Whether `file` is below `dir` (not `dir` itself, not beside it). `paths` is node:path, or path.win32 in tests.
export function isInside(dir, file, paths = path) {
  const relative = paths.relative(dir, file);
  return !!relative && relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
}

function numbered(name, n) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

// Paths (lists of segments) where names that would be the same on a case-insensitive file system ("Readme.md",
// "README.md" in one folder) get a number: "README (2).md". The same input always gives the same names (assigned in
// sorted order), so a folder copy doesn't flip between runs. Returns the paths in the order given.
export function caseFreePaths(paths) {
  const order = paths.map((path, i) => ({ path, i })).sort((a, b) => (a.path.join("/") < b.path.join("/") ? -1 : 1));
  const assigned = new Map();
  const used = new Map();
  const result = [];
  for (const { path, i } of order) {
    let parent = "";
    result[i] = path.map((segment) => {
      const key = `${parent}\u0000${segment}`;
      let name = assigned.get(key);
      if (name === undefined) {
        const taken = used.get(parent) ?? new Set();
        used.set(parent, taken);
        name = segment;
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = numbered(segment, n);
        taken.add(name.toLowerCase());
        assigned.set(key, name);
      }
      parent = `${parent}/${name}`;
      return name;
    });
  }
  return result;
}

// Deletes a file; when it is busy (open elsewhere, which Windows refuses), hands it to `later` for another try and
// still resolves, so callers can treat it as gone.
export async function removeOrDefer(file, { rm, later }) {
  try {
    await rm(file, { force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    await later(file);
  }
}
