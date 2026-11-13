import { For, Index, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount, type JSX } from "solid-js";
import { iconDragType } from "./IconSearch";
import { contentUrl } from "../../../core/content";
import { motionMs } from "../../../ui/presence";
import RemoteCursors from "../../../ui/RemoteCursors";
import type { ChannelContext } from "../../types";
import { layers, type Editor, type Tool, type Viewport } from "./editor";
import { removeNodes, restoreNodes } from "./data";
import { mirroredProps } from "./actions";
import { resizeInside } from "./constraints";
import { fitViewport, toScreen as cameraToScreen, toWorld as cameraToWorld, zoomAt as cameraZoomAt } from "../canvas/camera";
import { guidesFor, snapShift, snapTargets, type Guide } from "../canvas/snap";
import { createPinch } from "../canvas/touch";
import SelectionHandles from "../canvas/SelectionHandles";
import { handleDir, resizeFlips, resizeLocal, type Handle } from "../canvas/geometry";
import "./../canvas/canvas.css";
import {
  apply, boxAt, boundsOf, cornersOf, cssColor, defaultProps, svgGradient, inkFor, invert, kindLabels, solid, stroke, localTransform, normalizeAngle,
  rotate, type Change, type DesignNode, type NodeKind, type Point, type Rect, type Resolve, type Rigid,
} from "./model";
import { backgroundBlurs, boxStyle, cornerStyle, effectFilter, fillStyle, measureText, strokePaths, textBoxStyle, textStyle, tintedSvg, vectorPath } from "./render";
import { fitPaths, mapPaths, pathData, scaledPaths, simplify, smoothThrough, type Anchor, type SubPath } from "./vector";

const snapPx = 6;
const dragPx = 3;


type Snapshot = Map<number, DesignNode>;
type Gesture =
  | { kind: "pan"; start: Point; from: Viewport }
  | { kind: "move"; start: Point; screen: Point; from: Snapshot; bounds: Rect; targets: Rect[]; moved: boolean }
  | { kind: "resize"; handle: Handle; from: Snapshot; inner: Snapshot; worlds: Map<number, Rigid>; bounds: Rect; targets: Rect[]; free?: boolean }
  | { kind: "line-end"; id: number; from: Snapshot; fixed: Point; end: "start" | "end" }
  | { kind: "rotate"; center: Point; startAngle: number; from: Snapshot; worlds: Map<number, Rigid> }
  | { kind: "marquee"; start: Point; base: number[]; container: number | null }
  | { kind: "draw"; tool: Tool; start: Point; parent: number | null; targets: Rect[] }
  | { kind: "pencil"; parent: number | null; points: Point[] }
  // Dragging out the handles of the point just placed, or of the first point when the drag closes the path.
  | { kind: "pen-handle"; index: number; start: Point; close?: boolean }
  | { kind: "anchor"; id: number; part: AnchorPart; path: number; index: number; from: Snapshot; paths: SubPath[]; world: Rigid };

type AnchorPart = "point" | "in" | "out";

export interface CanvasControls {
  fit(rects?: Rect[]): void;
  zoomBy(factor: number): void;
  zoomTo(zoom: number): void;
  center(): Point;
  toWorld(screen: Point): Point;
  // Keys for the pen and for editing a path's points; true when used.
  key(e: KeyboardEvent): boolean;
}

const drawnKinds: Partial<Record<Tool, NodeKind>> = { frame: "frame", rect: "rect", ellipse: "ellipse", line: "line", text: "text" };

