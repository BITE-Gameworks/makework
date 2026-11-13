import { Icon, type IconName } from "../theme/icons";

// An icon button that opens an overlay (settings, server settings, profile) and closes it on a second click.
// The icon moves on hover and keeps its shadow while the overlay is open.
export default function OverlayButton(props: {
  icon: IconName;
  label: string;
  open: boolean;
  onToggle: () => void;
  size?: number;
  motion?: "turn" | "tilt" | "grow";
  class?: string;
}) {
  return (
    <button class={`overlay-button ${props.class ?? ""}`} classList={{ open: props.open }} title={props.label}
      aria-label={props.label} aria-pressed={props.open} onClick={() => props.onToggle()}>
      <span class="overlay-button-icon" data-motion={props.motion ?? "turn"}><Icon name={props.icon} size={props.size} /></span>
    </button>
  );
}
