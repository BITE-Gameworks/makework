// A search field with Slack-style operators (`in:channel`, `by:member`): suggestions for the word being typed, picked
// with the mouse, Up/Down and Tab or Enter. Core/searchQuery.ts reads the text.
import { For, Show, createMemo, createSignal, createUniqueId, type JSX } from "solid-js";
import { memberListVisible } from "../core/members";
import { suggestions, lastToken, type SearchOperator } from "../core/searchQuery";
import { workspaces } from "../core/workspaces";
import { focusWhenShown } from "./focus";

export default function SearchBox(props: {
  workspaceId: string;
  value: string;
  onInput: (value: string) => void;
  placeholder: string;
  label: string;
  operators: readonly SearchOperator[];
  // Names offered after `in:`.
  channels?: string[];
  // Takes the keyboard when it appears (focusWhenShown).
  focusOnShow?: boolean;
  // Beside the field, inside the box (an icon or a toggle).
  children?: JSX.Element;
  class?: string;
}) {
  const [active, setActive] = createSignal(0);
  const [focused, setFocused] = createSignal(false);
  let input!: HTMLInputElement;
  const listId = createUniqueId();
  const channelNames = () => props.channels ?? (workspaces.byId[props.workspaceId]?.channels.map((c) => c.name) ?? []);
  const options = createMemo(() => (focused() ? suggestions(props.value, props.operators, channelNames(), memberListVisible(props.workspaceId)) : []));
  const accept = (index: number) => {
    const choice = options()[index];
    if (!choice) return false;
    props.onInput(props.value.slice(0, lastToken(props.value).start) + choice.insert);
    setActive(0);
    input.focus();
    return true;
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const count = options().length;
    if (count && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setActive((active() + (e.key === "ArrowDown" ? 1 : count - 1)) % count);
    } else if ((e.key === "Tab" || e.key === "Enter") && count && accept(active())) e.preventDefault();
    else if (e.key === "Escape") props.onInput("");
  };
  return (
    <div class={`search-box mw-box ${props.class ?? ""}`}>
      <input ref={(el) => { input = el; if (props.focusOnShow) focusWhenShown(el); }} placeholder={props.placeholder} value={props.value} aria-label={props.label}
        autocomplete="off" role="combobox" aria-expanded={options().length > 0} aria-controls={listId} aria-autocomplete="list"
        onInput={(e) => { setActive(0); props.onInput(e.currentTarget.value); }} onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} />
      {props.children}
      <Show when={options().length > 0}>
        <ul id={listId} class="search-suggestions mw-box" role="listbox">
          <For each={options()}>
            {(choice, i) => (
              <li role="option" aria-selected={i() === active()} classList={{ active: i() === active() }}
                onMouseDown={(e) => { e.preventDefault(); accept(i()); }}>
                <span>{choice.label}</span>
                <Show when={choice.hint}><span class="muted">{choice.hint}</span></Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
