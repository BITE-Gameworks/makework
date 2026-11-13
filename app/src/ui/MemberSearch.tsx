import { For, Show, createSignal, createUniqueId, type JSX } from "solid-js";
import { matchMembers } from "../core/members";
import { handleOf } from "../core/userServer";
import Avatar from "./Avatar";
import Popover from "./Popover";
import "./Select.css";
import "./MemberSearch.css";

export interface SearchableMember {
  id: number;
  username: string;
  displayName: string;
  color?: string;
  avatar?: string;
  // Tells apart members who share a username (core/members.ts); plugins' user lists may lack it.
  tag?: string;
}

// A field that finds members by name as you type, for servers too big for a dropdown of everyone. Arrows and Enter
// or a click pick one; the field then clears and stays focused for the next. The matches show in a popover below,
// or `inline` under the field (inside a right-click menu, where a popover would count as a click outside it).
export default function MemberSearch(props: {
  members: SearchableMember[];
  exclude?: number[];
  onPick: (id: number) => void;
  label: string;
  placeholder?: string;
  inline?: boolean;
}) {
  const [text, setText] = createSignal("");
  const [open, setOpen] = createSignal(false);
  const [active, setActive] = createSignal(0);
  let input!: HTMLInputElement;
  let list: HTMLDivElement | undefined;
  const listId = createUniqueId();
  const matches = () => matchMembers(props.members.filter((m) => !props.exclude?.includes(m.id)), text()).slice(0, 8);
  const pick = (m: SearchableMember | undefined) => {
    if (!m) return;
    setText("");
    setActive(0);
    props.onPick(m.id);
  };
  const move = (by: number) => {
    const n = matches().length;
    if (n === 0) return;
    setActive((active() + by + n) % n);
    list?.querySelectorAll(".mw-menu-item")[active()]?.scrollIntoView({ block: "nearest" });
  };

  const results = (): JSX.Element => (
    <div ref={list} id={listId} class="mw-select-list mw-scroll-fade mw-member-search-list" role="listbox" aria-label={props.label}
      style={props.inline ? undefined : { "min-width": `${Math.max(180, input?.offsetWidth ?? 0) - 14}px` }}>
      <For each={matches()}>
        {(m, i) => (
          <button type="button" class="mw-menu-item" role="option" tabIndex={-1} aria-selected={i() === active()}
            classList={{ active: i() === active() }}
            onPointerDown={(e) => e.preventDefault()} onPointerEnter={() => setActive(i())} onClick={() => pick(m)}>
            <Avatar user={m} size={20} />
            <span class="mw-member-search-name">{m.displayName}</span>
            <span class="mw-member-search-handle">{handleOf(m)}</span>
          </button>
        )}
      </For>
    </div>
  );

  return (
    <div class="mw-popover-anchor mw-member-search" classList={{ inline: props.inline }}>
      <input ref={input} class="mw-input mw-box" value={text()} aria-label={props.label} placeholder={props.placeholder}
        role="combobox" aria-expanded={open() && matches().length > 0} aria-controls={listId} aria-autocomplete="list" spellcheck={false}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onInput={(e) => {
          setText(e.currentTarget.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") move(1);
          else if (e.key === "ArrowUp") move(-1);
          else if (e.key === "Enter") pick(matches()[active()]);
          else if (e.key === "Escape" && open() && !props.inline) {
            setText("");
            setOpen(false);
          } else return;
          e.preventDefault();
          e.stopPropagation();
        }} />
      <Show when={props.inline} fallback={
        <Popover open={open() && matches().length > 0} onClose={() => setOpen(false)} label={props.label} placement="below">
          {results()}
        </Popover>
      }>
        <Show when={open() && matches().length > 0}>{results()}</Show>
      </Show>
    </div>
  );
}
