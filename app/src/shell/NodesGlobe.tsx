// A globe with the workspace's nodes and the members who share their location, each joined to the node they use and
// to the members it is connected to directly.
// Drag to turn it, scroll to zoom, right or middle drag (or Shift+drag) to move it a little; double click puts it back.
// It turns slowly by itself, easing back up to speed after being left alone, unless motion is reduced or the app saves
// power (core/power.ts; data dots hold still then too). Connections arc above the surface; while data goes over one,
// it is dotted and the dots move the way the data goes. Drawn on a
// canvas in the theme's colors, only while it is in view and only on frames where something moved or changed; turning
// by itself at most `idleFrameMs` apart, and not at all while the window isn't focused. Land and graticule are turned
// from vectors worked out once (`trace`), not drawn by d3's path, whose clipping and resampling took ~7 ms a frame.
// Points of one place (members of one time zone) spread around it as a crowd (`globeSpread.ts`); those who don't fit
// are a crowd badge, which shows the crowd card on hover and keeps it open on a click (a second click, Escape or a
// click beside it closes it). The globe holds still while a card shows.
import { geoDistance, geoGraticule10, geoInterpolate, geoOrthographic, geoRotation } from "d3-geo";
import type { Geometry } from "geojson";
import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack, type JSX } from "solid-js";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import { powerSaving } from "../core/power";
import { createPresence } from "../ui/presence";
import { groupPlaces, layout, type CrowdBadge, type Spread } from "./globeSpread";

export interface GlobePoint {
  key: string;
  lon: number;
  lat: number;
  kind: "node" | "member";
  label: string;
  // Nodes: reached now.
  online?: boolean;
  // The signed-in member: ringed and labelled "You".
  self?: boolean;
}

export interface GlobeLine {
  // Points' keys: a line ends at its point's spot in a crowd, or at the crowd's badge.
  from: string;
  to: string;
  // "node": a member and a node it uses; "member": two members connected directly.
  kind: "node" | "member";
  // Data going over it now: 1 from `from` to `to`, -1 the other way, 0 both ways; undefined when idle.
  flow?: 1 | -1 | 0;
}

// Lines of [lon, lat] points as unit vectors, three numbers a point, so a frame only turns and flattens them.
type Vectors = Float64Array[];
function toVectors(lines: number[][][]): Vectors {
  return lines.map((line) => {
    const out = new Float64Array(line.length * 3);
    line.forEach(([lon, lat], i) => {
      const l = (lon * Math.PI) / 180;
      const p = (lat * Math.PI) / 180;
      out[i * 3] = Math.cos(p) * Math.cos(l);
      out[i * 3 + 1] = Math.cos(p) * Math.sin(l);
      out[i * 3 + 2] = Math.sin(p);
    });
    return out;
  });
}

function ringsOf(geometry: Geometry): number[][][] {
  if (geometry.type === "Polygon") return geometry.coordinates;
  if (geometry.type === "MultiPolygon") return geometry.coordinates.flat();
  if (geometry.type === "GeometryCollection") return geometry.geometries.flatMap(ringsOf);
  return [];
}

let land: Promise<Vectors> | null = null;
function loadLand() {
  land ??= import("world-atlas/land-110m.json").then((m) => {
    const topology = m.default as unknown as Topology<{ land: GeometryCollection }>;
    const shapes = feature(topology, topology.objects.land);
    return toVectors(("features" in shapes ? shapes.features : [shapes]).flatMap((f) => ringsOf(f.geometry)));
  });
  return land;
}

// Degrees per second at full speed, and how long it takes to get there.
const turnSpeed = 5;
const speedUpMs = 3000;
const stillMs = 4000;
const minZoom = 1;
const maxZoom = 6;
const maxSize = 560;
// The least distance between two points of a crowd on screen, and how far a crowd may spread over the surface (at
// least three steps, when that is less on screen; never into a neighbouring crowd).
const step = 9;
const spreadDeg = 3;
// A crowd badge's pill.
const badgeHeight = 16;
// A pointer that moved less than this between down and up clicked.
const clickPx = 4;
// Dots of a line with data going over it, and how fast they move (px per second).
const dash = [3, 5];
const dashSpeed = 24;
// Frames drawn while it only turns by itself or moves its dots: each one projects all the land again (d3-geo), and on
// every frame of a high refresh display that kept the main thread busy all the time, so the whole app lagged while
// the Nodes page was open. 5°/s moves the surface under 1 px in that time. Dragging and zooming draw every frame.
const idleFrameMs = 33;
// How far past the allowed place the globe stretches while being moved, as a share of the view.
const panStretch = 0.12;
const graticule = toVectors(geoGraticule10().coordinates);
const colorNames = ["--mw-darker", "--mw-dark", "--mw-light", "--mw-border", "--mw-accent", "--mw-text", "--mw-text-muted", "--mw-text-disabled", "--mw-font-ui"] as const;
type Colors = Record<(typeof colorNames)[number], string>;

