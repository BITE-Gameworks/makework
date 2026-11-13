import { prepareUpload } from "../core/files";
import { workspaceApi } from "../core/workspaces";
import { parseDeclared } from "../system/declared";
import { validateWorkspacePluginUpdate } from "./registry";

// Replaces the package a workspace shares for one plugin with a newer version of it (same data schema).
export async function updateWorkspacePlugin(
  workspaceId: string,
  registration: Record<string, unknown>,
  bytes: Uint8Array,
): Promise<void> {
  const id = String(registration.plugin_id);
  const next = validateWorkspacePluginUpdate(bytes, id, String(registration.version), parseDeclared(String(registration.manifest)));
  const upload = await prepareUpload(new File([bytes as BlobPart], `${id}.mwp`, { type: "application/zip" }));
  await workspaceApi(workspaceId).plugin("channels").call("update-plugin", {
    plugin_id: id,
    version: next.version,
    manifest: next.manifest,
    package: upload.url,
  });
}
