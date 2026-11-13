// A design channel on disk: its images in the channel's folder, and in .design/ the document (document.json: the
// page, colors, palettes and the layer tree) with the markup of vector layers. Edits of document.json change the
// layers it lists (place, size, name, style, nesting), edits of a vector's .svg change its markup, and images added
// to the folder become image layers.
import { mimeOfName, withExtension } from "../../../core/fileNames";
import { decodeEmoji } from "../../../markdown/emoji";
import type { JsonRow } from "../../../system/data";
import type { DiskContext, DiskEntry, DiskLayout } from "../../types";
import { defaultProps, sameValue, toNode, toRow, type Change, type DesignNode, type Props } from "./model";

const svgName = (name: string) => (name.toLowerCase().endsWith(".svg") ? name : `${name}.svg`);
const alive = (row: JsonRow) => row.deleted !== true;
const byZ = (a: { z?: unknown; id: number }, b: { z?: unknown; id: number }) => Number(a.z) - Number(b.z) || a.id - b.id;
const key = (path: string[]) => path.join("/").toLowerCase();
const boxFields = ["x", "y", "width", "height", "rotation"] as const;
const batch = 500;

function layout({ rows, kept, fileExtension, name }: DiskContext) {
  const data = name([], "data", ".design");
  const document = name([data], "document", "document.json");
  const nodes = rows("design", "design_nodes").filter(alive).map(toNode);
  const images = new Map<number, string>();
  const vectors = new Map<number, string>();
  for (const node of nodes) {
    const hash = node.url ? kept(node.url) : null;
    if (node.url) images.set(node.id, name([], `node:${node.id}`, withExtension(node.name || "image", hash ? fileExtension(hash) : "")));
    if (node.props.svg) vectors.set(node.id, name([data], `node:${node.id}`, svgName(node.name || "vector")));
  }
  return { data, document, nodes, images, vectors };
}