export default function Canvas(props: {
  editor: Editor;
  context: ChannelContext;
  controls: (c: CanvasControls) => void;
  onContextMenu: (e: MouseEvent, at: Point) => void;
  onFiles: (files: File[], at: Point) => void;
  // An icon dragged in from the icons panel (its Iconify name).
  onIcon: (name: string, at: Point) => void;
  onFinishText: (id: number, text: string, isNew: boolean) => void;
  spaceDown: boolean;
}) {
  const ed = props.editor;
  const ctx = props.context;
  let board!: HTMLDivElement;
  let gesture: Gesture | null = null;
  const [band, setBand] = createSignal<{ a: Point; b: Point } | null>(null);
  const [guides, setGuides] = createSignal<Guide[]>([]);
  const [drawing, setDrawing] = createSignal<{ kind: NodeKind; rect: Rect; line?: [Point, Point] } | null>(null);
  const [dropTarget, setDropTarget] = createSignal<number | null>(null);
  const [animating, setAnimating] = createSignal(false);
  const [dropping, setDropping] = createSignal(false);
  const [panning, setPanning] = createSignal(false);
  // The path the pen is placing (page points), and where the pointer is for the next segment.
  // `redo`: points taken back with Ctrl+Z, for Ctrl+Shift+Z.
  const [pen, setPen] = createSignal<{ parent: number | null; points: Anchor[]; hover: Point | null; redo: Anchor[] } | null>(null);
  const [scribble, setScribble] = createSignal<Point[] | null>(null);
  // The point picked while editing a path's points.
  const [anchor, setAnchor] = createSignal<{ path: number; index: number } | null>(null);
  // The pen's path shown closed while a drag on its first point shapes the closing curve.
  const [closing, setClosing] = createSignal(false);

  const view = ed.view;
  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = board.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const toWorld = (p: Point): Point => cameraToWorld(view(), p);
  const toScreen = (p: Point): Point => cameraToScreen(view(), p);
  const center = (): Point => ({ x: board.clientWidth / 2, y: board.clientHeight / 2 });

  // One timer at a time: an older zoom's timer must not end a newer zoom's animation early.
  let animationEnd: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(animationEnd));
  const animateView = (next: Viewport) => {
    setAnimating(motionMs() > 0);
    ed.setView(next);
    clearTimeout(animationEnd);
    animationEnd = setTimeout(() => setAnimating(false), motionMs() * 1.5);
  };
  const zoomAt = (p: Point, zoom: number, animate = false) => {
    const next = cameraZoomAt(view(), p, zoom);
    animate ? animateView(next) : ed.setView(next);
  };
  const rootBounds = () => ed.children(null).filter((id) => ed.node(id)!.props.visible).map(ed.worldBounds);
  const fit = (rects = rootBounds(), animate = true) => {
    const next = fitViewport(rects, board.clientWidth, board.clientHeight);
    animate ? animateView(next) : ed.setView(next);
  };
  props.controls({
    fit: (rects) => fit(rects),
    zoomBy: (f) => zoomAt(center(), view().zoom * f, true),
    zoomTo: (z) => zoomAt(center(), z, true),
    center,
    toWorld,
    key: (e) => onKey(e),
  });

  // The first fit waits for the board to have a size and the layers to be loaded.
  const [sized, setSized] = createSignal(false);
  let fitted = ed.viewSaved;
  createEffect(() => {
    if (fitted || !ed.live.loaded || !sized()) return;
    fitted = true;
    queueMicrotask(() => fit(rootBounds(), false));
  });

  // Which layer a click picks: inside open frames (page-level frames and the parents of selected layers) the
  // layer under the pointer one level below; Ctrl picks the deepest.
  const pick = (deepest: number | null, deep: boolean): number | null => {
    if (deepest === null) return null;
    const chain = [deepest, ...ed.ancestors(deepest)].reverse();
    if (chain.some((id) => ed.node(id)!.props.locked)) return null;
    if (deep) return deepest;
    const open = new Set<number>(ed.children(null).filter((id) => ed.node(id)!.kind === "frame"));
    for (const id of ed.selected()) ed.ancestors(id).forEach((a) => open.add(a));
    let chosen = chain[0];
    for (const id of chain) {
      chosen = id;
      if (!open.has(id)) break;
    }
    return chosen;
  };
  // Board pointer capture makes clicks and double clicks report the board, so those look up what is under the pointer.
  const under = (e: MouseEvent) => document.elementFromPoint(e.clientX, e.clientY);
  const deepestAt = (target: EventTarget | null) => {
    const el = (target as HTMLElement | null)?.closest<HTMLElement>("[data-node]");
    return el ? Number(el.dataset.node) : null;
  };

  const snapshot = (ids: number[]): Snapshot => new Map(ids.map((id) => [id, JSON.parse(JSON.stringify(ed.node(id)!)) as DesignNode]));
  // Other layers to line up with: everything visible except the moving layers and what is inside them.
  const snapRects = (moving: number[]) => {
    const skip = new Set(moving.flatMap((id) => [id, ...ed.descendants(id)]));
    return ed.live.value.filter((n) => !skip.has(n.id) && ed.isShown(n.id)).map((n) => ed.worldBounds(n.id));
  };

  const pinch = createPinch({
    view, setView: ed.setView, local,
    cancel: () => {
      const g = gesture;
      gesture = null;
      setBand(null);
      setGuides([]);
      setPanning(false);
      setDropTarget(null);
      setScribble(null);
      if (g && "from" in g && g.from instanceof Map) ed.clearPreview([...g.from.keys(), ...("inner" in g ? g.inner.keys() : [])]);
    },
  });
  const onPointerDown = (e: PointerEvent) => {
    if (e.button === 2 || pinch.down(e)) return;
    if ((e.target as HTMLElement).closest(".design-text-editing")) return;
    const target = e.target as HTMLElement;
    const editingPath = editedPath();
    if (editingPath && target.dataset.anchor === undefined && e.button === 0) ed.setEditing(null);
    else if (ed.editing() !== null) (document.activeElement as HTMLElement | null)?.blur();
    board.focus({ preventScroll: true });
    const p = local(e);
    const w = toWorld(p);
    const additive = e.shiftKey;
    const tool = ed.tool();

    if (e.button === 1 || props.spaceDown || tool === "hand") {
      gesture = { kind: "pan", start: p, from: view() };
      setPanning(true);
    } else if (editingPath && target.dataset.anchor !== undefined) {
      const [path, index, part] = target.dataset.anchor.split(":");
      const n = editingPath;
      if (part === "point") setAnchor({ path: Number(path), index: Number(index) });
      gesture = {
        kind: "anchor", id: n.id, part: part as AnchorPart, path: Number(path), index: Number(index), from: snapshot([n.id]),
        paths: scaledPaths(n.props.vector!, n.width, n.height), world: ed.world(n.id),
      };
    } else if (tool === "pen" && ed.canEdit()) {
      const current = pen();
      // On the first point: closes the path when released, dragging first shapes the closing curve.
      if (current && current.points.length > 1 && near(current.points[0], w)) {
        gesture = { kind: "pen-handle", index: 0, start: p, close: true };
        setClosing(true);
      }
      else {
        const last = current?.points[current.points.length - 1];
        const at = e.shiftKey && last ? snapAngle(last, w) : w;
        const next = current ?? { parent: ed.frameAt(w), points: [], hover: null, redo: [] };
        ed.select([]);
        setPen({ ...next, points: [...next.points, { x: at.x, y: at.y }], redo: [] });
        gesture = { kind: "pen-handle", index: next.points.length, start: p };
      }
    } else if (tool === "pencil" && ed.canEdit()) {
      ed.select([]);
      gesture = { kind: "pencil", parent: ed.frameAt(w), points: [w] };
      setScribble([w]);
    } else if (drawnKinds[tool] && ed.canEdit()) {
      const parent = ed.frameAt(w);
      ed.select([]);
      gesture = { kind: "draw", tool, start: w, parent, targets: tool === "text" ? [] : snapRects([]) };
    } else if (target.dataset.handle && ed.canEdit()) {
      const sel = ed.topSelected();
      const from = snapshot(sel);
      const worlds = new Map(sel.map((id) => [id, ed.world(id)]));
      const bounds = ed.selectionBounds()!;
      if (target.dataset.handle === "rotate") {
        const c = { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
        gesture = { kind: "rotate", center: c, startAngle: angle(c, w), from, worlds };
      } else if (target.dataset.handle === "line-start" || target.dataset.handle === "line-end") {
        const id = sel[0];
        const n = ed.node(id)!;
        const t = ed.world(id);
        const end = target.dataset.handle === "line-start" ? "start" : "end";
        const fixed = apply(t, end === "start" ? { x: n.width, y: 0 } : { x: 0, y: 0 });
        gesture = { kind: "line-end", id, from, fixed, end };
      } else {
        // What is inside resized groups scales with them; inside frames it keeps to its constraints.
        const inner = snapshot(sel.filter((id) => ed.node(id)!.kind === "group" || (ed.node(id)!.kind === "frame" && ed.instanceOf(id) === null))
          .flatMap((id) => ed.descendants(id)));
        gesture = { kind: "resize", handle: target.dataset.handle as Handle, from, inner, worlds, bounds, targets: snapRects(sel) };
      }
    } else {
      const label = target.closest<HTMLElement>("[data-label]");
      const hit = label ? Number(label.dataset.label) : pick(deepestAt(target), e.ctrlKey || e.metaKey);
      const n = ed.node(hit);
      const emptyFrame = n?.kind === "frame" && n.parentId === null && !label && ed.children(n.id).length > 0;
      if (hit === null || (emptyFrame && !ed.selected().includes(hit))) {
        if (!additive) ed.select([]);
        gesture = { kind: "marquee", start: p, base: additive ? ed.selected() : [], container: emptyFrame ? hit : null };
      } else {
        if (additive) ed.select(ed.selected().includes(hit) ? ed.selected().filter((id) => id !== hit) : [...ed.selected(), hit]);
        else if (!ed.selected().includes(hit)) ed.select([hit]);
        const sel = ed.topSelected();
        if (ed.canEdit() && sel.length && ed.selected().includes(hit))
          gesture = { kind: "move", start: w, screen: p, from: snapshot(sel), bounds: ed.selectionBounds()!, targets: snapRects(sel), moved: false };
      }
    }
    board.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const others = () => ctx.presence.others().map((o) => {
    const state = o.state as { sel?: number[] } | null;
    return { userId: o.userId, sel: state?.sel ?? [] };
  });

  const onPointerMove = (e: PointerEvent) => {
    if (pinch.move(e)) return;
    const p = local(e);
    const w = toWorld(p);
    ctx.cursors.move(w);
    // A gesture whose button release never arrived (released outside the window, a menu opened) ends here.
    if (gesture && e.pointerType === "mouse" && e.buttons === 0) return onPointerUp(e);
    const g = gesture;
    if (!g) {
      const current = pen();
      if (current) setPen({ ...current, hover: e.shiftKey && current.points.length ? snapAngle(current.points.at(-1)!, w) : w });
      if (ed.tool() === "move" && !props.spaceDown) {
        const label = (e.target as HTMLElement).closest<HTMLElement>("[data-label]");
        ed.setHovered(label ? Number(label.dataset.label) : pick(deepestAt(e.target), e.ctrlKey || e.metaKey));
      }
      return;
    }
    const threshold = snapPx / view().zoom;
    const noSnap = e.altKey && g.kind === "move";
    if (g.kind === "pan") {
      ed.setView({ ...g.from, x: g.from.x + p.x - g.start.x, y: g.from.y + p.y - g.start.y });
    } else if (g.kind === "move") {
      if (!g.moved && Math.hypot(p.x - g.screen.x, p.y - g.screen.y) < dragPx) return;
      g.moved = true;
      let d = { x: w.x - g.start.x, y: w.y - g.start.y };
      if (e.shiftKey) d = Math.abs(d.x) > Math.abs(d.y) ? { x: d.x, y: 0 } : { x: 0, y: d.y };
      const shifted = (r: Rect, s: Point): Rect => ({ left: r.left + s.x, right: r.right + s.x, top: r.top + s.y, bottom: r.bottom + s.y });
      if (!noSnap) {
        const t = snapTargets(g.targets);
        const box = shifted(g.bounds, d);
        if (!(e.shiftKey && d.x === 0)) d.x += snapShift([box.left, (box.left + box.right) / 2, box.right], t.x, threshold);
        if (!(e.shiftKey && d.y === 0)) d.y += snapShift([box.top, (box.top + box.bottom) / 2, box.bottom], t.y, threshold);
      }
      setGuides(noSnap ? [] : guidesFor(shifted(g.bounds, d), g.targets));
      ed.preview(new Map([...g.from].map(([id, n]) => {
        const l = rotate(d, -ed.world(n.parentId).angle);
        return [id, { x: n.x + l.x, y: n.y + l.y }];
      })));
      const movingRoots = [...g.from.values()].every((n) => n.kind === "frame" && n.parentId === null);
      setDropTarget(movingRoots || inGroups(g.from) ? null : ed.frameAt(w, new Set(g.from.keys())));
    } else if (g.kind === "resize") {
      resize(g, w, e.shiftKey, e.altKey);
      g.free = e.ctrlKey || e.metaKey;
      scaleInner(g);
    } else if (g.kind === "line-end") {
      const moved = e.shiftKey ? snapAngle(g.fixed, w) : w;
      const parent = ed.world(g.from.get(g.id)!.parentId);
      ed.preview(new Map([[g.id, g.end === "end" ? lineBox(g.fixed, moved, parent) : lineBox(moved, g.fixed, parent)]]));
    } else if (g.kind === "rotate") {
      let delta = angle(g.center, w) - g.startAngle;
      if (e.shiftKey) {
        const first = g.worlds.values().next().value!.angle;
        delta = Math.round((first + delta) / 15) * 15 - first;
      }
      ed.preview(new Map([...g.from].map(([id, n]) => {
        const t = g.worlds.get(id)!;
        const turned: Rigid = { origin: { x: 0, y: 0 }, angle: t.angle + delta };
        const o = rotate({ x: t.origin.x - g.center.x, y: t.origin.y - g.center.y }, delta);
        turned.origin = { x: g.center.x + o.x, y: g.center.y + o.y };
        return [id, boxAt(turned, ed.world(n.parentId), n.width, n.height)];
      })));
    } else if (g.kind === "marquee") {
      setBand({ a: g.start, b: p });
      const a = toWorld(g.start);
      const box = { left: Math.min(a.x, w.x), right: Math.max(a.x, w.x), top: Math.min(a.y, w.y), bottom: Math.max(a.y, w.y) };
      const hit = ed.children(g.container).filter((id) => {
        const n = ed.node(id)!;
        return n.props.visible && !n.props.locked && overlaps(ed.worldBounds(id), box);
      });
      ed.select([...new Set([...g.base, ...hit])]);
    } else if (g.kind === "pen-handle") {
      const current = pen();
      if (!current || Math.hypot(p.x - g.start.x, p.y - g.start.y) < dragPx) return;
      const points = [...current.points];
      const a = points[g.index];
      const to = e.shiftKey ? snapAngle(a, w) : w;
      const mirror = { x: 2 * a.x - to.x, y: 2 * a.y - to.y };
      // Ctrl (or Alt) moves the dragged handle alone; the other stays where it is.
      const alone = e.ctrlKey || e.metaKey || e.altKey;
      points[g.index] = g.close
        ? { x: a.x, y: a.y, in: mirror, out: alone ? a.out : to }
        : { x: a.x, y: a.y, out: to, in: alone ? a.in ?? null : mirror };
      setPen({ ...current, points, hover: null });
    } else if (g.kind === "pencil") {
      const last = g.points.at(-1)!;
      if (Math.hypot(w.x - last.x, w.y - last.y) * view().zoom < 1.5) return;
      g.points.push(w);
      setScribble([...g.points]);
    } else if (g.kind === "anchor") {
      ed.preview(new Map([[g.id, movedAnchor(g, invert(g.world, w), e.ctrlKey || e.metaKey || e.altKey, e.shiftKey)]]));
    } else if (g.kind === "draw") {
      const kind = drawnKinds[g.tool]!;
      if (kind === "line") {
        const end = e.shiftKey ? snapAngle(g.start, w) : w;
        setDrawing({ kind, rect: boundsOf([g.start, end]), line: [g.start, end] });
      } else if (kind !== "text") {
        const t = snapTargets(g.targets);
        const end = { x: w.x + snapShift([w.x], t.x, threshold), y: w.y + snapShift([w.y], t.y, threshold) };
        let dx = end.x - g.start.x;
        let dy = end.y - g.start.y;
        if (e.shiftKey) {
          const s = Math.max(Math.abs(dx), Math.abs(dy));
          dx = Math.sign(dx || 1) * s;
          dy = Math.sign(dy || 1) * s;
        }
        const a = e.altKey ? { x: g.start.x - dx, y: g.start.y - dy } : g.start;
        const rect = boundsOf([a, { x: g.start.x + dx, y: g.start.y + dy }]);
        setDrawing({ kind, rect });
        setGuides(guidesFor(rect, g.targets));
      }
    }
  };

  const resize = (g: Extract<Gesture, { kind: "resize" }>, w: Point, keepRatio: boolean, fromCenter: boolean) => {
    const dir = handleDir(g.handle);
    const threshold = snapPx / view().zoom;
    if (g.from.size === 1) {
      const [id, n] = [...g.from][0];
      const t = g.worlds.get(id)!;
      let q = invert(t, w);
      // Edges snap only when the layer is upright on the page.
      if (Math.abs(normalizeAngle(t.angle)) < 0.01) {
        const s = snapTargets(g.targets);
        q = {
          x: dir.x ? q.x + snapShift([w.x], s.x, threshold) : q.x,
          y: dir.y ? q.y + snapShift([w.y], s.y, threshold) : q.y,
        };
      }
      const box = resizeLocal(g.handle, q, n.width, n.height, keepRatio, fromCenter);
      const width = Math.max(1, box.right - box.left);
      let height = Math.max(n.kind === "line" ? 0 : 1, box.bottom - box.top);
      const change: Change = {};
      if (n.kind === "text") {
        // Dragging the height fixes the box; dragging only the width wraps the text and keeps it growing down.
        const sizing = dir.y !== 0 || n.props.sizing === "fixed" ? "fixed" : "height";
        const props = { ...n.props, sizing } as const;
        if (sizing === "height") height = measureText(props, width).height;
        change.props = props;
      }
      // Paths and corners mirror when dragged past the other side; layers holding others only resize.
      const flips = resizeFlips(g.handle, q, n.width, n.height, fromCenter);
      if (ed.children(id).length === 0) for (const axis of ["x", "y"] as const) {
        const mirrored = flips[axis] ? mirroredProps(change.props ?? n.props, axis) : null;
        if (mirrored) change.props = mirrored;
      }
      const placed = boxAt({ origin: apply(t, { x: box.left, y: box.top }), angle: t.angle }, ed.world(n.parentId), width, height);
      ed.preview(new Map([[id, { ...change, ...placed }]]));
      const upright = Math.abs(normalizeAngle(t.angle)) < 0.01;
      setGuides(upright ? guidesFor(boundsOf(cornersOf({ origin: apply(t, { x: box.left, y: box.top }), angle: 0 }, width, height)), g.targets) : []);
      return;
    }
    // Several layers scale inside their combined box.
    const b = g.bounds;
    let { left, top, right, bottom } = b;
    if (dir.x < 0) left = w.x;
    if (dir.x > 0) right = w.x;
    if (dir.y < 0) top = w.y;
    if (dir.y > 0) bottom = w.y;
    if (keepRatio) {
      const f = Math.max(dir.x ? (right - left) / (b.right - b.left) : 0, dir.y ? (bottom - top) / (b.bottom - b.top) : 0);
      if (dir.x >= 0) right = left + (b.right - b.left) * f; else left = right - (b.right - b.left) * f;
      if (dir.y >= 0) bottom = top + (b.bottom - b.top) * f; else top = bottom - (b.bottom - b.top) * f;
    }
    const fx = Math.max(0.01, (right - left) / Math.max(1e-6, b.right - b.left));
    const fy = Math.max(0.01, (bottom - top) / Math.max(1e-6, b.bottom - b.top));
    ed.preview(new Map([...g.from].map(([id, n]) => {
      const t = g.worlds.get(id)!;
      const c = apply(t, { x: n.width / 2, y: n.height / 2 });
      const nc = { x: left + (c.x - b.left) * fx, y: top + (c.y - b.top) * fy };
      const width = Math.max(1, n.width * fx);
      const height = Math.max(n.kind === "line" ? 0 : 1, n.height * fy);
      const half = rotate({ x: width / 2, y: height / 2 }, t.angle);
      return [id, boxAt({ origin: { x: nc.x - half.x, y: nc.y - half.y }, angle: t.angle }, ed.world(n.parentId), width, height)];
    })));
  };

  // Ctrl leaves what is inside frames where it is.
  const scaleInner = (g: Extract<Gesture, { kind: "resize" }>) => {
    const changes = new Map<number, Change>();
    for (const [id, orig] of g.from) {
      if (orig.kind !== "group" && (orig.kind !== "frame" || g.free || ed.instanceOf(id) !== null)) continue;
      for (const [k, c] of resizeInside(id, orig.kind, orig, ed.node(id)!, ed.children, (d) => g.inner.get(d))) changes.set(k, c);
    }
    ed.clearPreview([...g.inner.keys()].filter((k) => !changes.has(k) && ed.draft[k]));
    if (changes.size) ed.preview(changes);
  };

  const onPointerUp = (e: PointerEvent) => {
    if (pinch.up(e)) return;
    const g = gesture;
    gesture = null;
    setBand(null);
    setGuides([]);
    setPanning(false);
    const target = dropTarget();
    setDropTarget(null);
    if (!g) return;
    if (g.kind === "move") {
      if (!g.moved) {
        // A plain click on one of several selected layers selects just that one.
        const hit = pick(deepestAt(under(e)), e.ctrlKey || e.metaKey);
        if (!e.shiftKey && hit !== null && ed.selected().length > 1) ed.select([hit]);
        return ed.clearPreview(g.from.keys());
      }
      const ids = [...g.from.keys()];
      const moved = new Map(ids.map((id) => [id, { x: ed.node(id)!.x, y: ed.node(id)!.y } as Change]));
      const movingRoots = [...g.from.values()].every((n) => n.kind === "frame" && n.parentId === null);
      const into = movingRoots ? undefined : target;
      // Layers in a group stay in it when dragged; the group grows instead.
      const leaving = into !== undefined && !inGroups(g.from) ? ids.filter((id) => ed.node(id)!.parentId !== into) : [];
      const changes = new Map([...moved, ...ed.reparentChanges(leaving, into ?? null)]);
      const old = new Map(ids.map((id) => {
        const n = g.from.get(id)!;
        return [id, { x: n.x, y: n.y, ...(leaving.includes(id) ? { parentId: n.parentId, z: n.z, rotation: n.rotation } : {}) } as Change];
      }));
      ed.update(changes, `Move ${layers(ids.length)}`, "forward", old);
    } else if (g.kind === "resize" || g.kind === "rotate" || g.kind === "line-end") {
      const ids = [...g.from.keys()];
      const originals = new Map([...g.from, ...(g.kind === "resize" ? g.inner : [])]);
      const changed = [...originals.keys()].filter((id) => ed.draft[id]);
      if (!changed.length) return;
      const changes = new Map(changed.map((id) => [id, { ...ed.draft[id] } as Change]));
      const old = new Map(changed.map((id) => {
        const n = originals.get(id)!;
        return [id, Object.fromEntries(Object.keys(changes.get(id)!).map((k) => [k, n[k as keyof DesignNode]])) as Change];
      }));
      const label = g.kind === "rotate" ? "Rotate" : "Resize";
      ed.update(changes, `${label} ${layers(ids.length)}`, g.kind === "rotate" ? "rotate" : "normalize-size", old, !(g.kind === "resize" && g.free));
    } else if (g.kind === "draw") {
      const shape = drawing();
      setDrawing(null);
      void create(g, shape);
    } else if (g.kind === "pen-handle") {
      setClosing(false);
      if (g.close) finishPen(true);
    } else if (g.kind === "pencil") {
      setScribble(null);
      finishPencil(g);
    } else if (g.kind === "anchor") {
      const change = ed.draft[g.id];
      if (!change) return;
      const n = g.from.get(g.id)!;
      const old = Object.fromEntries(Object.keys(change).map((k) => [k, n[k as keyof DesignNode]])) as Change;
      ed.update(new Map([[g.id, { ...change }]]), "Edit path", "design-pen", new Map([[g.id, old]]));
    }
  };

  // Paths: placed with the pen, drawn with the pencil, points edited after a double click.
  const near = (a: Point, b: Point, px = 8) => Math.hypot(a.x - b.x, a.y - b.y) * view().zoom < px;
  const editedPath = () => {
    const n = ed.node(ed.editing());
    return n?.kind === "path" && n.props.vector ? n : undefined;
  };
  createEffect(on(() => ed.editing(), () => setAnchor(null)));
  createEffect(on(ed.tool, (tool) => tool !== "pen" && pen() && finishPen(false)));

  // `drawn`: the pen's points (page coordinates); undoing the new path then reopens the pen on them.
  const createPath = async (parent: number | null, paths: SubPath[], how: "pen" | "pencil", drawn?: Anchor[]) => {
    const parentWorld = ed.world(parent);
    const fit = fitPaths(mapPaths(paths, (pt) => invert(parentWorld, pt)));
    if (!fit) return;
    const closed = paths.some((s) => s.closed);
    const props = {
      ...defaultProps("path"), vector: fit.vector,
      fills: closed ? [solid("#d9d9d9")] : [],
      strokes: [stroke(ed.inkIn(parent), "center", how === "pencil" ? 2 : 1)],
    };
    await ed.run(async () => {
      const [id] = await ed.add([{
        kind: "path", name: nameFor("path"), parent_id: parent,
        x: fit.box.left, y: fit.box.top, width: fit.vector.w, height: fit.vector.h, rotation: 0, props,
      }], how === "pen" ? "Add path" : "Draw", !drawn);
      if (id === undefined) return;
      if (drawn) ed.history.push({
        label: "Add path", icon: "add",
        undo: async () => {
          await removeNodes(ctx.api, [id]);
          ed.setTool("pen");
          setPen({ parent, points: drawn, hover: null, redo: [] });
        },
        redo: async () => {
          setPen(null);
          await restoreNodes(ctx.api, [id]);
        },
      });
      // Straight into editing its points, to adjust handles and corners.
      if (how === "pen") {
        ed.select([id]);
        ed.setEditing(id);
      }
    });
  };

  // Ends the pen's path, closed or open; a click on the same spot (a double click) adds no extra point.
  const finishPen = (close: boolean) => {
    const current = pen();
    if (!current) return false;
    setPen(null);
    const points: Anchor[] = [];
    for (const a of current.points) {
      const prev = points.at(-1);
      if (prev && near(prev, a, 2)) points[points.length - 1] = { ...prev, out: a.out ?? prev.out };
      else points.push(a);
    }
    if (ed.tool() === "pen") ed.setTool("move");
    if (points.length > 1) void createPath(current.parent, [{ points, closed: close && points.length > 2 }], "pen", points);
    return true;
  };

  // A freehand line becomes a smooth curve through fewer points; ending near the start closes it.
  const finishPencil = (g: Extract<Gesture, { kind: "pencil" }>) => {
    const pts = g.points;
    if (pts.length < 2) return;
    let length = 0;
    for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (length * view().zoom < 3) return;
    const closed = pts.length > 3 && near(pts[0], pts.at(-1)!, 12) && length * view().zoom > 48;
    let kept = simplify(pts, 1.5 / view().zoom);
    if (closed && kept.length > 3) kept = kept.slice(0, -1);
    void createPath(g.parent, [{ points: smoothThrough(kept, closed), closed }], "pencil");
  };

  // A path with one point or handle dragged to `to` (layer coordinates), refitted into its box. Handles in a
  // straight line turn together; once apart, or with Ctrl or Alt held, the dragged one moves alone. Shift snaps
  // its angle.
  const movedAnchor = (g: Extract<Gesture, { kind: "anchor" }>, to: Point, free: boolean, snap = false): Change => {
    const n = g.from.get(g.id)!;
    const paths = g.paths.map((s) => ({ closed: s.closed, points: s.points.map((a) => ({ ...a })) }));
    const a = paths[g.path].points[g.index];
    if (g.part === "point") {
      const d = { x: to.x - a.x, y: to.y - a.y };
      const shift = (h?: Point | null) => (h ? { x: h.x + d.x, y: h.y + d.y } : h);
      Object.assign(a, { x: to.x, y: to.y, in: shift(a.in), out: shift(a.out) });
    } else {
      const other = g.part === "in" ? "out" : "in";
      a[g.part] = snap ? snapAngle(a, to) : to;
      to = a[g.part]!;
      const opposite = a[other];
      if (!free && opposite && inLine(g.paths[g.path].points[g.index])) {
        const length = Math.hypot(opposite.x - a.x, opposite.y - a.y);
        const angle = Math.atan2(a.y - to.y, a.x - to.x);
        a[other] = { x: a.x + Math.cos(angle) * length, y: a.y + Math.sin(angle) * length };
      }
    }
    return refit(n, paths, g.world);
  };
  const inLine = (a: Anchor) => {
    if (!a.in || !a.out) return false;
    const u = { x: a.in.x - a.x, y: a.in.y - a.y };
    const v = { x: a.out.x - a.x, y: a.out.y - a.y };
    const lengths = Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y);
    return lengths > 0 && Math.abs(u.x * v.y - u.y * v.x) / lengths < 0.02 && u.x * v.x + u.y * v.y < 0;
  };
  // A point made a corner (no handles) or smooth (handles along the line through its neighbors).
  const setPointType = (n: DesignNode, path: number, index: number, smooth: boolean) => {
    const paths = scaledPaths(n.props.vector!, n.width, n.height).map((s) => ({ closed: s.closed, points: s.points.map((a) => ({ ...a })) }));
    const sub = paths[path];
    const a = sub?.points[index];
    if (!a) return;
    if (!smooth) Object.assign(a, { in: null, out: null });
    else {
      const count = sub.points.length;
      const at = (i: number) => sub.closed ? sub.points[(i + count) % count] : sub.points[Math.max(0, Math.min(count - 1, i))];
      const prev = at(index - 1);
      const next = at(index + 1);
      const t = { x: (next.x - prev.x) / 4, y: (next.y - prev.y) / 4 };
      const first = !sub.closed && index === 0;
      const last = !sub.closed && index === count - 1;
      Object.assign(a, {
        in: first ? null : { x: a.x - t.x, y: a.y - t.y },
        out: last ? null : { x: a.x + t.x, y: a.y + t.y },
      });
    }
    ed.update(new Map([[n.id, refit(n, paths, ed.world(n.id))]]), smooth ? "Smooth point" : "Corner point", "design-pen");
  };
  const refit = (n: DesignNode, paths: SubPath[], world: Rigid): Change => {
    const fit = fitPaths(paths)!;
    const origin = apply(world, { x: fit.box.left, y: fit.box.top });
    return { ...boxAt({ origin, angle: world.angle }, ed.world(n.parentId), fit.vector.w, fit.vector.h), props: { ...n.props, vector: fit.vector } };
  };

  const onKey = (e: KeyboardEvent): boolean => {
    const k = e.key;
    if (pen()) {
      if (k === "Enter" || k === "Escape") return finishPen(false);
      // Undo and redo while drawing take back or put back one point.
      const key = k.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && (key === "z" || key === "y")) {
        const current = pen()!;
        if (key === "z" && !e.shiftKey) {
          const points = current.points.slice(0, -1);
          setPen(points.length ? { ...current, points, redo: [...current.redo, current.points.at(-1)!] } : null);
        } else if (current.redo.length) {
          setPen({ ...current, points: [...current.points, current.redo.at(-1)!], redo: current.redo.slice(0, -1) });
        }
        return true;
      }
      if (k === "Backspace" || k === "Delete") {
        const current = pen()!;
        const points = current.points.slice(0, -1);
        setPen(points.length ? { ...current, points, redo: [] } : null);
        return true;
      }
      return false;
    }
    const n = editedPath();
    if (!n) return false;
    if (k === "Enter" || k === "Escape") {
      ed.setEditing(null);
      return true;
    }
    const picked = anchor();
    if ((k === "Backspace" || k === "Delete") && picked) {
      const paths = scaledPaths(n.props.vector!, n.width, n.height)
        .map((s, i) => (i === picked.path ? { ...s, points: s.points.filter((_, j) => j !== picked.index) } : s))
        .filter((s) => s.points.length > 1);
      setAnchor(null);
      if (paths.length === 0) ed.remove([n.id]);
      else ed.update(new Map([[n.id, refit(n, paths, ed.world(n.id))]]), "Delete point", "design-pen");
      return true;
    }
    return false;
  };

  const inGroups = (nodes: Snapshot) => [...nodes.values()].some((n) => ed.node(n.parentId)?.kind === "group");

  const nameFor = (kind: NodeKind) => `${kindLabels[kind]} ${ed.live.value.filter((n) => n.kind === kind).length + 1}`;

  const create = async (g: Extract<Gesture, { kind: "draw" }>, shape: ReturnType<typeof drawing>) => {
    const kind = drawnKinds[g.tool]!;
    const parentWorld = ed.world(g.parent);
    const props = defaultProps(kind);
    const ink = ed.inkIn(g.parent);
    if (kind === "text") props.fills = [solid(ink)];
    if (kind === "line") props.strokes = props.strokes.map((s) => ({ ...s, color: ink }));
    ed.setTool("move");
    if (kind === "text") {
      props.text = "";
      const size = measureText(props);
      const box = boxAt({ origin: { x: g.start.x, y: g.start.y - size.height / 2 }, angle: 0 }, parentWorld, size.width, size.height);
      const [id] = await ed.add([{ kind, name: "Text", parent_id: g.parent, ...box, props }], "Add text", false);
      if (id === undefined) return;
      ed.select([id]);
      ed.setEditing(id);
      newText = id;
      return;
    }
    let world: Rigid;
    let width: number;
    let height: number;
    const small = !shape || ((shape.rect.right - shape.rect.left) * view().zoom < 2 && (shape.rect.bottom - shape.rect.top) * view().zoom < 2);
    if (kind === "line") {
      const [a, b] = small ? [g.start, { x: g.start.x + 100, y: g.start.y }] : shape!.line!;
      const box = lineBox(a, b, { origin: { x: 0, y: 0 }, angle: 0 });
      world = localTransform(box);
      width = box.width;
      height = 0;
    } else {
      const rect = small ? { left: g.start.x - 50, top: g.start.y - 50, right: g.start.x + 50, bottom: g.start.y + 50 } : shape!.rect;
      world = { origin: { x: rect.left, y: rect.top }, angle: 0 };
      width = rect.right - rect.left;
      height = rect.bottom - rect.top;
    }
    const box = boxAt(world, parentWorld, width, height);
    await ed.run(async () => {
      const [id] = await ed.add([{ kind, name: nameFor(kind), parent_id: g.parent, ...box, props }], `Add ${kindLabels[kind].toLowerCase()}`);
      if (id !== undefined) ed.select([id]);
    });
  };

  // A text layer made with the text tool is only kept (and recorded) once it has text.
  let newText: number | null = null;
  const finishText = (id: number, text: string) => {
    const isNew = newText === id;
    if (isNew) newText = null;
    ed.setEditing(null);
    props.onFinishText(id, text, isNew);
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const pixels = (d: number) => (e.deltaMode === 1 ? d * 33 : d);
    if (e.ctrlKey || e.metaKey) {
      const step = Math.max(-0.5, Math.min(0.5, pixels(e.deltaY) * 0.01));
      zoomAt(local(e), view().zoom * Math.exp(-step));
    } else {
      const dx = e.shiftKey && !e.deltaX ? pixels(e.deltaY) : pixels(e.deltaX);
      const dy = e.shiftKey && !e.deltaX ? 0 : pixels(e.deltaY);
      ed.setView({ ...view(), x: view().x - dx, y: view().y - dy });
    }
  };

  onMount(() => {
    const resizeObserver = new ResizeObserver(() => setSized(board.clientWidth > 0 && board.clientHeight > 0));
    resizeObserver.observe(board);
    board.addEventListener("wheel", onWheel, { passive: false });
    onCleanup(() => {
      resizeObserver.disconnect();
      board.removeEventListener("wheel", onWheel);
    });
  });

  // Grid dots stay 12 to 48 px apart at any zoom.
  const gridSize = () => {
    let size = 24 * view().zoom;
    while (size < 12) size *= 2;
    while (size > 48) size /= 2;
    return size;
  };

  // A layer's box on screen, as styles for an element with its origin at the board's top left.
  const screenBox = (id: number, pad = 0): JSX.CSSProperties => {
    const n = ed.node(id)!;
    const t = ed.world(id);
    const o = toScreen(t.origin);
    return {
      width: `${n.width * view().zoom + pad * 2}px`,
      height: `${n.height * view().zoom + pad * 2}px`,
      transform: `translate(${o.x}px, ${o.y}px) rotate(${t.angle}deg) translate(${-pad}px, ${-pad}px)`,
    };
  };
  const rectBox = (r: Rect): JSX.CSSProperties => {
    const a = toScreen({ x: r.left, y: r.top });
    return {
      width: `${(r.right - r.left) * view().zoom}px`,
      height: `${(r.bottom - r.top) * view().zoom}px`,
      transform: `translate(${a.x}px, ${a.y}px)`,
    };
  };

  const single = () => (ed.topSelected().length === 1 ? ed.node(ed.topSelected()[0]) : undefined);
  const selectionSize = () => {
    const n = single();
    if (n) return `${round(n.width)} × ${round(n.height)}`;
    const b = ed.selectionBounds();
    return b ? `${round(b.right - b.left)} × ${round(b.bottom - b.top)}` : "";
  };
  // Prototype links on screen, from the layer's side facing the frame it goes to.
  const links = createMemo(() => {
    if (ed.panelTab() !== "prototype") return [];
    const selected = new Set(ed.selected());
    return ed.live.value.flatMap((n) => {
      const targets = n.props.interactions.filter((i) => (i.action === "navigate" || i.action === "overlay") && i.target !== null && i.target !== n.id)
        .map((i) => i.target!);
      if (targets.length === 0 || !ed.isShown(n.id)) return [];
      const from = ed.worldBounds(n.id);
      const lit = selected.has(n.id) || ed.ancestors(n.id).some((a) => selected.has(a));
      return [...new Set(targets)].filter((t) => ed.node(t) && ed.isShown(t)).map((t) => {
        const to = ed.worldBounds(t);
        const right = (to.left + to.right) / 2 >= (from.left + from.right) / 2;
        const a = toScreen({ x: right ? from.right : from.left, y: (from.top + from.bottom) / 2 });
        const b = toScreen({ x: right ? to.left : to.right, y: to.top + Math.min(40, (to.bottom - to.top) / 2) });
        const side = right ? 1 : -1;
        const pull = Math.max(30, Math.abs(b.x - a.x) / 2);
        return {
          lit,
          d: `M ${a.x} ${a.y} C ${a.x + side * pull} ${a.y} ${b.x - side * pull} ${b.y} ${b.x} ${b.y}`,
          head: `M ${b.x - side * 8} ${b.y - 5} L ${b.x} ${b.y} L ${b.x - side * 8} ${b.y + 5} Z`,
          start: a,
        };
      });
    });
  });

  const rootFrames = () => ed.children(null).filter((id) => {
    const n = ed.node(id)!;
    return n.kind === "frame" && n.props.visible;
  });

  return (
    <div ref={board} class="design-board" role="application" tabIndex={0} aria-label="Design canvas"
      classList={{
        panning: props.spaceDown || ed.tool() === "hand", grabbing: panning(), dropping: dropping(),
        drawing: !!drawnKinds[ed.tool()] || ed.tool() === "pen" || ed.tool() === "pencil",
        taken: ed.tool() === "move" && ed.hovered() !== null && !ed.free(ed.hovered()!),
      }}
      style={{
        "--grid": `${gridSize()}px`, "background-position": `${view().x}px ${view().y}px`,
        "background-color": ed.background() ?? undefined, "--page-ink": ed.background() ? inkFor(ed.background()!) : undefined,
      }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onPointerLeave={() => {
        ctx.cursors.move(null);
        ed.setHovered(null);
      }}
      onDblClick={(e) => {
        if ((e.target as HTMLElement).closest(".design-text-editing")) return;
        const point = (e.target as HTMLElement).dataset.anchor?.split(":");
        const path = editedPath();
        if (point?.[2] === "point" && path && ed.canEdit()) {
          const a = scaledPaths(path.props.vector!, path.width, path.height)[Number(point[0])]?.points[Number(point[1])];
          if (a) setPointType(path, Number(point[0]), Number(point[1]), !a.in && !a.out);
          return;
        }
        const deepest = deepestAt(under(e));
        const hit = pick(deepest, e.ctrlKey || e.metaKey);
        if (ed.tool() === "pen") return void finishPen(false);
        const n = ed.node(hit);
        if (!n || !ed.free(n.id)) return;
        if ((n.kind === "path" || n.kind === "text") && ed.canEdit()) {
          ed.select([n.id]);
          ed.setEditing(n.id);
        } else if (ed.selected().includes(n.id) && deepest !== null && deepest !== n.id) {
          const chain = [deepest, ...ed.ancestors(deepest)];
          const next = chain[chain.indexOf(n.id) - 1];
          if (next !== undefined) {
            ed.select([next]);
            if (ed.node(next)!.kind === "text" && next === deepest && ed.canEdit()) ed.setEditing(next);
          }
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const label = (e.target as HTMLElement).closest<HTMLElement>("[data-label]");
        const hit = label ? Number(label.dataset.label) : pick(deepestAt(e.target), e.ctrlKey || e.metaKey);
        if (hit !== null && !ed.selected().includes(hit)) ed.select([hit]);
        props.onContextMenu(e, toWorld(local(e)));
      }}
      onDragOver={(e) => {
        if ((e.dataTransfer?.types.includes("Files") || e.dataTransfer?.types.includes(iconDragType)) && ed.canEdit()) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropping(false)}
      onDrop={(e) => {
        const icon = e.dataTransfer?.getData(iconDragType);
        if (icon) {
          e.preventDefault();
          setDropping(false);
          return props.onIcon(icon, toWorld(local(e)));
        }
        if (!e.dataTransfer?.types.includes("Files")) return;
        e.preventDefault();
        setDropping(false);
        props.onFiles([...e.dataTransfer.files], toWorld(local(e)));
      }}>
      <div class="design-canvas" classList={{ animating: animating() }}
        style={{ transform: `translate(${view().x}px, ${view().y}px) scale(${view().zoom})`, "--zoom": view().zoom }}>
        <For each={ed.children(null)}>{(id) => <NodeView editor={ed} id={id} onFinishText={finishText} />}</For>
      </div>

      <div class="design-overlay">
        <For each={rootFrames()}>
          {(id) => {
            const n = () => ed.node(id)!;
            return (
              <Show when={ed.node(id)}>
                <div class="design-frame-label" data-label={id} classList={{ selected: ed.selected().includes(id) }}
                  style={{ width: screenBox(id).width, transform: screenBox(id).transform }}>
                  <span>{n().name}</span>
                </div>
              </Show>
            );
          }}
        </For>
        <Show when={ed.hovered() !== null && !ed.selected().includes(ed.hovered()!) && ed.node(ed.hovered())}>
          <div class="design-outline hover" style={screenBox(ed.hovered()!)} />
        </Show>
        <Show when={dropTarget() !== null && ed.node(dropTarget())}>
          <div class="design-outline drop" style={screenBox(dropTarget()!)} />
        </Show>
        <For each={ed.topSelected()}>
          {(id) => <Show when={ed.node(id)}><div class="design-outline" style={screenBox(id)} /></Show>}
        </For>
        <Show when={ed.canEdit() && ed.editing() === null && !drawing() && ed.topSelected().length > 0}>
          <Show when={single()?.kind === "line" ? single() : undefined} fallback={
            <SelectionHandles class="design-selection" style={single() ? screenBox(single()!.id) : rectBox(ed.selectionBounds()!)}
              rotate size={selectionSize()} />
          }>
            {(line) => (
              <div class="design-selection line" style={screenBox(line().id)}>
                <span class="design-handle line-start" data-handle="line-start" />
                <span class="design-handle line-end" data-handle="line-end" />
                <span class="design-size">{round(line().width)}</span>
              </div>
            )}
          </Show>
        </Show>
        <For each={others()}>
          {(other) => {
            const who = () => ctx.users.get(other.userId);
            return (
              <For each={other.sel.filter((id) => ed.node(id))}>
                {(id, i) => (
                  <div class="design-outline other" style={{ ...screenBox(id), "--who": who().color || "var(--mw-text-muted)" }}>
                    <Show when={i() === 0}>
                      <span class="design-who" style={{ color: inkFor(who().color) }}>{who().displayName}</span>
                    </Show>
                  </div>
                )}
              </For>
            );
          }}
        </For>
        <Show when={editedPath()}>
          {(n) => <>
            <PathPoints node={n()} world={ed.world(n().id)} toScreen={toScreen} picked={anchor()} />
            <Show when={ed.canEdit()}>
              <div class="design-path-bar mw-box mw-fade-in" onPointerDown={(e) => e.stopPropagation()} onDblClick={(e) => e.stopPropagation()}>
                <button class="mw-button mw-box" disabled={!anchor()} onClick={() => setPointType(n(), anchor()!.path, anchor()!.index, false)}>Corner</button>
                <button class="mw-button mw-box" disabled={!anchor()} onClick={() => setPointType(n(), anchor()!.path, anchor()!.index, true)}>Smooth</button>
                <span>Double-click a point to switch. Ctrl-drag a handle to move it alone, Shift snaps. Enter when done.</span>
              </div>
            </Show>
          </>}
        </Show>
        <Show when={pen()}>
          <div class="design-path-bar hint mw-box mw-fade-in">
            <span>Click to add points, drag for curves (Ctrl moves one handle, Shift snaps). Ctrl+Z takes back a point. Click the first point to close, Enter to finish.</span>
          </div>
        </Show>
        <Show when={pen()}>
          {(current) => {
            const shown = () => mapPaths([{ points: current().points, closed: closing() }], toScreen)[0];
            const last = () => shown().points[shown().points.length - 1];
            const hover = () => (current().hover ? toScreen(current().hover!) : null);
            return (
              <svg class="design-draw-path" aria-hidden="true">
                <path d={pathData([shown()])} />
                <Show when={hover() && last()}>
                  <path class="next" d={`M ${last().x} ${last().y} L ${hover()!.x} ${hover()!.y}`} />
                </Show>
                <Show when={closing() ? shown().points[0] : last()}>
                  {(a) => <>
                    <Show when={a().in}><path class="handle" d={`M ${a().x} ${a().y} L ${a().in!.x} ${a().in!.y}`} /></Show>
                    <Show when={a().out}><path class="handle" d={`M ${a().x} ${a().y} L ${a().out!.x} ${a().out!.y}`} /></Show>
                  </>}
                </Show>
                <Index each={shown().points}>
                  {(a, i) => <circle cx={a().x} cy={a().y} r={i === 0 && current().points.length > 1 ? 5 : 3.5} />}
                </Index>
              </svg>
            );
          }}
        </Show>
        <Show when={scribble()}>
          {(pts) => (
            <svg class="design-draw-path" aria-hidden="true">
              <polyline points={pts().map((p) => { const s = toScreen(p); return `${s.x},${s.y}`; }).join(" ")} />
            </svg>
          )}
        </Show>
        <Show when={links().length > 0}>
          <svg class="design-links" aria-hidden="true">
            <For each={links()}>
              {(l) => (
                <g classList={{ lit: l.lit }}>
                  <path class="line" d={l.d} />
                  <path class="head" d={l.head} />
                  <circle cx={l.start.x} cy={l.start.y} r={3.5} />
                </g>
              )}
            </For>
          </svg>
        </Show>
        <RemoteCursors others={ctx.cursors.others} user={ctx.users.get} toScreen={toScreen} />
        <For each={guides()}>
          {(g) => {
            const a = () => toScreen(g.axis === "x" ? { x: g.at, y: g.from } : { x: g.from, y: g.at });
            const length = () => (g.to - g.from) * view().zoom;
            return <div class={`design-guide ${g.axis}`} style={{
              transform: `translate(${a().x}px, ${a().y}px)`,
              [g.axis === "x" ? "height" : "width"]: `${length()}px`,
            }} />;
          }}
        </For>
        <Show when={drawing()}>
          {(d) => (
            <Show when={d().line} fallback={<div class="design-draw" classList={{ round: d().kind === "ellipse" }} style={rectBox(d().rect)} />}>
              {(line) => {
                const a = () => toScreen(line()[0]);
                const b = () => toScreen(line()[1]);
                return <div class="design-draw line" style={{
                  width: `${Math.hypot(b().x - a().x, b().y - a().y)}px`,
                  transform: `translate(${a().x}px, ${a().y}px) rotate(${Math.atan2(b().y - a().y, b().x - a().x)}rad)`,
                }} />;
              }}
            </Show>
          )}
        </Show>
        <Show when={band()}>
          {(b) => (
            <div class="design-band" style={{
              transform: `translate(${Math.min(b().a.x, b().b.x)}px, ${Math.min(b().a.y, b().b.y)}px)`,
              width: `${Math.abs(b().a.x - b().b.x)}px`,
              height: `${Math.abs(b().a.y - b().b.y)}px`,
            }} />
          )}
        </Show>
      </div>

      <Show when={ed.live.loaded && ed.live.value.length === 0}>
        <p class="design-empty mw-fade-in">Pick a tool above (F frame, R rectangle, T text) and draw, or drop images here.</p>
      </Show>
      <div class="design-drop-hint" aria-hidden="true">Drop to add</div>
    </div>
  );
}

// In play mode: instances and mains shown as another variant (`swaps`, by the layer shown there), and frames that scroll.
export interface PlayState {
  swaps: () => Record<number, number>;
}

// `backdrop`: background blur of the groups around this layer, which its shapes draw.
export function NodeView(props: { editor: Editor; id: number; backdrop?: string[]; onFinishText: (id: number, text: string) => void; play?: PlayState }) {
  const ed = props.editor;
  const shownAs = () => props.play?.swaps()[props.id];
  // A swapped layer keeps its place and shows the variant's look and layers.
  const n = createMemo(() => {
    const own = ed.node(props.id);
    const variant = ed.node(shownAs());
    return own && variant ? { ...variant, id: own.id, x: own.x, y: own.y, rotation: own.rotation, parentId: own.parentId, z: own.z } : own;
  });
  const scroll = () => {
    const s = props.play && n()?.kind === "frame" ? n()!.props.scroll : "none";
    if (s === "none") return undefined;
    return { "overflow-x": s === "vertical" ? "hidden" : "auto", "overflow-y": s === "horizontal" ? "hidden" : "auto" } as const;
  };
  const filterId = createUniqueId();
  const groupFilter = createMemo(() => {
    const node = n();
    return node?.kind === "group" ? effectFilter(node.props.effects, ed.resolve, filterId) : null;
  });
  const childBackdrop = () => [...(props.backdrop ?? []), ...(n()?.kind === "group" ? backgroundBlurs(n()!) : [])];
  return (
    <Show when={n()}>
      {(node) => (
        <div class={`design-node ${node().kind}`} data-node={props.id} classList={{ editing: ed.editing() === props.id }}
          style={boxStyle(node(), ed.resolve, groupFilter() ? filterId : undefined)}>
          <Show when={groupFilter()}>
            {(filter) => <svg class="design-filter" width="0" height="0" aria-hidden="true"><defs innerHTML={filter()} /></svg>}
          </Show>
          <Show when={node().kind !== "text" && node().kind !== "line" && node().kind !== "group" && node().kind !== "path"}>
            <div class="design-fill" style={fillStyle(node(), ed.resolve, props.backdrop)}>
              <Show when={node().kind === "image"}>
                <img class="design-image" classList={{ ghost: !contentUrl(node().url ?? "") }} draggable={false} alt=""
                  src={contentUrl(node().url ?? "") ?? node().thumb ?? undefined} />
              </Show>
              <Show when={node().kind === "svg" && node().props.svg}>
                <img class="design-image" draggable={false} alt="" src={`data:image/svg+xml,${encodeURIComponent(tintedSvg(node(), ed.resolve))}`} />
              </Show>
            </div>
          </Show>
          <Show when={node().kind === "path"}>
            <svg class="design-path" width={Math.max(1, node().width)} height={Math.max(1, node().height)} aria-hidden="true">
              <For each={[...node().props.fills].reverse().filter((f) => f.visible)}>
                {(f, i) => (
                  <Show when={f.gradient} fallback={<path d={vectorPath(node())} fill={cssColor(f, ed.resolve)} />}>
                    {(g) => <>
                      <defs innerHTML={svgGradient(g(), `${filterId}-g${i()}`, node().width, node().height, f.opacity)} />
                      <path d={vectorPath(node())} fill={`url(#${filterId}-g${i()})`} />
                    </>}
                  </Show>
                )}
              </For>
              <path class="design-path-hit" d={vectorPath(node())} />
            </svg>
          </Show>
          <Show when={node().kind === "text"}>
            <div class="design-text-box" style={textBoxStyle(node())}>
              <Show when={ed.editing() === props.id} fallback={
                <div class="design-text" classList={{ wrap: node().props.sizing !== "width" }} style={textStyle(node(), ed.resolve)}>{node().props.text}</div>
              }>
                <TextEditor node={node()} resolve={ed.resolve} onDone={(text) => props.onFinishText(props.id, text)} />
              </Show>
            </div>
          </Show>
          <Show when={node().kind === "frame" || node().kind === "group"}>
            <div class="design-children" classList={{ clip: node().kind === "frame" && node().props.clip }}
              style={{ ...(node().props.clip ? cornerStyle(node()) : {}), ...scroll() }}>
              <For each={ed.children(shownAs() ?? props.id)}>
                {(id) => <NodeView editor={ed} id={id} backdrop={childBackdrop()} onFinishText={props.onFinishText} play={props.play} />}
              </For>
            </div>
          </Show>
          <Show when={strokePaths(node(), ed.resolve).length > 0}>
            <svg class="design-strokes" width={node().width} height={Math.max(1, node().height)} aria-hidden="true">
              <For each={strokePaths(node(), ed.resolve)}>
                {(path) => <path d={path.d} fill="none" stroke={path.stroke} stroke-width={path.width} />}
              </For>
            </svg>
          </Show>
        </div>
      )}
    </Show>
  );
}

// A path's points and the picked point's handles while its points are edited, on screen.
function PathPoints(props: { node: DesignNode; world: Rigid; toScreen: (p: Point) => Point; picked: { path: number; index: number } | null }) {
  const paths = () => mapPaths(scaledPaths(props.node.props.vector!, props.node.width, props.node.height), (p) => props.toScreen(apply(props.world, p)));
  const picked = () => (props.picked ? paths()[props.picked.path]?.points[props.picked.index] : undefined);
  return (
    <>
      <svg class="design-draw-path editing" aria-hidden="true">
        <path d={pathData(paths())} />
        <Show when={picked()}>
          {(a) => (
            <>
              <Show when={a().in}><path class="handle" d={`M ${a().x} ${a().y} L ${a().in!.x} ${a().in!.y}`} /></Show>
              <Show when={a().out}><path class="handle" d={`M ${a().x} ${a().y} L ${a().out!.x} ${a().out!.y}`} /></Show>
            </>
          )}
        </Show>
      </svg>
      <Index each={paths()}>
        {(s, i) => (
          <Index each={s().points}>
            {(a, j) => (
              <span class="design-anchor" data-anchor={`${i}:${j}:point`}
                classList={{ picked: props.picked?.path === i && props.picked.index === j }}
                style={{ transform: `translate(${a().x}px, ${a().y}px)` }} />
            )}
          </Index>
        )}
      </Index>
      <Show when={props.picked && picked()}>
        {(a) => (
          <>
            <Show when={a().in}>
              <span class="design-anchor handle" data-anchor={`${props.picked!.path}:${props.picked!.index}:in`}
                style={{ transform: `translate(${a().in!.x}px, ${a().in!.y}px)` }} />
            </Show>
            <Show when={a().out}>
              <span class="design-anchor handle" data-anchor={`${props.picked!.path}:${props.picked!.index}:out`}
                style={{ transform: `translate(${a().out!.x}px, ${a().out!.y}px)` }} />
            </Show>
          </>
        )}
      </Show>
    </>
  );
}

function TextEditor(props: { node: DesignNode; resolve: Resolve; onDone: (text: string) => void }) {
  let el!: HTMLDivElement;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    props.onDone(el.innerText.replace(/\n$/, ""));
  };
  onMount(() => {
    el.textContent = props.node.props.text;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
  });
  onCleanup(finish);
  return (
    <div ref={el} class="design-text design-text-editing" classList={{ wrap: props.node.props.sizing !== "width" }}
      role="textbox" aria-multiline="true" aria-label="Layer text" tabIndex={0}
      style={textStyle(props.node, props.resolve)}
      contentEditable="plaintext-only" spellcheck={false}
      onBlur={finish}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) el.blur();
      }}
      onPointerDown={(e) => e.stopPropagation()} />
  );
}

const round = (v: number) => Math.round(v * 100) / 100;
const angle = (c: Point, p: Point) => (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI;
const overlaps = (a: Rect, b: Rect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

// Shift on a line: the end turns in 45 degree steps around the start.
function snapAngle(from: Point, to: Point): Point {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const a = Math.round(Math.atan2(to.y - from.y, to.x - from.x) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: from.x + Math.cos(a) * length, y: from.y + Math.sin(a) * length };
}

// A line from a to b (page points) as a box in a parent: as long as the line, no height, turned to its angle.
function lineBox(a: Point, b: Point, parent: Rigid) {
  const width = Math.hypot(b.x - a.x, b.y - a.y);
  const world: Rigid = { origin: a, angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI };
  return boxAt(world, parent, width, 0);
}
