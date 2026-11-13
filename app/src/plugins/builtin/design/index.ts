import { solidView } from "../../solid";
import type { ClientPlugin } from "../../types";
import { designSkills, designBoardSkills, designChangeSkills, designComponentSkills, designDrawSkills, designGroupSkills, designSceneSkills, designIndex } from "./agentSkills";
import { designDisk } from "./disk";
import DesignView from "./DesignView";
import { listNodes } from "./data";
import { kindIcons } from "./model";
import { designExports } from "./exportProvider";

export const designPlugin: ClientPlugin = {
  manifest: {
    id: "makework.design",
    icon: "channel-design",
    name: "Design",
    version: "1.0.0",
    description: "Design documents: frames, shapes, text and images, with layers, properties, snapping and live cursors.",
    author: "MakeWork",
  },
  agentSkills: { design: [...designSkills, ...designChangeSkills, ...designDrawSkills, ...designGroupSkills, ...designSceneSkills, ...designComponentSkills, ...designBoardSkills] },
  agentIndex: { design: designIndex },
  channelViews: { design: solidView(DesignView) },
  disk: { design: designDisk },
  exports: { design: designExports },
  links: {
    design: {
      async resolve(target, ctx) {
        if (target.kind !== "node") return null;
        const node = (await listNodes(ctx.api, ctx.channel.id)).find((n) => n.id === Number(target.id));
        return node ? { title: node.name, icon: kindIcons[node.kind] } : null;
      },
      async search(query, ctx) {
        const nodes = await listNodes(ctx.api, ctx.channel.id);
        return nodes.filter((n) => n.name.toLowerCase().includes(query)).slice(0, 5)
          .map((n) => ({ kind: "node", id: n.id, title: n.name, icon: kindIcons[n.kind] }));
      },
    },
  },
};
