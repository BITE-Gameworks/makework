import { createEffect, createSignal, type JSX } from "solid-js";
import ColorPicker from "../../../ui/ColorPicker";
import { toHex } from "./model";

const format = (v: number, decimals: number) => String(Math.round(v * 10 ** decimals) / 10 ** decimals);

// A number with a label that scrubs the value when dragged sideways. `value` null shows "Mixed".
// `onPreview` runs while scrubbing, `onCommit` once the value is final.
export function NumberField(props: {
  label: string | JSX.Element;
  title: string;
  value: number | null;
  onCommit: (v: number) => void;
  onPreview?: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  decimals?: number;
  suffix?: string;
  scale?: number;    // shown value = value * scale (100 for percentages)
}) {
  const scale = () => props.scale ?? 1;
  const clamp = (v: number) => Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, v));
  const shown = () => (props.value === null ? "" : format(props.value * scale(), props.decimals ?? 2));
  const [text, setText] = createSignal(shown());
  createEffect(() => setText(shown()));
  let input!: HTMLInputElement;

  const commitText = () => {
    const parsed = Number(text().replace(/[^0-9.+\-eE]/g, ""));
    if (text().trim() === "" || !Number.isFinite(parsed)) return setText(shown());
    const v = clamp(parsed / scale());
    if (v !== props.value) props.onCommit(v);
    else setText(shown());
  };

  const scrub = (e: PointerEvent) => {
    if (props.value === null || e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const start = props.value;
    const x0 = e.clientX;
    let last = start;
    const move = (m: PointerEvent) => {
      const step = (props.step ?? 1) * (m.shiftKey ? 10 : 1);
      last = clamp(start + Math.round((m.clientX - x0) / 2) * step / scale());
      props.onPreview?.(last);
      setText(format(last * scale(), props.decimals ?? 2));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      if (last !== start) props.onCommit(last);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  return (
    <label class="design-field" title={props.title}>
      <span class="design-field-label" onPointerDown={scrub}>{props.label}</span>
      <input ref={input} class="design-field-input" value={text()} placeholder={props.value === null ? "Mixed" : ""}
        onInput={(e) => setText(e.currentTarget.value)}
        onChange={commitText}
        onKeyDown={(e) => {
          if (e.key === "Enter") input.blur();
          else if (e.key === "Escape") { setText(shown()); input.blur(); }
          else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && props.value !== null) {
            e.preventDefault();
            const step = (props.step ?? 1) * (e.shiftKey ? 10 : 1) / scale();
            props.onCommit(clamp(props.value + (e.key === "ArrowUp" ? step : -step)));
          }
        }} />
      {props.suffix && <span class="design-field-suffix">{props.suffix}</span>}
    </label>
  );
}

// A color swatch with its hex code and opacity (left out when `opacity` is). Dragging in the system picker
// previews, closing it commits.
export function ColorField(props: {
  color: string;
  opacity?: number;
  onPreview: (color: string, opacity: number) => void;
  onCommit: (color: string, opacity: number) => void;
}) {
  const [hex, setHex] = createSignal(props.color);
  const alpha = () => props.opacity ?? 1;
  createEffect(() => setHex(props.color.replace("#", "").toUpperCase()));
  const commitHex = () => {
    let v = hex().trim().replace(/^#/, "");
    if (/^[0-9a-f]{3}$/i.test(v)) v = [...v].map((c) => c + c).join("");
    if (/^[0-9a-f]{6}$/i.test(v)) props.onCommit(`#${v.toLowerCase()}`, alpha());
    else setHex(props.color.replace("#", "").toUpperCase());
  };
  return (
    <div class="design-color">
      <ColorPicker class="design-swatch mw-box" value={toHex(props.color)} label="Pick a color"
        style={{ "--swatch": props.color, "--alpha": alpha() }}
        onPreview={(color) => props.onPreview(color, alpha())}
        onPick={(color) => props.onCommit(color, alpha())} />
      <input class="design-field-input hex" value={hex()} aria-label="Hex color" spellcheck={false}
        onInput={(e) => setHex(e.currentTarget.value)} onChange={commitHex}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
      {props.opacity !== undefined && (
        <NumberField label="%" title="Opacity (%)" value={props.opacity} scale={100} decimals={0}
          min={0} max={1} onPreview={(v) => props.onPreview(props.color, v)} onCommit={(v) => props.onCommit(props.color, v)} />
      )}
    </div>
  );
}

export function Section(props: { title: string; children: JSX.Element; actions?: JSX.Element }) {
  return (
    <section class="design-section">
      <header class="design-section-title"><span>{props.title}</span>{props.actions}</header>
      {props.children}
    </section>
  );
}
