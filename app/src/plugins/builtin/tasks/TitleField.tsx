import { splitProps, type JSX } from "solid-js";
import { autoGrow } from "../../../ui/autoGrow";

const lineBreaks = /[\r\n]+/g;

// A task or issue title. Long titles wrap onto more lines and the field grows with them, but a title stays one line
// of text: Enter (Shift+Enter too) calls `onEnter`, and pasted or dropped line breaks become spaces.
export default function TitleField(props: Omit<JSX.TextareaHTMLAttributes<HTMLTextAreaElement>, "ref" | "value" | "rows"> & {
  value: string;
  ref?: (el: HTMLTextAreaElement) => void;
  onEnter: (el: HTMLTextAreaElement) => void;
}) {
  const [own, rest] = splitProps(props, ["value", "ref", "onEnter", "class"]);
  const setUp = (el: HTMLTextAreaElement) => {
    // Enter from a phone's keyboard may come without a keydown for it; text an input method is composing never
    // arrives as a line break.
    el.addEventListener("beforeinput", (e) => {
      if (e.inputType !== "insertLineBreak" && e.inputType !== "insertParagraph") return;
      e.preventDefault();
      own.onEnter(el);
    });
    // Added before autoGrow's listener, and runs before delegated `onInput` handlers: both see the text as it stays.
    el.addEventListener("input", () => {
      if (!el.value.includes("\n") && !el.value.includes("\r")) return;
      const caret = el.value.slice(0, el.selectionStart).replace(lineBreaks, " ").length;
      el.value = el.value.replace(lineBreaks, " ");
      el.setSelectionRange(caret, caret);
    });
    autoGrow(el, () => own.value);
    own.ref?.(el);
  };
  return (
    <textarea {...rest} ref={setUp} rows={1} enterkeyhint="done" value={own.value}
      class={`mw-input mw-box tasks-title-field${own.class ? ` ${own.class}` : ""}`} />
  );
}
