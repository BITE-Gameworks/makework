// Files and folders the user dropped or picked, as a tree to upload: each folder becomes a folder entry.
export interface UploadTree {
  name: string;
  files: File[];
  folders: UploadTree[];
}

const emptyTree = (name: string): UploadTree => ({ name, files: [], folders: [] });

// Files and top-level folders in the tree.
export const itemCount = (tree: UploadTree) => tree.files.length + tree.folders.length;

// What was dropped, folders with everything in them (also empty ones). Call it while the drop event runs: the
// browser forgets the dropped items once it is over.
export function fromDrop(data: DataTransfer): Promise<UploadTree> {
  const root = emptyTree("");
  const entries: FileSystemEntry[] = [];
  for (const item of [...data.items]) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry();
    const file = entry ? null : item.getAsFile();
    if (entry) entries.push(entry);
    else if (file) root.files.push(file);
  }
  return (async () => {
    for (const entry of entries) await addEntry(root, entry);
    return root;
  })();
}

async function addEntry(into: UploadTree, entry: FileSystemEntry): Promise<void> {
  if (entry.isFile) {
    into.files.push(await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)));
    return;
  }
  if (!entry.isDirectory) return;
  const folder = emptyTree(entry.name);
  into.folders.push(folder);
  // readEntries hands out a directory in batches until it returns none.
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    for (const child of batch) await addEntry(folder, child);
  }
}

// Files from a file or folder picker; a folder picker gives each file's path ("photos/2024/a.jpg").
export function fromPicked(files: Iterable<File>): UploadTree {
  const root = emptyTree("");
  for (const file of files) {
    const folders = (file.webkitRelativePath || file.name).split("/").slice(0, -1);
    let at = root;
    for (const name of folders) {
      let next = at.folders.find((f) => f.name === name);
      if (!next) at.folders.push((next = emptyTree(name)));
      at = next;
    }
    at.files.push(file);
  }
  return root;
}
