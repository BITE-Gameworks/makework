import type { ApiValue } from "../../../api/types";
import type { ExportInfo, ExportProvider, LinkContext } from "../../types";
import { listNodes } from "./data";
import { compose, identity, localTransform, type DesignNode, type Resolve, type Rigid } from "./model";
import { exportFile, type SvgSource } from "./export";

type PaletteData = {
  palettes: Record<string, ApiValue>[];
  values: Record<string, ApiValue>[];
};

async function snapshot(context: LinkContext): Promise<{ nodes: DesignNode[]; source: SvgSource }> {
  const [nodes, paletteData, pageData] = await Promise.all([
    listNodes(context.api, context.channel.id),
    context.api.call<PaletteData>("list-palettes", { channel_id: context.channel.id }),
    context.api.call<{ page: Record<string, ApiValue> | null }>("get-page", { channel_id: context.channel.id }),
  ]);
  const paletteIds = paletteData.palettes.map((p) => Number(p.id));
  const activePalette = Number(pageData.page?.palette_id) || paletteIds[0];
  const values = new Map<number, string>();
  for (const value of paletteData.values)
    if (Number(value.palette_id) === activePalette) values.set(Number(value.color_id), String(value.value));
  const resolve: Resolve = (paint) => paint.ref == null ? paint.color : values.get(paint.ref) ?? paint.color;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<number | null, DesignNode[]>();
  for (const node of nodes) {
    const parent = node.parentId !== null && byId.has(node.parentId) ? node.parentId : null;
    (children.get(parent) ?? children.set(parent, []).get(parent)!).push(node);
  }
  for (const list of children.values()) list.sort((a, b) => a.z - b.z || a.id - b.id);
  const worldCache = new Map<number, Rigid>();
  const world = (id: number): Rigid => {
    const cached = worldCache.get(id);
    if (cached) return cached;
    const node = byId.get(id);
    if (!node) throw new Error(`Layer ${id} no longer exists.`);
    const parent = node.parentId !== null && byId.has(node.parentId) ? world(node.parentId) : identity;
    const result = compose(parent, localTransform(node));
    worldCache.set(id, result);
    return result;
  };
  return {
    nodes,
    source: {
      node: (id) => byId.get(id),
      world,
      children: (parent) => (children.get(parent) ?? []).map((node) => node.id),
      resolve,
    },
  };
}

export function designExportList(nodes: DesignNode[]): ExportInfo[] {
  return nodes.filter((node) => node.props.exports.length > 0)
    .map((node): ExportInfo => ({ id: node.id, name: node.name.trim() || "Untitled", kinds: ["image", "svg"] }));
}

const safeName = (name: string) => name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "_").trim() || "Export";

export const designExports: ExportProvider = {
  async list(context) {
    return designExportList(await listNodes(context.api, context.channel.id));
  },

  async render(id, kind, context, element) {
    if (kind !== "image" && kind !== "svg") throw new Error(`Design exports don't support '${kind}'.`);
    let current = true;
    let objectUrl: string | undefined;
    const draw = async () => {
      try {
        const { source } = await snapshot(context);
        const { blob } = await exportFile(source, Number(id), { scale: 1, format: "svg", suffix: "" });
        if (!current) return;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = URL.createObjectURL(blob);
        const image = document.createElement("img");
        image.alt = "";
        image.src = objectUrl;
        element.replaceChildren(image);
      } catch {
        if (current) element.textContent = "This export is hidden or unavailable.";
      }
    };
    const unsubscribe = context.api.onEvent(() => void draw());
    await draw();
    return () => {
      current = false;
      unsubscribe();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      element.replaceChildren();
    };
  },

  async file(id, format, context) {
    if (!["png", "jpg", "webp", "svg", "pdf"].includes(format))
      throw new Error(`Unsupported design export format '${format}'.`);
    const { nodes, source } = await snapshot(context);
    const node = nodes.find((item) => item.id === Number(id));
    if (!node || node.props.exports.length === 0) throw new Error("That layer is not an export.");
    const setting = node.props.exports.find((item) => item.format === format)
      ?? { format: format as "png" | "jpg" | "webp" | "svg" | "pdf", scale: 1, suffix: "" };
    const result = await exportFile(source, node.id, setting);
    return { name: safeName(result.name), blob: result.blob };
  },
};
