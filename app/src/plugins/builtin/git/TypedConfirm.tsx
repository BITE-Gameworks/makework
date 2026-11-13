// A confirmation for changes that remove a lot: the user types a word (the branch name) before it goes ahead.
import { createEffect, createSignal } from "solid-js";
import Collapse from "../../../ui/Collapse";

export default function TypedConfirm(props: {
  open: boolean;
  question: string;
  word: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = createSignal("");
  let input!: HTMLInputElement;
  createEffect(() => {
    if (!props.open) return setTyped("");
    requestAnimationFrame(() => input?.focus({ preventScroll: true }));
  });
  return (
    <Collapse open={props.open}>
      <form class="mw-confirm mw-box git-typed-confirm" role="alertdialog" aria-label={props.question}
        onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), props.onCancel())}
        onSubmit={(e) => {
          e.preventDefault();
          if (typed() === props.word) props.onConfirm();
        }}>
        <p>{props.question}</p>
        <label>
          <span>Type <code>{props.word}</code> to confirm</span>
          <input ref={input} class="mw-input mw-box" value={typed()} onInput={(e) => setTyped(e.currentTarget.value)} autocomplete="off" />
        </label>
        <div class="mw-confirm-buttons">
          <button class="mw-button mw-box mw-confirm-yes" type="submit" disabled={typed() !== props.word}>{props.confirmLabel}</button>
          <button class="mw-button mw-box" type="button" onClick={props.onCancel}>Cancel</button>
        </div>
      </form>
    </Collapse>
  );
}
