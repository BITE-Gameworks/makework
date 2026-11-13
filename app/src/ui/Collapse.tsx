import { Show, type JSX } from "solid-js";
import { createPresence } from "./presence";

// Animates its content's height open and closed; unmounts it once closed.
export default function Collapse(props: { open: boolean; children: JSX.Element }) {
  const presence = createPresence(() => props.open);
  return (
    <Show when={presence.mounted()}>
      <div class="mw-collapse" classList={{ open: presence.visible() }} inert={!props.open}>
        <div class="mw-collapse-inner">{props.children}</div>
      </div>
    </Show>
  );
}
