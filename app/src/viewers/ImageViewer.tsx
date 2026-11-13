// Fit to the window, zoom around the cursor with the wheel or buttons, drag to pan, double-click for 100%.
import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { FileContext } from "../plugins/types";
import { Icon } from "../theme/icons";
import { copyImage } from "../core/clipboardImage";
import { createObjectUrl } from "./content";

const minScale = 0.05;
const maxScale = 16;
const step = 1.25;

export default function ImageViewer(props: { file: FileContext }) {
  const url = createObjectUrl(props.file);
  const [natural, setNatural] = createSignal({ width: 0, height: 0 });
  const [box, setBox] = createSignal({ width: 0, height: 0 });
  const [view, setView] = createSignal<{ fit: boolean; scale: number; x: number; y: number }>({ fit: true, scale: 1, x: 0, y: 0 });
  const [dragging, setDragging] = createSignal(false);
  let stage!: HTMLDivElement;

  const [copied, setCopied] = createSignal(false);
  const copy = () => void copyImage(props.file.read()).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, (e) => console.warn("Image not copied:", e));

  const ready = () => natural().width > 0 && box().width > 0;
  const [settled, setSettled] = createSignal(false);
  createEffect(() => {
    if (!ready()) return;
    const frame = requestAnimationFrame(() => setSettled(true));
    onCleanup(() => cancelAnimationFrame(frame));
  });

  const fitScale = () => {
    const n = natural();
    const b = box();
    return n.width && b.width ? Math.min(1, (b.width - 32) / n.width, (b.height - 32) / n.height) : 1;
  };
  const scale = () => (view().fit ? fitScale() : view().scale);

  onMount(() => {
    const observer = new ResizeObserver(([entry]) => setBox({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(stage);
    onCleanup(() => observer.disconnect());
  });

  // Keeps the image point under (px, py) in place, in stage coordinates from the center.
  const zoomTo = (next: number, px = 0, py = 0) => {
    const v = view();
    const current = scale();
    const target = Math.min(maxScale, Math.max(minScale, next));
    const ratio = target / current;
    setView({ fit: false, scale: target, x: px - (px - (v.fit ? 0 : v.x)) * ratio, y: py - (py - (v.fit ? 0 : v.y)) * ratio });
  };

  const fromCenter = (e: MouseEvent) => {
    const rect = stage.getBoundingClientRect();
    return [e.clientX - rect.left - rect.width / 2, e.clientY - rect.top - rect.height / 2] as const;
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const [px, py] = fromCenter(e);
    zoomTo(scale() * Math.pow(step, -Math.sign(e.deltaY)), px, py);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || view().fit) return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    setDragging(true);
    const start = { x: e.clientX, y: e.clientY, vx: view().x, vy: view().y };
    const move = (m: PointerEvent) => setView({ ...view(), x: start.vx + m.clientX - start.x, y: start.vy + m.clientY - start.y });
    const end = () => {
      stage.removeEventListener("pointermove", move);
      stage.removeEventListener("pointerup", end);
      stage.removeEventListener("pointercancel", end);
      setDragging(false);
    };
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
  };

  const onDoubleClick = (e: MouseEvent) => {
    if (!view().fit) setView({ fit: true, scale: 1, x: 0, y: 0 });
    else {
      const [px, py] = fromCenter(e);
      zoomTo(1, px, py);
    }
  };

  return (
    <div class="image-viewer">
      <div class="image-stage" ref={stage} classList={{ zoomed: !view().fit, dragging: dragging() }}
        onWheel={onWheel} onPointerDown={onPointerDown} onDblClick={onDoubleClick}>
        <Show when={url()}>
          {(src) => (
            <img src={src()} alt={props.file.name} draggable={false}
              onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
              style={{
                width: natural().width ? `${natural().width}px` : undefined,
                // Hidden until its size and the stage's are known, or it shows at full size and then shrinks.
                opacity: ready() ? 1 : 0,
                // Zoom animates only once the first fit is in place, so the picture doesn't shrink into view.
                transition: settled() ? undefined : "none",
                transform: `translate(-50%, -50%) translate(${view().fit ? 0 : view().x}px, ${view().fit ? 0 : view().y}px) scale(${scale()})`,
              }} />
          )}
        </Show>
      </div>
      <div class="viewer-toolbar mw-box">
        <button class="icon-button" title="Zoom out" aria-label="Zoom out" onClick={() => zoomTo(scale() / step)}>
          <Icon name="zoom-out" />
        </button>
        <span class="viewer-zoom">{Math.round(scale() * 100)}%</span>
        <button class="icon-button" title="Zoom in" aria-label="Zoom in" onClick={() => zoomTo(scale() * step)}>
          <Icon name="zoom-in" />
        </button>
        <button class="mw-button mw-box" classList={{ active: view().fit }} onClick={() => setView({ fit: true, scale: 1, x: 0, y: 0 })}>Fit</button>
        <button class="mw-button mw-box" onClick={() => zoomTo(1)}>100%</button>
        <button class="icon-button" title={copied() ? "Image copied!" : "Copy image"} aria-label="Copy image" onClick={copy}>
          <Icon name={copied() ? "check" : "copy"} />
        </button>
        <Show when={natural().width}>
          <span class="muted">{natural().width} x {natural().height}</span>
        </Show>
      </div>
    </div>
  );
}
