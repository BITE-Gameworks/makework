// Agent skills of files channels: folders and files of any kind; the agent reads and writes text files.
import { contentBlob } from "../../../core/content";
import { mimeOfName } from "../../../core/fileNames";
import { prepareUpload } from "../../../core/files";
import { clip, findChannel, rowsOfChannels } from "../../../agents/skillKit";
import type { AgentIndexer, AgentSkill, BotContext } from "../../types";
import { compareText } from "../../../core/text";

type Entry = { id: number; parent_id: number | null; kind: string; name: string; url: string | null; mime: string };

async function entries(context: BotContext, channelId: number): Promise<Entry[]> {
  const rows = (await context.read("files", "files_entries", { channel_id: channelId })).filter((r) => r.deleted !== true);
  return rows.map((r) => ({
    id: Number(r.id), parent_id: r.parent_id == null ? null : Number(r.parent_id), kind: String(r.kind), name: String(r.name),
    url: typeof r.url === "string" ? r.url : null, mime: String(r.mime ?? ""),
  }));
}

const pathOf = (all: Entry[], entry: Entry): string => {
  const parent = all.find((e) => e.id === entry.parent_id);
  return parent ? `${pathOf(all, parent)}/${entry.name}` : entry.name;
};

const split = (path: string) => path.split("/").map((p) => p.trim()).filter(Boolean);

function find(all: Entry[], path: string): Entry | undefined {
  let parent: number | null = null;
  let found: Entry | undefined;
  for (const part of split(path)) {
    found = all.find((e) => e.parent_id === parent && e.name.toLowerCase() === part.toLowerCase());
    if (!found) return undefined;
    parent = found.id;
  }
  return found;
}

export const filesSkills: AgentSkill[] = [{
  name: "files_list",
  description: "Lists the files and folders of a files channel.",
  args: { channel: "string" },
  permissions: ["read:files"], channelType: "files",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "files");
    const all = await entries(context, channel.id);
    return all.length ? all.map((e) => `${pathOf(all, e)}${e.kind === "folder" ? "/" : ""}`).sort(compareText).slice(0, 80).join("\n") : "The channel has no files.";
  },
}, {
  name: "files_read_text",
  description: "Reads a text file of a files channel.",
  args: { channel: "string", path: "string" },
  permissions: ["read:files"], channelType: "files",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "files");
    const file = find(await entries(context, channel.id), String(args.path));
    if (file?.kind !== "file") throw new Error(`There is no file '${args.path}'.`);
    if (!file.url) throw new Error("That file has no content.");
    if (file.mime && !/(?:^text\/)|json|xml|javascript/.test(file.mime)) throw new Error(`That is a ${file.mime} file, not text.`);
    return clip(await (await contentBlob(file.url, file.mime || "text/plain")).text()) || "(empty)";
  },
}, {
  name: "files_write_text",
  description: "Creates a text file in a files channel (folders in the path are created), or replaces the content of one.",
  args: { channel: "string", path: "string", content: "string" },
  permissions: ["read:files", "write:files"], channelType: "files",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "files");
    const all = await entries(context, channel.id);
    const parts = split(String(args.path));
    if (!parts.length) throw new Error("A file needs a name like notes.txt.");
    const files = context.write("files");
    let parent: number | null = null;
    for (const folder of parts.slice(0, -1)) {
      let entry = all.find((e) => e.kind === "folder" && e.parent_id === parent && e.name.toLowerCase() === folder.toLowerCase());
      if (!entry) {
        const { id }: { id: number } = await files.call<{ id: number }>("add-folder", { channel_id: channel.id, parent_id: parent, name: folder });
        entry = { id, parent_id: parent, kind: "folder", name: folder, url: null, mime: "" };
        all.push(entry);
      }
      parent = entry.id;
    }
    const name = parts.at(-1)!;
    const mime = mimeOfName(name).startsWith("text/") || mimeOfName(name) === "application/json" ? mimeOfName(name) : "text/plain";
    const upload = await prepareUpload(new File([String(args.content)], name, { type: mime }), { workspaceId: context.workspaceId });
    const content = { mime, size: upload.file.size, url: upload.url, thumb: null, width: null, height: null };
    const existing = all.find((e) => e.kind === "file" && e.parent_id === parent && e.name.toLowerCase() === name.toLowerCase());
    if (existing) await files.call("set-content", { entry_id: existing.id, ...content });
    else await files.call("add-file", { channel_id: channel.id, parent_id: parent, name, ...content });
    return `${existing ? "Replaced" : "Created"} ${parts.join("/")} in #${channel.name} (${upload.file.size} bytes).`;
  },
}];


export const filesIndex: AgentIndexer = {
  permissions: ["read:files"], noun: "files and folders",
  async items(context, channels) {
    return (await rowsOfChannels(context, "files", "files_entries", channels)).map((r) => ({ channelId: Number(r.channel_id), id: Number(r.id), label: String(r.name), text: r.kind === "folder" ? "folder" : String(r.mime ?? "") }));
  },
};
