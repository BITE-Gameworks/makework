import { For, Show } from "solid-js";
import ColorPicker from "./ColorPicker";
import "./ColorSwatches.css";

// A row of color swatches to pick from; `none` adds "No color" (""), `custom` a swatch that opens the system picker.
export default function ColorSwatches(props: {
  colors: readonly string[];
  value: string;
  onPick: (color: string) => void;
  label: string;
  none?: boolean;
  custom?: boolean;
  small?: boolean;
  disabled?: boolean;
}) {
  const isCustom = () => !!props.value && !props.colors.includes(props.value);
  return (
    <div class="mw-swatches" classList={{ small: props.small }} role="radiogroup" aria-label={props.label}>
      <Show when={props.none}>
        <button type="button" class="mw-swatch no-color mw-box" classList={{ selected: !props.value }} role="radio" aria-checked={!props.value}
          aria-label="No color" title="No color" disabled={props.disabled} onClick={() => props.onPick("")} />
      </Show>
      <For each={props.colors}>
        {(color) => (
          <button type="button" class="mw-swatch mw-box" classList={{ selected: color === props.value }} role="radio"
            aria-checked={color === props.value} aria-label={color} title={color} style={{ background: color }} disabled={props.disabled}
            onClick={() => props.onPick(color)} />
        )}
      </For>
      <Show when={props.custom}>
        <ColorPicker value={props.value} label="Custom color" class={`mw-swatch custom ${isCustom() ? "selected" : ""}`}
          style={!isCustom() ? { background: "conic-gradient(#e5484d, #ffc53d, #46a758, #3e63dd, #8e4ec6, #e5484d)" } : undefined}
          disabled={props.disabled} onPick={props.onPick} />
      </Show>
    </div>
  );
}
