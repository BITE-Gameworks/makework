import type { ExportInfo, ExportProvider, LinkContext } from "../../types";
import { svgFile, type ExportFormat } from "../canvas/export";
import { listEdges, listPages, listRows, listShapes } from "./data";
import { shapeName, type DiagramPage, type DiagramShape } from "./model";
import { renderDiagram } from "./render";

// Every page is an export (id: the page id); objects are when they have export settings (id: "shape-<id>").
const objectPrefix = "shape-";
const formats: ReadonlySet<ExportFormat> = new Set(["png", "jpg", "webp", "svg", "pdf"]);

export const objectExportId = (shapeId: number) => `${objectPrefix}${shapeId}`;

async function pageShapes(context: LinkContext, page: DiagramPage) {
  const [shapes, edges, rows] = await Promise.all([listShapes(context.api, page.id), listEdges(context.api, page.id), listRows(context.api, page.id)]);
  return { shapes, edges, rows };
}

// What an export id draws: a page, or one object on its page.
async function resolve(id: number | string, context: LinkContext) {
  const pages = await listPages(context.api, context.channel.id);
  const text = String(id);
  if (!text.startsWith(objectPrefix)) {
    const page = pages.find((item) => item.id === Number(id));
    if (!page) throw new Error("The page is unavailable.");
    const { shapes, edges, rows } = await pageShapes(context, page);
    return { name: page.name, settings: page.exports, ...renderDiagram(page, shapes, edges, undefined, rows) };
  }
  const shapeId = Number(text.slice(objectPrefix.length));
  for (const page of pages) {
    const { shapes, edges, rows } = await pageShapes(context, page);
    const shape = shapes.find((item) => item.id === shapeId);
    if (shape && shape.exports.length > 0) return { name: shapeName(shape), settings: shape.exports, ...renderDiagram(page, shapes, edges, [shape.id], rows) };
  }
  throw new Error("That object is not an export.");
}

export const diagramExports: ExportProvider = {
  async list(context) {
    const pages = await listPages(context.api, context.channel.id);
    const items: ExportInfo[] = [];
    for (const page of pages) {
      items.push({ id: page.id, name: page.name, kinds: ["image", "svg"] });
      const shapes: DiagramShape[] = await listShapes(context.api, page.id);
      for (const shape of shapes.filter((item) => item.exports.length > 0))
        items.push({ id: objectExportId(shape.id), name: `${shapeName(shape)} (${page.name})`, kinds: ["image", "svg"] });
    }
    return items;
  },

  async render(id, kind, context, element) {
    if (kind !== "image" && kind !== "svg") throw new Error(`Diagram exports don't support '${kind}'.`);
    let active = true;
    let url: string | null = null;
    const draw = async () => {
      try {
        const { svg } = await resolve(id, context);
        if (!active) return;
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
        const image = document.createElement("img");
        image.alt = "";
        image.src = url;
        element.replaceChildren(image);
      } catch {
        if (active) element.textContent = "This diagram export is unavailable.";
      }
    };
    const unsubscribe = context.api.onEvent(() => void draw());
    await draw();
    return () => {
      active = false;
      unsubscribe();
      if (url) URL.revokeObjectURL(url);
      element.replaceChildren();
    };
  },

  async file(id, format, context) {
    const extension = format.toLowerCase() as ExportFormat;
    if (!formats.has(extension)) throw new Error(`Diagram exports don't support ${format}.`);
    const { name, settings, svg, width, height } = await resolve(id, context);
    const setting = settings.find((item) => item.format === extension) ?? { scale: 1, format: extension, suffix: "" };
    const file = await svgFile(svg, width, height, name, setting);
    return { name: file.name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "_").trim() || `Diagram.${extension}`, blob: file.blob };
  },
};
