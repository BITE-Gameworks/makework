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

// The "diff --git" sections of a diff, each as its header lines and its hunks' text.
function sections(text: string): { head: string[]; body: string }[] {
  return text.split(/^(?=diff --git )/m).filter((s) => s.startsWith("diff --git ")).map((section) => {
    const all = section.split("\n");
    const at = all.findIndex((line) => line.startsWith("@@"));
    return at < 0 ? { head: all, body: "" } : { head: all.slice(0, at), body: all.slice(at).join("\n") };
  });
}

// `git show` / `git diff` output: one entry per "diff --git" section.
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  for (const { head: headLines, body } of sections(text)) {
    const head = headLines[0].slice("diff --git ".length);
    // "a/x b/x": without renames both halves name the same file, which may contain spaces.
    const half = head.length >= 5 ? head.slice(Math.floor(head.length / 2) + 1) : head;
    let oldPath: string | null = cleanPath(head.slice(0, Math.floor(head.length / 2)));
    let path = cleanPath(half);
    let status: DiffFile["status"] = "modified";
    let binary = false;
    for (const line of headLines.slice(1)) {
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
    const lines = hunkLines(body);
    files.push({ path, oldPath, status, additions: count(lines, "add"), deletions: count(lines, "del"), binary, lines });
  }
  return files;
}

const isChange = (line: DiffLine) => line.kind === "add" || line.kind === "del";

// Whether changes of a working diff's file can be picked one by one to discard: text that is still there (a deleted
// file comes back whole).
export const canPickLines = (file: DiffFile) => !file.binary && file.status !== "deleted" && file.lines.some(isChange);

const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@(.*)$/;

// One file's working diff (the last commit to the files) cut down to the picked changes, to apply in reverse: that
// takes out just those. Lines are picked by their index in the file's `DiffFile.lines`. An unpicked added line becomes
// context (it stays in the file) and an unpicked removed line is left out (it stays removed); the old side's counts
// are worked out again, shifted by the hunks before. Part of a new file is taken out as a change to it, not as the
// file. Null with nothing picked.
export function pickedPatch(patch: string, picked: (line: number) => boolean): string | null {
  const [section] = sections(patch);
  if (!section) return null;
  const lines = hunkLines(section.body);
  const changes = lines.flatMap((line, i) => (isChange(line) ? [i] : []));
  const chosen = changes.filter(picked);
  if (!chosen.length) return null;
  const minus = section.head.find((line) => line.startsWith("--- "));
  const plus = section.head.find((line) => line.startsWith("+++ "));
  if (!minus || !plus || plus === "+++ /dev/null") return null;
  const head = chosen.length === changes.length ? section.head : [
    section.head[0],
    minus === "--- /dev/null" ? plus.replace(/^\+\+\+ ("?)b\//, "--- $1a/") : minus,
    plus,
  ];
  const out = [...head];
  // How many more lines the result has than the file, from the hunks before.
  let shift = 0;
  for (let at = 0; at < lines.length; at++) {
    const header = lines[at].kind === "hunk" ? hunkHeader.exec(lines[at].text) : null;
    if (!header) continue;
    const newStart = Number(header[1]);
    const newCount = header[2] === undefined ? 1 : Number(header[2]);
    const body: string[] = [];
    let oldCount = 0;
    let any = false;
    // A "\ No newline" note belongs to the line before it, and goes where that line goes.
    let lastKept = false;
    for (let i = at + 1; i < lines.length && lines[i].kind !== "hunk"; i++) {
      const line = lines[i];
      const take = picked(i);
      if (line.kind === "note") {
        if (lastKept) body.push(`\\ ${line.text}`);
        continue;
      }
      lastKept = line.kind !== "del" || take;
      if (!lastKept) continue;
      any ||= isChange(line) && take;
      if (line.kind === "add" && take) body.push(`+${line.text}`);
      else body.push(`${line.kind === "del" ? "-" : " "}${line.text}`);
      if (line.kind !== "add" || !take) oldCount++;
    }
    const firstLine = (newCount ? newStart : newStart + 1) + shift;
    shift += oldCount - newCount;
    if (!any) continue;
    out.push(`@@ -${oldCount ? firstLine : firstLine - 1},${oldCount} +${newStart},${newCount} @@${header[3]}`, ...body);
  }
  return `${out.join("\n")}\n`;
}

// A host's per-file entry (patch null: binary or too large for the host to send).
export function hostFile(entry: { path: string; oldPath: string | null; status: DiffFile["status"]; patch: string | null; additions?: number; deletions?: number }): DiffFile {
  const lines = entry.patch ? hunkLines(entry.patch) : [];
  return {
    path: entry.path, oldPath: entry.oldPath, status: entry.status, binary: entry.patch === null, lines,
    additions: entry.additions ?? count(lines, "add"), deletions: entry.deletions ?? count(lines, "del"),
  };
}
