import { solidView } from "../../solid";
import type { ClientPlugin } from "../../types";
import { diagramSkills, diagramIndex } from "./agentSkills";
import DiagramView from "./DiagramView";
import { diagramDisk } from "./disk";
import { diagramExports } from "./exportProvider";
import { listPages, listShapes } from "./data";

export const diagramPlugin: ClientPlugin = {
  manifest: {
    id: "makework.diagram",
    icon: "channel-diagram",
    name: "Diagram",
    version: "0.1.0",
    description: "Collaborative diagrams with attached connectors, shape libraries, pages and .drawio exchange.",
    author: "MakeWork",
  },
  agentSkills: { diagram: [...diagramSkills] },
  agentIndex: { diagram: diagramIndex },
  channelViews: { diagram: solidView(DiagramView) },
  disk: { diagram: diagramDisk },
  exports: { diagram: diagramExports },
  links: {
    diagram: {
      async resolve(target, context) {
        if (target.kind === "page") {
          const page = (await listPages(context.api, context.channel.id)).find((item) => item.id === Number(target.id));
          return page ? { title: page.name, icon: "channel-diagram" } : null;
        }
        if (target.kind === "shape") {
          const pages = await listPages(context.api, context.channel.id);
          for (const page of pages) {
            const shape = (await listShapes(context.api, page.id)).find((item) => item.id === Number(target.id));
            if (shape) return { title: shape.text.trim() || `${shape.kind} ${shape.id}`, icon: "diagram-rect" };
          }
        }
        return null;
      },
      async search(query, context) {
        const pages = await listPages(context.api, context.channel.id);
        const results = pages.filter((page) => page.name.toLowerCase().includes(query.toLowerCase()))
          .map((page) => ({ kind: "page", id: page.id, title: page.name, icon: "channel-diagram" }));
        for (const page of pages) {
          const shapes = await listShapes(context.api, page.id);
          results.push(...shapes.filter((shape) => shape.text.toLowerCase().includes(query.toLowerCase()))
            .slice(0, 5).map((shape) => ({ kind: "shape", id: shape.id, title: shape.text || `${shape.kind} ${shape.id}`, detail: page.name, icon: "diagram-rect" })));
          if (results.length >= 10) break;
        }
        return results.slice(0, 10);
      },
    },
  },
};
