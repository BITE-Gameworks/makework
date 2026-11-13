import { createEffect } from "solid-js";
import Collapse from "./Collapse";
import "./ConfirmPrompt.css";

// Expands under the button that asked, with the question and buttons to go ahead or cancel. Escape cancels.
export default function ConfirmPrompt(props: {
  open: boolean;
  question: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  let confirm!: HTMLButtonElement;
  createEffect(() => props.open && requestAnimationFrame(() => confirm.focus({ preventScroll: true })));
  return (
    <Collapse open={props.open}>
      <div class="mw-confirm mw-box" role="alertdialog" aria-label={props.question}
        onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), props.onCancel())}>
        <p>{props.question}</p>
        <div class="mw-confirm-buttons">
          <button ref={confirm} class="mw-button mw-box mw-confirm-yes" onClick={props.onConfirm}>{props.confirmLabel}</button>
          <button class="mw-button mw-box" onClick={props.onCancel}>Cancel</button>
        </div>
      </div>
    </Collapse>
  );
}
