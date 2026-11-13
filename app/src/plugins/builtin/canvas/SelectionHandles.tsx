import type { JSX } from "solid-js";

const handles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;

export default function SelectionHandles(props: {
  class?: string;
  style: JSX.CSSProperties;
  rotate?: boolean;
  size?: string;
}) {
  return (
    <div class={`canvas-selection ${props.class ?? ""}`} style={props.style}>
      {handles.map((handle) => <span class={`canvas-handle ${handle}`} data-handle={handle} />)}
      {props.rotate && <span class="canvas-handle rotate" data-handle="rotate" title="Rotate (Shift snaps)" />}
      {props.size && <span class="canvas-size">{props.size}</span>}
    </div>
  );
}
