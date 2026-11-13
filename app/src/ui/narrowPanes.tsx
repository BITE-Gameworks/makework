import { Show, createSignal } from "solid-js";
import { narrow } from "../core/ui";
import { Icon } from "../theme/icons";

// On narrow screens a view's side panes (layer lists, page trees, properties) don't fit beside its content: they open
// over it, one at a time, from buttons in the view's header (views.css `.narrow-pane`). Wide, nothing changes.
export function createPanes<T extends string>() {
  const [open, setOpen] = createSignal<T | null>(null);
  return {
    open,
    toggle: (pane: T) => setOpen(() => (open() === pane ? null : pane)),
    close: () => setOpen(null),
    // Classes for the pane's container.
    classes: (pane: T, side: "left" | "right") => ({
      "narrow-pane": narrow(), [`narrow-pane-${side}`]: narrow(), open: narrow() && open() === pane,
    }),
  };
}

export type Panes<T extends string> = ReturnType<typeof createPanes<T>>;

// The header button for one pane, shown only while narrow.
export function PaneButton<T extends string>(props: { panes: Panes<T>; pane: T; icon: string; label: string }) {
  const on = () => props.panes.open() === props.pane;
  return (
    <Show when={narrow()}>
      <button class="icon-button" classList={{ on: on() }} title={props.label} aria-label={props.label} aria-expanded={on()}
        onClick={() => props.panes.toggle(props.pane)}>
        <Icon name={props.icon} />
      </button>
    </Show>
  );
}
