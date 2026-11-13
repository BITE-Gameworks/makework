import type { PluginClient } from "../../../api/client";
import type { ApiValue } from "../../../api/types";
import type { Accessor } from "solid-js";
import { createLive } from "../../live";
import type { ExportSetting } from "../canvas/export";
import { encodeText, shapeStyleText, toEdge, toPage, toRow, toShape, type DiagramEdge, type DiagramRow, type DiagramPage, type DiagramShape, type EdgeKind, type PageChange, type Port, type ShapeChange, type ShapeKind, type DiagramStyle } from "./model";

export const listPages = async (api: PluginClient, channelId: number): Promise<DiagramPage[]> => {
  const { rows } = await api.call<{ rows: Record<string, ApiValue>[] }>("list-pages", { channel_id: channelId });
  return rows.map(toPage);
};

export const createPages = (api: PluginClient, channelId: number) =>
  createLive<DiagramPage[]>(api, [], () => channelId, () => listPages(api, channelId));

export const addPage = async (api: PluginClient, channelId: number, name: string) =>
  api.call<{ id: number }>("add-page", { channel_id: channelId, name: encodeText(name) });

export const updatePage = (api: PluginClient, id: number, changes: PageChange) =>
  api.call("update-page", { id, changes: JSON.stringify({
    ...changes, ...(changes.name ? { name: encodeText(changes.name) } : {}), ...(changes.exports ? { exports: JSON.stringify(changes.exports) } : {}),
  }) });

export const listShapes = async (api: PluginClient, pageId: number): Promise<DiagramShape[]> => {
  const { rows } = await api.call<{ rows: Record<string, ApiValue>[] }>("list-shapes", { page_id: pageId });
  return rows.map(toShape);
};

export const createShapes = (api: PluginClient, pageId: number | Accessor<number>) => {
  const id = typeof pageId === "function" ? pageId : () => pageId;
  return createLive<DiagramShape[]>(api, [], id, () => listShapes(api, id()));
};

export interface NewShape {
  ref?: string;
  parent_id?: number | null;
  parent_ref?: string;
  kind: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
  z?: number;
  text?: string;
  style?: DiagramStyle;
  exports?: ExportSetting[];
}

export async function addShapes(api: PluginClient, pageId: number, shapes: NewShape[]): Promise<number[]> {
  const json = shapes.map(({ style, text, exports, ...shape }) => ({
    ...shape,
    ...(exports ? { exports: JSON.stringify(exports) } : {}),
    ...(text !== undefined ? { text: encodeText(text) } : {}),
    style: shapeStyleText(style ?? { fill: "var(--mw-light)", stroke: "var(--mw-text)", strokeWidth: 1.5, textColor: "var(--mw-text)", fontSize: 14, align: "center", dash: false }),
  }));
  const { ids } = await api.call<{ ids: number[] }>("add-shapes", { page_id: pageId, shapes: JSON.stringify(json) });
  return ids;
}

export const updateShapes = (api: PluginClient, changes: Map<number, ShapeChange>) =>
  api.call("update-shapes", { changes: JSON.stringify([...changes].map(([id, change]) => ({
    id, ...change, ...(change.text !== undefined ? { text: encodeText(change.text) } : {}),
    ...(change.style ? { style: shapeStyleText(change.style) } : {}),
    ...(change.exports ? { exports: JSON.stringify(change.exports) } : {}),
    ...(change.parentId !== undefined ? { parent_id: change.parentId } : {}),
  }))) });
export const removeShapes = (api: PluginClient, ids: number[]) => api.call("remove-shapes", { ids: JSON.stringify(ids) });
export const restoreShapes = (api: PluginClient, ids: number[]) => api.call("restore-shapes", { ids: JSON.stringify(ids) });

export const listEdges = async (api: PluginClient, pageId: number): Promise<DiagramEdge[]> => {
  const { rows } = await api.call<{ rows: Record<string, ApiValue>[] }>("list-edges", { page_id: pageId });
  return rows.map(toEdge);
};

export const createEdges = (api: PluginClient, pageId: number | Accessor<number>) => {
  const id = typeof pageId === "function" ? pageId : () => pageId;
  return createLive<DiagramEdge[]>(api, [], id, () => listEdges(api, id()));
};

export interface NewEdge {
  parent_id?: number | null;
  from_id: number | null;
  from_port: Port;
  from_x?: number;
  from_y?: number;
  to_id: number | null;
  to_port: Port;
  to_x?: number;
  to_y?: number;
  points?: { x: number; y: number }[];
  kind?: EdgeKind;
  start_arrow?: string;
  end_arrow?: string;
  label?: string;
  start_label?: string;
  end_label?: string;
  from_row?: number | null;
  to_row?: number | null;
  style?: DiagramEdge["style"];
}

