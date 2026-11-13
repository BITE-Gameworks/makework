import { Icon } from "../../../theme/icons";

// Zoom controls over a canvas's bottom left corner (design, diagram). Its parent needs `position: relative`.
export default function ZoomBar(props: {
  zoom: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onActual: () => void;
  onFit: () => void;
  fitLabel: string;
  keys?: { out: string; in: string; actual: string; fit: string };
}) {
  const hint = (label: string, key?: string) => (key ? `${label} (${key})` : label);
  return (
    <div class="canvas-zoom-bar" onPointerDown={(e) => e.stopPropagation()} onDblClick={(e) => e.stopPropagation()}>
      <button class="icon-button" title={hint("Zoom out", props.keys?.out)} aria-label="Zoom out" onClick={() => props.onZoomOut()}>
        <Icon name="zoom-out" />
      </button>
      <button class="canvas-zoom" title={hint("Actual size", props.keys?.actual)} onClick={() => props.onActual()}>
        {Math.round(props.zoom * 100)}%
      </button>
      <button class="icon-button" title={hint("Zoom in", props.keys?.in)} aria-label="Zoom in" onClick={() => props.onZoomIn()}>
        <Icon name="zoom-in" />
      </button>
      <button class="icon-button" title={hint(props.fitLabel, props.keys?.fit)} aria-label={props.fitLabel} onClick={() => props.onFit()}>
        <Icon name="fit-all" />
      </button>
    </div>
  );
}
