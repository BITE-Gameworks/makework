import "./ResizeHandle.css";

// A strip on an edge of a panel (its parent) that resizes it by dragging or with the arrow keys (Shift for bigger
// steps). `setWidth(null)` on double click goes back to the default size. On the top edge it sets the height.
export default function ResizeHandle(props: {
  edge: "left" | "right" | "top";
  label: string;
  setWidth: (width: number | null) => void;
  save?: () => void;
  onResizing?: (resizing: boolean) => void;
}) {
  // Dragging away from the panel's inside grows it.
  const sign = () => (props.edge === "right" ? 1 : -1);
  const vertical = () => props.edge === "top";
  const size = (panel: HTMLElement) => (vertical() ? panel.offsetHeight : panel.offsetWidth);
  const at = (e: PointerEvent) => (vertical() ? e.clientY : e.clientX);
  const start = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    const startWidth = size(handle.parentElement!);
    const startX = at(e);
    handle.setPointerCapture(e.pointerId);
    props.onResizing?.(true);
    const move = (ev: PointerEvent) => props.setWidth(startWidth + (at(ev) - startX) * sign());
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      props.onResizing?.(false);
      props.save?.();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  const keys = (e: KeyboardEvent) => {
    const width = size((e.currentTarget as HTMLElement).parentElement!);
    const step = (e.shiftKey ? 40 : 10) * sign();
    if (e.key === (vertical() ? "ArrowUp" : "ArrowLeft")) props.setWidth(width - step);
    else if (e.key === (vertical() ? "ArrowDown" : "ArrowRight")) props.setWidth(width + step);
    else return;
    e.preventDefault();
    props.save?.();
  };
  return (
    <div class={`mw-resize-handle ${props.edge}`} role="separator" aria-orientation={vertical() ? "horizontal" : "vertical"} aria-label={props.label} tabindex="0"
      title="Drag to resize, double click to reset" onPointerDown={start} onKeyDown={keys}
      onDblClick={() => {
        props.setWidth(null);
        props.save?.();
      }} />
  );
}