// How a new connector looks unless it says otherwise.
export const defaultEdgeStyle = (): DiagramEdge["style"] => ({ stroke: "var(--mw-text-muted)", strokeWidth: 1.5, dash: false });

export async function addEdges(api: PluginClient, pageId: number, edges: NewEdge[]): Promise<number[]> {
  const json = edges.map((edge) => ({
    ...edge, points: JSON.stringify(edge.points ?? []), label: encodeText(edge.label ?? ""),
    ...(edge.start_label ? { start_label: encodeText(edge.start_label) } : {}),
    ...(edge.end_label ? { end_label: encodeText(edge.end_label) } : {}),
    style: JSON.stringify(edge.style ?? defaultEdgeStyle()),
  }));
  const { ids } = await api.call<{ ids: number[] }>("add-edges", { page_id: pageId, edges: JSON.stringify(json) });
  return ids;
}

export const updateEdges = (api: PluginClient, changes: Map<number, Partial<DiagramEdge>>) =>
  api.call("update-edges", { changes: JSON.stringify([...changes].map(([id, change]) => ({
    id,
    ...(change.parentId !== undefined ? { parent_id: change.parentId } : {}),
    ...(change.fromId !== undefined ? { from_id: change.fromId } : {}),
    ...(change.fromPort !== undefined ? { from_port: change.fromPort } : {}),
    ...(change.fromPoint !== undefined ? { from_x: change.fromPoint.x, from_y: change.fromPoint.y } : {}),
    ...(change.toId !== undefined ? { to_id: change.toId } : {}),
    ...(change.toPort !== undefined ? { to_port: change.toPort } : {}),
    ...(change.toPoint !== undefined ? { to_x: change.toPoint.x, to_y: change.toPoint.y } : {}),
    ...(change.points !== undefined ? { points: JSON.stringify(change.points) } : {}),
    ...(change.kind !== undefined ? { kind: change.kind } : {}),
    ...(change.startArrow !== undefined ? { start_arrow: change.startArrow } : {}),
    ...(change.endArrow !== undefined ? { end_arrow: change.endArrow } : {}),
    ...(change.label !== undefined ? { label: encodeText(change.label) } : {}),
    ...(change.startLabel !== undefined ? { start_label: encodeText(change.startLabel) } : {}),
    ...(change.endLabel !== undefined ? { end_label: encodeText(change.endLabel) } : {}),
    ...(change.fromRow !== undefined ? { from_row: change.fromRow } : {}),
    ...(change.toRow !== undefined ? { to_row: change.toRow } : {}),
    ...(change.style !== undefined ? { style: JSON.stringify(change.style) } : {}),
  }))) });

export const removeEdges = (api: PluginClient, ids: number[]) => api.call("remove-edges", { ids: JSON.stringify(ids) });
export const restoreEdges = (api: PluginClient, ids: number[]) => api.call("restore-edges", { ids: JSON.stringify(ids) });

// The rows of a page's classes and tables (rows.ts).
export const listRows = async (api: PluginClient, pageId: number): Promise<DiagramRow[]> => {
  const { rows } = await api.call<{ rows: Record<string, ApiValue>[] }>("list-rows", { page_id: pageId });
  return rows.map(toRow);
};

export const createRows = (api: PluginClient, pageId: Accessor<number>) =>
  createLive<DiagramRow[]>(api, [], pageId, () => listRows(api, pageId()));

export type RowChange = Partial<Omit<DiagramRow, "id" | "shapeId">>;

const rowColumns = (row: RowChange) => ({
  ...(row.section !== undefined ? { section: row.section } : {}),
  ...(row.z !== undefined ? { z: row.z } : {}),
  ...(row.name !== undefined ? { name: encodeText(row.name) } : {}),
  ...(row.type !== undefined ? { type: encodeText(row.type) } : {}),
  ...(row.params !== undefined ? { params: encodeText(row.params) } : {}),
  ...(row.value !== undefined ? { value: encodeText(row.value) } : {}),
  ...(row.visibility !== undefined ? { visibility: row.visibility } : {}),
  ...(row.marks !== undefined ? { marks: row.marks.join(",") } : {}),
});

export async function addRows(api: PluginClient, rows: (RowChange & { shapeId: number })[]): Promise<number[]> {
  const { ids } = await api.call<{ ids: number[] }>("add-rows", { rows: JSON.stringify(rows.map((row) => ({ shape_id: row.shapeId, ...rowColumns(row) }))) });
  return ids;
}

export const updateRows = (api: PluginClient, changes: Map<number, RowChange>) =>
  api.call("update-rows", { changes: JSON.stringify([...changes].map(([id, change]) => ({ id, ...rowColumns(change) }))) });
export const removeRows = (api: PluginClient, ids: number[]) => api.call("remove-rows", { ids: JSON.stringify(ids) });
export const restoreRows = (api: PluginClient, ids: number[]) => api.call("restore-rows", { ids: JSON.stringify(ids) });
