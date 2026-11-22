import { Show, createEffect } from "solid-js";
import Collapse from "./Collapse";
import { createPresence } from "./presence";
import "./ConfirmPrompt.css";

interface ConfirmProps {
  open: boolean;
  question: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

const cancelOnEscape = (props: ConfirmProps) => (e: KeyboardEvent) =>
  e.key === "Escape" && (e.stopPropagation(), props.onCancel());

// The confirm and cancel buttons; the confirm button takes the keyboard when shown.
function ConfirmButtons(props: ConfirmProps) {
  let confirm!: HTMLButtonElement;
  createEffect(() => props.open && requestAnimationFrame(() => confirm.focus({ preventScroll: true })));
  return (
    <div class="mw-confirm-buttons">
      <button ref={confirm} class="mw-button mw-box mw-confirm-yes" onClick={props.onConfirm}>{props.confirmLabel}</button>
      <button class="mw-button mw-box" onClick={props.onCancel}>Cancel</button>
    </div>
  );
}

// Expands under the button that asked, with the question and buttons to go ahead or cancel. Escape cancels.
export default function ConfirmPrompt(props: ConfirmProps & { ref?: (el: HTMLDivElement) => void }) {
  return (
    <Collapse open={props.open}>
      <div ref={props.ref} class="mw-confirm mw-box" role="alertdialog" aria-label={props.question}
        onKeyDown={cancelOnEscape(props)}>
        <p>{props.question}</p>
        <ConfirmButtons {...props} />
      </div>
    </Collapse>
  );
}

// Only the buttons, fading in beside the button that asked, for places with no room under it. Escape cancels.
export function ConfirmBeside(props: ConfirmProps) {
  const presence = createPresence(() => props.open);
  return (
    <Show when={presence.mounted()}>
      <div class="mw-confirm-beside" classList={{ visible: presence.visible() }} role="alertdialog"
        aria-label={props.question} inert={!props.open} onKeyDown={cancelOnEscape(props)}>
        <ConfirmButtons {...props} />
      </div>
    </Show>
  );
}
