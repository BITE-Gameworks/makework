import { solidView } from "../../solid";
import type { ClientPlugin } from "../../types";
import { codeSkills, codeIndex } from "./agentSkills";
import CodeView from "./CodeView";
import { listFiles } from "./data";
import { codeDisk } from "./disk";
import { codeSettings } from "./settings";

export const codePlugin: ClientPlugin = {
  manifest: { id: "makework.code", icon: "channel-code", name: "Code", version: "1.0.0", description: "A collaborative code editor with a project file tree.", author: "MakeWork" },
  agentSkills: { code: [...codeSkills] },
  agentIndex: { code: codeIndex },
  channelViews: { code: solidView(CodeView) },
  disk: { code: codeDisk },
  settings: codeSettings,
  links: { code: {
    async resolve(target, context) {
      if (target.kind !== "file") return null;
      const file = (await listFiles(context.api, context.channel.id)).find((entry) => entry.id === Number(target.id));
      return file ? { title: file.name, icon: file.kind === "folder" ? "code-folder" : "code-file" } : null;
    },
    async search(query, context) {
      return (await listFiles(context.api, context.channel.id)).filter((entry) => entry.kind === "file" && entry.name.toLowerCase().includes(query.toLowerCase())).slice(0, 5)
        .map((entry) => ({ kind: "file", id: entry.id, title: entry.name, icon: "code-file" }));
    },
  } },
};