export const designDisk: DiskLayout = {
  entries(context) {
    const { rows, kept } = context;
    const { data, document, nodes, images, vectors } = layout(context);
    const result: DiskEntry[] = [];

    const colors = rows("design", "design_colors").filter(alive).sort(byZ);
    const colorNames = new Map(colors.map((c) => [c.id, decodeEmoji(String(c.name))]));
    const values = rows("design", "design_color_values");
    const palettes = rows("design", "design_palettes").filter(alive).sort(byZ).map((p) => ({
      id: p.id,
      name: decodeEmoji(String(p.name)),
      colors: Object.fromEntries(values.filter((v) => Number(v.palette_id) === p.id && colorNames.has(Number(v.color_id)))
        .map((v) => [colorNames.get(Number(v.color_id)), v.value])),
    }));
    const [page] = rows("design", "design_pages");

    const ids = new Set(nodes.map((n) => n.id));
    const children = new Map<number | null, DesignNode[]>();
    for (const node of nodes) {
      const parent = node.parentId !== null && ids.has(node.parentId) ? node.parentId : null;
      (children.get(parent) ?? children.set(parent, []).get(parent)!).push(node);
    }
    const layer = (node: DesignNode): Record<string, unknown> => {
      const defaults = defaultProps(node.kind) as unknown as Record<string, unknown>;
      const props = Object.fromEntries(Object.entries(node.props)
        .filter(([key, value]) => key !== "svg" && JSON.stringify(value) !== JSON.stringify(defaults[key])));
      const out: Record<string, unknown> = {
        id: node.id, kind: node.kind, name: node.name,
        x: node.x, y: node.y, width: node.width, height: node.height, rotation: node.rotation, ...props,
      };
      const image = images.get(node.id);
      if (image) {
        out.image = `../${image}`;
        const hash = kept(node.url);
        if (hash) result.push({ path: [image], hash });
      }
      const vector = vectors.get(node.id);
      if (vector) {
        out.svg = vector;
        result.push({ path: [data, vector], text: node.props.svg });
      }
      const inside = children.get(node.id);
      if (inside) out.layers = inside.toSorted(byZ).map(layer);
      return out;
    };

    const text = JSON.stringify({
      background: page?.background || null,
      palette: palettes.find((p) => p.id === Number(page?.palette_id))?.name ?? palettes[0]?.name ?? null,
      colors: colors.map((c) => colorNames.get(c.id)),
      palettes: palettes.map(({ name, colors }) => ({ name, colors })),
      layers: (children.get(null) ?? []).sort(byZ).map(layer),
    }, null, 2);
    result.push({ path: [data, document], text: `${text}\n` });
    return result;
  },

  async apply(changes, context) {
    const api = context.api("design");
    const { data, document, nodes, images, vectors } = layout(context);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const byVector = new Map([...vectors].map(([id, file]) => [file.toLowerCase(), byId.get(id)!]));
    const byImage = new Map([...images].map(([id, file]) => [file.toLowerCase(), byId.get(id)!]));
    const update = async (list: Record<string, unknown>[]) => {
      for (let i = 0; i < list.length; i += batch) await api.call("update-nodes", { changes: JSON.stringify(list.slice(i, i + batch)) });
    };

    for (const change of changes) {
      try {
        if (key(change.path) === key([data, document])) {
          if (change.text === undefined) continue;
          const list: Record<string, unknown>[] = [];
          const read = (layers: unknown, parentId: number | null) => {
            if (!Array.isArray(layers)) return;
            for (const layer of layers as Record<string, unknown>[]) {
              const node = byId.get(Number(layer.id));
              if (node) {
                const next = readLayer(node, layer, parentId);
                if (Object.keys(next).length) list.push({ id: node.id, ...toRow(next) });
              }
              read(layer.layers, node ? node.id : parentId);
            }
          };
          read((JSON.parse(change.text) as { layers?: unknown }).layers, null);
          await update(list);
          await context.adopt(change, undefined, true);
        } else if (change.path.length === 2 && change.path[0].toLowerCase() === data.toLowerCase()) {
          const node = byVector.get(change.path[1].toLowerCase());
          if (!node || change.text === undefined || change.kind === "moved") continue;
          if (change.text !== node.props.svg) await update([{ id: node.id, ...toRow({ props: { ...node.props, svg: change.text } }) }]);
          await context.adopt(change, undefined, true);
        } else if (change.path.length === 1 && change.hash && mimeOfName(change.path[0]).startsWith("image/")) {
          if (byImage.has(change.path[0].toLowerCase()) || change.kind === "moved") {
            context.problem(change, "Replacing or renaming an image of a design on disk isn't supported yet; add it as a new file.");
            continue;
          }
          const mime = mimeOfName(change.path[0]);
          const info = await context.imageInfo(change.hash, mime);
          const right = Math.max(0, ...nodes.filter((n) => n.parentId === null).map((n) => n.x + n.width)) + 100;
          await api.call("add-nodes", {
            channel_id: context.channel.id,
            nodes: JSON.stringify([{
              kind: "image", name: change.path[0], x: right, y: 0, width: info.width ?? 512, height: info.height ?? 512,
              url: `mwc:${change.hash}`, thumb: info.thumb,
            }]),
          });
          await context.adopt(change);
        }
      } catch (e) {
        context.problem(change, (e as Error).message);
      }
    }
  },

  removal(changes, context) {
    const { images } = layout(context);
    const byImage = new Map([...images].map(([id, file]) => [file.toLowerCase(), id]));
    const gone = changes.filter((c) => c.path.length === 1).map((c) => byImage.get(c.path[0].toLowerCase())).filter((id): id is number => id !== undefined);
    if (!gone.length) return null;
    return {
      what: gone.length === 1 ? "1 image was" : `${gone.length} images were`,
      remove: async () => void (await context.api("design").call("remove-nodes", { ids: JSON.stringify(gone) })),
    };
  },
};

// What a layer of document.json changes on its node: box, name, nesting and style (props it leaves out are the
// defaults, as written).
function readLayer(node: DesignNode, layer: Record<string, unknown>, parentId: number | null): Change {
  const change: Change = {};
  for (const field of boxFields) {
    const value = Number(layer[field]);
    if (layer[field] !== undefined && Number.isFinite(value) && !sameValue(value, node[field])) change[field] = value;
  }
  if (typeof layer.name === "string" && layer.name !== node.name) change.name = layer.name;
  if (parentId !== node.parentId) change.parentId = parentId;
  const defaults = defaultProps(node.kind);
  const props = { ...defaults, svg: node.props.svg } as Props & Record<string, unknown>;
  for (const field of Object.keys(defaults)) if (field !== "svg" && layer[field] !== undefined) props[field] = layer[field];
  if (stable(props) !== stable(node.props)) change.props = props;
  return change;
}

// JSON with sorted keys, so the same value compares equal whatever order its keys were written in.
const stable = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v);
