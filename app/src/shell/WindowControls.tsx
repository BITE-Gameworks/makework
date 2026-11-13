// Minimize, maximize and close for the frameless desktop window. Not shown in the browser.
import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { desktop, type DesktopBridge } from "../core/desktop";
import { Icon } from "../theme/icons";

export const hasWindowControls = !!desktop;

export default function WindowControls() {
  return (
    <Show when={desktop}>
      {(bridge) => <Controls desktop={bridge()} />}
    </Show>
  );
}

function Controls(props: { desktop: DesktopBridge }) {
  const win = props.desktop;
  const [maximized, setMaximized] = createSignal(false);

  onMount(() => void win.isMaximized().then(setMaximized, () => {}));
  onCleanup(win.onMaximizedChange(setMaximized));

  return (
    <div class="window-controls">
      <button title="Minimize" aria-label="Minimize" onClick={() => win.minimize()}>
        <Icon name="window-minimize" />
      </button>
      <button title={maximized() ? "Restore" : "Maximize"} aria-label={maximized() ? "Restore" : "Maximize"}
        onClick={() => win.toggleMaximize()}>
        <Icon name={maximized() ? "window-restore" : "window-maximize"} size={14} />
      </button>
      <button class="close" title="Close" aria-label="Close" onClick={() => win.close()}>
        <Icon name="window-close" />
      </button>
    </div>
  );
}
