import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount, on } from "solid-js";
import { userMessage } from "../../../api/client";
import { Icon } from "../../../theme/icons";
import Collapse from "../../../ui/Collapse";
import Disclosure from "../../../ui/Disclosure";
import HistoryControls from "../../../ui/HistoryControls";
import { PaneButton, createPanes } from "../../../ui/narrowPanes";
import { narrow } from "../../../core/ui";
import RemoteCursors from "../../../ui/RemoteCursors";
import ResizeHandle from "../../../ui/ResizeHandle";
import ColorPicker from "../../../ui/ColorPicker";
import Select from "../../../ui/Select";
import type { ChannelContext } from "../../types";
import { solidMount } from "../../solid";
import IconSearch, { coloredIcon, iconDragType } from "../design/IconSearch";
import { fetchIcon } from "../design/iconify";
import { addPage, addRows, addShapes, addEdges, createEdges, createRows, defaultEdgeStyle, removeRows, restoreRows, updateRows, type RowChange, createPages, createShapes, removeEdges, removeShapes, restoreEdges, restoreShapes, updateEdges, updatePage, updateShapes, type NewEdge, type NewShape } from "./data";
import { clampZoom, fitViewport, toScreen, toWorld, zoomAt, type Viewport } from "../canvas/camera";
import {
  alignShift, distributeShifts, handleDir, resizeLocal, rotatePoint, turnedBounds, type Align, type Handle, type Point, type Rect,
} from "../canvas/geometry";
import SelectionHandles from "../canvas/SelectionHandles";
import { panelWidth, savePanelWidth, setPanelWidth } from "../canvas/panels";
import { saveExports, svgFile, type ExportSetting } from "../canvas/export";
import { ExportButton, ExportRows, nextExport } from "../canvas/ExportSettings";
import {
  edgeGeometry, edgeGeometryOf, endLabelPoint, freeEnd, nearestPort, recolorIconSvg, renderDiagram, rowsByShape, shapeEnd, shapeSvgMarkup, type EdgeEnd,
} from "./render";
import { parseRow, rowText, rowZ, structuredItems, structureLayout } from "./rows";
import { RowInput, StructuredPanel, type RowEdit } from "./StructuredEditors";
import { headIcon, headOf, heads, markerFrame, partPaint, presets, type Preset } from "./ends";
import { libraryItems, type LibraryItem } from "./library";
import { readJson, writeJson } from "../../../core/storage";
import { defaultStyle, isStructured, portPoint, shapeKinds, shapeName, type DiagramEdge, type DiagramRow, type DiagramShape, type RowSection, type StructuredKind, type EdgeKind, type Port, type ShapeChange, type ShapeKind } from "./model";
import { encodeDrawio, importDrawio } from "./drawio";
import { saveBlob } from "../../../ui/download";
import "../canvas/canvas.css";
import ZoomBar from "../canvas/ZoomBar";
import "../views.css";
import "./diagram.css";
import { focusWhenShown } from "../../../ui/focus";

const dragType = "application/x-makework-diagram-shape";
// A connector kind dragged from the library (its preset id), dropped as a free connector of that kind.
const connectorDragType = "application/x-makework-diagram-connector";
// The connector kind new connectors are drawn with, kept per device.
const penKey = "mw.diagram.pen";
const sectionsKey = "mw.diagram.librarySections";
const propertiesKey = "mw.diagram.propertiesPinned";
const framedPages = new Set<string>();
const ports: Port[] = ["n", "e", "s", "w", "c"];
const cameraByPage = new Map<string, Viewport>();
const minSize = 24;

// One end of a connector: on a shape's port, or free at a point (id null).
// `row`: on one row of a structured shape.
type End = { id: number | null; port: Port; point: Point; row?: number | null };

type Gesture =
  | { kind: "pan"; start: Point; view: Viewport }
  | { kind: "move"; start: Point; ids: number[]; edgeIds: number[]; originals: Map<number, DiagramShape>; moved: boolean; delta: Point }
  | { kind: "resize"; handle: Handle; originals: Map<number, DiagramShape>; bounds: Rect }
  | { kind: "rotate"; center: Point; startAngle: number; originals: Map<number, DiagramShape> }
  | { kind: "connect"; from: End; to: End }
  | { kind: "reattach"; edgeId: number; end: "from" | "to" }
  | { kind: "bend"; edgeId: number; start: Point; origin: Point; axis: "x" | "y" | "xy"; moved: boolean }
  | { kind: "edge-move"; edgeId: number; start: Point; original: DiagramEdge; moved: boolean }
  | { kind: "marquee"; start: Point; base: number[]; baseEdges: number[] };

