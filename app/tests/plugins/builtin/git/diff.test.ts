import { describe, expect, it } from "vitest";
import { canPickLines, hunkLines, parseUnifiedDiff, pickedPatch } from "../../../../src/plugins/builtin/git/diff";

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

describe("the patch of picked changes", () => {
  const modified = [
    "diff --git a/list.txt b/list.txt",
    "index 1111111..2222222 100644",
    "--- a/list.txt",
    "+++ b/list.txt",
    "@@ -1,4 +1,5 @@",
    " one",
    "-two",
    "+TWO",
    "+extra",
    " three",
    " four",
    "@@ -10,3 +11,3 @@ section",
    " ten",
    "-eleven",
    "+ELEVEN",
    " twelve",
    "",
  ].join("\n");
  // Indexes into the file's lines: 0 hunk, 1 one, 2 -two, 3 +TWO, 4 +extra, 5 three, 6 four, 7 hunk, 8 ten,
  // 9 -eleven, 10 +ELEVEN, 11 twelve.
  const picked = (...lines: number[]) => (line: number) => lines.includes(line);

  it("lines up its indexes with the file's lines", () => {
    const [file] = parseUnifiedDiff(modified);
    expect(file.lines[3]).toMatchObject({ kind: "add", text: "TWO" });
    expect(file.lines[9]).toMatchObject({ kind: "del", text: "eleven" });
  });

  it("keeps an unpicked added line as context and leaves an unpicked removed line out", () => {
    expect(pickedPatch(modified, picked(4))).toBe([
      "diff --git a/list.txt b/list.txt",
      "--- a/list.txt",
      "+++ b/list.txt",
      "@@ -1,4 +1,5 @@",
      " one",
      " TWO",
      "+extra",
      " three",
      " four",
      "",
    ].join("\n"));
  });

  it("brings a picked removed line back and shifts later hunks by what earlier ones change", () => {
    expect(pickedPatch(modified, picked(2, 10))).toBe([
      "diff --git a/list.txt b/list.txt",
      "--- a/list.txt",
      "+++ b/list.txt",
      "@@ -1,6 +1,5 @@",
      " one",
      "-two",
      " TWO",
      " extra",
      " three",
      " four",
      "@@ -12,2 +11,3 @@ section",
      " ten",
      "+ELEVEN",
      " twelve",
      "",
    ].join("\n"));
  });

  it("keeps git's own header when every change is picked", () => {
    const all = pickedPatch(modified, picked(2, 3, 4, 9, 10));
    expect(all?.split("\n").slice(0, 4)).toEqual(modified.split("\n").slice(0, 4));
    expect(all).toContain("@@ -10,3 +11,3 @@ section");
  });

  it("takes part of a new file out as a change to it, and all of it as the file", () => {
    const created = [
      "diff --git \"a/new \\303\\251.txt\" \"b/new \\303\\251.txt\"",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ \"b/new \\303\\251.txt\"",
      "@@ -0,0 +1,2 @@",
      "+keep",
      "+drop",
      "",
    ].join("\n");
    expect(pickedPatch(created, picked(2))).toBe([
      "diff --git \"a/new \\303\\251.txt\" \"b/new \\303\\251.txt\"",
      "--- \"a/new \\303\\251.txt\"",
      "+++ \"b/new \\303\\251.txt\"",
      "@@ -1,1 +1,2 @@",
      " keep",
      "+drop",
      "",
    ].join("\n"));
    expect(pickedPatch(created, picked(1, 2))).toContain("new file mode 100644\n");
  });

  it("keeps a missing final line break with the line it belongs to", () => {
    const ending = [
      "diff --git a/end.txt b/end.txt",
      "--- a/end.txt",
      "+++ b/end.txt",
      "@@ -1,2 +1,2 @@",
      " first",
      "-last",
      "\\ No newline at end of file",
      "+LAST",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    // 0 hunk, 1 first, 2 -last, 3 note, 4 +LAST, 5 note.
    expect(pickedPatch(ending, picked(4))).toBe([
      "diff --git a/end.txt b/end.txt",
      "--- a/end.txt",
      "+++ b/end.txt",
      "@@ -1,1 +1,2 @@",
      " first",
      "+LAST",
      "\\ No newline at end of file",
      "",
    ].join("\n"));
  });

  it("is nothing with nothing picked, and never part of a deleted file", () => {
    expect(pickedPatch(modified, picked())).toBeNull();
    const deleted = "diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n";
    expect(pickedPatch(deleted, picked(1))).toBeNull();
    expect(canPickLines(parseUnifiedDiff(deleted)[0])).toBe(false);
    expect(canPickLines(parseUnifiedDiff(modified)[0])).toBe(true);
  });
});
