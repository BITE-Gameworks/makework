import { createEffect } from "solid-js";
import Select from "../../../ui/Select";

export type AddKind = "task" | "issue";

// One input that adds on Enter. With `kind`, a dropdown beside it chooses between adding a task and an issue.
export default function AddForm(props: {
  active: boolean;
  placeholder: string;
  // Resolves false when the add failed (its error is shown elsewhere): the title comes back to be fixed or tried again.
  onAdd: (title: string, kind: AddKind) => Promise<boolean>;
  onDone: () => void;
  kind?: { value: AddKind; onChange: (kind: AddKind) => void };
}) {
  let input!: HTMLInputElement;
  createEffect(() => props.active && requestAnimationFrame(() => input.focus()));
  return (
    <form class="tasks-add" onSubmit={async (e) => {
      e.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      // Cleared at once, so the next title can be typed while this one is added.
      input.value = "";
      if (!(await props.onAdd(title, props.kind?.value ?? "task")) && !input.value) input.value = title;
    }}>
      <input ref={input} class="mw-input mw-box view-input" placeholder={props.placeholder} aria-label={props.placeholder}
        onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), props.onDone())}
        onBlur={(e) => props.active && !input.value.trim() && !e.relatedTarget && props.onDone()} />
      {props.kind && (
        <Select label="Add as" value={props.kind.value} onChange={props.kind.onChange}
          options={[{ value: "task", label: "Task" }, { value: "issue", label: "Issue" }]} />
      )}
    </form>
  );
}
