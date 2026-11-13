// The frame of every page shown over the workspace (Settings, a workspace's settings and profile): title, close
// button, a row of section tabs with the sliding underline, Escape to close. The content comes from children.
import { For, onCleanup, onMount, type JSX } from "solid-js";
import { Icon } from "../theme/icons";
import TabUnderline from "./TabUnderline";
import { dialogOpen } from "./Dialog";

export interface OverlaySection {
  id: string;
  label: string;
}

export default function OverlayPage(props: {
  visible: boolean;
  title: string;
  sections: readonly OverlaySection[];
  section: string;
  onSection: (id: string) => void;
  onClose: () => void;
  children: JSX.Element;
}) {
  let dialog!: HTMLDivElement;
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && !dialogOpen() && props.onClose();
  onMount(() => {
    document.addEventListener("keydown", onKey);
    // The overlay starts scaled up, and a plain focus() would scroll the page under it to fit.
    dialog.focus({ preventScroll: true });
  });
  onCleanup(() => document.removeEventListener("keydown", onKey));

  return (
    <div class="settings-overlay" classList={{ visible: props.visible }} role="dialog" aria-modal="true" aria-label={props.title}>
      <div class="settings-scroll mw-scroll-fade" tabindex="-1" ref={dialog}>
      <header class="settings-header">
        <h1>{props.title}</h1>
        <button class="icon-button accent" title="Close (Esc)" aria-label={`Close ${props.title}`} onClick={() => props.onClose()}>
          <Icon name="close" size={22} />
        </button>
      </header>
      <nav class="settings-tabs mw-scroll-fade-x" role="tablist" aria-label={`${props.title} sections`}>
        <For each={props.sections}>
          {(s) => (
            <button class="settings-tab" role="tab" aria-selected={props.section === s.id} classList={{ active: props.section === s.id }} aria-current={props.section === s.id}
              onClick={() => props.onSection(s.id)}>
              {s.label}
            </button>
          )}
        </For>
        <TabUnderline active={props.section} />
      </nav>
      {props.children}
      </div>
    </div>
  );
}
