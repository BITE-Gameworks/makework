// Diffs as files with numbered lines: from git's unified diff text (a local folder's commits and working changes), or
// from a host's per-file patches (GitHub and GitLab send each file's hunks separately).

export interface DiffLine {
  kind: "hunk" | "context" | "add" | "del" | "note";
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface DiffFile {
  path: string;
  // null for a new file.
  oldPath: string | null;
  status: "added" | "deleted" | "modified" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
  lines: DiffLine[];
}

export interface CommitDiff {
  files: DiffFile[];
  // The host or git stopped early (huge commits): some files or lines are missing.
  truncated: boolean;
}

// Git quotes paths with unusual characters ("a/sp\303\251cial"); the quotes and the a/ b/ prefix go.
function cleanPath(raw: string): string {
  let p = raw.trim();
  if (p.startsWith("\"") && p.endsWith("\"")) {
    // Inside the quotes everything is ASCII, with other bytes as octal escapes (UTF-8 split into bytes).
    const bytes = p.slice(1, -1).replace(/\\([0-7]{3})/g, (_m, oct: string) => String.fromCodePoint(Number.parseInt(oct, 8)))
      .replace(/\\(.)/g, (_m, c: string) => ({ n: "\n", t: "\t" })[c as "n" | "t"] ?? c);
    p = new TextDecoder().decode(Uint8Array.from(bytes, (c) => c.charCodeAt(0) & 0xff));
  }
  return p.replace(/^[ab]\//, "");
}

// The hunks of one file: "@@ -a,b +c,d @@" headers and the lines under them, numbered on both sides.
export function hunkLines(text: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of text.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      lines.push({ kind: "hunk", text: raw });
    } else if (raw.startsWith("+")) lines.push({ kind: "add", text: raw.slice(1), newNo: newNo++ });
    else if (raw.startsWith("-")) lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++ });
    else if (raw.startsWith(" ")) lines.push({ kind: "context", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    else if (raw.startsWith("\\")) lines.push({ kind: "note", text: raw.slice(1).trim() });
  }
  return lines;
}

const count = (lines: DiffLine[], kind: DiffLine["kind"]) => lines.filter((l) => l.kind === kind).length;

// `git show` / `git diff` output: one entry per "diff --git" section.
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  const sections = text.split(/^(?=diff --git )/m).filter((s) => s.startsWith("diff --git "));
  for (const section of sections) {
    const all = section.split("\n");
    const head = all[0].slice("diff --git ".length);
    // "a/x b/x": without renames both halves name the same file, which may contain spaces.
    const half = head.length >= 5 ? head.slice(Math.floor(head.length / 2) + 1) : head;
    let oldPath: string | null = cleanPath(head.slice(0, Math.floor(head.length / 2)));
    let path = cleanPath(half);
    let status: DiffFile["status"] = "modified";
    let binary = false;
    let body = 1;
    for (; body < all.length && !all[body].startsWith("@@"); body++) {
      const line = all[body];
      if (line.startsWith("new file mode")) status = "added";
      else if (line.startsWith("deleted file mode")) status = "deleted";
      else if (line.startsWith("rename from ")) {
        oldPath = cleanPath(line.slice("rename from ".length));
        status = "renamed";
      } else if (line.startsWith("rename to ")) path = cleanPath(line.slice("rename to ".length));
      else if (line.startsWith("--- ") && !line.startsWith("--- /dev/null")) oldPath = cleanPath(line.slice(4));
      else if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null")) path = cleanPath(line.slice(4));
      else if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) binary = true;
    }
    if (status === "deleted") path = oldPath ?? path;
    if (status === "added") oldPath = null;
    const lines = hunkLines(all.slice(body).join("\n"));
    files.push({ path, oldPath, status, additions: count(lines, "add"), deletions: count(lines, "del"), binary, lines });
  }
  return files;
}

// A host's per-file entry (patch null: binary or too large for the host to send).
export function hostFile(entry: { path: string; oldPath: string | null; status: DiffFile["status"]; patch: string | null; additions?: number; deletions?: number }): DiffFile {
  const lines = entry.patch ? hunkLines(entry.patch) : [];
  return {
    path: entry.path, oldPath: entry.oldPath, status: entry.status, binary: entry.patch === null, lines,
    additions: entry.additions ?? count(lines, "add"), deletions: entry.deletions ?? count(lines, "del"),
  };
}
