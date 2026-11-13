import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import { narrow, saveSidePanelWidth, setSidePanel, setSidePanelWidth, sidePanel, sidePanelWidth } from "../core/ui";
import { Icon } from "../theme/icons";
import { createPresence } from "../ui/presence";
import ResizeHandle from "../ui/ResizeHandle";

export default function SidePanel() {
  const presence = createPresence(() => sidePanel() !== null);
  const [resizing, setResizing] = createSignal(false);
  // Keeps showing the last content while the panel slides closed.
  const [shown, setShown] = createSignal(sidePanel());
  createEffect(() => {
    const panel = sidePanel();
    if (panel) setShown(panel);
  });
  // At most 60% of the room beside it, the content too, so nothing in it reaches past the panel's edge.
  const [room, setRoom] = createSignal(Infinity);
  const observer = new ResizeObserver(([entry]) => setRoom(entry.contentRect.width * 0.6));
  onCleanup(() => observer.disconnect());
  const width = () => Math.min(sidePanelWidth(), room());

  return (
    <Show when={presence.mounted() && shown()}>
      {(panel) => (
        <aside ref={(el) => queueMicrotask(() => el.parentElement && observer.observe(el.parentElement))} class="side-panel" classList={{ resizing: resizing(), shown: presence.visible() }} aria-label={panel().title}
          style={narrow() ? undefined : { width: presence.visible() ? `${width()}px` : "0px" }}>
          <div class="side-panel-content" style={narrow() ? undefined : { width: `${width()}px` }}>
            <ResizeHandle edge="left" label="Resize panel" setWidth={setSidePanelWidth} save={saveSidePanelWidth} onResizing={setResizing} />
            <header class="side-panel-header">
              <h2>{panel().title}</h2>
              <button class="icon-button accent" title="Close" aria-label="Close panel" onClick={() => setSidePanel(null)}>
                <Icon name="close" />
              </button>
            </header>
            <div class="side-panel-body mw-scroll-fade">{panel().render()}</div>
          </div>
        </aside>
      )}
    </Show>
  );
}
