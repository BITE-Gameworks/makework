// Files dropped on a files or code channel in the channel bar go to the root of that channel.
import { workspaceApi, type Channel } from "../../core/workspaces";
import { playSound } from "../../theme/sounds";
import { entriesOf, expandZips } from "./docs/transfer";
import { listFiles } from "./code/data";
import { importFiles } from "./code/transfer";
import { uploadTree } from "./files/data";
import { fromDrop } from "./files/folders";

export const acceptsFiles = (channel: Channel) => channel.type === "files" || channel.type === "code";

export async function dropFilesOnChannel(workspaceId: string, channel: Channel, data: DataTransfer): Promise<string | null> {
  const tree = await fromDrop(data);
  const client = workspaceApi(workspaceId);
  try {
    if (channel.type === "files") {
      const api = client.plugin("files");
      const { rows } = await api.call<{ rows: { name: string }[] }>("list", { channel_id: channel.id, folder_id: null });
      const ids = await uploadTree(api, `${workspaceId}:${channel.id}`, channel.id, null, tree, new Set(rows.map((row) => row.name)));
      if (ids.length) playSound("upload-done");
      return null;
    }
    const api = client.plugin("code");
    const entries = await expandZips(entriesOf(tree));
    const result = await importFiles(api, workspaceId, channel.id, null, entries, await listFiles(api, channel.id), () => {});
    if (result.ids.length) playSound("upload-done");
    return result.failed ? `${result.failed} files were skipped.` : null;
  } catch (e) {
    playSound("error");
    throw e;
  }
}
