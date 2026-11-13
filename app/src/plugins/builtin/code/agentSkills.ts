// Agent skills of code channels.
import * as Y from "yjs";
import { fromBase64, toBase64 } from "../../../core/liveText";
import { findChannel, rowsOfChannels } from "../../../agents/skillKit";
import type { AgentIndexer, AgentSkill, BotContext } from "../../types";
import { compareText } from "../../../core/text";

type CodeFile = { id: number; parent_id: number | null; kind: string; name: string };

async function codeEntries(context: BotContext, channelId: number): Promise<CodeFile[]> {
  const rows = (await context.read("code", "code_files", { channel_id: channelId })).filter((row) => row.deleted !== true);
  return rows.map((row) => ({ id: Number(row.id), parent_id: row.parent_id == null ? null : Number(row.parent_id), kind: String(row.kind), name: String(row.name) }));
}

const pathOf = (entries: CodeFile[], entry: CodeFile): string => {
  const parent = entries.find((e) => e.id === entry.parent_id);
  return parent ? `${pathOf(entries, parent)}/${entry.name}` : entry.name;
};

async function findFile(context: BotContext, channelId: number, path: string): Promise<{ entries: CodeFile[]; file?: CodeFile; parent: number | null; name: string }> {
  const parts = path.split("/").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("A file needs a path like src/main.py.");
  const entries = await codeEntries(context, channelId);
  let parent: number | null = null;
  const code = context.write("code");
  for (const folder of parts.slice(0, -1)) {
    let entry = entries.find((e) => e.kind === "folder" && e.parent_id === parent && e.name === folder);
    if (!entry) {
      const { id }: { id: number } = await code.call<{ id: number }>("add-folder", { channel_id: channelId, parent_id: parent, name: folder });
      entry = { id, parent_id: parent, kind: "folder", name: folder };
      entries.push(entry);
    }
    parent = entry.id;
  }
  const name = parts.at(-1)!;
  return { entries, file: entries.find((e) => e.kind === "file" && e.parent_id === parent && e.name === name), parent, name };
}

async function loadText(context: BotContext, fileId: number): Promise<{ doc: Y.Doc; text: Y.Text }> {
  const doc = new Y.Doc();
  const rows = (await context.read("code", "code_updates", { file_id: fileId })).sort((a, b) => Number(a.id) - Number(b.id));
  for (const row of rows) Y.applyUpdate(doc, fromBase64(String(row.data)));
  return { doc, text: doc.getText("body") };
}

export const codeSkills: AgentSkill[] = [{
  name: "code_list_files",
  description: "Lists the files in a code channel.",
  args: { channel: "string" },
  permissions: ["read:code"], channelType: "code",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "code");
    const entries = await codeEntries(context, channel.id);
    const files = entries.filter((e) => e.kind === "file").map((e) => pathOf(entries, e)).sort(compareText);
    return files.length ? files.join("\n") : "The channel has no files.";
  },
}, {
  name: "code_read_file",
  description: "Reads one file of a code channel.",
  args: { channel: "string", path: "string" },
  permissions: ["read:code"], channelType: "code",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "code");
    const { file } = await findFile(context, channel.id, String(args.path));
    if (!file) throw new Error(`There is no file '${args.path}'.`);
    return (await loadText(context, file.id)).text.toString().slice(0, 4000) || "(empty)";
  },
}, {
  name: "code_write_file",
  description: "Creates a file in a code channel, or replaces its whole content. Folders in the path are created.",
  args: { channel: "string", path: "string", content: "string" },
  permissions: ["read:code", "write:code"], channelType: "code",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "code");
    const content = String(args.content);
    const { file, parent, name } = await findFile(context, channel.id, String(args.path));
    const code = context.write("code");
    const id = file?.id ?? (await code.call<{ id: number }>("add-file", { channel_id: channel.id, parent_id: parent, name, size: content.length })).id;
    const { doc, text } = await loadText(context, id);
    const before = Y.encodeStateVector(doc);
    doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, content);
    });
    await code.call("add-update", { file_id: id, data: toBase64(Y.encodeStateAsUpdate(doc, before)) });
    await code.call("set-content", { file_id: id, size: content.length });
    return `${file ? "Replaced" : "Created"} ${args.path} in #${channel.name} (${content.length} characters).`;
  },
}];


const maxScanned = 400;

export const codeIndex: AgentIndexer = {
  permissions: ["read:code"], noun: "code files and folders",
  async items(context, channels) {
    const rows = await rowsOfChannels(context, "code", "code_files", channels);
    const files = rows.filter((r) => r.kind === "file").slice(0, maxScanned);
    const byFile = new Map<number, string[]>();
    if (files.length) {
      const wanted = new Set(files.map((r) => Number(r.id)));
      for (const u of (await context.read("code", "code_updates")).sort((a, b) => Number(a.id) - Number(b.id)))
        if (wanted.has(Number(u.file_id))) byFile.set(Number(u.file_id), [...(byFile.get(Number(u.file_id)) ?? []), String(u.data)]);
    }
    return rows.map((r) => {
      const parts = byFile.get(Number(r.id));
      let text = "";
      if (parts) {
        const doc = new Y.Doc();
        for (const data of parts) Y.applyUpdate(doc, fromBase64(data));
        text = doc.getText("body").toString();
      }
      return { channelId: Number(r.channel_id), id: Number(r.id), label: String(r.name), text };
    });
  },
};
