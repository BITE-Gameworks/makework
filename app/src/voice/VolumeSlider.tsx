import { Show } from "solid-js";
import { rangeFill } from "../ui/range";
import { gainAt, positionOf, positionSteps, volumeLabel } from "./loudness";
import { maxVolume } from "./volume";

// 0 to 300% (or up to `max`), following perceived loudness (loudness.ts); double-click goes back to 100%. `onCommit` when the slider is let go.
// `vertical`: the value on top, the slider standing up (a turned horizontal one, so it keeps the theme's look),
// the label under it. `labelWidth` lines up sliders shown together whose labels differ in length.
export default function VolumeSlider(props: {
  label: string; value: number; onChange: (value: number) => void; max?: number; onCommit?: () => void; vertical?: boolean;
  labelWidth?: string;
}) {
  const max = () => props.max ?? maxVolume;
  const input = () => (
    <input type="range" min="0" max={positionSteps} step="1" value={Math.round(positionOf(props.value, max()) * positionSteps)}
        style={rangeFill(positionOf(props.value, max()), 0, 1)} aria-label={props.label} aria-valuetext={volumeLabel(props.value)}
        onInput={(e) => props.onChange(Math.round(gainAt(Number(e.currentTarget.value) / positionSteps, max()) * 1000) / 1000)}
        onChange={() => props.onCommit?.()} />
  );
  return (
    <label class="voice-volume" classList={{ vertical: props.vertical }} title="Double-click for 100%" onDblClick={() => props.onChange(1)}
      style={props.labelWidth ? { "--voice-volume-label": props.labelWidth } : undefined}>
      <Show when={props.vertical} fallback={
        <>
          <span class="voice-volume-label">{props.label}</span>
          {input()}
          <span class="voice-volume-value">{volumeLabel(props.value)}</span>
        </>
      }>
        <span class="voice-volume-value">{volumeLabel(props.value)}</span>
        <span class="voice-volume-upright">{input()}</span>
        <span class="voice-volume-label">{props.label}</span>
      </Show>
    </label>
  );
}
