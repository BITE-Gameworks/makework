import { createEffect, createSignal } from "solid-js";
import Select from "../../../ui/Select";
import TitleField from "./TitleField";

export type AddKind = "task" | "issue";

// One field that wraps and grows with its text and adds on Enter. With `kind`, a dropdown beside it chooses between
// adding a task and an issue.
export default function AddForm(props: {
  active: boolean;
  placeholder: string;
  // Resolves false when the add failed (its error is shown elsewhere): the title comes back to be fixed or tried again.
  onAdd: (title: string, kind: AddKind) => Promise<boolean>;
  onDone: () => void;
  kind?: { value: AddKind; onChange: (kind: AddKind) => void };
}) {
  let input!: HTMLTextAreaElement;
  const [text, setText] = createSignal("");
  createEffect(() => props.active && requestAnimationFrame(() => input.focus()));
  const add = async () => {
    const title = text().trim();
    if (!title) return;
    // Cleared at once, so the next title can be typed while this one is added.
    setText("");
    if (!(await props.onAdd(title, props.kind?.value ?? "task")) && !text()) setText(title);
  };
  return (
    <form class="tasks-add" onSubmit={(e) => {
      e.preventDefault();
      void add();
    }}>
      <TitleField ref={(el) => (input = el)} class="view-input" value={text()} placeholder={props.placeholder} aria-label={props.placeholder}
        onInput={(e) => setText(e.currentTarget.value)} onEnter={() => void add()}
        onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), props.onDone())}
        onBlur={(e) => props.active && !text().trim() && !e.relatedTarget && props.onDone()} />
      {props.kind && (
        <Select label="Add as" value={props.kind.value} onChange={props.kind.onChange}
          options={[{ value: "task", label: "Task" }, { value: "issue", label: "Issue" }]} />
      )}
    </form>
  );
}
