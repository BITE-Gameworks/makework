import { clampZoom, type Viewport } from "./camera";
import type { Point } from "./geometry";

// Two fingers on a canvas pan and pinch-zoom it. A second finger cancels what the first one started; until every
// finger has lifted, the touches belong to the pinch. Each pointer handler asks first and stops when it returns true.
export function createPinch(opts: {
  view: () => Viewport;
  setView: (view: Viewport) => void;
  local: (e: { clientX: number; clientY: number }) => Point;
  cancel: () => void;
}) {
  const touches = new Map<number, Point>();
  let pinch: { from: Viewport; center: Point; distance: number } | null = null;
  let held = false;

  const measure = () => {
    const [a, b] = [...touches.values()];
    return { center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
  };

  const down = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return false;
    touches.set(e.pointerId, opts.local(e));
    if (touches.size < 2) return held;
    if (!pinch) {
      opts.cancel();
      held = true;
      pinch = { from: opts.view(), ...measure() };
    }
    (e.currentTarget as Element | null)?.setPointerCapture(e.pointerId);
    e.preventDefault();
    return true;
  };

  const move = (e: PointerEvent) => {
    if (e.pointerType !== "touch" || !touches.has(e.pointerId)) return false;
    touches.set(e.pointerId, opts.local(e));
    if (!pinch) return held;
    if (touches.size < 2) return true;
    const now = measure();
    const { from, center } = pinch;
    const zoom = clampZoom(from.zoom * (now.distance / pinch.distance));
    const world = { x: (center.x - from.x) / from.zoom, y: (center.y - from.y) / from.zoom };
    opts.setView({ zoom, x: now.center.x - world.x * zoom, y: now.center.y - world.y * zoom });
    return true;
  };

  const up = (e: PointerEvent) => {
    if (e.pointerType !== "touch" || !touches.delete(e.pointerId)) return false;
    if (touches.size < 2) pinch = null;
    const wasHeld = held;
    if (touches.size === 0) held = false;
    return wasHeld;
  };

  return { down, move, up };
}
