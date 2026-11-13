import { describe, expect, it } from "vitest";
import { hunkLines, parseUnifiedDiff } from "../../../../src/plugins/builtin/git/diff";

const patch = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@ function start()",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " export { a };",
  "diff --git a/docs/new file.md b/docs/new file.md",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/docs/new file.md",
  "@@ -0,0 +1 @@",
  "+# Hello",
  "diff --git a/old.txt b/old.txt",
  "deleted file mode 100644",
  "index 4444444..0000000",
  "--- a/old.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "\\ No newline at end of file",
  "diff --git a/logo.png b/logo.png",
  "index 5555555..6666666 100644",
  "Binary files a/logo.png and b/logo.png differ",
  "diff --git a/a.txt b/b.txt",
  "similarity index 100%",
  "rename from a.txt",
  "rename to b.txt",
  "",
].join("\n");

describe("unified diffs", () => {
  it("splits a commit's diff into files with numbered lines", () => {
    const files = parseUnifiedDiff(patch);
    expect(files.map((f) => [f.path, f.oldPath, f.status, f.additions, f.deletions, f.binary])).toEqual([
      ["src/app.ts", "src/app.ts", "modified", 2, 1, false],
      ["docs/new file.md", null, "added", 1, 0, false],
      ["old.txt", "old.txt", "deleted", 0, 1, false],
      ["logo.png", "logo.png", "modified", 0, 0, true],
      ["b.txt", "a.txt", "renamed", 0, 0, false],
    ]);
    expect(files[0].lines).toEqual([
      { kind: "hunk", text: "@@ -1,3 +1,4 @@ function start()" },
      { kind: "context", text: "const a = 1;", oldNo: 1, newNo: 1 },
      { kind: "del", text: "const b = 2;", oldNo: 2 },
      { kind: "add", text: "const b = 3;", newNo: 2 },
      { kind: "add", text: "const c = 4;", newNo: 3 },
      { kind: "context", text: "export { a };", oldNo: 3, newNo: 4 },
    ]);
    expect(files[2].lines.at(-1)).toEqual({ kind: "note", text: "No newline at end of file" });
  });

  it("reads a host's per-file patch (GitHub and GitLab send only the hunks)", () => {
    expect(hunkLines("@@ -5,2 +5,2 @@\n-old\n+new\n same")).toEqual([
      { kind: "hunk", text: "@@ -5,2 +5,2 @@" },
      { kind: "del", text: "old", oldNo: 5 },
      { kind: "add", text: "new", newNo: 5 },
      { kind: "context", text: "same", oldNo: 6, newNo: 6 },
    ]);
  });

  it("reads paths git quoted for their unusual characters", () => {
    const quoted = "diff --git \"a/sp\\303\\251cial.txt\" \"b/sp\\303\\251cial.txt\"\n--- \"a/sp\\303\\251cial.txt\"\n+++ \"b/sp\\303\\251cial.txt\"\n@@ -1 +1 @@\n-a\n+b";
    expect(parseUnifiedDiff(quoted)[0].path).toBe("spécial.txt");
  });

  it("copes with an empty diff and a cut off one", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a")[0].deletions).toBe(1);
  });
});