function escapedSvg(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const textSafe = (value: string) => value.replaceAll("\r\n", "\n");
const labelFor = (kind: ShapeKind) =>
  shapeKinds.find((item) => item.kind === kind)?.label ?? structuredItems.find((item) => item.kind === kind)?.label ?? "Shape";
const numeric = (value: string, fallback: number) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const round = (value: number) => Math.round(value);
const centerOf = (shape: DiagramShape): Point => ({ x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 });
const turned = (shape: DiagramShape) => turnedBounds(shape.x, shape.y, shape.w, shape.h, shape.rotation);
const unionOf = (rects: Rect[]): Rect => ({
  left: Math.min(...rects.map((r) => r.left)), top: Math.min(...rects.map((r) => r.top)),
  right: Math.max(...rects.map((r) => r.right)), bottom: Math.max(...rects.map((r) => r.bottom)),
});
const shift = (p: Point, d: Point): Point => ({ x: p.x + d.x, y: p.y + d.y });
const touches = (edge: DiagramEdge, ids: number[]) => (edge.fromId !== null && ids.includes(edge.fromId))
  || (edge.toId !== null && ids.includes(edge.toId)) || (edge.parentId !== null && ids.includes(edge.parentId));
// The fields of an edge a change names, copied, for undo.
const edgeFields = (edge: DiagramEdge, change: Partial<DiagramEdge>) =>
  JSON.parse(JSON.stringify(Object.fromEntries(Object.keys(change).map((key) => [key, edge[key as keyof DiagramEdge]])))) as Partial<DiagramEdge>;
const endChange = (side: "from" | "to", end: End): Partial<DiagramEdge> => side === "from"
  ? { fromId: end.id, fromPort: end.port, fromPoint: end.point, fromRow: end.row ?? null }
  : { toId: end.id, toPort: end.port, toPoint: end.point, toRow: end.row ?? null };

// A connector's head as a marker, from its definition in ends.ts (exports draw the same with markerSvg).
function EndMarker(props: { id: string; name: string; color: string; background: string; strokeWidth: number }) {
  const head = () => headOf(props.name);
  return (
    <Show when={head()}>
      {(h) => {
        const frame = () => markerFrame(h(), props.strokeWidth);
        return (
          <marker id={props.id} markerUnits="userSpaceOnUse" markerWidth={frame().width} markerHeight={frame().height}
            refX={frame().refX} refY={frame().refY} viewBox={frame().viewBox} orient="auto-start-reverse" overflow="visible">
            <For each={h().parts}>
              {(part) => {
                const paint = () => partPaint(part, props.color, props.background, props.strokeWidth);
                return <path d={part.d} stroke-linejoin="round" style={{ fill: paint().fill, stroke: paint().stroke, "stroke-width": `${paint().strokeWidth}` }} />;
              }}
            </For>
          </marker>
        );
      }}
    </Show>
  );
}

// The head choices for a connector's end, each with its picture.
const headOptions = [{ value: "none", label: "None", icon: headIcon("") }, ...heads.map((head) => ({ value: head.name, label: head.label, icon: headIcon(head.name) }))];

export default function DiagramView(props: { context: ChannelContext }) {
  const ctx = props.context;
  const panes = createPanes<"library" | "properties">();
  const pages = createPages(ctx.api, ctx.channel.id);
  const [pageId, setPageId] = createSignal<number | null>(null);
  const page = createMemo(() => pages.value.find((item) => item.id === pageId()) ?? pages.value[0]);
  createEffect(() => {
    if (!pages.loaded || pages.value.length !== 0 || !ctx.can("edit_content")) return;
    void run(async () => {
      const { id } = await addPage(ctx.api, ctx.channel.id, "Page 1");
      setPageId(id);
    });
  });
  createEffect(() => {
    const current = page();
    if (current && current.id !== pageId()) setPageId(current.id);
  });
  const shapesLive = createShapes(ctx.api, () => pageId() ?? 0);
  const edgesLive = createEdges(ctx.api, () => pageId() ?? 0);
  // The rows of the page's classes and tables (rows.ts), by shape.
  const rowsLive = createRows(ctx.api, () => pageId() ?? 0);
  const rowsOf = createMemo(() => rowsByShape(rowsLive.value));
  const shapeRows = (id: number): readonly DiagramRow[] => rowsOf().get(id) ?? [];
  const [rowEdit, setRowEdit] = createSignal<RowEdit | null>(null);
  const [selected, setSelected] = createSignal<number[]>([]);
  // Connectors in the selection; the connector panel and handles show for one connector alone.
  const [selectedEdges, setSelectedEdges] = createSignal<number[]>([]);
  const selectedEdge = () => selected().length === 0 && selectedEdges().length === 1 ? selectedEdges()[0] : null;
  const setSelectedEdge = (id: number | null) => setSelectedEdges(id === null ? [] : [id]);
  // The kind new connectors are drawn with (picked in the library).
  const [penId, setPenId] = createSignal(readJson<string>(penKey, "flow"));
  const pen = (): Preset => presets.find((item) => item.id === penId()) ?? presets[0];
  const penEnds = () => ({ start_arrow: pen().start, end_arrow: pen().end, style: { ...defaultEdgeStyle(), dash: pen().dash } });
  const [connectMode, setConnectMode] = createSignal(false);
  const [renaming, setRenaming] = createSignal(false);
  let pageNameInput: HTMLInputElement | undefined;
  const [hovered, setHovered] = createSignal<number | null>(null);
  const [editing, setEditing] = createSignal<number | null>(null);
  const [error, setError] = createSignal("");
  const [query, setQuery] = createSignal("");
  const [preview, setPreview] = createSignal<Map<number, ShapeChange>>(new Map());
  // Connector changes shown before they are saved (while dragging, and until the save is back).
  const [edgeDraft, setEdgeDraft] = createSignal<Map<number, Partial<DiagramEdge>>>(new Map());
  const [camera, setCamera] = createSignal<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [activeGesture, setActiveGesture] = createSignal<Gesture | null>(null);
  const [band, setBand] = createSignal<{ from: Point; to: Point } | null>(null);
  const [space, setSpace] = createSignal(false);
  const [boardSize, setBoardSize] = createSignal({ width: 0, height: 0 });
  let board!: HTMLDivElement;
  let gesture: Gesture | null = null;
  let importPicker!: HTMLInputElement;
  const beginGesture = (next: Gesture | null) => {
    gesture = next;
    setActiveGesture(next);
  };
  createEffect(() => {
    pageId();
    setSelected([]);
    setSelectedEdge(null);
    setEditing(null);
    setPreview(new Map());
    setEdgeDraft(new Map());
    beginGesture(null);
    ctx.cursors.move(null);
  });
  const cameraKey = () => `${ctx.workspace.id}:${ctx.channel.id}:${pageId()}`;
  createEffect(() => {
    const saved = cameraByPage.get(cameraKey());
    setCamera(saved ?? { x: 0, y: 0, zoom: 1 });
  });
  createEffect(() => cameraByPage.set(cameraKey(), camera()));
  const canEdit = () => ctx.can("edit_content");
  const [propertiesPinned, setPropertiesPinned] = createSignal(readJson(propertiesKey, false));
  const togglePropertiesPinned = () => {
    setPropertiesPinned(!propertiesPinned());
    writeJson(propertiesKey, propertiesPinned());
  };
  const allShapes = createMemo(() => shapesLive.value.map((shape) => {
    const change = preview().get(shape.id);
    return change ? { ...shape, ...change } : shape;
  }));
  const byId = createMemo(() => new Map(allShapes().map((shape) => [shape.id, shape])));
  // Connectors moved along with dragged shapes: their bend when both ends move, and their free ends too when they
  // are in a dragged group or selected.
  const carried = (edge: DiagramEdge, ids: number[], edgeIds: number[], delta: Point): Partial<DiagramEdge> | null => {
    const along = (edge.parentId !== null && ids.includes(edge.parentId)) || edgeIds.includes(edge.id);
    const both = edge.fromId !== null && edge.toId !== null && ids.includes(edge.fromId) && ids.includes(edge.toId);
    if (!along && !both) return null;
    const change: Partial<DiagramEdge> = {};
    if (edge.points.length) change.points = edge.points.map((p) => shift(p, delta));
    if (along && edge.fromId === null) change.fromPoint = shift(edge.fromPoint, delta);
    if (along && edge.toId === null) change.toPoint = shift(edge.toPoint, delta);
    return Object.keys(change).length ? change : null;
  };
  const edges = createMemo(() => {
    const draft = edgeDraft();
    const shapes = byId();
    const current = activeGesture();
    const moving = current?.kind === "move" && current.moved ? current : null;
    return edgesLive.value.flatMap((edge) => {
      if ((edge.fromId !== null && !shapes.has(edge.fromId)) || (edge.toId !== null && !shapes.has(edge.toId))) return [];
      let shown = draft.has(edge.id) ? { ...edge, ...draft.get(edge.id) } : edge;
      const moved = moving && carried(shown, moving.ids, moving.edgeIds, moving.delta);
      if (moved) shown = { ...shown, ...moved };
      return [shown];
    });
  });
  const geometries = createMemo(() => new Map(edges().flatMap((edge) => {
    const geometry = edgeGeometry(edge, byId(), rowsOf());
    return geometry ? [[edge.id, { edge, geometry }] as const] : [];
  })));
  const selectedEdgeView = createMemo(() => {
    const id = selectedEdge();
    return id === null ? undefined : geometries().get(id);
  });
  const endOf = (end: End): EdgeEnd => {
    const shape = end.id === null ? undefined : byId().get(end.id);
    if (shape && end.row) return { at: end.point, dir: { x: end.port === "e" ? 1 : -1, y: 0 }, attached: true };
    return shape ? shapeEnd(shape, end.port) : freeEnd(end.point);
  };
  const connectPreview = createMemo(() => {
    const current = activeGesture();
    if (current?.kind !== "connect") return undefined;
    const kind: EdgeKind = current.from.id === null && current.to.id === null ? "straight" : "orthogonal";
    return edgeGeometryOf({ kind, points: [] }, endOf(current.from), endOf(current.to)).d;
  });
  const selectedShapes = () => selected().flatMap((id) => {
    const shape = byId().get(id);
    return shape ? [shape] : [];
  });
  const worldPoint = (event: { clientX: number; clientY: number }) => {
    const rect = board.getBoundingClientRect();
    return toWorld(camera(), { x: event.clientX - rect.left, y: event.clientY - rect.top });
  };
  const screenPoint = (point: Point) => toScreen(camera(), point);
  const center = () => ({ x: board.clientWidth / 2, y: board.clientHeight / 2 });
  const fit = (list = allShapes()) => {
    const free = edges().flatMap((edge) => [
      ...(edge.fromId === null ? [edge.fromPoint] : []), ...(edge.toId === null ? [edge.toPoint] : []),
    ]).map((p) => ({ left: p.x, top: p.y, right: p.x, bottom: p.y }));
    setCamera(fitViewport([...list.map(turned), ...free], board.clientWidth, board.clientHeight));
  };
  const zoomTo = (value: number) => setCamera(zoomAt(camera(), center(), clampZoom(value)));
  // A page opens with all of it in view, once per session; after that it stays where the member left it.
  createEffect(() => {
    const key = cameraKey();
    if (framedPages.has(key) || pageId() === null || !shapesLive.loaded) return;
    framedPages.add(key);
    const shapes = allShapes();
    if (shapes.length) setCamera(fitViewport(shapes.map(turned), board.clientWidth, board.clientHeight, undefined, 1));
  });
  // Opening the properties narrows the canvas: a shape it would cover moves back into view.
  createEffect(on(() => selected().join(), () => requestAnimationFrame(() => {
    const shapes = selectedShapes();
    if (!shapes.length || !board) return;
    const right = toScreen(camera(), { x: Math.max(...shapes.map((s) => turned(s).right)), y: 0 }).x;
    const over = right + 24 - board.clientWidth;
    if (over > 0) setCamera({ ...camera(), x: camera().x - over });
  }), { defer: true }));
  const showProperties = () => propertiesPinned() || selectedShapes().length + selectedEdges().length > 0 || selectedEdge() !== null;
  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      setError("");
    } catch (e) {
      setError(e instanceof Error && !("code" in e) ? e.message : userMessage(e));
    }
  };
  const descendants = (id: number): number[] => allShapes().filter((shape) => shape.parentId === id).flatMap((shape) => [shape.id, ...descendants(shape.id)]);
  const shapeRoots = (ids: number[]) => ids.filter((id) => {
    const found = new Set(ids);
    let parent = byId().get(id)?.parentId ?? null;
    while (parent !== null) {
      if (found.has(parent)) return false;
      parent = byId().get(parent)?.parentId ?? null;
    }
    return true;
  });
  const shapeBounds = (shapes: DiagramShape[]) => ({
    left: Math.min(...shapes.map((shape) => shape.x)), top: Math.min(...shapes.map((shape) => shape.y)),
    right: Math.max(...shapes.map((shape) => shape.x + shape.w)), bottom: Math.max(...shapes.map((shape) => shape.y + shape.h)),
  });
  // What a click inside groups picks: the outermost group, or the next one in when that group is already selected
  // (so clicking again goes into it). `parentId`: the clicked shape's or connector's parent; null result: the connector.
  const pickObject = (shapeId: number | null, parentId: number | null): number | null => {
    const chain: number[] = [];
    for (let p = parentId; p !== null;) {
      const shape = byId().get(p);
      if (!shape) break;
      if (shape.kind === "group") chain.unshift(shape.id);
      p = shape.parentId;
    }
    for (let i = chain.length - 1; i >= 0; i--) if (selected().includes(chain[i])) return chain[i + 1] ?? shapeId;
    return chain[0] ?? shapeId;
  };
  const outermost = (shapeId: number | null, parentId: number | null): number | null => {
    let found: number | null = null;
    for (let p = parentId; p !== null;) {
      const shape = byId().get(p);
      if (!shape) break;
      if (shape.kind === "group") found = shape.id;
      p = shape.parentId;
    }
    return found ?? shapeId;
  };
  // The drawn shapes of a selection (groups stand for what is in them).
  const leavesOf = (shapes: DiagramShape[]) => [...new Map(shapes.flatMap((shape) => shape.kind === "group"
    ? descendants(shape.id).flatMap((id) => {
      const inner = byId().get(id);
      return inner && inner.kind !== "group" ? [inner] : [];
    }) : [shape]).map((shape) => [shape.id, shape])).values()];
  const selectionBounds = (): Rect | null => {
    const shapes = selectedShapes();
    const groups = new Set(shapes.flatMap((shape) => shape.kind === "group" ? [shape.id, ...descendants(shape.id)] : []));
    const lines = [...geometries().values()].filter(({ edge }) => selectedEdges().includes(edge.id) || (edge.parentId !== null && groups.has(edge.parentId)));
    const rects = [
      ...leavesOf(shapes).map(turned),
      ...lines.flatMap(({ geometry }) => geometry.points.map((p) => ({ left: p.x, top: p.y, right: p.x, bottom: p.y }))),
    ];
    return rects.length ? unionOf(rects) : null;
  };
  // One shape: its own turned box. Several, or a group: the page-aligned box around them.
  const selectionFrame = createMemo(() => {
    const targets = selectedShapes();
    if (targets.length === 0) return undefined;
    const zoom = camera().zoom;
    if (targets.length === 1 && targets[0].kind !== "group" && selectedEdges().length === 0) {
      const shape = targets[0];
      const corner = shift(centerOf(shape), rotatePoint({ x: -shape.w / 2, y: -shape.h / 2 }, shape.rotation));
      const at = screenPoint(corner);
      return {
        style: { width: `${shape.w * zoom}px`, height: `${shape.h * zoom}px`, transform: `translate(${at.x}px, ${at.y}px) rotate(${shape.rotation}deg)` },
        size: `${round(shape.w)} × ${round(shape.h)}`,
      };
    }
    const bounds = selectionBounds();
    if (!bounds) return undefined;
    const at = screenPoint({ x: bounds.left, y: bounds.top });
    return {
      style: { width: `${(bounds.right - bounds.left) * zoom}px`, height: `${(bounds.bottom - bounds.top) * zoom}px`, transform: `translate(${at.x}px, ${at.y}px)` },
      size: `${round(bounds.right - bounds.left)} × ${round(bounds.bottom - bounds.top)}`,
    };
  });
  const commit = async (changes: Map<number, ShapeChange>, label: string, ids = [...changes.keys()], edgeChanges = new Map<number, Partial<DiagramEdge>>()) => {
    if (!canEdit() || (changes.size === 0 && edgeChanges.size === 0)) return;
    // A class or table is never made shorter than its rows.
    for (const [id, change] of changes) {
      const shape = shapesLive.value.find((item) => item.id === id);
      if (shape && change.h !== undefined && isStructured(change.kind ?? shape.kind))
        changes.set(id, { ...change, h: Math.max(change.h, structureLayout({ ...shape, ...change, h: 0 }, shapeRows(id)).needed) });
    }
    const previous = new Map([...changes].map(([id, change]) => {
      const shape = shapesLive.value.find((item) => item.id === id)!;
      const old = JSON.parse(JSON.stringify(Object.fromEntries(Object.keys(change).map((key) => [key, shape[key as keyof DiagramShape]])))) as ShapeChange;
      return [id, old];
    }));
    const previousEdges = new Map([...edgeChanges].map(([id, change]) => [id, edgeFields(edgesLive.value.find((edge) => edge.id === id)!, change)]));
    const save = async (shapes: Map<number, ShapeChange>, lines: Map<number, Partial<DiagramEdge>>) => {
      if (shapes.size) await updateShapes(ctx.api, shapes);
      if (lines.size) await updateEdges(ctx.api, lines);
    };
    setPreview(changes);
    setEdgeDraft(edgeChanges);
    try {
      await save(changes, edgeChanges);
      await Promise.all([shapesLive.refresh(), edgesLive.refresh()]);
    } finally {
      setPreview(new Map());
      setEdgeDraft(new Map());
    }
    ctx.history.push({
      label, icon: "diagram-rect",
      undo: () => save(previous, previousEdges),
      redo: () => save(changes, edgeChanges),
    });
    if (ids.length) setSelected(ids);
  };
  const editEdge = (id: number, change: Partial<DiagramEdge>, label = "Change connector") => void run(async () => {
    const edge = edgesLive.value.find((item) => item.id === id);
    if (!edge) return;
    const previous = edgeFields(edge, change);
    const changes = new Map([[id, change]]);
    setEdgeDraft(changes);
    try {
      await updateEdges(ctx.api, changes);
      await edgesLive.refresh();
    } finally {
      setEdgeDraft(new Map());
    }
    ctx.history.push({
      label, icon: "forward",
      undo: () => updateEdges(ctx.api, new Map([[id, previous]])),
      redo: () => updateEdges(ctx.api, changes),
    });
  });
  const addShape = async (kind: ShapeKind, at: Point, style = defaultStyle(kind), text = labelFor(kind), extra: Partial<NewShape> = {}) => {
    const pageIdValue = pageId();
    if (!canEdit() || pageIdValue === null) return;
    const structured = isStructured(kind);
    // A table starts with its key; a class empty. Its height is what its rows take.
    const firstRows = kind === "db-table" || kind === "db-junction" ? [parseRow("id int PK", kind)] : [];
    const w = extra.w ?? (kind === "text" ? 180 : structured ? 200 : 128);
    const h = extra.h ?? (kind === "text" ? 52 : structured
      ? structureLayout({ kind, w, h: 0 } as DiagramShape, firstRows.map((row, i) => ({ ...row, id: -1 - i, shapeId: 0, z: i + 1 }))).needed : 72);
    const shape: NewShape = {
      kind, x: at.x - w / 2, y: at.y - h / 2, w, h, text, style,
      ...(extra.parent_id !== undefined ? { parent_id: extra.parent_id } : {}),
      ...(extra.rotation !== undefined ? { rotation: extra.rotation } : {}),
    };
    const ids = await addShapes(ctx.api, pageIdValue, [shape]);
    if (firstRows.length) {
      await addRows(ctx.api, firstRows.map((row, i) => ({ ...row, shapeId: ids[0], z: i + 1 })));
      await rowsLive.refresh();
    }
    setSelected(ids);
    ctx.history.push({
      label: `Add ${labelFor(kind).toLowerCase()}`, icon: "add",
      undo: () => removeShapes(ctx.api, ids), redo: () => restoreShapes(ctx.api, ids),
    });
  };
  // A class's or table's rows changed: the shape takes the height its rows need, in the same undo step.
  const fitHeight = async (shape: DiagramShape, rows: readonly DiagramRow[]) => {
    const needed = structureLayout({ ...shape, h: 0 }, rows).needed;
    if (Math.round(needed) !== Math.round(shape.h)) await updateShapes(ctx.api, new Map([[shape.id, { h: needed }]]));
  };
  const rowStep = (label: string, shape: DiagramShape, after: () => readonly DiagramRow[], change: () => Promise<void>,
    undo: () => Promise<void>, redo: () => Promise<void> = change) => run(async () => {
    const h = shape.h;
    await change();
    await fitHeight(shape, after());
    await Promise.all([rowsLive.refresh(), shapesLive.refresh()]);
    ctx.history.push({
      label, icon: "diagram-rect",
      undo: async () => { await undo(); await updateShapes(ctx.api, new Map([[shape.id, { h }]])); },
      redo: async () => { await redo(); await fitHeight(shape, after()); },
    });
  });
  // A row typed in: added (after a row, or last in its section) or changed. Returns the row's id.
  const saveRow = async (shape: DiagramShape, edit: RowEdit, text: string): Promise<number | null> => {
    const rows = shapeRows(shape.id);
    const row = edit.rowId === null ? undefined : rows.find((item) => item.id === edit.rowId);
    if (!text.trim()) return null;
    if (row && rowText(row, shape.kind) === text.trim()) return row.id;
    const fields = parseRow(text, shape.kind, edit.section);
    if (row) {
      const previous: RowChange = { section: row.section, name: row.name, type: row.type, params: row.params, value: row.value, visibility: row.visibility, marks: [...row.marks] };
      await rowStep("Edit row", shape, () => rows.map((item) => item.id === row.id ? { ...item, ...fields } : item),
        () => updateRows(ctx.api, new Map([[row.id, fields]])).then(() => {}), () => updateRows(ctx.api, new Map([[row.id, previous]])).then(() => {}));
      return row.id;
    }
    const afterRow = rows.find((item) => item.id === edit.after);
    const z = rowZ(rows, fields.section, afterRow?.section === fields.section ? afterRow : undefined);
    let ids: number[] = [];
    await rowStep("Add row", shape, () => [...rows, { ...fields, id: ids[0] ?? -1, shapeId: shape.id, z }],
      async () => { ids = await addRows(ctx.api, [{ ...fields, shapeId: shape.id, z }]); },
      () => removeRows(ctx.api, ids).then(() => {}), () => restoreRows(ctx.api, ids).then(() => {}));
    return ids[0] ?? null;
  };
  const removeRow = (shape: DiagramShape, row: DiagramRow) => rowStep("Remove row", shape,
    () => shapeRows(shape.id).filter((item) => item.id !== row.id),
    () => removeRows(ctx.api, [row.id]).then(() => {}), () => restoreRows(ctx.api, [row.id]).then(() => {}));
  const moveRow = (shape: DiagramShape, row: DiagramRow, by: -1 | 1) => {
    const inSection = shapeRows(shape.id).filter((item) => item.section === row.section).sort((a, b) => a.z - b.z || a.id - b.id);
    const other = inSection[inSection.indexOf(row) + by];
    if (!other) return;
    const swap = new Map<number, RowChange>([[row.id, { z: other.z }], [other.id, { z: row.z }]]);
    const back = new Map<number, RowChange>([[row.id, { z: row.z }], [other.id, { z: other.z }]]);
    void rowStep("Move row", shape, () => shapeRows(shape.id), () => updateRows(ctx.api, swap).then(() => {}), () => updateRows(ctx.api, back).then(() => {}));
  };
  const markRow = (shape: DiagramShape, row: DiagramRow, mark: string, on: boolean) => {
    const marks = on ? [...row.marks, mark] : row.marks.filter((item) => item !== mark);
    const previous = [...row.marks];
    void rowStep(on ? `Mark ${mark}` : `Unmark ${mark}`, shape, () => shapeRows(shape.id),
      () => updateRows(ctx.api, new Map([[row.id, { marks }]])).then(() => {}), () => updateRows(ctx.api, new Map([[row.id, { marks: previous }]])).then(() => {}));
  };
  // Typing on the canvas: Enter saved a row and goes on to a new one below it; Backspace in an empty row removed it and
  // goes to the one above.
  const finishRow = (shape: DiagramShape, edit: RowEdit, text: string, next: boolean) => void (async () => {
    // Emptied: the row goes.
    if (!text.trim()) {
      const row = shapeRows(shape.id).find((item) => item.id === edit.rowId);
      setRowEdit(null);
      if (row) await removeRow(shape, row);
      return;
    }
    const id = await saveRow(shape, edit, text);
    if (!next) return setRowEdit(null);
    const saved = shapeRows(shape.id).find((item) => item.id === id);
    setRowEdit({ shapeId: shape.id, rowId: null, section: saved?.section ?? edit.section, after: id ?? undefined });
  })();
  const dropRow = (shape: DiagramShape, edit: RowEdit) => {
    const rows = shapeRows(shape.id);
    const row = rows.find((item) => item.id === edit.rowId);
    const inSection = rows.filter((item) => item.section === edit.section).sort((a, b) => a.z - b.z || a.id - b.id);
    const above = row ? inSection[inSection.indexOf(row) - 1] : inSection.find((item) => item.id === edit.after);
    setRowEdit(above ? { shapeId: shape.id, rowId: above.id, section: above.section } : null);
    if (row) void removeRow(shape, row);
  };
  // A double click on a class or table: its name in the header, a row to change, or a new row in an empty part.
  const editStructured = (shape: DiagramShape, point: Point) => {
    const layout = structureLayout(shape, shapeRows(shape.id));
    const y = point.y - shape.y;
    if (y < layout.header.h) return setEditing(shape.id);
    const hit = layout.compartments.flatMap((c) => c.rows).find((item) => y >= item.y && y < item.y + item.h);
    if (hit) return setRowEdit({ shapeId: shape.id, rowId: hit.row.id, section: hit.row.section });
    const compartment = layout.compartments.find((c) => y >= c.y && y < c.y + c.h) ?? layout.compartments.at(-1);
    if (compartment) setRowEdit({ shapeId: shape.id, rowId: null, section: compartment.section, after: compartment.rows.at(-1)?.row.id });
  };
  // Another kind of the same family; rows of a part the new kind lacks (an enumeration has no operations) are kept for
  // a change back, and the height follows what shows.
  const changeKind = (shape: DiagramShape, kind: StructuredKind) => void run(() => commit(new Map([[shape.id, {
    kind, h: structureLayout({ ...shape, kind, h: 0 }, shapeRows(shape.id)).needed,
  }]]), `Make it ${labelFor(kind).toLowerCase()}`));
  const addIcon = async (name: string, at = toWorld(camera(), center())) => run(async () => {
    const svg = await fetchIcon(name);
    await addShape("icon", at, { ...defaultStyle("icon"), icon: name, svg }, name.split(":")[1] ?? name, { w: 72, h: 72 });
  });
  // Free at both ends it is a straight arrow; with a shape at either end it routes around corners.
  const addEdge = async (from: End, to: End) => {
    const pageIdValue = pageId();
    if (pageIdValue === null) return;
    const ends = (side: "from" | "to", end: End) => end.id === null
      ? { [`${side}_id`]: null, [`${side}_port`]: "c", [`${side}_x`]: end.point.x, [`${side}_y`]: end.point.y }
      : { [`${side}_id`]: end.id, [`${side}_port`]: end.port, ...(end.row ? { [`${side}_row`]: end.row } : {}) };
    const kind: EdgeKind = from.id === null && to.id === null ? "straight" : "orthogonal";
    const ids = await addEdges(ctx.api, pageIdValue, [{ ...ends("from", from), ...ends("to", to), kind, ...penEnds() } as NewEdge]);
    await edgesLive.refresh();
    ctx.history.push({
      label: "Add connector", icon: "forward",
      undo: () => removeEdges(ctx.api, ids), redo: () => restoreEdges(ctx.api, ids),
    });
    setSelected([]);
    setSelectedEdge(ids[0]);
  };
  const addQuick = (shape: DiagramShape, direction: "n" | "e" | "s" | "w") => run(async () => {
    const gap = 72;
    const delta = direction === "e" ? { x: shape.w + gap, y: 0 }
      : direction === "w" ? { x: -shape.w - gap, y: 0 }
        : direction === "s" ? { x: 0, y: shape.h + gap } : { x: 0, y: -shape.h - gap };
    const pageIdValue = pageId();
    if (pageIdValue === null) return;
    const duplicate: NewShape = {
      kind: shape.kind, x: shape.x + delta.x, y: shape.y + delta.y, w: shape.w, h: shape.h,
      rotation: shape.rotation, text: shape.text, style: shape.style,
    };
    const [newId] = await addShapes(ctx.api, pageIdValue, [duplicate]);
    const opposite: Record<typeof direction, Port> = { e: "w", w: "e", n: "s", s: "n" };
    const edgeIds = await addEdges(ctx.api, pageIdValue, [{
      from_id: shape.id, from_port: direction, to_id: newId, to_port: opposite[direction], ...penEnds(),
    }]);
    ctx.history.push({
      label: "Add connected shape", icon: "add",
      undo: async () => { await removeEdges(ctx.api, edgeIds); await removeShapes(ctx.api, [newId]); },
      redo: async () => { await restoreShapes(ctx.api, [newId]); await restoreEdges(ctx.api, edgeIds); },
    });
    setSelected([newId]);
  });

  const nearestShape = (event: PointerEvent) => {
    const element = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-shape]");
    return element ? byId().get(Number(element.dataset.shape)) : undefined;
  };
  // The connector end under the pointer: the port pointed at or the shape's nearest one, else a free point.
  const endAt = (event: PointerEvent, point: Point, skip: number | null = null): End => {
    const shape = nearestShape(event);
    if (!shape || shape.id === skip) return { id: null, port: "c", point };
    const portElement = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-port]");
    // Over a row of a class or table: on that row, from the side nearest the pointer (it then faces the other end).
    if (!portElement && isStructured(shape.kind)) {
      const y = point.y - shape.y;
      const row = structureLayout(shape, shapeRows(shape.id)).compartments.flatMap((c) => c.rows).find((item) => y >= item.y && y < item.y + item.h);
      if (row) {
        const port: Port = point.x >= shape.x + shape.w / 2 ? "e" : "w";
        return { id: shape.id, port, point: { x: port === "e" ? shape.x + shape.w : shape.x, y: shape.y + row.y + row.h / 2 }, row: row.row.id };
      }
    }
    const port = portElement ? portElement.dataset.port as Port : nearestPort(shape, point);
    return { id: shape.id, port, point: portPoint(shape, port) };
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.button === 2 || editing() !== null) return;
    const target = event.target as HTMLElement;
    // A row being typed closes when the board is pressed: focused, it saves as it loses the focus (below); one that
    // never had the focus is just closed.
    if (rowEdit() && !board.querySelector(".diagram-row-input")?.contains(document.activeElement)) setRowEdit(null);
    board.focus({ preventScroll: true });
    const point = worldPoint(event);
    const local = { x: event.clientX - board.getBoundingClientRect().left, y: event.clientY - board.getBoundingClientRect().top };
    const port = target.closest<HTMLElement>("[data-port]");
    const shapeElement = target.closest<HTMLElement>("[data-shape]");
    const shapeId = shapeElement ? Number(shapeElement.dataset.shape) : null;
    const handle = target.closest<HTMLElement>("[data-handle]")?.dataset.handle;
    const edgeEndElement = target.closest<HTMLElement>("[data-edge-end]");
    const view = selectedEdgeView();
    if (event.button === 1 || space()) {
      beginGesture({ kind: "pan", start: local, view: camera() });
    } else if (edgeEndElement && view && canEdit()) {
      beginGesture({ kind: "reattach", edgeId: view.edge.id, end: edgeEndElement.dataset.edgeEnd as "from" | "to" });
    } else if (target.closest("[data-edge-bend]") && view && canEdit()) {
      beginGesture({ kind: "bend", edgeId: view.edge.id, start: point, origin: view.geometry.handle.at, axis: view.geometry.handle.axis, moved: false });
    } else if (port && shapeId !== null && canEdit()) {
      const shape = byId().get(shapeId)!;
      const from: End = { id: shapeId, port: port.dataset.port as Port, point: portPoint(shape, port.dataset.port as Port) };
      beginGesture({ kind: "connect", from, to: { id: null, port: "c", point } });
    } else if (connectMode() && canEdit()) {
      const shape = shapeId === null ? undefined : byId().get(shapeId);
      const from: End = shape ? { id: shape.id, port: nearestPort(shape, point), point: portPoint(shape, nearestPort(shape, point)) } : { id: null, port: "c", point };
      setSelected([]);
      setSelectedEdge(null);
      beginGesture({ kind: "connect", from, to: { id: null, port: "c", point } });
    } else if (handle && selectedShapes().length) {
      const originals = new Map(leavesOf(selectedShapes()).map((shape) => [shape.id, shape]));
      const bounds = originals.size ? unionOf([...originals.values()].map(turned)) : selectionBounds()!;
      if (handle === "rotate") {
        const mid = { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
        beginGesture({ kind: "rotate", center: mid, startAngle: Math.atan2(point.y - mid.y, point.x - mid.x), originals });
      } else beginGesture({ kind: "resize", handle: handle as Handle, originals, bounds });
    } else if (shapeId !== null) {
      const picked = pickObject(shapeId, byId().get(shapeId)?.parentId ?? null)!;
      if (event.shiftKey) setSelected((current) => current.includes(picked) ? current.filter((id) => id !== picked) : [...current, picked]);
      else if (!selected().includes(picked)) {
        setSelected([picked]);
        setSelectedEdge(null);
      }
      const ids = shapeRoots(selected().includes(picked) ? selected() : [picked]).flatMap((id) => [id, ...descendants(id)]);
      const originals = new Map(ids.flatMap((id) => {
        const shape = byId().get(id);
        return shape ? [[id, shape] as const] : [];
      }));
      if (canEdit()) beginGesture({ kind: "move", start: point, ids, edgeIds: selectedEdges(), originals, moved: false, delta: { x: 0, y: 0 } });
    } else {
      const edgeElement = target.closest<SVGElement>("[data-edge]");
      if (edgeElement) {
        const edge = edges().find((item) => item.id === Number(edgeElement.dataset.edge));
        const group = edge ? pickObject(null, edge.parentId) : null;
        if (edge && group !== null) {
          // A connector in a group picks the group, which then drags like a shape.
          if (event.shiftKey) setSelected((current) => current.includes(group) ? current.filter((id) => id !== group) : [...current, group]);
          else setSelected([group]);
          if (!event.shiftKey) setSelectedEdge(null);
          const ids = shapeRoots(selected()).flatMap((id) => [id, ...descendants(id)]);
          const originals = new Map(ids.flatMap((id) => {
            const shape = byId().get(id);
            return shape ? [[id, shape] as const] : [];
          }));
          if (canEdit()) beginGesture({ kind: "move", start: point, ids, edgeIds: selectedEdges(), originals, moved: false, delta: { x: 0, y: 0 } });
        } else if (edge && event.shiftKey) {
          setSelectedEdges((current) => current.includes(edge.id) ? current.filter((id) => id !== edge.id) : [...current, edge.id]);
          return;
        } else {
          setSelected([]);
          setSelectedEdge(edge?.id ?? null);
        }
        // A connector free at both ends can be dragged as a whole.
        if (edge && group === null && edge.fromId === null && edge.toId === null && canEdit())
          beginGesture({ kind: "edge-move", edgeId: edge.id, start: point, original: edge, moved: false });
        else if (group === null) return;
      } else {
        const base = event.shiftKey ? selected() : [];
        const baseEdges = event.shiftKey ? selectedEdges() : [];
        if (!event.shiftKey) {
          setSelected([]);
          setSelectedEdge(null);
        }
        setBand({ from: point, to: point });
        beginGesture({ kind: "marquee", start: point, base, baseEdges });
      }
    }
    board.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const resizePreview = (current: Extract<Gesture, { kind: "resize" }>, point: Point, keepRatio: boolean, fromCenter: boolean) => {
    if (current.originals.size === 1) {
      const [[id, shape]] = [...current.originals];
      const c = centerOf(shape);
      const q = shift(rotatePoint({ x: point.x - c.x, y: point.y - c.y }, -shape.rotation), { x: shape.w / 2, y: shape.h / 2 });
      const box = resizeLocal(current.handle, q, shape.w, shape.h, keepRatio, fromCenter);
      const dir = handleDir(current.handle);
      if (box.right - box.left < minSize) dir.x < 0 ? box.left = box.right - minSize : box.right = box.left + minSize;
      if (box.bottom - box.top < minSize) dir.y < 0 ? box.top = box.bottom - minSize : box.bottom = box.top + minSize;
      const w = box.right - box.left;
      const h = box.bottom - box.top;
      const middle = shift(c, rotatePoint({ x: (box.left + box.right - shape.w) / 2, y: (box.top + box.bottom - shape.h) / 2 }, shape.rotation));
      setPreview(new Map([[id, { x: middle.x - w / 2, y: middle.y - h / 2, w, h }]]));
      return;
    }
    // Several shapes scale inside their combined box.
    const b = current.bounds;
    const dir = handleDir(current.handle);
    let { left, top, right, bottom } = b;
    if (dir.x < 0) left = point.x;
    if (dir.x > 0) right = point.x;
    if (dir.y < 0) top = point.y;
    if (dir.y > 0) bottom = point.y;
    if (keepRatio) {
      const f = Math.max(dir.x ? (right - left) / (b.right - b.left) : 0, dir.y ? (bottom - top) / (b.bottom - b.top) : 0);
      if (dir.x >= 0) right = left + (b.right - b.left) * f; else left = right - (b.right - b.left) * f;
      if (dir.y >= 0) bottom = top + (b.bottom - b.top) * f; else top = bottom - (b.bottom - b.top) * f;
    }
    const fx = Math.max(0.01, (right - left) / Math.max(1e-6, b.right - b.left));
    const fy = Math.max(0.01, (bottom - top) / Math.max(1e-6, b.bottom - b.top));
    setPreview(new Map([...current.originals].map(([id, shape]) => {
      const c = centerOf(shape);
      const middle = { x: left + (c.x - b.left) * fx, y: top + (c.y - b.top) * fy };
      const w = Math.max(minSize, shape.w * fx);
      const h = Math.max(minSize, shape.h * fy);
      return [id, { x: middle.x - w / 2, y: middle.y - h / 2, w, h }];
    })));
  };

  const onPointerMove = (event: PointerEvent) => {
    const point = worldPoint(event);
    ctx.cursors.move(point);
    const current = gesture;
    if (!current) {
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-shape]");
      setHovered(target ? Number(target.dataset.shape) : null);
      return;
    }
    if (current.kind === "pan") {
      const dx = event.clientX - (board.getBoundingClientRect().left + current.start.x);
      const dy = event.clientY - (board.getBoundingClientRect().top + current.start.y);
      setCamera({ ...current.view, x: current.view.x + dx, y: current.view.y + dy });
    } else if (current.kind === "move") {
      const dx = point.x - current.start.x;
      const dy = point.y - current.start.y;
      current.moved ||= Math.hypot(dx, dy) * camera().zoom > 3;
      if (current.moved) {
        current.delta = { x: dx, y: dy };
        setPreview(new Map([...current.originals].map(([id, shape]) => [id, { x: shape.x + dx, y: shape.y + dy }])));
        setActiveGesture({ ...current });
      }
    } else if (current.kind === "resize") {
      resizePreview(current, point, event.shiftKey, event.altKey);
    } else if (current.kind === "rotate") {
      let delta = (Math.atan2(point.y - current.center.y, point.x - current.center.x) - current.startAngle) * 180 / Math.PI;
      if (event.shiftKey) {
        const first = current.originals.values().next().value!.rotation;
        delta = Math.round((first + delta) / 15) * 15 - first;
      }
      setPreview(new Map([...current.originals].map(([id, shape]) => {
        const c = shift(current.center, rotatePoint({ x: shape.x + shape.w / 2 - current.center.x, y: shape.y + shape.h / 2 - current.center.y }, delta));
        const rotation = ((shape.rotation + delta) % 360 + 540) % 360 - 180;
        return [id, { x: c.x - shape.w / 2, y: c.y - shape.h / 2, rotation }];
      })));
    } else if (current.kind === "connect") {
      current.to = endAt(event, point, current.from.id);
      setActiveGesture({ ...current });
    } else if (current.kind === "reattach") {
      const edge = edgesLive.value.find((item) => item.id === current.edgeId);
      const other = edge && (current.end === "from" ? edge.toId : edge.fromId);
      setEdgeDraft(new Map([[current.edgeId, endChange(current.end, endAt(event, point, other ?? null))]]));
    } else if (current.kind === "bend") {
      const d = { x: point.x - current.start.x, y: point.y - current.start.y };
      current.moved ||= Math.hypot(d.x, d.y) * camera().zoom > 2;
      const bend = current.axis === "x" ? { x: current.origin.x + d.x, y: current.origin.y }
        : current.axis === "y" ? { x: current.origin.x, y: current.origin.y + d.y } : shift(current.origin, d);
      if (current.moved) setEdgeDraft(new Map([[current.edgeId, { points: [bend] }]]));
    } else if (current.kind === "edge-move") {
      const d = { x: point.x - current.start.x, y: point.y - current.start.y };
      current.moved ||= Math.hypot(d.x, d.y) * camera().zoom > 3;
      const edge = current.original;
      if (current.moved) setEdgeDraft(new Map([[current.edgeId, {
        fromPoint: shift(edge.fromPoint, d), toPoint: shift(edge.toPoint, d), points: edge.points.map((p) => shift(p, d)),
      }]]));
    } else if (current.kind === "marquee") {
      const left = Math.min(current.start.x, point.x), right = Math.max(current.start.x, point.x);
      const top = Math.min(current.start.y, point.y), bottom = Math.max(current.start.y, point.y);
      // Shapes it touches and connectors entirely inside it; what is in a group selects the group.
      const hits = allShapes().filter((shape) => {
        if (shape.kind === "group") return false;
        const r = turned(shape);
        return r.left <= right && r.right >= left && r.top <= bottom && r.bottom >= top;
      }).map((shape) => outermost(shape.id, shape.parentId)!);
      const lines: number[] = [];
      for (const { edge, geometry } of geometries().values()) {
        if (!geometry.points.every((p) => p.x >= left && p.x <= right && p.y >= top && p.y <= bottom)) continue;
        const group = outermost(null, edge.parentId);
        if (group === null) lines.push(edge.id);
        else hits.push(group);
      }
      setSelected([...new Set([...current.base, ...hits])]);
      setSelectedEdges([...new Set([...current.baseEdges, ...lines])]);
      setBand({ from: current.start, to: point });
    }
  };

  const onPointerUp = (event: PointerEvent) => {
    const current = gesture;
    beginGesture(null);
    setBand(null);
    if (!current) return;
    if (current.kind === "move" || current.kind === "resize" || current.kind === "rotate") {
      const changes = preview();
      setPreview(new Map());
      const edgeChanges = new Map<number, Partial<DiagramEdge>>();
      if (current.kind === "move" && current.moved)
        for (const edge of edgesLive.value) {
          const moved = carried(edge, current.ids, current.edgeIds, current.delta);
          if (moved) edgeChanges.set(edge.id, moved);
        }
      if (changes.size) void run(() => commit(changes, current.kind === "move" ? "Move shapes" : current.kind === "rotate" ? "Rotate shapes" : "Resize shapes",
        current.kind === "move" ? current.ids : [...current.originals.keys()], edgeChanges));
    } else if (current.kind === "connect") {
      const end = endAt(event, worldPoint(event), current.from.id);
      const length = Math.hypot(end.point.x - current.from.point.x, end.point.y - current.from.point.y) * camera().zoom;
      if (end.id !== null || length > 6) {
        setConnectMode(false);
        void run(() => addEdge(current.from, end));
      }
    } else if (current.kind === "reattach" || current.kind === "bend" || current.kind === "edge-move") {
      const change = edgeDraft().get(current.edgeId);
      const moved = current.kind === "reattach" || current.moved;
      if (change && moved) editEdge(current.edgeId, change, current.kind === "reattach" ? "Reconnect connector" : current.kind === "bend" ? "Reroute connector" : "Move connector");
      else setEdgeDraft(new Map());
    }
  };

  const addFromLibrary = (kind: ShapeKind) => void run(() => addShape(kind, toWorld(camera(), center())));
  // A connector kind picked in the library: new connectors are drawn with it, and the selected ones become it (one
  // undo step).
  const pickConnector = (preset: Preset) => {
    setPenId(preset.id);
    writeJson(penKey, preset.id);
    const changes = new Map(selectedEdges().map((id) => {
      const edge = edgesLive.value.find((item) => item.id === id);
      return [id, { startArrow: preset.start, endArrow: preset.end, style: { ...(edge?.style ?? defaultEdgeStyle()), dash: preset.dash } }] as const;
    }));
    if (changes.size) void run(() => commit(new Map(), `Make ${changes.size === 1 ? "it" : "them"} ${preset.label.toLowerCase()}`, [], new Map(changes)));
  };
  // Dropped from the library: a free connector of that kind, selected, its ends to be put on shapes.
  const dropConnector = (preset: Preset, at: Point) => void run(async () => {
    const pageIdValue = pageId();
    if (pageIdValue === null) return;
    const ids = await addEdges(ctx.api, pageIdValue, [{
      from_id: null, from_port: "c", from_x: at.x - 60, from_y: at.y, to_id: null, to_port: "c", to_x: at.x + 60, to_y: at.y,
      kind: "straight", start_arrow: preset.start, end_arrow: preset.end, style: { ...defaultEdgeStyle(), dash: preset.dash },
    }]);
    await edgesLive.refresh();
    ctx.history.push({
      label: `Add ${preset.label.toLowerCase()}`, icon: "forward",
      undo: () => removeEdges(ctx.api, ids), redo: () => restoreEdges(ctx.api, ids),
    });
    setSelected([]);
    setSelectedEdge(ids[0]);
  });
  const library = () => libraryItems(query());
  // The library's sections folded shut on this device (all open at first).
  const [closedSections, setClosedSections] = createSignal(readJson<string[]>(sectionsKey, []));
  const toggleSection = (id: string) => {
    const closed = closedSections().includes(id) ? closedSections().filter((item) => item !== id) : [...closedSections(), id];
    setClosedSections(closed);
    writeJson(sectionsKey, closed);
  };
  // One library item: a shape is added (click) or dropped (drag); a connector kind becomes the pen and changes the
  // selected connectors (click), or is dropped as a free connector (drag).
  const LibraryButton = (props: { item: LibraryItem }) => {
    const item = props.item;
    const active = () => item.type === "connector" && item.preset.id === pen().id;
    const title = item.type === "connector"
      ? `${item.label}: ${item.description}. Click to draw new connectors as this and change the selected ones; drag onto the canvas to add one.`
      : item.kind === "icon" ? "Search icons" : `${item.label}: ${item.description}. Click to add, or drag onto the canvas.`;
    return (
      <button class="diagram-library-item mw-box" classList={{ active: active() }} disabled={!canEdit()}
        aria-pressed={item.type === "connector" ? active() : undefined}
        draggable={canEdit() && !(item.type === "shape" && item.kind === "icon")} title={title}
        onClick={() => item.type === "connector" ? pickConnector(item.preset) : item.kind === "icon" ? openIcons() : addFromLibrary(item.kind)}
        onDragStart={(event) => {
          if (item.type === "shape" && item.kind === "icon") { event.preventDefault(); return; }
          event.dataTransfer?.setData(item.type === "connector" ? connectorDragType : dragType, item.type === "connector" ? item.preset.id : item.kind);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
        }}>
        <Icon name={item.icon} />
        <span class="diagram-library-text">{item.label}</span>
      </button>
    );
  };
  const pageOptions = () => pages.value.map((item) => ({ value: item.id, label: item.name }));
  const saveText = (shape: DiagramShape, value: string) => {
    const text = textSafe(value);
    setEditing(null);
    if (text !== shape.text) void run(() => commit(new Map([[shape.id, { text }]]), "Edit text"));
  };
  const updateStyle = (shape: DiagramShape, change: Partial<DiagramShape["style"]>) =>
    void run(() => commit(new Map([[shape.id, { style: {
      ...shape.style, ...change, ...(shape.kind === "icon" ? { tintIcons: true } : {}),
    } }]]), "Change shape style"));
  const alignSelected = (how: Align) => {
    const targets = selectedShapes();
    if (targets.length < 2) return;
    const target = shapeBounds(targets);
    const changes = new Map<number, ShapeChange>();
    for (const shape of targets) {
      const offset = alignShift({ left: shape.x, top: shape.y, right: shape.x + shape.w, bottom: shape.y + shape.h }, target, how);
      if (offset.x || offset.y) changes.set(shape.id, { x: shape.x + offset.x, y: shape.y + offset.y });
    }
    void run(() => commit(changes, `Align ${how}`));
  };
  const distribute = (axis: "x" | "y") => {
    const shifts = distributeShifts(selectedShapes().map((shape) => ({
      id: shape.id, rect: { left: shape.x, top: shape.y, right: shape.x + shape.w, bottom: shape.y + shape.h },
    })), axis);
    const changes = new Map<number, ShapeChange>();
    for (const [id, delta] of shifts) {
      const shape = byId().get(id)!;
      changes.set(id, axis === "x" ? { x: shape.x + delta } : { y: shape.y + delta });
    }
    void run(() => commit(changes, axis === "x" ? "Distribute horizontally" : "Distribute vertically"));
  };
  // Shapes with what is in them, the connectors on them or in them, and `lines` (selected connectors).
  const deleteShapes = (ids: number[], lines: number[] = []) => void run(async () => {
    const oldEdges = [...new Set([...lines, ...edges().filter((edge) => touches(edge, ids)).map((edge) => edge.id)])];
    const remove = async () => {
      if (ids.length) await removeShapes(ctx.api, ids);
      if (oldEdges.length) await removeEdges(ctx.api, oldEdges);
    };
    await remove();
    ctx.history.push({
      label: ids.length ? "Delete shapes" : "Delete connectors", icon: "delete",
      undo: async () => {
        if (ids.length) await restoreShapes(ctx.api, ids);
        if (oldEdges.length) await restoreEdges(ctx.api, oldEdges);
      },
      redo: remove,
    });
    setSelected([]);
    setSelectedEdges([]);
  });
  const deleteSelection = () => deleteShapes(shapeRoots(selected()).flatMap((id) => [id, ...descendants(id)]), selectedEdges());
  // The selected shapes and connectors become one group (with the connectors between its shapes).
  const groupSelection = () => void run(async () => {
    const pageIdValue = pageId();
    const roots = shapeRoots(selected()).flatMap((id) => byId().get(id) ?? []);
    if (!canEdit() || pageIdValue === null) return;
    const members = new Set(roots.flatMap((shape) => [shape.id, ...descendants(shape.id)]));
    const lines = new Set(selectedEdges());
    for (const edge of edges())
      if (edge.parentId === null && edge.fromId !== null && edge.toId !== null && members.has(edge.fromId) && members.has(edge.toId)) lines.add(edge.id);
    const bounds = selectionBounds();
    if (roots.length + selectedEdges().length < 2 || !bounds) return;
    const parents = new Set(roots.map((shape) => shape.parentId));
    const parent = parents.size === 1 ? [...parents][0] : null;
    const [groupId] = await addShapes(ctx.api, pageIdValue, [{
      kind: "group", x: bounds.left, y: bounds.top, w: Math.max(1, bounds.right - bounds.left), h: Math.max(1, bounds.bottom - bounds.top),
      text: "", parent_id: parent,
    }]);
    const into = new Map(roots.map((shape) => [shape.id, { parentId: groupId }]));
    const back = new Map(roots.map((shape) => [shape.id, { parentId: shape.parentId }]));
    const linesInto = new Map([...lines].map((id) => [id, { parentId: groupId }]));
    const linesBack = new Map([...lines].map((id) => [id, { parentId: edgesLive.value.find((edge) => edge.id === id)?.parentId ?? null }]));
    const apply = async (shapes: Map<number, ShapeChange>, connectors: Map<number, Partial<DiagramEdge>>) => {
      if (shapes.size) await updateShapes(ctx.api, shapes);
      if (connectors.size) await updateEdges(ctx.api, connectors);
    };
    await apply(into, linesInto);
    await Promise.all([shapesLive.refresh(), edgesLive.refresh()]);
    ctx.history.push({
      label: "Group", icon: "diagram-container",
      undo: async () => { await apply(back, linesBack); await removeShapes(ctx.api, [groupId]); },
      redo: async () => { await restoreShapes(ctx.api, [groupId]); await apply(into, linesInto); },
    });
    setSelected([groupId]);
    setSelectedEdges([]);
  });
  const ungroup = (group: DiagramShape) => void run(async () => {
    const children = allShapes().filter((shape) => shape.parentId === group.id).map((shape) => shape.id);
    const lines = edgesLive.value.filter((edge) => edge.parentId === group.id).map((edge) => edge.id);
    const outer = group.parentId !== null && byId().get(group.parentId)?.kind === "group" ? group.parentId : null;
    const apply = async (shapeParent: number | null, lineParent: number | null) => {
      if (children.length) await updateShapes(ctx.api, new Map(children.map((id) => [id, { parentId: shapeParent }])));
      if (lines.length) await updateEdges(ctx.api, new Map(lines.map((id) => [id, { parentId: lineParent }])));
    };
    await apply(group.parentId, outer);
    await removeShapes(ctx.api, [group.id]);
    await Promise.all([shapesLive.refresh(), edgesLive.refresh()]);
    ctx.history.push({
      label: "Ungroup", icon: "diagram-container",
      undo: async () => { await restoreShapes(ctx.api, [group.id]); await apply(group.id, group.id); },
      redo: async () => { await apply(group.parentId, outer); await removeShapes(ctx.api, [group.id]); },
    });
    setSelected(children);
    setSelectedEdges(lines);
  });
  const deleteEdge = (id: number) => void run(async () => {
    await removeEdges(ctx.api, [id]);
    ctx.history.push({ label: "Delete connector", icon: "delete", undo: () => restoreEdges(ctx.api, [id]), redo: () => removeEdges(ctx.api, [id]) });
    setSelectedEdge(null);
  });
  // The selection (or the whole page) with each export setting: one file saves as it is, several as a .zip.
  // What the Export section is about: one selected object, or the page when nothing is selected. Its settings are
  // saved on it, and with any set an object is offered as a live export (docs can embed it).
  const exportTarget = createMemo(() => {
    const shapes = selectedShapes();
    const current = page();
    if (shapes.length === 1 && selectedEdges().length === 0) return { shape: shapes[0], name: shapeName(shapes[0]), settings: shapes[0].exports };
    if (shapes.length === 0 && selectedEdges().length === 0 && current) return { page: current, name: current.name, settings: current.exports };
    return undefined;
  });
  const changeExports = (list: ExportSetting[], label: string) => {
    const target = exportTarget();
    const exports = JSON.parse(JSON.stringify(list)) as ExportSetting[];
    if (target?.shape) void run(() => commit(new Map([[target.shape.id, { exports }]]), label));
    else if (target?.page) {
      const id = target.page.id;
      const previous = JSON.parse(JSON.stringify(target.page.exports)) as ExportSetting[];
      void run(async () => {
        await updatePage(ctx.api, id, { exports });
        ctx.history.push({
          label, icon: "download",
          undo: () => updatePage(ctx.api, id, { exports: previous }), redo: () => updatePage(ctx.api, id, { exports }),
        });
      });
    }
  };
  const exportNow = async () => {
    const target = exportTarget();
    const current = page();
    if (!target || !current) return;
    const { svg, width, height } = renderDiagram(current, allShapes(), edges(), target.shape ? [target.shape.id] : undefined, rowsLive.value);
    const files = await Promise.all(target.settings.map((setting) => svgFile(svg, width, height, target.name, setting)));
    await saveExports(files, target.name);
  };
  const exportDrawio = () => {
    const current = page();
    if (!current) return;
    const shapes = allShapes().filter((shape) => shape.kind !== "group").map((shape) => ({
      ref: String(shape.id), kind: shape.kind, x: shape.x, y: shape.y, w: shape.w, h: shape.h,
      rotation: shape.rotation, text: shape.text, style: shape.style,
    }));
    const edgeRows = edges().map((edge) => ({
      from: String(edge.fromId ?? ""), to: String(edge.toId ?? ""), kind: edge.kind,
      ...(edge.fromId === null ? { fromPoint: edge.fromPoint } : {}), ...(edge.toId === null ? { toPoint: edge.toPoint } : {}),
      startArrow: edge.startArrow, endArrow: edge.endArrow, label: edge.label, startLabel: edge.startLabel, endLabel: edge.endLabel,
      style: edge.style,
    }));
    saveBlob(new Blob([encodeDrawio(shapes, edgeRows, current.name)], { type: "application/xml" }), `${current.name.replace(/[/\\:*?"<>|]/g, "_")}.drawio`);
  };
  const importFile = async (file: File) => run(async () => {
    const currentId = pageId();
    if (currentId === null) return;
    const parsed = importDrawio(await file.text());
    if (!parsed.shapes.length) throw new Error("The .drawio file has no supported shapes.");
    const newShapes: NewShape[] = parsed.shapes.map((shape) => ({
      ref: shape.ref, kind: shape.kind, x: shape.x, y: shape.y, w: shape.w, h: shape.h,
      rotation: shape.rotation, text: shape.text, style: shape.style,
    }));
    const created = await addShapes(ctx.api, currentId, newShapes);
    const idByRef = new Map(parsed.shapes.map((shape, index) => [shape.ref, created[index]]));
    let edgeIds: number[] = [];
    try {
      const newEdges: NewEdge[] = parsed.edges.flatMap((edge) => {
        const from = idByRef.get(edge.from);
        const to = idByRef.get(edge.to);
        if (from === undefined || to === undefined) return [];
        return [{
          from_id: from, from_port: "e", to_id: to, to_port: "w", kind: edge.kind,
          start_arrow: edge.startArrow, end_arrow: edge.endArrow, label: edge.label, start_label: edge.startLabel,
          end_label: edge.endLabel, style: edge.style,
        }];
      });
      if (newEdges.length) edgeIds = await addEdges(ctx.api, currentId, newEdges);
    } catch (e) {
      await removeShapes(ctx.api, created);
      throw e;
    }
    ctx.history.push({
      label: `Import ${file.name}`, icon: "add",
      undo: async () => {
        if (edgeIds.length) await removeEdges(ctx.api, edgeIds);
        await removeShapes(ctx.api, created);
      },
      redo: async () => { await restoreShapes(ctx.api, created); if (edgeIds.length) await restoreEdges(ctx.api, edgeIds); },
    });
    setSelected(created);
  });

  const openIcons = () => ctx.toggleSidePanel("diagram-icons", "Icons", solidMount(() => (
    <IconSearch canEdit={canEdit()} onInsert={(name) => void addIcon(name)} />
  )));
  const exportFileInput = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) void importFile(file);
  };

  const keyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, [contenteditable=true]")) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      void ctx.history.undo().catch((e) => setError(userMessage(e)));
    } else if (event.key === "Delete" || event.key === "Backspace") {
      if (selected().length || selectedEdges().length) {
        event.preventDefault();
        deleteSelection();
      }
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "g") {
      event.preventDefault();
      const [only] = selectedShapes();
      if (event.shiftKey) {
        if (only?.kind === "group" && selected().length === 1) ungroup(only);
      } else groupSelection();
    } else if (event.key === " ") {
      setSpace(true);
      event.preventDefault();
    } else if (event.key === "+" || event.key === "=") zoomTo(camera().zoom * 1.25);
    else if (event.key === "-") zoomTo(camera().zoom / 1.25);
    else if (event.shiftKey && event.code === "Digit1") fit();
    else if (event.key === "Escape") {
      setSelected([]);
      setSelectedEdge(null);
      setEditing(null);
      setConnectMode(false);
    }
  };

  onMount(() => {
    const resize = new ResizeObserver(() => setBoardSize({ width: board.clientWidth, height: board.clientHeight }));
    resize.observe(board);
    const up = (event: KeyboardEvent) => { if (event.key === " ") setSpace(false); };
    window.addEventListener("keyup", up);
    onCleanup(() => {
      resize.disconnect();
      window.removeEventListener("keyup", up);
    });
  });
  createEffect(() => {
    const target = ctx.target();
    if (target?.kind !== "shape" || !shapesLive.loaded) return;
    const id = Number(target.id);
    if (byId().has(id)) setSelected([id]);
  });

  return (
    <div class="view diagram" role="presentation" onKeyDown={keyDown}>
      <header class="view-header">
        <div class="view-tools mw-box">
          {/* Renaming turns the page picker into its name field in place: Enter, clicking away or the button again
              saves (the field's blur), Escape cancels. */}
          <Show when={renaming()} fallback={<Select label="Diagram page" value={pageId()} options={pageOptions()} onChange={setPageId} />}>
            <input ref={(el) => { pageNameInput = el; focusWhenShown(el); }} class="mw-input mw-box diagram-page-name" value={page()?.name ?? ""} maxLength={100} aria-label="Page name"
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setRenaming(false);
                }
              }}
              onBlur={(e) => {
                if (!renaming()) return;
                setRenaming(false);
                const name = e.currentTarget.value.trim();
                const current = page();
                if (name && current && name !== current.name) void run(() => updatePage(ctx.api, current.id, { name }));
              }} />
          </Show>
          <button class="icon-button" title="Add page" aria-label="Add page" disabled={!canEdit()} onClick={() => void run(async () => {
            const { id } = await addPage(ctx.api, ctx.channel.id, `Page ${pages.value.length + 1}`);
            setPageId(id);
          })}><Icon name="add" /></button>
          <button class="icon-button" classList={{ on: renaming() }} title="Rename page" aria-label="Rename page" aria-pressed={renaming()}
            disabled={!canEdit() || !page()} onMouseDown={(e) => renaming() && e.preventDefault()}
            onClick={() => (renaming() ? pageNameInput?.blur() : setRenaming(true))}><Icon name="rename" /></button>
        </div>
        <div class="view-tools mw-box">
          <button class="icon-button" title="Import .drawio" aria-label="Import .drawio" disabled={!canEdit()} onClick={() => importPicker.click()}><Icon name="upload" /></button>
          <input ref={importPicker} id="diagram-import" type="file" accept=".drawio,.xml" hidden onChange={exportFileInput} />
          <button class="icon-button" title="Export .drawio" aria-label="Export .drawio" disabled={!page()} onClick={exportDrawio}><Icon name="download" /></button>
          <button class="icon-button" classList={{ on: connectMode() }} title={connectMode() ? "Cancel connector" : "Draw a connector: drag from a shape or from empty space"}
            aria-label={connectMode() ? "Cancel connector" : "Draw a connector"} aria-pressed={connectMode()} disabled={!canEdit()}
            onClick={() => setConnectMode((value) => !value)}>
            <Icon name="forward" />
          </button>
          <button class="icon-button" classList={{ on: ctx.isSidePanelOpen("diagram-icons") }} title="Search icons" aria-label="Search icons"
            aria-expanded={ctx.isSidePanelOpen("diagram-icons")} onClick={openIcons}><Icon name="icons" /></button>
        </div>
        <div class="view-tools view-history mw-box">
          <HistoryControls history={ctx.history} onError={(e) => setError(userMessage(e))} />
        </div>
        <Show when={!narrow()}>
          <div class="view-tools mw-box">
            <button class="icon-button" classList={{ on: propertiesPinned() }} title="Page properties and export" aria-label="Page properties and export" aria-expanded={propertiesPinned()}
              onClick={togglePropertiesPinned}><Icon name="settings" /></button>
          </div>
        </Show>
        <Show when={narrow()}>
          <div class="view-tools mw-box">
            <PaneButton panes={panes} pane="library" icon="diagram-note" label="Pages and shapes" />
            <PaneButton panes={panes} pane="properties" icon="settings" label="Properties" />
          </div>
        </Show>
      </header>
      <Collapse open={!!error()}><p class="view-error">{error()}</p></Collapse>
      <div class="diagram-body">
        <div class="diagram-side" classList={panes.classes("library", "left")} style={{ width: panelWidth("diagram.library") ? `${panelWidth("diagram.library")}px` : undefined }}>
        <aside class="diagram-library mw-scroll-fade" aria-label="Shapes and connectors">
          <label class="diagram-search mw-box"><Icon name="search" /><input value={query()} aria-label="Search shapes and connectors" placeholder="Search..." onInput={(e) => setQuery(e.currentTarget.value)} /></label>
          <div class="diagram-library-items">
            <For each={library()}>
              {(section) => {
                // Open while searching, so what was found shows.
                const open = () => !!query().trim() || !closedSections().includes(section.id);
                return (
                  <section class="diagram-library-section" aria-label={section.title}>
                    <Disclosure class="diagram-library-title" open={open()} onToggle={() => toggleSection(section.id)}>
                      <Icon name={section.icon} /> {section.title}
                    </Disclosure>
                    <Collapse open={open()}>
                      <div class="diagram-library-section-items">
                        <For each={section.items}>{(item) => <LibraryButton item={item} />}</For>
                      </div>
                    </Collapse>
                  </section>
                );
              }}
            </For>
            <Show when={library().length === 0}><p class="hint">Nothing matches.</p></Show>
          </div>
        </aside>
        <ResizeHandle edge="right" label="Resize shape library"
          setWidth={(width) => setPanelWidth("diagram.library", width)}
          save={() => savePanelWidth("diagram.library")} />
        </div>
        <main class="diagram-stage">
          <ZoomBar zoom={camera().zoom} onZoomOut={() => zoomTo(camera().zoom / 1.25)} onZoomIn={() => zoomTo(camera().zoom * 1.25)}
            onActual={() => zoomTo(1)} onFit={() => fit()} fitLabel="Fit diagram" />
          <div ref={board} class="diagram-board" role="application" tabIndex={0} aria-label="Diagram canvas"
            classList={{ panning: space(), dragging: activeGesture()?.kind === "pan", "connect-mode": connectMode() }}
            style={{ "background-color": page()?.background || undefined, "--diagram-grid": page()?.grid ? "1" : "0" }}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
            onPointerLeave={() => { setHovered(null); ctx.cursors.move(null); }}
            onWheel={(event) => {
              event.preventDefault();
              if (event.ctrlKey || event.metaKey) {
                const rect = board.getBoundingClientRect();
                const local = { x: event.clientX - rect.left, y: event.clientY - rect.top };
                setCamera(zoomAt(camera(), local, camera().zoom * Math.exp(-Math.max(-0.5, Math.min(0.5, event.deltaY * 0.01)))));
              } else setCamera({ ...camera(), x: camera().x - event.deltaX, y: camera().y - event.deltaY });
            }}
            onDragOver={(event) => {
              const types = event.dataTransfer?.types ?? [];
              if ((types.includes(dragType) || types.includes(iconDragType) || types.includes(connectorDragType)) && canEdit()) event.preventDefault();
            }}
            onDrop={(event) => {
              const kind = event.dataTransfer?.getData(dragType);
              const icon = event.dataTransfer?.getData(iconDragType);
              const connector = presets.find((item) => item.id === event.dataTransfer?.getData(connectorDragType));
              if (connector && canEdit()) {
                event.preventDefault();
                dropConnector(connector, worldPoint(event));
              } else if (icon && canEdit()) {
                event.preventDefault();
                void addIcon(icon, worldPoint(event));
              } else if (kind && shapeKinds.some((item) => item.kind === kind)) {
                event.preventDefault();
                void run(() => addShape(kind as ShapeKind, worldPoint(event)));
              }
            }}>
            <Show when={page()} fallback={<div class="diagram-empty">{pages.loaded ? "Create a page to start diagramming." : "Opening diagram..."}</div>}>
                <div class="diagram-world" data-page={page()!.id} style={{ transform: `translate(${camera().x}px, ${camera().y}px) scale(${camera().zoom})` }}>
                  <svg class="diagram-wires" aria-label="Connectors" width={boardSize().width} height={boardSize().height}
                    viewBox={`0 0 ${boardSize().width} ${boardSize().height}`}>
                    <For each={edgesLive.value}>
                      {(raw) => (
                        <Show when={geometries().get(raw.id)}>
                          {(item) => {
                            const marker = `diagram-end-${raw.id}`;
                            const color = () => selectedEdges().includes(raw.id) ? "var(--mw-accent)" : item().edge.style.stroke;
                            // Hollow heads take the page's color, so the line doesn't show through them.
                            const paper = () => page()?.background || "var(--mw-darker)";
                            const end = (side: "start" | "end") => side === "start" ? item().edge.startArrow : item().edge.endArrow;
                            const endPoint = (side: "start" | "end") => endLabelPoint(item().geometry, side);
                            return <>
                              <EndMarker id={`${marker}-start`} name={end("start")} color={color()} background={paper()} strokeWidth={item().edge.style.strokeWidth} />
                              <EndMarker id={`${marker}-end`} name={end("end")} color={color()} background={paper()} strokeWidth={item().edge.style.strokeWidth} />
                              <path class="diagram-edge-hit" data-edge={raw.id} d={item().geometry.d} fill="none" stroke="transparent"
                                onDblClick={(event) => {
                                  // Near an end: that end's label (a multiplicity, a role) to type in.
                                  const at = worldPoint(event);
                                  const points = item().geometry.points;
                                  const away = (point: Point) => Math.hypot(point.x - at.x, point.y - at.y);
                                  const side = away(points[0]) <= away(points.at(-1)!) ? "start" : "end";
                                  if (Math.min(away(points[0]), away(points.at(-1)!)) > 40 / camera().zoom) return;
                                  setSelectedEdge(raw.id);
                                  requestAnimationFrame(() => document.getElementById(`diagram-${side}-label-${raw.id}`)?.focus());
                                }}
                                stroke-width={Math.max(12, item().edge.style.strokeWidth + 8)} />
                              <path class="diagram-edge-visible" classList={{ selected: selectedEdges().includes(raw.id) }} d={item().geometry.d} fill="none"
                                style={{ stroke: color() }} stroke-width={item().edge.style.strokeWidth}
                                stroke-dasharray={item().edge.style.dash ? "6 4" : undefined}
                                marker-start={end("start") ? `url(#${marker}-start)` : undefined}
                                marker-end={end("end") ? `url(#${marker}-end)` : undefined} />
                              <Show when={item().edge.label}>
                                <text class="diagram-edge-label" x={item().geometry.handle.at.x} y={item().geometry.handle.at.y - 6}>{item().edge.label}</text>
                              </Show>
                              <Show when={item().edge.startLabel}>
                                <text class="diagram-edge-label end" x={endPoint("start").x} y={endPoint("start").y}>{item().edge.startLabel}</text>
                              </Show>
                              <Show when={item().edge.endLabel}>
                                <text class="diagram-edge-label end" x={endPoint("end").x} y={endPoint("end").y}>{item().edge.endLabel}</text>
                              </Show>
                            </>;
                          }}
                        </Show>
                      )}
                    </For>
                    <Show when={connectPreview()}>
                      {(d) => <path class="diagram-preview-wire" d={d()} />}
                    </Show>
                  </svg>
                  <For each={shapesLive.value.filter((shape) => shape.kind !== "group").sort((a, b) => a.z - b.z || a.id - b.id)}>
                    {(shape) => (
                      <div class="diagram-shape" data-shape={shape.id}
                        classList={{
                          selected: selected().includes(shape.id), hovered: hovered() === shape.id,
                          editing: editing() === shape.id, structured: isStructured((byId().get(shape.id) ?? shape).kind),
                        }}
                        style={{
                          left: `${byId().get(shape.id)?.x ?? shape.x}px`,
                          top: `${byId().get(shape.id)?.y ?? shape.y}px`,
                          width: `${byId().get(shape.id)?.w ?? shape.w}px`, height: `${byId().get(shape.id)?.h ?? shape.h}px`,
                          transform: `rotate(${byId().get(shape.id)?.rotation ?? shape.rotation}deg)`,
                          "--shape-fill": byId().get(shape.id)?.style.fill ?? shape.style.fill,
                          "--shape-stroke": byId().get(shape.id)?.style.stroke ?? shape.style.stroke,
                          "--shape-stroke-width": `${byId().get(shape.id)?.style.strokeWidth ?? shape.style.strokeWidth}px`,
                          "--shape-text-color": byId().get(shape.id)?.style.textColor ?? shape.style.textColor,
                          "--shape-font-size": `${byId().get(shape.id)?.style.fontSize ?? shape.style.fontSize}px`,
                        }}
                        onDblClick={(event) => {
                          event.stopPropagation();
                          if (!canEdit()) return;
                          setSelected([shape.id]);
                          const current = byId().get(shape.id) ?? shape;
                          if (isStructured(current.kind)) editStructured(current, worldPoint(event));
                          else setEditing(shape.id);
                        }}>
                        <svg class="diagram-shape-svg" viewBox={`0 0 ${byId().get(shape.id)?.w ?? shape.w} ${byId().get(shape.id)?.h ?? shape.h}`} preserveAspectRatio="none" aria-hidden="true"
                          innerHTML={shapeSvgMarkup(byId().get(shape.id) ?? shape, shapeRows(shape.id))} />
                        {/* Keyed: each row typed in gets an input of its own. */}
                        <Show when={rowEdit()?.shapeId === shape.id ? rowEdit() : null} keyed>
                          {(edit) => (
                            <RowInput shape={byId().get(shape.id) ?? shape} rows={shapeRows(shape.id)} edit={edit}
                              onSave={(text, next) => finishRow(byId().get(shape.id) ?? shape, edit, text, next)}
                              onCancel={() => setRowEdit(null)} onRemove={() => dropRow(byId().get(shape.id) ?? shape, edit)} />
                          )}
                        </Show>
                        <Show when={(byId().get(shape.id) ?? shape).kind === "icon" && (byId().get(shape.id) ?? shape).style.svg}>
                          {(svg) => {
                            const current = () => byId().get(shape.id) ?? shape;
                            const recolored = () => !coloredIcon(current().style.icon ?? "") || current().style.tintIcons === true;
                            return <img class="diagram-shape-icon" src={escapedSvg(recolored()
                              ? recolorIconSvg(svg(), current().style, current().style.tintIcons === true)
                              : svg())} alt="" draggable={false} />;
                          }}
                        </Show>
                        <Show when={editing() === shape.id} fallback={<span class="diagram-shape-text">{byId().get(shape.id)?.text ?? shape.text}</span>}>
                          <textarea class="diagram-text-input" aria-label="Shape text" value={byId().get(shape.id)?.text ?? shape.text} ref={focusWhenShown}
                            onInput={(event) => {
                              const text = event.currentTarget.value;
                              setPreview(new Map([[shape.id, { text }]]));
                            }}
                            onBlur={(event) => {
                              const text = event.currentTarget.value;
                              setPreview(new Map());
                              saveText(byId().get(shape.id) ?? shape, text);
                            }}
                            onKeyDown={(event) => {
                              event.stopPropagation();
                              if (event.key === "Escape" || (event.key === "Enter" && (event.ctrlKey || event.metaKey))) event.currentTarget.blur();
                            }} />
                        </Show>
                        <Show when={canEdit() && (selected().includes(shape.id) || hovered() === shape.id) && editing() === null}>
                          <For each={ports}>
                            {(port) => <button class={`diagram-port ${port}`} data-port={port} title={`Connect from ${port} port`} aria-label={`Connect from ${port} port`} />}
                          </For>
                        </Show>
                        <Show when={canEdit() && selected().includes(shape.id) && editing() === null}>
                          <For each={["n", "e", "s", "w"] as const}>
                            {(direction) => <button class={`diagram-quick ${direction}`}
                              title={`Add connected ${labelFor(shape.kind).toLowerCase()} ${direction === "e" ? "to the right" : direction === "w" ? "to the left" : direction === "s" ? "below" : "above"}`}
                              aria-label={`Add connected shape ${direction}`}
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={() => void addQuick(byId().get(shape.id) ?? shape, direction)}>+</button>}
                          </For>
                        </Show>
                      </div>
                    )}
                  </For>
                  <Show when={band()}>
                    {(marquee) => <div class="diagram-band" style={{
                      left: `${Math.min(marquee().from.x, marquee().to.x)}px`,
                      top: `${Math.min(marquee().from.y, marquee().to.y)}px`,
                      width: `${Math.abs(marquee().to.x - marquee().from.x)}px`,
                      height: `${Math.abs(marquee().to.y - marquee().from.y)}px`,
                    }} />}
                  </Show>
                </div>
                <div class="diagram-overlay">
                  <Show when={connectMode()}>
                    <div class="diagram-connect-hint mw-fade-in">Drag from a shape or from empty space to draw a connector.</div>
                  </Show>
                  <RemoteCursors others={ctx.cursors.others} user={ctx.users.get} toScreen={screenPoint} />
                  <Show when={canEdit() ? selectedEdgeView() : undefined}>
                    {(view) => {
                      const at = (p: () => Point) => {
                        const screen = () => screenPoint(p());
                        return { left: `${screen().x}px`, top: `${screen().y}px` };
                      };
                      return <>
                        <button class="diagram-edge-handle" data-edge-end="from" style={at(() => view().geometry.points[0])}
                          title="Drag onto a shape to connect, or anywhere to leave it free" aria-label="Move connector start" />
                        <button class="diagram-edge-handle" data-edge-end="to" style={at(() => view().geometry.points.at(-1)!)}
                          title="Drag onto a shape to connect, or anywhere to leave it free" aria-label="Move connector end" />
                        <button class="diagram-edge-bend" data-edge-bend classList={{ x: view().geometry.handle.axis === "x", y: view().geometry.handle.axis === "y" }}
                          style={at(() => view().geometry.handle.at)} title="Drag to bend the connector, double-click to straighten it"
                          aria-label="Bend connector" onDblClick={() => editEdge(view().edge.id, { points: [] }, "Straighten connector")} />
                      </>;
                    }}
                  </Show>
                  <Show when={canEdit() && editing() === null && selectionFrame()}>
                    {(frame) => <SelectionHandles class="diagram-resize" style={frame().style} rotate size={frame().size} />}
                  </Show>
                </div>
            </Show>
          </div>
        </main>
        <div class="diagram-side" classList={{ ...panes.classes("properties", "right"), "diagram-side-closed": !showProperties() }} style={{ width: panelWidth("diagram.properties") ? `${panelWidth("diagram.properties")}px` : undefined }}>
        <aside class="diagram-properties">
          <Show when={selectedEdgeView()?.edge}>
            {(edge) => <>
              <h3>Connector</h3>
              <label class="diagram-property">Route
                <Select label="Connector route" value={edge().kind}
                  options={[
                    { value: "straight", label: "Straight" },
                    { value: "orthogonal", label: "Orthogonal" },
                    { value: "curved", label: "Curved" },
                  ]}
                  disabled={!canEdit()} onChange={(kind) => editEdge(edge().id, { kind, points: [] })} />
              </label>
              <Show when={edge().points.length > 0}>
                <button class="mw-button mw-box" disabled={!canEdit()} onClick={() => editEdge(edge().id, { points: [] }, "Straighten connector")}>
                  <Icon name="undo" /> Reset route
                </button>
              </Show>
              <div class="diagram-property">Line color
                <ColorPicker class="mw-input mw-box" label="Line color"
                  value={edge().style.stroke.startsWith("#") ? edge().style.stroke : "#666666"}
                  disabled={!canEdit()} onPick={(color) => editEdge(edge().id, { style: { ...edge().style, stroke: color } })} />
              </div>
              <label class="diagram-property">Line width<input class="mw-input mw-box" type="number" min="0.5" max="32" step="0.5"
                value={edge().style.strokeWidth} disabled={!canEdit()}
                onChange={(event) => editEdge(edge().id, { style: { ...edge().style, strokeWidth: Math.max(0.5, Math.min(32, numeric(event.currentTarget.value, edge().style.strokeWidth))) } })} /></label>
              <label class="diagram-grid-toggle"><input type="checkbox" checked={edge().style.dash} disabled={!canEdit()}
                onChange={(event) => editEdge(edge().id, { style: { ...edge().style, dash: event.currentTarget.checked } })} /> Dashed line</label>
              <label class="diagram-property">Label<input class="mw-input mw-box" value={edge().label} disabled={!canEdit()}
                onChange={(event) => editEdge(edge().id, { label: event.currentTarget.value }, "Edit connector label")} /></label>
              <div class="diagram-edge-arrows">
                <label class="diagram-property">Start
                  <Select label="Start head" value={edge().startArrow || "none"} options={headOptions} search
                    disabled={!canEdit()} onChange={(value) => editEdge(edge().id, { startArrow: value === "none" ? "" : value })} />
                </label>
                <label class="diagram-property">End
                  <Select label="End head" value={edge().endArrow || "none"} options={headOptions} search
                    disabled={!canEdit()} onChange={(value) => editEdge(edge().id, { endArrow: value === "none" ? "" : value })} />
                </label>
                <label class="diagram-property">Start label<input id={`diagram-start-label-${edge().id}`} class="mw-input mw-box" value={edge().startLabel}
                  placeholder="1" disabled={!canEdit()} onChange={(event) => editEdge(edge().id, { startLabel: event.currentTarget.value }, "Edit connector label")} /></label>
                <label class="diagram-property">End label<input id={`diagram-end-label-${edge().id}`} class="mw-input mw-box" value={edge().endLabel}
                  placeholder="0..*" disabled={!canEdit()} onChange={(event) => editEdge(edge().id, { endLabel: event.currentTarget.value }, "Edit connector label")} /></label>
              </div>
              <button class="mw-button mw-box diagram-delete" disabled={!canEdit()} onClick={() => deleteEdge(edge().id)}>
                <Icon name="delete" /> Delete connector</button>
            </>}
          </Show>
          <Switch fallback={<Show when={selectedEdge() === null}><div class="diagram-inspector-empty">Select a shape or connector to edit its properties.</div></Show>}>
            <Match when={selectedShapes().length + selectedEdges().length > 1}>
              <h3>{selectedShapes().length + selectedEdges().length} objects selected</h3>
              <button class="mw-button mw-box diagram-group-button" disabled={!canEdit()} onClick={groupSelection}>
                <Icon name="diagram-container" /> Group (Ctrl+G)</button>
              <div class="diagram-align">
                <span>Align selection</span>
                <For each={["left", "h-center", "right", "top", "v-center", "bottom"] as Align[]}>
                  {(how) => <button class="icon-button" title={`Align ${how}`} aria-label={`Align ${how}`} disabled={!canEdit() || selectedShapes().length < 2}
                    onClick={() => alignSelected(how)}><Icon name={`align-${how}`} /></button>}
                </For>
                <button class="icon-button" title="Distribute horizontally" aria-label="Distribute horizontally" disabled={!canEdit() || selectedShapes().length < 3}
                  onClick={() => distribute("x")}><Icon name="distribute-h" /></button>
                <button class="icon-button" title="Distribute vertically" aria-label="Distribute vertically" disabled={!canEdit() || selectedShapes().length < 3}
                  onClick={() => distribute("y")}><Icon name="distribute-v" /></button>
              </div>
              <button class="mw-button mw-box diagram-delete" disabled={!canEdit()} onClick={deleteSelection}><Icon name="delete" /> Delete</button>
            </Match>
            <Match when={selectedShapes()[0]?.kind === "group" ? selectedShapes()[0] : undefined}>
              {(group) => <>
                <h3>Group</h3>
                <label class="diagram-property">Name<input class="mw-input mw-box" value={group().text} placeholder="Group" disabled={!canEdit()}
                  onChange={(event) => saveText(group(), event.currentTarget.value.trim())} /></label>
                <p class="hint">Click again to pick something inside it.</p>
                <button class="mw-button mw-box diagram-group-button" disabled={!canEdit()} onClick={() => ungroup(group())}>
                  <Icon name="diagram-container" /> Ungroup (Ctrl+Shift+G)</button>
                <button class="mw-button mw-box diagram-delete" disabled={!canEdit()} onClick={deleteSelection}><Icon name="delete" /> Delete</button>
              </>}
            </Match>
            <Match when={selectedShapes()[0]}>
              {(shape) => <>
              <h3>{labelFor(shape().kind)}</h3>
              <label class="diagram-property">{isStructured(shape().kind) ? "Name" : "Text"}<textarea class="mw-input mw-box" value={shape().text} disabled={!canEdit()}
                onChange={(event) => saveText(shape(), event.currentTarget.value)} /></label>
              <Show when={isStructured(shape().kind)}>
                <StructuredPanel shape={shape()} rows={shapeRows(shape().id)} disabled={!canEdit()}
                  onKind={(kind) => changeKind(shape(), kind)}
                  onText={(row, text) => void (text.trim() ? saveRow(shape(), { shapeId: shape().id, rowId: row.id, section: row.section }, text) : removeRow(shape(), row))}
                  onMark={(row, mark, on) => markRow(shape(), row, mark, on)} onMove={(row, by) => moveRow(shape(), row, by)}
                  onRemove={(row) => void removeRow(shape(), row)}
                  onAdd={(section: RowSection) => setRowEdit({ shapeId: shape().id, rowId: null, section, after: shapeRows(shape().id).filter((row) => row.section === section).sort((a, b) => a.z - b.z).at(-1)?.id })} />
              </Show>
              <div class="diagram-property">Fill
                <ColorPicker class="mw-input mw-box" label="Fill color"
                  value={shape().style.fill.startsWith("#") ? shape().style.fill : "#ffffff"}
                  disabled={!canEdit()} onPreview={(color) => updateStyle(shape(), { fill: color })}
                  onPick={(color) => updateStyle(shape(), { fill: color })} />
              </div>
              <div class="diagram-property">Line
                <ColorPicker class="mw-input mw-box" label="Line color"
                  value={shape().style.stroke.startsWith("#") ? shape().style.stroke : "#333333"}
                  disabled={!canEdit()} onPreview={(color) => updateStyle(shape(), { stroke: color })}
                  onPick={(color) => updateStyle(shape(), { stroke: color })} />
              </div>
              <label class="diagram-property">Font size<input class="mw-input mw-box" type="number" min="6" max="96" value={shape().style.fontSize}
                disabled={!canEdit()} onChange={(event) => updateStyle(shape(), { fontSize: numeric(event.currentTarget.value, shape().style.fontSize) })} /></label>
              <label class="diagram-property">Rotation<input class="mw-input mw-box" type="number" value={shape().rotation}
                disabled={!canEdit()} onChange={(event) => void run(() => commit(new Map([[shape().id, { rotation: numeric(event.currentTarget.value, shape().rotation) }]]), "Rotate shape"))} /></label>
              <button class="mw-button mw-box diagram-delete" disabled={!canEdit()} onClick={deleteSelection}><Icon name="delete" /> Delete</button>
              </>}
            </Match>
          </Switch>
          <section class="diagram-export">
            <div class="diagram-export-title">
              <h3>Export</h3>
              <Show when={exportTarget()}>
                <button class="icon-button" title="Add export" aria-label="Add export" disabled={!canEdit()}
                  onClick={() => changeExports([...exportTarget()!.settings, nextExport(exportTarget()!.settings)], "Add export")}><Icon name="add" /></button>
              </Show>
            </div>
            <Show when={exportTarget()} fallback={
              <p class="hint">{selectedShapes().length + selectedEdges().length > 1
                ? "Group the selection (Ctrl+G) to export it as one object." : "Connectors are exported with a group or the page."}</p>
            }>
              {(target) => <>
                <Show when={target().shape && target().settings.length > 0}>
                  <p class="hint">Docs can embed this {target().shape!.kind === "group" ? "group" : "shape"}: link it with # or Ctrl+K.</p>
                </Show>
                <ExportRows list={target().settings} disabled={!canEdit()} onChange={changeExports} />
                <ExportButton show={target().settings.length > 0} label={`Export ${target().name}`} onExport={() => run(exportNow)} />
              </>}
            </Show>
          </section>
          <Show when={page()}>
            {(current) => <div class="diagram-page-settings">
              <div class="diagram-page-setting-row">
                <span>Page background</span>
                <ColorPicker class="mw-input mw-box diagram-page-color" label="Page background color"
                  value={current().background || "#ffffff"} disabled={!canEdit()}
                  onPick={(color) => void run(() => updatePage(ctx.api, current().id, { background: color }))} />
              </div>
              <div class="diagram-page-setting-row">
                <label class="diagram-grid-toggle"><input type="checkbox" checked={current().grid} disabled={!canEdit()}
                  onChange={(event) => void run(() => updatePage(ctx.api, current().id, { grid: event.currentTarget.checked }))} /> Show grid</label>
                <button class="mw-button mw-box diagram-clear-background" disabled={!canEdit() || !current().background}
                  onClick={() => void run(() => updatePage(ctx.api, current().id, { background: "" }))}>Clear</button>
              </div>
            </div>}
          </Show>
        </aside>
        <ResizeHandle edge="left" label="Resize diagram properties"
          setWidth={(width) => setPanelWidth("diagram.properties", width)}
          save={() => savePanelWidth("diagram.properties")} />
        </div>
      </div>
      <Show when={!canEdit()}><p class="diagram-readonly">You can look but not edit: you need the "Edit content" permission.</p></Show>
    </div>
  );
}
