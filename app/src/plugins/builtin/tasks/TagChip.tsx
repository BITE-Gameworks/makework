import { Show } from "solid-js";
import { Icon } from "../../../theme/icons";
import type { Tag } from "./data";

// A tag as a chip. With `onClick` it is a button (a tab stop, Enter and Space press it); without, plain text.
export function TagChip(props: { tag: Tag; on?: boolean; off?: boolean; onClick?: () => void; onRemove?: () => void }) {
  const classes = () => ({ on: props.on, off: props.off, clickable: !!props.onClick });
  const style = () => ({ "--tag": props.tag.color || "var(--mw-border)" });
  const inside = () => (
    <>
      #{props.tag.name}
      <Show when={props.onRemove}>
        <button class="task-tag-remove" aria-label={`Remove #${props.tag.name}`} onClick={(e) => { e.stopPropagation(); props.onRemove!(); }}>
          <Icon name="close" size={12} />
        </button>
      </Show>
    </>
  );
  return (
    <Show when={props.onClick} fallback={<span class="task-tag mw-box" classList={classes()} style={style()}>{inside()}</span>}>
      <span class="task-tag mw-box" classList={classes()} style={style()} role="button" tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          props.onClick?.();
        }}
        onKeyDown={(e) => {
          // Not the keys of the remove button inside.
          if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
          e.preventDefault();
          e.stopPropagation();
          props.onClick?.();
        }}>
        {inside()}
      </span>
    </Show>
  );
}
