// A switch: a button that toggles a setting on and off, shown as a track with a thumb. The thumb is the only
// part that moves (a transform), so it stays smooth with the theme's animations.
import { Show } from "solid-js";
import "./Switch.css";

export function Switch(props: {
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  // The aria-label and optional visible text next to the switch.
  label?: string;
  title?: string;
}) {
  return (
    <span class="mw-switch" classList={{ on: props.checked, disabled: props.disabled ?? false }}>
      <button type="button" role="switch" aria-checked={props.checked} aria-label={props.label} title={props.title}
        disabled={props.disabled ?? false} onClick={() => props.onChange(!props.checked)}>
        <span class="mw-switch-thumb" />
      </button>
      <Show when={props.label}><span class="mw-switch-label">{props.label}</span></Show>
    </span>
  );
}