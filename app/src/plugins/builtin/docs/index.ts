import { solidView } from "../../solid";
import type { ClientPlugin } from "../../types";
import { docsSkills, docsIndex } from "./agentSkills";
import { docsDisk } from "./disk";
import DocsView from "./DocsView";
import { listPages } from "./data";

export const docsPlugin: ClientPlugin = {
  manifest: {
    id: "makework.docs",
    icon: "channel-docs",
    name: "Docs",
    version: "1.0.0",
    description: "Markdown pages in a tree, with preview, edit and side by side modes, and export as .md files.",
    author: "MakeWork",
  },
  agentSkills: { docs: [...docsSkills] },
  agentIndex: { docs: docsIndex },
  channelViews: { docs: solidView(DocsView) },
  disk: { docs: docsDisk },
  links: {
    docs: {
      async resolve(target, ctx) {
        if (target.kind !== "page") return null;
        const page = (await listPages(ctx.api, ctx.channel.id)).find((p) => p.id === Number(target.id));
        return page ? { title: page.title, icon: "docs-page" } : null;
      },
      async search(query, ctx) {
        return (await listPages(ctx.api, ctx.channel.id)).filter((p) => p.title.toLowerCase().includes(query)).slice(0, 5)
          .map((p) => ({ kind: "page", id: p.id, title: p.title, icon: "docs-page" }));
      },
    },
  },
};
