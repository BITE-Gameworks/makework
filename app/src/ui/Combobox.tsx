import { For, createSignal, createUniqueId, type JSX } from "solid-js";
import Popover from "./Popover";
import "./Select.css";

// A text field with suggestions drawn in the theme, in place of <datalist>. Typing filters the suggestions;
// arrows and Enter pick one, Enter alone keeps what was typed. `onCommit` runs when the value is final.
export default function Combobox(props: {
  value: string;
  suggestions: string[];
  onCommit: (value: string) => void;
  onInput?: (value: string) => void;
  label: string;
  class?: string;
  placeholder?: string;
  required?: boolean;
  itemStyle?: (suggestion: string) => JSX.CSSProperties;
}) {
  const [open, setOpen] = createSignal(false);
  const [text, setText] = createSignal<string | null>(null);
  const [active, setActive] = createSignal(-1);
  let input!: HTMLInputElement;
  let list: HTMLDivElement | undefined;
  const listId = createUniqueId();
  const shownText = () => text() ?? props.value;
  // Everything while the field shows its value, else what matches the typing.
  const matches = () => {
    const t = text();
    if (t === null || t === props.value) return props.suggestions;
    return props.suggestions.filter((s) => s.toLowerCase().includes(t.toLowerCase()));
  };
  const commit = (value: string) => {
    setText(null);
    setOpen(false);
    setActive(-1);
    if (value !== props.value) props.onCommit(value);
  };
  const move = (by: number) => {
    setOpen(true);
    const n = matches().length;
    if (n === 0) return;
    const next = (active() + by + n) % n;
    setActive(next);
    list?.querySelectorAll(".mw-menu-item")[next]?.scrollIntoView({ block: "nearest" });
  };
  return (
    <div class={`mw-popover-anchor mw-combobox ${props.class ?? ""}`}>
      <input ref={input} class="mw-input mw-box" value={shownText()} aria-label={props.label} placeholder={props.placeholder}
        required={props.required} role="combobox" aria-expanded={open()} aria-controls={listId} aria-autocomplete="list" spellcheck={false}
        onFocus={() => setOpen(true)}
        onInput={(e) => {
          setText(e.currentTarget.value);
          setActive(-1);
          setOpen(true);
          props.onInput?.(e.currentTarget.value);
        }}
        onBlur={() => commit(shownText())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") move(1);
          else if (e.key === "ArrowUp") move(-1);
          else if (e.key === "Enter") {
            const picked = matches()[active()];
            commit(picked ?? shownText());
            input.blur();
          } else if (e.key === "Escape" && open()) {
            setText(null);
            setOpen(false);
          } else return;
          e.preventDefault();
          e.stopPropagation();
        }} />
      <Popover open={open() && matches().length > 0} onClose={() => setOpen(false)} label={props.label} placement="below">
        <div ref={list} id={listId} class="mw-select-list mw-scroll-fade" role="listbox" aria-label={props.label}
          style={{ "min-width": `${Math.max(120, input?.offsetWidth ?? 0) - 14}px` }}>
          <For each={matches()}>
            {(s, i) => (
              <button type="button" class="mw-menu-item" role="option" tabIndex={-1} aria-selected={s === props.value}
                classList={{ selected: s === props.value, active: i() === active() }} style={props.itemStyle?.(s)}
                onPointerDown={(e) => e.preventDefault()} onClick={() => commit(s)}>
                {s}
              </button>
            )}
          </For>
        </div>
      </Popover>
    </div>
  );
}
