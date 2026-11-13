// A code file dragged out of a code channel's explorer: dropped on a folder of a files channel, on a files or code
// channel in the channel bar, or in another code folder, it is copied there (Shift moves it).
import { userMessage } from "../../api/client";
import { contentBlob, refHash } from "../../core/content";
import { prepareUpload } from "../../core/files";
import { mimeOfName, numberedName, suffixedName } from "../../core/fileNames";
import { workspaceApi } from "../../core/workspaces";

export const codeFileType = "application/x-makework-code-file";

export interface CodePayload {
  workspaceId: string;
  channelId: number;
  id: number;
}

export const hasCodeFile = (data: DataTransfer | null) => !!data?.types.includes(codeFileType);

export function readCodePayload(data: DataTransfer | null): CodePayload | null {
  try {
    const value = JSON.parse(data?.getData(codeFileType) ?? "");
    return typeof value?.id === "number" ? value : null;
  } catch {
    return null;
  }
}

// Copies (or moves) the dragged code file into a files or code channel. Returns the new entry id.
export async function dropCodeFile(
  source: CodePayload, target: { workspaceId: string; channelId: number; type: string; parentId: number | null }, move: boolean,
): Promise<number> {
  const from = workspaceApi(source.workspaceId).plugin("code");
  const { rows } = await from.call<{ rows: { id: number; name: string; hash: string | null; size: number; kind: string }[] }>("list-files", { channel_id: source.channelId });
  const file = rows.find((row) => row.id === source.id);
  if (file?.kind !== "file") throw new Error("That file is gone.");
  // Content reaches another workspace's store by copying it in; inside one workspace the reference is shared.
  let url = file.hash;
  let size = Number(file.size);
  if (url && source.workspaceId !== target.workspaceId) {
    const hash = refHash(url);
    if (!hash) throw new Error("That file has no content here.");
    const upload = await prepareUpload(new File([await contentBlob(url, "text/plain")], file.name, { type: mimeOfName(file.name) }), { workspaceId: target.workspaceId });
    url = upload.url;
    size = upload.file.size;
  }
  const isCode = target.type === "code";
  const to = workspaceApi(target.workspaceId).plugin(isCode ? "code" : "files");
  const content: Record<string, string | number> = isCode ? (url ? { hash: url, size } : {}) : { mime: mimeOfName(file.name), size: url ? size : 0, ...(url ? { url } : {}) };
  // A name taken in the folder gets "(copy)" and then a number.
  let id: number | null = null;
  for (let n = 0; id === null; n++) {
    const name = n === 0 ? file.name : n === 1 ? suffixedName(file.name, "copy") : numberedName(suffixedName(file.name, "copy"), n);
    try {
      id = (await to.call<{ id: number }>("add-file", { channel_id: target.channelId, parent_id: target.parentId, name, ...content })).id;
    } catch (e) {
      if (n >= 20 || !/unique|already|taken|exists/i.test(userMessage(e))) throw e;
    }
  }
  if (move) await from.call("remove", { file_id: source.id });
  return id;
}

