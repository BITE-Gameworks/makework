import { describe, expect, it } from "vitest";
import { fromPicked, itemCount, type UploadTree } from "../../../../src/plugins/builtin/files/folders";

// A file as a folder picker gives it, with its path inside the picked folder.
const picked = (path: string) => {
  const file = new File(["x"], path.split("/").at(-1)!);
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
};

// Folder names and file names, nested, for comparing.
const shape = (tree: UploadTree): unknown => ({
  files: tree.files.map((f) => f.name),
  ...Object.fromEntries(tree.folders.map((f) => [f.name, shape(f)])),
});

describe("upload trees", () => {
  it("rebuilds folders from a folder picker's paths", () => {
    const tree = fromPicked([picked("photos/a.jpg"), picked("photos/2024/b.jpg"), picked("photos/2024/c.json"), picked("photos/notes.txt")]);
    expect(itemCount(tree)).toBe(1);
    expect(shape(tree)).toEqual({
      files: [],
      photos: { files: ["a.jpg", "notes.txt"], 2024: { files: ["b.jpg", "c.json"] } },
    });
  });

  it("keeps files from a file picker at the top", () => {
    const tree = fromPicked([new File(["x"], "a.json"), new File(["y"], "b.bin")]);
    expect(itemCount(tree)).toBe(2);
    expect(shape(tree)).toEqual({ files: ["a.json", "b.bin"] });
  });
});
