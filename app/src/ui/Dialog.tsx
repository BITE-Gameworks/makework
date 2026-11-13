import { Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { Icon } from "../theme/icons";
import { createPresence } from "./presence";
import "./Dialog.css";

const focusable = "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], [contenteditable='true'], [tabindex]:not([tabindex='-1'])";

function keepTabInside(e: KeyboardEvent, box: HTMLElement) {
  // A popover opened from the dialog is drawn outside it and keeps its own keys.
  if ((e.target as Element | null)?.closest?.(".mw-popover")) return;
  const items = [...box.querySelectorAll<HTMLElement>(focusable)].filter((el) => el.getClientRects().length > 0);
  if (!items.length) return;
  const first = items[0];
  const last = items.at(-1)!;
  const at = document.activeElement;
  if (!box.contains(at) || (e.shiftKey && at === first)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (!e.shiftKey && at === last) {
    e.preventDefault();
    first.focus();
  }
}
// How many dialogs are open. The layers under one (the file viewer, a settings page) leave Escape to it.
const [openCount, setOpenCount] = createSignal(0);
export const dialogOpen = () => openCount() > 0;

// A box in the middle of the window over the dimmed app, for a short form. Escape, the close button and a click
// beside it close it; popovers opened inside it (a Select's list) take Escape first.
export default function Dialog(props: { open: boolean; title: string; onClose: () => void; children: JSX.Element; class?: string }) {
  const presence = createPresence(() => props.open);
  let box: HTMLDivElement | undefined;
  createEffect(() => {
    if (!props.open) return;
    const before = document.activeElement as HTMLElement | null;
    // After what is inside had its say: a popover (a Select's list) or an editor's picker takes Escape first and
    // marks it handled. The layers under the dialog skip Escape while it is open (dialogOpen).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (e.defaultPrevented) return;
        e.preventDefault();
        props.onClose();
      } else if (e.key === "Tab" && box) keepTabInside(e, box);
    };
    setOpenCount((n) => n + 1);
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => {
      if (!box || box.contains(document.activeElement)) return;
      (box.querySelector<HTMLElement>("input, textarea, [contenteditable]") ?? box.querySelector<HTMLElement>("button"))?.focus();
    });
    onCleanup(() => {
      setOpenCount((n) => n - 1);
      document.removeEventListener("keydown", onKey);
      before?.focus?.();
    });
  });
  return (
    <Show when={presence.mounted()}>
      <Portal>
        <div class="mw-dialog-backdrop" classList={{ visible: presence.visible() }}
          onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
          <div ref={box} class={`mw-dialog mw-box ${props.class ?? ""}`} role="dialog" aria-modal="true" aria-label={props.title}>
            <header class="mw-dialog-header">
              <h2>{props.title}</h2>
              <button class="icon-button accent" title="Close (Esc)" aria-label="Close" onClick={props.onClose}><Icon name="close" /></button>
            </header>
            <div class="mw-dialog-body mw-scroll-fade">{props.children}</div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}
