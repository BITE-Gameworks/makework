import type { ApiValue } from "../../../api/types";
import type { DiskContext, DiskEntry, DiskLayout } from "../../types";
import { toEdge, toPage, toRow, toShape } from "./model";
import { renderDiagramSvg } from "./render";

const jsonName = (id: number) => `page-${id}.json`;
const svgName = (id: number) => `page-${id}.svg`;

export const diagramDisk: DiskLayout = {
  entries(context: DiskContext): DiskEntry[] {
    const pages = context.rows("diagram", "diagram_pages").map((row) => toPage(row as Record<string, ApiValue>));
    const shapes = context.rows("diagram", "diagram_shapes").map((row) => toShape(row as Record<string, ApiValue>));
    const edges = context.rows("diagram", "diagram_edges").map((row) => toEdge(row as Record<string, ApiValue>));
    const rows = context.rows("diagram", "diagram_rows").filter((row) => row.deleted !== true).map((row) => toRow(row as Record<string, ApiValue>));
    const folder = ".diagram";
    return pages.flatMap((page) => {
      const pageShapes = shapes.filter((shape) => shape.pageId === page.id);
      const pageEdges = edges.filter((edge) => edge.pageId === page.id);
      const ids = new Set(pageShapes.map((shape) => shape.id));
      const pageRows = rows.filter((row) => ids.has(row.shapeId));
      const document = JSON.stringify({ page, shapes: pageShapes, edges: pageEdges, rows: pageRows }, null, 2);
      return [
        { path: [folder, jsonName(page.id)], text: `${document}\n` },
        { path: [folder, svgName(page.id)], text: renderDiagramSvg(page, pageShapes, pageEdges, undefined, pageRows) },
      ];
    });
  },
};
