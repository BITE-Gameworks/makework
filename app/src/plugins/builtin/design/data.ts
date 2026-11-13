import type { PluginClient } from "../../../api/client";
import type { ApiValue } from "../../../api/types";
import { decodeEmoji, encodeEmoji } from "../../../markdown/emoji";
import { createLive } from "../../live";
import { propsText, toNode, toRow, type Change, type DesignNode, type NodeKind, type Props } from "./model";

export interface NewNode {
  ref?: string;
  parent_id?: number | null;
  parent_ref?: string;
  kind: NodeKind;
  name: string;
  z?: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  props: Props;
  url?: string | null;
  thumb?: string | null;
}

export async function listNodes(api: PluginClient, channelId: number): Promise<DesignNode[]> {
  const { rows } = await api.call<{ rows: Record<string, ApiValue>[] }>("list-nodes", { channel_id: channelId });
  return rows.map(toNode);
}

export const createNodes = (api: PluginClient, channelId: number) =>
  createLive<DesignNode[]>(api, [], () => channelId, () => listNodes(api, channelId));

export async function addNodes(api: PluginClient, channelId: number, nodes: NewNode[]): Promise<number[]> {
  const rows = nodes.map(({ props, name, ...n }) => ({ ...n, name: encodeEmoji(name), props: propsText(props) }));
  const { ids } = await api.call<{ ids: number[] }>("add-nodes", { channel_id: channelId, nodes: JSON.stringify(rows) });
  return ids;
}

export const updateNodes = (api: PluginClient, changes: Map<number, Change>) =>
  api.call("update-nodes", { changes: JSON.stringify([...changes].map(([id, change]) => ({ id, ...toRow(change) }))) });

export const removeNodes = (api: PluginClient, ids: number[]) => api.call("remove-nodes", { ids: JSON.stringify(ids) });
export const restoreNodes = (api: PluginClient, ids: number[]) => api.call("restore-nodes", { ids: JSON.stringify(ids) });

export interface ColorVar {
  id: number;
  name: string;
  z: number;
}

export interface Palettes {
  id: number;      // always 0, for createLive
  colors: ColorVar[];
  palettes: ColorVar[];
  // palette id -> color id -> #rrggbb
  values: Record<number, Record<number, string>>;
}

const byZ = (rows: Record<string, ApiValue>[]) => rows.slice().sort((a, b) => Number(a.z) - Number(b.z))
  .map((r) => ({ id: Number(r.id), name: decodeEmoji(String(r.name ?? "")), z: Number(r.z) }));

export const createPalettes = (api: PluginClient, channelId: number) =>
  createLive<Palettes>(api, { id: 0, colors: [], palettes: [], values: {} }, () => channelId, async () => {
    const r = await api.call<Record<"colors" | "palettes" | "values", Record<string, ApiValue>[]>>("list-palettes", { channel_id: channelId });
    const values: Palettes["values"] = {};
    for (const v of r.values) (values[Number(v.palette_id)] ??= {})[Number(v.color_id)] = String(v.value);
    return { id: 0, colors: byZ(r.colors), palettes: byZ(r.palettes), values };
  });

// The page background as stored, and the palette everyone sees (null: the first).
export const createPage = (api: PluginClient, channelId: number) =>
  createLive<{ id: number; background: string; palette: number | null }>(api, { id: 0, background: "", palette: null }, () => channelId, async () => {
    const { page } = await api.call<{ page: Record<string, ApiValue> | null }>("get-page", { channel_id: channelId });
    return { id: 0, background: String(page?.background ?? ""), palette: page?.palette_id ? Number(page.palette_id) : null };
  });

export const setPalette = (api: PluginClient, channelId: number, paletteId: number) =>
  api.call("set-palette", { channel_id: channelId, palette_id: paletteId });

export const setPage = (api: PluginClient, channelId: number, background: string) =>
  api.call("set-page", { channel_id: channelId, background });