// What a crowd card shows: the hidden points' keys; `peek` while only hovered (a few rows), else all of them.
export interface CrowdCardProps {
  keys: string[];
  peek: boolean;
}

// A line as drawn: its ends where their points are now.
type Arc = { from: [number, number]; to: [number, number]; kind: GlobeLine["kind"]; flow: GlobeLine["flow"] };

export default function NodesGlobe(props: { points: GlobePoint[]; lines: GlobeLine[]; card?: (props: CrowdCardProps) => JSX.Element }) {
  let wrap!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  let stage!: HTMLDivElement;
  let cardBox: HTMLDivElement | undefined;
  const [size, setSize] = createSignal(320);
  const [shape, setShape] = createSignal<Vectors | null>(null);
  const [hover, setHover] = createSignal<GlobePoint | null>(null);
  // The crowd card: which badge (`CrowdBadge.id`), and whether a click keeps it open.
  const [card, setCard] = createSignal<{ id: string; pinned: boolean } | null>(null);
  const [cardKeys, setCardKeys] = createSignal<string[]>([]);
  const cardShown = createPresence(() => card() !== null);
  // The card as last shown, so it keeps its rows while it fades out.
  const lastCard = createMemo<{ id: string; pinned: boolean } | null>((last) => card() ?? last, null);
  let rotation: [number, number] = [-10, -30];
  // `last`: where the pointer was on the canvas at the previous move.
  let dragging: { x: number; y: number; last: [number, number]; pan: [number, number]; panning: boolean } | null = null;
  let pan: [number, number] = [0, 0];
  let panTarget: [number, number] = [0, 0];
  let dashOffset = 0;
  let frame = 0;
  let idleUntil = 0;
  // 0 to 1: how far into speeding up again.
  let spin = 0;
  let zoom = 1;
  let zoomTarget = 1;
  let last = performance.now();
  let drawnAt = 0;
  // Nobody watches it turn while the window isn't focused.
  let focused = document.hasFocus();
  // Something changed that the next frame has to show (new data, the pointer, the theme, the size).
  let dirty = true;
  // Theme colors, read again only when the theme changes (`theme/apply.ts` sets them on the root element). Reading
  // styles makes the browser work out the page's styles; read once a second, that was a hitch every second.
  let colors: Colors | null = null;
  const readColors = (): Colors => {
    if (!colors) {
      const css = getComputedStyle(canvas);
      colors = Object.fromEntries(colorNames.map((n) => [n, css.getPropertyValue(n).trim()])) as Colors;
    }
    return colors;
  };
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  // Members first, nodes on top: sorted once per new set of points, not on every frame.
  const sorted = createMemo(() => [...props.points].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "node" ? 1 : -1)));
  const places = createMemo(() => groupPlaces(props.points));
  const byKey = createMemo(() => new Map(props.points.map((p) => [p.key, p])));

  const projection = geoOrthographic().clipAngle(90);

  // Where each point on the near side is drawn: its own spot in its place's crowd, or counted in the crowd's badge.
  let spread: Spread = { spots: new Map(), ends: new Map(), badges: [] };
  // Each drawn badge's width, for hovering it.
  const badgeWidths = new Map<string, number>();
  const place = () => {
    const center: [number, number] = [-rotation[0], -rotation[1]];
    const front = places().filter((p) => geoDistance([p.lon, p.lat], center) < Math.PI / 2)
      .map((place) => ({ place, at: projection([place.lon, place.lat]) ?? [0, 0] as [number, number] }));
    spread = layout(front, { step, maxRadius: Math.max(step * 3, (projection.scale() * spreadDeg * Math.PI) / 180) });
  };

  // Lines between where their points are drawn now; lines of hidden members that end at the same badge are one line,
  // dotted while any of them carries data. A spot spread past the globe's edge (a crowd near it) has no place on the
  // surface: its line starts at the point's own place.
  const arcs = (): Arc[] => {
    const [cx, cy] = projection.translate();
    const radius = projection.scale();
    const at = (key: string): [number, number] | null => {
      const spot = spread.ends.get(key);
      if (spot && Math.hypot(spot[0] - cx, spot[1] - cy) < radius * 0.98) return projection.invert!(spot);
      const point = byKey().get(key);
      return point ? [point.lon, point.lat] : null;
    };
    const badgeOf = new Map<string, string>();
    for (const badge of spread.badges) for (const key of badge.keys) badgeOf.set(key, badge.id);
    const drawn = new Map<string, Arc>();
    for (const line of props.lines) {
      const from = at(line.from);
      const to = at(line.to);
      if (!from || !to) continue;
      const id = `${line.kind} ${badgeOf.get(line.from) ?? line.from} ${badgeOf.get(line.to) ?? line.to}`;
      const seen = drawn.get(id);
      if (!seen) drawn.set(id, { from, to, kind: line.kind, flow: line.flow });
      else if (line.flow !== undefined) seen.flow = seen.flow === undefined || seen.flow === line.flow ? line.flow : 0;
    }
    return [...drawn.values()];
  };

  // The card's size, kept by an observer: read on every frame, it made the browser work out the layout each time.
  let cardSize: [number, number] = [0, 0];
  const cardSizes = new ResizeObserver((entries) => {
    for (const { target } of entries) {
      // A card that closed meanwhile (one fading out while another opens) is let go.
      if (target !== cardBox) cardSizes.unobserve(target);
      else cardSize = [cardBox.offsetWidth, cardBox.offsetHeight];
    }
    mark();
  });
  onCleanup(() => cardSizes.disconnect());
  // The card follows its badge; it closes when the badge turns away or everyone fits again.
  const placeCard = () => {
    const open = card();
    if (!open) return;
    const badge = spread.badges.find((b) => b.id === open.id);
    if (!badge) {
      setCard(null);
      return;
    }
    const keys = cardKeys();
    if (keys.length !== badge.keys.length || keys.some((k, i) => k !== badge.keys[i])) setCardKeys(badge.keys);
    if (!cardBox) return;
    const px = size();
    const gap = (badgeWidths.get(badge.id) ?? 0) / 2 + 6;
    const [width, height] = cardSize;
    const right = badge.at[0] + gap;
    const left = right + width > px ? badge.at[0] - gap - width : right;
    const top = Math.min(Math.max(0, badge.at[1] - badgeHeight), Math.max(0, px - height));
    cardBox.style.transform = `translate(${Math.round(Math.max(0, left))}px, ${Math.round(top)}px)`;
  };

  const draw = () => {
    const context = canvas.getContext("2d");
    if (!context) return;
    const px = size();
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(px * ratio)) {
      canvas.width = Math.round(px * ratio);
      canvas.height = Math.round(px * ratio);
    }
    const c = readColors();
    const color = (name: keyof Colors) => c[name];
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, px, px);
    const radius = (px / 2 - 2) * zoom;
    const cx = px / 2 + pan[0];
    const cy = px / 2 + pan[1];
    projection.scale(radius).translate([cx, cy]).rotate(rotation);

    context.beginPath();
    context.arc(cx, cy, radius, 0, Math.PI * 2);
    context.fillStyle = color("--mw-darker");
    context.fill();
    context.beginPath();
    trace(context, graticule, rotation, cx, cy, radius, false);
    context.strokeStyle = color("--mw-light");
    context.lineWidth = 0.5;
    context.stroke();
    const landShape = shape();
    if (landShape) {
      context.beginPath();
      trace(context, landShape, rotation, cx, cy, radius, true);
      context.fillStyle = color("--mw-light");
      context.fill();
    }
    context.beginPath();
    context.arc(cx, cy, radius, 0, Math.PI * 2);
    context.strokeStyle = color("--mw-border");
    context.lineWidth = 1;
    context.stroke();

    const accent = color("--mw-accent");
    const rotate = geoRotation(rotation);
    place();
    const lines = arcs();
    for (const kind of ["member", "node"] as const) {
      context.strokeStyle = kind === "node" ? accent : color("--mw-text-muted");
      context.lineWidth = kind === "node" ? 1.2 : 0.8;
      for (const line of lines) {
        if (line.kind !== kind) continue;
        const busy = line.flow !== undefined;
        context.globalAlpha = busy ? 1 : kind === "node" ? 0.6 : 0.35;
        context.setLineDash(busy ? dash : []);
        // Drawn from `from` to `to`: a growing offset moves the dots backwards along it.
        context.lineDashOffset = line.flow === -1 ? dashOffset : -dashOffset;
        context.beginPath();
        arc(context, rotate, line, cx, cy, radius);
        context.stroke();
      }
    }
    context.setLineDash([]);
    context.globalAlpha = 1;

    context.font = `11px ${color("--mw-font-ui")}`;
    // Labels are drawn after the points, nodes' first; one that would cover a label already drawn is left out (nodes in
    // one crowd), hovering still names it.
    const labels: { text: string; x: number; y: number; node: boolean }[] = [];
    const label = (text: string, x: number, y: number, node = false) => labels.push({ text, x, y, node });
    for (const point of sorted()) {
      const spot = spread.spots.get(point.key);
      if (!spot) continue;
      const [x, y] = spot;
      if (point.kind === "member") {
        context.beginPath();
        context.arc(x, y, 3, 0, Math.PI * 2);
        context.fillStyle = point.self ? accent : color("--mw-text");
        context.fill();
        if (point.self) {
          context.beginPath();
          context.arc(x, y, 7, 0, Math.PI * 2);
          context.strokeStyle = accent;
          context.lineWidth = 1.5;
          context.stroke();
          label("You", x + 10, y + 4);
        }
        continue;
      }
      context.fillStyle = point.online ? accent : color("--mw-text-disabled");
      context.fillRect(x - 5, y - 5, 10, 10);
      label(point.label, x + 8, y + 4, true);
    }
    const labelled: [number, number, number][] = [];
    context.fillStyle = color("--mw-text");
    labels.sort((a, b) => Number(b.node) - Number(a.node));
    for (const { text, x, y } of labels) {
      const width = context.measureText(text).width;
      if (labelled.some(([lx, ly, lw]) => x < lx + lw && lx < x + width && Math.abs(ly - y) < 12)) continue;
      labelled.push([x, y, width]);
      context.fillText(text, x, y);
    }

    const open = card()?.id;
    badgeWidths.clear();
    for (const badge of spread.badges) {
      const text = `+${badge.keys.length}`;
      const width = context.measureText(text).width + 10;
      badgeWidths.set(badge.id, width);
      const [x, y] = badge.at;
      context.beginPath();
      context.roundRect(x - width / 2, y - badgeHeight / 2, width, badgeHeight, badgeHeight / 2);
      context.fillStyle = color("--mw-dark");
      context.fill();
      context.strokeStyle = badge.id === open ? accent : color("--mw-border");
      context.lineWidth = 1;
      context.stroke();
      context.fillStyle = color("--mw-text");
      context.fillText(text, x - width / 2 + 5, y + 4);
    }
    placeCard();

    const shown = hover();
    const shownAt = shown && spread.spots.get(shown.key);
    if (shown && shownAt) {
      const [x, y] = shownAt;
      const width = context.measureText(shown.label).width + 12;
      const left = Math.min(Math.max(4, x - width / 2), px - width - 4);
      context.fillStyle = color("--mw-dark");
      context.fillRect(left, y - 30, width, 20);
      context.fillStyle = color("--mw-text");
      context.fillText(shown.label, left + 6, y - 16);
    }
  };

  // Runs only while the globe is in view (`visible`) and something moves or changed, and draws only those frames. At
  // rest (not turning by itself: reduced motion, saving power, the window unfocused) the loop stops; `wake` starts it
  // again, and the end of a pause after a drag or a card wakes it by a timer.
  let visible = true;
  let rest: ReturnType<typeof setTimeout> | undefined;
  const wake = () => {
    if (frame || !visible) return;
    last = performance.now();
    frame = requestAnimationFrame(tick);
  };
  const mark = () => {
    dirty = true;
    wake();
  };
  const tick = (now: number) => {
    // Capped, so a frame after the tab was hidden or the globe out of view doesn't jump.
    const dt = Math.min(100, now - last);
    last = now;
    const canTurn = !(dragging || reduced.matches || powerSaving() || !focused || card());
    const turning = canTurn && now >= idleUntil;
    if (!turning) spin = 0;
    else {
      spin = Math.min(1, spin + dt / speedUpMs);
      // Eased in and out: starts gently, settles into the full speed.
      // Slower when zoomed in, so the surface doesn't race past.
      const speed = (turnSpeed * spin * spin * (3 - 2 * spin)) / zoom;
      // Kept within -180..180 so the number never grows.
      rotation = [((rotation[0] + (speed * dt) / 1000 + 540) % 360) - 180, rotation[1]];
    }
    const ease = Math.min(1, dt / 120);
    const zooming = Math.abs(zoomTarget - zoom) > 1e-3;
    zoom = zooming ? zoom + (zoomTarget - zoom) * ease : zoomTarget;
    // Let go of, the globe springs back to where its edge stays out of view.
    if (!dragging?.panning) panTarget = clampPan(panTarget, 0);
    const back = Math.min(1, dt / 70);
    const moving = Math.abs(panTarget[0] - pan[0]) > 0.05 || Math.abs(panTarget[1] - pan[1]) > 0.05;
    pan = moving ? [pan[0] + (panTarget[0] - pan[0]) * back, pan[1] + (panTarget[1] - pan[1]) * back] : panTarget;
    // Dots move only on lines with data going over them.
    const dots = focused && !reduced.matches && !powerSaving() && props.lines.some((line) => line.flow !== undefined);
    if (dots) dashOffset = (dashOffset + (dashSpeed * dt) / 1000) % (dash[0] + dash[1]);
    if (zooming || moving || dirty || ((turning || dots) && now - drawnAt >= idleFrameMs)) {
      dirty = false;
      drawnAt = now;
      draw();
    }
    if (visible && (turning || dots || zooming || moving || dirty)) {
      frame = requestAnimationFrame(tick);
      return;
    }
    frame = 0;
    clearTimeout(rest);
    if (visible && canTurn && now < idleUntil) rest = setTimeout(wake, idleUntil - now);
  };

  // How far the globe may be off center without its edge coming into the view (none at full size), plus `stretch`
  // of the view while it is being moved.
  const clampPan = (target: [number, number], stretch: number): [number, number] => {
    const half = size() / 2;
    const limit = Math.max(0, (half - 2) * Math.max(zoom, zoomTarget) - half) + size() * stretch;
    const clamp = (v: number) => Math.max(-limit, Math.min(limit, v));
    return [clamp(target[0]), clamp(target[1])];
  };

  // Turns the globe so the surface point under `from` (canvas px) moves to `to`, north kept up. Off the globe, by the
  // distance moved instead.
  const turn = (from: [number, number], to: [number, number]) => {
    const [cx, cy] = projection.translate();
    const radius = projection.scale();
    const onGlobe = (p: [number, number]) => Math.hypot(p[0] - cx, p[1] - cy) < radius * 0.98;
    const a = onGlobe(from) ? projection.invert!(from) : null;
    const b = onGlobe(to) ? projection.invert!(to) : null;
    let dLon: number;
    let dLat: number;
    if (a && b) {
      dLon = ((b[0] - a[0] + 540) % 360) - 180;
      dLat = b[1] - a[1];
    } else {
      const k = 180 / Math.PI / radius;
      dLon = (to[0] - from[0]) * k;
      dLat = -(to[1] - from[1]) * k;
    }
    const step = (v: number) => Math.max(-30, Math.min(30, v));
    rotation = [((rotation[0] + step(dLon) + 540) % 360) - 180, Math.max(-80, Math.min(80, rotation[1] + step(dLat)))];
  };

  onMount(() => {
    void loadLand().then(setShape, (e) => console.warn("Globe map not loaded:", e));
    const observer = new ResizeObserver(() => setSize(Math.min(maxSize, Math.floor(wrap.clientWidth))));
    observer.observe(wrap);
    mark();
    // Out of view (scrolled away on the Nodes page) it doesn't turn or draw; back in view it goes on where it was.
    const inView = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) mark();
    });
    inView.observe(wrap);
    const focus = () => {
      focused = true;
      wake();
    };
    const blur = () => (focused = false);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    // Reduced motion turned off in the system: it may turn again.
    reduced.addEventListener("change", wake);
    // A new theme: its colors are read again on the next frame.
    const themeChange = new MutationObserver(() => {
      colors = null;
      mark();
    });
    themeChange.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    // Not passive, so scrolling over the globe zooms instead of scrolling the page.
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomTarget = Math.max(minZoom, Math.min(maxZoom, zoomTarget * Math.exp(-e.deltaY * 0.0015)));
      wake();
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    onCleanup(() => {
      observer.disconnect();
      inView.disconnect();
      themeChange.disconnect();
      cancelAnimationFrame(frame);
      clearTimeout(rest);
      reduced.removeEventListener("change", wake);
      canvas.removeEventListener("wheel", wheel);
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
    });
  });
  // Faces the signed-in member the first time they are on it.
  let faced = false;
  createEffect(() => {
    const me = props.points.find((p) => p.self);
    if (!me || faced) return;
    faced = true;
    rotation = [-me.lon, Math.max(-80, Math.min(80, -me.lat))];
    mark();
  });
  // Shown on the next frame, also when not turning (reduced motion). Drawing at once drew some frames twice.
  createEffect(() => {
    void [sorted(), props.lines, shape(), size(), hover(), card()];
    mark();
  });
  // No longer saving power: it may turn again.
  createEffect(on(powerSaving, wake, { defer: true }));
  // A card kept open closes on Escape (before the page under it takes it) and on a click outside the globe; once
  // closed, the globe waits a moment before turning again.
  let cardWasOpen = false;
  createEffect(() => {
    if (card() === null) {
      if (cardWasOpen) idleUntil = performance.now() + stillMs;
      cardWasOpen = false;
      wake();
      return;
    }
    cardWasOpen = true;
    if (!card()!.pinned) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setCard(null);
    };
    const pointer = (e: PointerEvent) => {
      if (!stage.contains(e.target as Node)) setCard(null);
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", pointer, true);
    onCleanup(() => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", pointer, true);
    });
  });

  const canvasAt = (event: PointerEvent): [number, number] => {
    const box = canvas.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  };
  const badgeAt = ([x, y]: [number, number]): CrowdBadge | null =>
    spread.badges.find((b) => Math.abs(b.at[0] - x) <= (badgeWidths.get(b.id) ?? 0) / 2 && Math.abs(b.at[1] - y) <= badgeHeight / 2) ?? null;
  const pointAt = ([x, y]: [number, number]): GlobePoint | null => {
    let best: GlobePoint | null = null;
    let bestDistance = Infinity;
    for (const point of props.points) {
      const [px, py] = spread.spots.get(point.key) ?? [Infinity, Infinity];
      const distance = Math.hypot(px - x, py - y);
      // Within half a step of a crowd's dot, anywhere on a node's square.
      if (distance < (point.kind === "node" ? 8 : step / 2 + 1) && distance < bestDistance) {
        best = point;
        bestDistance = distance;
      }
    }
    return best;
  };
  // Hovering a badge peeks at its crowd; leaving it puts a peek away (a kept card stays).
  const hoverAt = (at: [number, number]) => {
    const badge = badgeAt(at);
    setHover(badge ? null : pointAt(at));
    if (card()?.pinned) return;
    if (!badge) setCard(null);
    else if (card()?.id !== badge.id) {
      setCardKeys(badge.keys);
      setCard({ id: badge.id, pinned: false });
    }
  };
  let downAt: [number, number] | null = null;
  // A click on a badge keeps its card open, or closes it when it was kept open; a click beside it closes it.
  const click = (at: [number, number]) => {
    const badge = badgeAt(at);
    const open = card();
    if (badge && !(open?.pinned && open.id === badge.id)) {
      setCardKeys(badge.keys);
      setCard({ id: badge.id, pinned: true });
    } else if (open) setCard(null);
  };

  return (
    <div class="nodes-globe" ref={wrap}>
      <div class="nodes-globe-stage" ref={stage}>
        <canvas ref={canvas} style={{ width: `${size()}px`, height: `${size()}px` }} role="img"
          aria-label={`Globe with ${props.points.filter((p) => p.kind === "node").length} nodes and ${props.points.filter((p) => p.kind === "member").length} members`}
          onPointerDown={(e) => {
            canvas.setPointerCapture(e.pointerId);
            const at = canvasAt(e);
            downAt = at;
            dragging = { x: e.clientX, y: e.clientY, last: at, pan: panTarget, panning: e.button !== 0 || e.shiftKey };
          }}
          onContextMenu={(e) => e.preventDefault()}
          onPointerMove={(e) => {
            if (!dragging) {
              hoverAt(canvasAt(e));
              return;
            }
            if (dragging.panning) {
              panTarget = pan = clampPan([dragging.pan[0] + e.clientX - dragging.x, dragging.pan[1] + e.clientY - dragging.y], panStretch);
              mark();
              return;
            }
            const box = canvas.getBoundingClientRect();
            const at: [number, number] = [e.clientX - box.left, e.clientY - box.top];
            turn(dragging.last, at);
            dragging.last = at;
            mark();
          }}
          onPointerUp={(e) => {
            if (!dragging?.panning) idleUntil = performance.now() + stillMs;
            const at = canvasAt(e);
            if (e.button === 0 && downAt && Math.hypot(at[0] - downAt[0], at[1] - downAt[1]) < clickPx) click(at);
            dragging = null;
            downAt = null;
            wake(); // springs back from a pan, and turns again after the pause
          }}
          onDblClick={() => {
            zoomTarget = minZoom;
            panTarget = [0, 0];
            wake();
          }}
          onPointerLeave={() => {
            setHover(null);
            if (!card()?.pinned) setCard(null);
          }} />
        <Show when={cardShown.mounted() && props.card}>
          <div ref={(box) => {
            cardBox = box;
            cardSizes.observe(box);
          }} class="nodes-globe-card mw-box mw-scroll-fade" classList={{ shown: cardShown.visible(), pinned: lastCard()?.pinned }}>
            {untrack(() => props.card!({ get keys() { return cardKeys(); }, get peek() { return !lastCard()?.pinned; } }))}
          </div>
        </Show>
      </div>
    </div>
  );
}

