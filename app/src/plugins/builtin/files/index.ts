import { solidView } from "../../solid";
import type { ClientPlugin } from "../../types";
import { filesSkills, filesIndex } from "./agentSkills";
import { filesDisk } from "./disk";
import FilesView from "./FilesView";
import { getEntry, searchEntries } from "./data";

export const filesPlugin: ClientPlugin = {
  manifest: {
    id: "makework.files",
    icon: "channel-files",
    name: "Files",
    version: "1.0.0",
    description: "Shared folders: upload, browse, open in viewers, move and rename.",
    author: "MakeWork",
  },
  agentSkills: { files: [...filesSkills] },
  agentIndex: { files: filesIndex },
  channelViews: { files: solidView(FilesView) },
  disk: { files: filesDisk },
  links: {
    files: {
      async resolve(target, ctx) {
        if (target.kind !== "file") return null;
        const entry = await getEntry(ctx.api, Number(target.id));
        return { title: entry.name, icon: entry.kind === "folder" ? "folder" : entry.mime.startsWith("image/") ? "image" : "file" };
      },
      async search(query, ctx) {
        const entries = await searchEntries(ctx.api, ctx.channel.id, query);
        return entries.slice(0, 5).map((e) => ({
          kind: "file", id: e.id, title: e.name, icon: e.kind === "folder" ? "folder" : e.mime.startsWith("image/") ? "image" : "file",
        }));
      },
    },
  },
};
