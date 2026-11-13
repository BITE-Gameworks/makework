import { For, Match, Switch, createSignal, type JSX } from "solid-js";
import { readJson, writeJson } from "../core/storage";
import { hexToRgb, hslToHsv, hsvToHsl, hsvToRgb, parseHex, rgbToHex, rgbToHsv, type Hsv } from "./color";
import Popover from "./Popover";
import Select from "./Select";
import "./ColorPicker.css";

type Format = "hex" | "rgb" | "hsl";
const formatKey = "colorPicker.format";
const formats: { value: Format; label: string }[] = [{ value: "hex", label: "HEX" }, { value: "rgb", label: "RGB" }, { value: "hsl", label: "HSL" }];

// A swatch that opens a themed picker: saturation and brightness square, hue bar and fields in the format last used
// (HEX, RGB or HSL, remembered on this device). Dragging previews, letting go or editing a field picks.
export default function ColorPicker(props: {
  value: string;
  label: string;
  onPick: (color: string) => void;
  onPreview?: (color: string) => void;
  disabled?: boolean;
  class?: string;
  style?: JSX.CSSProperties;
}) {
  const [open, setOpen] = createSignal(false);
  const value = () => parseHex(props.value) ?? "#888888";
  // Kept as HSV so the hue stays put while the color is gray.
  const [hsv, setHsv] = createSignal<Hsv>(rgbToHsv(hexToRgb(value())));
  const [format, setFormat] = createSignal<Format>(readJson<Format>(formatKey, "hex"));
  const hex = () => rgbToHex(hsvToRgb(hsv()));

  const toggle = () => {
    if (!open()) setHsv(rgbToHsv(hexToRgb(value())));
    setOpen(!open());
  };
  const preview = (next: Hsv) => {
    setHsv(next);
    props.onPreview?.(hex());
  };
  const pick = (next = hsv()) => {
    setHsv(next);
    props.onPick(hex());
  };
  const pickHex = (text: string) => {
    const parsed = parseHex(text);
    if (parsed) pick({ ...rgbToHsv(hexToRgb(parsed)), ...(rgbToHsv(hexToRgb(parsed)).s === 0 ? { h: hsv().h } : {}) });
  };
  const chooseFormat = (next: Format) => {
    setFormat(next);
    writeJson(formatKey, next);
  };

  // Pointer drags on the square and the hue bar: preview while moving, pick on release.
  const drag = (event: PointerEvent, apply: (x: number, y: number) => Hsv) => {
    if (props.disabled) return;
    const element = event.currentTarget as HTMLElement;
    const at = (e: PointerEvent) => {
      const box = element.getBoundingClientRect();
      return apply(Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)), Math.max(0, Math.min(1, (e.clientY - box.top) / box.height)));
    };
    element.setPointerCapture(event.pointerId);
    preview(at(event));
    const move = (e: PointerEvent) => preview(at(e));
    const up = (e: PointerEvent) => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
      pick(at(e));
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
    event.preventDefault();
  };
  // Arrow keys on the square and the hue bar.
  const nudge = (event: KeyboardEvent, change: (step: number, key: string) => Hsv | null) => {
    const step = event.shiftKey ? 0.1 : 0.01;
    const next = change(step, event.key);
    if (!next) return;
    event.preventDefault();
    pick(next);
  };

  const rgb = () => hsvToRgb(hsv());
  const hsl = () => hsvToHsl(hsv());
  const field = (label: string, shown: () => number, max: number, set: (v: number) => Hsv) => (
    <label class="mw-color-field">
      <input class="mw-input mw-box" type="number" min="0" max={max} value={Math.round(shown())} disabled={props.disabled}
        onChange={(e) => {
          const v = Number(e.currentTarget.value);
          if (Number.isFinite(v)) pick(set(Math.max(0, Math.min(max, v))));
        }} />
      <span>{label}</span>
    </label>
  );

  return (
    <div class="mw-color-picker-anchor">
      <button type="button" class={`mw-color-picker-trigger mw-box ${props.class ?? ""}`}
        style={{ "--mw-picker-color": value(), ...props.style }}
        title={props.label} aria-label={props.label} aria-expanded={open()} disabled={props.disabled}
        onClick={toggle} />
      <Popover open={open()} onClose={() => setOpen(false)} label={props.label} placement="below" align="end">
        <div class="mw-color-picker">
          <div class="mw-color-area" style={{ "--hue": `${hsv().h}` }} tabIndex={0} role="slider"
            aria-label="Saturation and brightness" aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={Math.round(hsv().s * 100)} aria-valuetext={hex()}
            onPointerDown={(e) => drag(e, (x, y) => ({ h: hsv().h, s: x, v: 1 - y }))}
            onKeyDown={(e) => nudge(e, (step, key) => {
              const { h, s, v } = hsv();
              const clamp = (n: number) => Math.max(0, Math.min(1, n));
              return key === "ArrowLeft" ? { h, s: clamp(s - step), v } : key === "ArrowRight" ? { h, s: clamp(s + step), v }
                : key === "ArrowUp" ? { h, s, v: clamp(v + step) } : key === "ArrowDown" ? { h, s, v: clamp(v - step) } : null;
            })}>
            <span class="mw-color-thumb" style={{ left: `${hsv().s * 100}%`, top: `${(1 - hsv().v) * 100}%`, background: hex() }} />
          </div>
          <div class="mw-color-hue" tabIndex={0} role="slider" aria-label="Hue" aria-valuemin={0} aria-valuemax={360} aria-valuenow={Math.round(hsv().h)}
            onPointerDown={(e) => drag(e, (x) => ({ ...hsv(), h: x * 360 }))}
            onKeyDown={(e) => nudge(e, (step, key) => key === "ArrowLeft" || key === "ArrowDown"
              ? { ...hsv(), h: Math.max(0, hsv().h - step * 360) }
              : key === "ArrowRight" || key === "ArrowUp" ? { ...hsv(), h: Math.min(360, hsv().h + step * 360) } : null)}>
            <span class="mw-color-thumb" style={{ left: `${(hsv().h / 360) * 100}%`, background: `hsl(${hsv().h} 100% 50%)` }} />
          </div>
          <div class="mw-color-fields">
            <Select label="Color format" value={format()} options={formats} onChange={chooseFormat} />
            <Switch>
              <Match when={format() === "hex"}>
                <input class="mw-input mw-box mw-color-hex" value={hex()} aria-label="Hex color" spellcheck={false} disabled={props.disabled}
                  onChange={(e) => pickHex(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
              </Match>
              <Match when={format() === "rgb"}>
                <For each={["r", "g", "b"] as const}>
                  {(key) => field(key.toUpperCase(), () => rgb()[key], 255, (v) => {
                    const next = rgbToHsv({ ...rgb(), [key]: v });
                    return next.s === 0 ? { ...next, h: hsv().h } : next;
                  })}
                </For>
              </Match>
              <Match when={format() === "hsl"}>
                {field("H", () => hsl().h, 360, (v) => hslToHsv({ ...hsl(), h: v }))}
                {field("S", () => hsl().s * 100, 100, (v) => hslToHsv({ ...hsl(), s: v / 100 }))}
                {field("L", () => hsl().l * 100, 100, (v) => hslToHsv({ ...hsl(), l: v / 100 }))}
              </Match>
            </Switch>
          </div>
        </div>
      </Popover>
    </div>
  );
}
