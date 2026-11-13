import type { Point, Rect } from "./geometry";

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export const minZoom = 0.02;
export const maxZoom = 64;
export const clampZoom = (zoom: number) => Math.min(maxZoom, Math.max(minZoom, zoom));

export const toWorld = (view: Viewport, screen: Point): Point => ({
  x: (screen.x - view.x) / view.zoom,
  y: (screen.y - view.y) / view.zoom,
});

export const toScreen = (view: Viewport, world: Point): Point => ({
  x: world.x * view.zoom + view.x,
  y: world.y * view.zoom + view.y,
});

export function zoomAt(view: Viewport, point: Point, zoom: number): Viewport {
  const next = clampZoom(zoom);
  return {
    zoom: next,
    x: point.x - ((point.x - view.x) / view.zoom) * next,
    y: point.y - ((point.y - view.y) / view.zoom) * next,
  };
}

export function fitViewport(
  rects: Rect[],
  width: number,
  height: number,
  margin = 48,
  animateZoomLimit = maxZoom,
): Viewport {
  if (rects.length === 0) return { x: width / 2, y: height / 2, zoom: 1 };
  const bounds = {
    left: Math.min(...rects.map((r) => r.left)),
    top: Math.min(...rects.map((r) => r.top)),
    right: Math.max(...rects.map((r) => r.right)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
  };
  const zoom = clampZoom(Math.min(
    (width - margin * 2) / Math.max(1, bounds.right - bounds.left),
    (height - margin * 2) / Math.max(1, bounds.bottom - bounds.top),
    rects.length === 1 ? 4 : animateZoomLimit,
  ));
  return {
    zoom,
    x: width / 2 - ((bounds.left + bounds.right) / 2) * zoom,
    y: height / 2 - ((bounds.top + bounds.bottom) / 2) * zoom,
  };
}
