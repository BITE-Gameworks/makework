// Importing dropped or picked files, folders and .zip files into a code channel, keeping their structure.
import type { PluginClient } from "../../../api/client";
import { prepareUpload } from "../../../core/files";
import { addFile, addFolder, type CodeFile } from "./data";
import type { ImportEntry } from "../docs/transfer";

const skipped = /(^|\/)(node_modules|\.git)\//;
const parallel = 4;

export interface ImportResult {
  ids: number[];
  failed: number;
}

// Creates the folders and files of `entries` under `parent`. Names already taken in a folder are skipped.
export async function importFiles(
  api: PluginClient, workspaceId: string, channelId: number, parent: number | null, entries: ImportEntry[],
  existing: CodeFile[], progress: (done: number, total: number) => void,
): Promise<ImportResult> {
  const children = new Map<string, number>();
  const nameKey = (folder: number | null, name: string) => `${folder ?? ""}/${name.toLowerCase()}`;
  for (const file of existing) children.set(nameKey(file.parentId, file.name), file.id);
  const wanted = entries.filter((entry) => !skipped.test(entry.path.join("/")));
  const ids: number[] = [];
  let failed = 0;
  const folderOf = new Map<string, Promise<number | null>>();
  const folder = (segments: string[]): Promise<number | null> => {
    if (!segments.length) return Promise.resolve(parent);
    const path = segments.join("/").toLowerCase();
    let found = folderOf.get(path);
    if (!found) {
      found = (async () => {
        const above = await folder(segments.slice(0, -1));
        const name = segments.at(-1)!;
        const known = children.get(nameKey(above, name));
        if (known !== undefined) return known;
        const { id } = await addFolder(api, channelId, above, name);
        children.set(nameKey(above, name), id);
        ids.push(id);
        return id;
      })();
      folderOf.set(path, found);
    }
    return found;
  };
  let done = 0;
  const next = (() => { let index = 0; return () => wanted[index++]; })();
  const worker = async () => {
    for (let entry = next(); entry; entry = next()) {
      try {
        const above = await folder(entry.path.slice(0, -1));
        const name = entry.path.at(-1)!;
        if (children.has(nameKey(above, name))) failed++;
        else {
          const upload = await prepareUpload(entry.file, { workspaceId });
          const { id } = await addFile(api, channelId, above, name, upload.url, entry.file.size);
          children.set(nameKey(above, name), id);
          ids.push(id);
        }
      } catch {
        failed++;
      }
      progress(++done, wanted.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, wanted.length) }, worker));
  return { ids, failed };
}
