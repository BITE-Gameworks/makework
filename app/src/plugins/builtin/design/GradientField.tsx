import { Show, createSignal, For } from "solid-js";
import { Icon } from "../../../theme/icons";
import Select from "../../../ui/Select";
import { ColorField, NumberField } from "./fields";
import { cssGradient, type Gradient, type GradientKind, type GradientStop } from "./model";

const kindOptions: { value: GradientKind | "solid"; label: string }[] = [
  { value: "solid", label: "Solid" }, { value: "linear", label: "Linear" }, { value: "radial", label: "Radial" },
];

// The stop shown first, whose color a paint keeps as its one color.
export const firstStop = (g: Gradient): GradientStop => [...g.stops].sort((a, b) => a.position - b.position)[0];

// A fill's kind: solid, or a linear or radial gradient.
export function PaintKind(props: { value: GradientKind | "solid"; onChange: (kind: GradientKind | "solid") => void }) {
  return <Select label="Fill type" class="design-paint-kind" value={props.value} options={kindOptions} onChange={props.onChange} />;
}

// A gradient's stops on a bar (drag a stop to move it, click the bar to add one), the picked stop's color and place,
// and a linear gradient's angle.
export default function GradientField(props: {
  gradient: Gradient;
  opacity: number;
  onPreview: (g: Gradient) => void;
  onCommit: (g: Gradient, label: string) => void;
}) {
  const [picked, setPicked] = createSignal(0);
  const index = () => Math.min(picked(), props.gradient.stops.length - 1);
  const stop = () => props.gradient.stops[index()];
  const withStop = (i: number, part: Partial<GradientStop>): Gradient =>
    ({ ...props.gradient, stops: props.gradient.stops.map((s, j) => (j === i ? { ...s, ...part } : s)) });
  let bar!: HTMLDivElement;
  const at = (e: PointerEvent) => {
    const r = bar.getBoundingClientRect();
    return Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 100) / 100;
  };
  const drag = (i: number) => (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setPicked(i);
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    let moved: Gradient | null = null;
    const move = (ev: PointerEvent) => props.onPreview((moved = withStop(i, { position: at(ev) })));
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      if (moved) props.onCommit(moved, "Move gradient stop");
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  const add = (e: PointerEvent) => {
    if (e.button !== 0 || e.target !== bar) return;
    const { color, opacity } = stop();
    setPicked(props.gradient.stops.length);
    props.onCommit({ ...props.gradient, stops: [...props.gradient.stops, { color, opacity, position: at(e) }] }, "Add gradient stop");
  };
  const remove = () => {
    const stops = props.gradient.stops.filter((_, j) => j !== index());
    setPicked(0);
    props.onCommit({ ...props.gradient, stops }, "Remove gradient stop");
  };
  return (
    <div class="design-gradient">
      <div ref={bar} class="design-gradient-bar mw-box" title="Click to add a stop, drag a stop to move it"
        style={{ "--gradient": cssGradient({ ...props.gradient, kind: "linear", angle: 90 }, props.opacity) }} onPointerDown={add}>
        <For each={props.gradient.stops}>
          {(s, i) => (
            <button class="design-gradient-stop mw-box" classList={{ on: index() === i() }} style={{ left: `${s.position * 100}%`, "--swatch": s.color, "--alpha": s.opacity }}
              aria-label={`Stop at ${Math.round(s.position * 100)}%`} onPointerDown={drag(i())} onClick={() => setPicked(i())} />
          )}
        </For>
      </div>
      <div class="design-paint">
        <ColorField color={stop().color} opacity={stop().opacity}
          onPreview={(color, opacity) => props.onPreview(withStop(index(), { color, opacity }))}
          onCommit={(color, opacity) => props.onCommit(withStop(index(), { color, opacity }), "Change gradient stop")} />
        <button class="icon-button" title="Remove stop" aria-label="Remove stop" disabled={props.gradient.stops.length <= 2} onClick={remove}>
          <Icon name="remove" />
        </button>
      </div>
      <div class="design-grid">
        <NumberField label="At" title="Stop position (%)" value={stop().position} scale={100} decimals={0} min={0} max={1} suffix="%"
          onPreview={(position) => props.onPreview(withStop(index(), { position }))}
          onCommit={(position) => props.onCommit(withStop(index(), { position }), "Move gradient stop")} />
        <Show when={props.gradient.kind === "linear"}>
          <NumberField label={<Icon name="rotate" size={12} />} title="Angle" value={props.gradient.angle} decimals={0} suffix="°"
            onPreview={(angle) => props.onPreview({ ...props.gradient, angle: ((angle % 360) + 360) % 360 })}
            onCommit={(angle) => props.onCommit({ ...props.gradient, angle: ((angle % 360) + 360) % 360 }, "Turn gradient")} />
        </Show>
      </div>
    </div>
  );
}