// Adds `lines` to the context's path, turned by `rotation` the way geoOrthographic's `rotate` does it and flattened onto
// the view. Filled rings (`fill`) keep their points behind the globe, moved onto its edge, so a fill stops there; stroked
// lines break where they go behind.
let flat = new Float64Array(0);
function trace(
  context: CanvasRenderingContext2D, lines: Vectors, rotation: [number, number], cx: number, cy: number, radius: number, fill: boolean,
) {
  const lambda = (rotation[0] * Math.PI) / 180;
  const phi = (rotation[1] * Math.PI) / 180;
  const cl = Math.cos(lambda);
  const sl = Math.sin(lambda);
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  for (const line of lines) {
    if (flat.length < line.length) flat = new Float64Array(line.length * 2);
    // Screen x, y per point, and whether it is in front (NaN x for a point behind a stroked line).
    let front = false;
    let n = 0;
    for (let i = 0; i < line.length; i += 3) {
      const x1 = line[i] * cl - line[i + 1] * sl;
      let y = line[i] * sl + line[i + 1] * cl;
      let z = line[i + 2] * cp + x1 * sp;
      if (x1 * cp - line[i + 2] * sp >= 0) front = true;
      else if (!fill) y = Number.NaN;
      else {
        const h = Math.hypot(y, z);
        // Straight behind the middle: no way to the edge is better than another.
        if (h < 1e-9) continue;
        y /= h;
        z /= h;
      }
      flat[n++] = cx + radius * y;
      flat[n++] = cy - radius * z;
    }
    if (!front) continue;
    let drawing = false;
    for (let i = 0; i < n; i += 2) {
      if (Number.isNaN(flat[i])) {
        drawing = false;
        continue;
      }
      if (drawing) context.lineTo(flat[i], flat[i + 1]);
      else context.moveTo(flat[i], flat[i + 1]);
      drawing = true;
    }
    if (fill) context.closePath();
  }
}

// A connection as an arc above the surface, higher for longer ones. Drawn in 3D (d3's paths stay on the surface): a
// point behind the globe still shows where the arc rises past its edge.
function arc(
  context: CanvasRenderingContext2D, rotate: (p: [number, number]) => [number, number], line: Arc, cx: number, cy: number, radius: number,
) {
  const between = geoInterpolate(line.from, line.to);
  const height = 0.04 + 0.16 * (geoDistance(line.from, line.to) / Math.PI);
  const steps = 40;
  let drawing = false;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const [lon, lat] = rotate(between(t)).map((d) => (d * Math.PI) / 180);
    const lift = 1 + height * Math.sin(Math.PI * t);
    const x = Math.cos(lat) * Math.sin(lon) * lift;
    const y = Math.sin(lat) * lift;
    const visible = Math.cos(lat) * Math.cos(lon) > 0 || Math.hypot(x, y) > 1;
    if (!visible) {
      drawing = false;
      continue;
    }
    const sx = cx + radius * x;
    const sy = cy - radius * y;
    if (drawing) context.lineTo(sx, sy);
    else context.moveTo(sx, sy);
    drawing = true;
  }
}
