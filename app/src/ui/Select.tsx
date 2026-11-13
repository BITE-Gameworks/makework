import { For, Show, createSignal, onCleanup, type JSX } from "solid-js";
import { Icon } from "../theme/icons";
import Popover from "./Popover";
import "./Select.css";

let closeActiveSelect: (() => void) | undefined;

export interface SelectOption<T> {
  value: T;
  label: string;
  icon?: string;
  swatch?: string;
  disabled?: boolean;
}

// A dropdown drawn in the theme, in place of the browser's <select>: a button showing the choice, and the options
// in a popover. Keyboard: arrows, Home/End and Enter or Space; typing a letter jumps to the next option starting with it.
// `search` adds a filter field above long lists (Enter picks the first match).
export default function Select<T extends string | number>(props: {
  value: T | null | undefined;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  label: string;          // for screen readers, and the title
  placeholder?: string;   // shown when the value matches no option ("Mixed")
  class?: string;
  disabled?: boolean;
  prefix?: JSX.Element;
  search?: boolean;
}) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  let searchInput: HTMLInputElement | undefined;
  const shown = () => {
    const q = query().trim().toLowerCase();
    return q ? props.options.filter((o) => `${o.label} ${o.value}`.toLowerCase().includes(q)) : props.options;
  };
  let button!: HTMLButtonElement;
  let list: HTMLDivElement | undefined;
  const chosen = () => props.options.find((o) => o.value === props.value);
  const items = () => [...(list?.querySelectorAll<HTMLButtonElement>(".mw-menu-item:not(:disabled)") ?? [])];

  const closeActive = () => close(false);
  const show = () => {
    if (props.disabled) return;
    closeActiveSelect?.();
    closeActiveSelect = closeActive;
    setQuery("");
    setOpen(true);
    requestAnimationFrame(() => {
      const selected = list?.querySelector<HTMLButtonElement>(".mw-menu-item.selected");
      selected?.scrollIntoView({ block: "nearest" });
      if (searchInput) searchInput.focus();
      else (selected ?? items()[0])?.focus();
    });
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (closeActiveSelect === closeActive) closeActiveSelect = undefined;
    if (refocus) button.focus();
  };
  onCleanup(() => {
    if (closeActiveSelect === closeActive) closeActiveSelect = undefined;
  });
  const pick = (o: SelectOption<T>) => {
    if (o.disabled) return;
    close();
    if (o.value !== props.value) props.onChange(o.value);
  };

  const onListKey = (e: KeyboardEvent) => {
    const all = items();
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    const go = (j: number) => all[Math.max(0, Math.min(all.length - 1, j))]?.focus();
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(all.length - 1);
    else if (e.key === "Tab") return close(false);
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      const next = [...all.slice(i + 1), ...all.slice(0, i + 1)].find((b) => b.textContent?.trim().toLowerCase().startsWith(e.key.toLowerCase()));
      next?.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div class={`mw-popover-anchor mw-select ${props.class ?? ""}`}>
      <button ref={button} type="button" class="mw-select-button mw-box" title={props.label} aria-label={props.label}
        aria-haspopup="listbox" aria-expanded={open()} disabled={props.disabled}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => (open() ? close() : show())}
        onKeyDown={(e) => {
          if (["ArrowDown", "ArrowUp"].includes(e.key)) {
            e.preventDefault();
            show();
          }
        }}>
        {props.prefix}
        <Show when={chosen()?.swatch} fallback={<Show when={chosen()?.icon}><Icon name={chosen()!.icon!} size={14} /></Show>}>
          <span class="mw-select-swatch" style={{ background: chosen()?.swatch }} />
        </Show>
        <span class="mw-select-value" classList={{ placeholder: !chosen() }}>{chosen()?.label ?? props.placeholder ?? ""}</span>
        <Icon name="expanded" size={12} />
      </button>
      <Popover open={open()} onClose={() => close(false)} label={props.label} placement="below">
        <Show when={props.search}>
          <input ref={searchInput} class="mw-input mw-box mw-select-search" type="search" placeholder="Search"
            aria-label={`Search ${props.label}`} value={query()} onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); items()[0]?.focus(); }
              else if (e.key === "Enter") { e.preventDefault(); const first = shown().find((o) => !o.disabled); if (first) pick(first); }
              else if (e.key === "Escape") { e.stopPropagation(); close(); }
            }} />
        </Show>
        <div ref={list} class="mw-select-list mw-scroll-fade" role="listbox" tabIndex={-1} aria-label={props.label}
          style={{ "min-width": `${Math.max(120, button?.offsetWidth ?? 0) - 14}px` }} onKeyDown={onListKey}>
          <For each={shown()}>
            {(o) => (
              <button type="button" class="mw-menu-item" role="option" aria-selected={o.value === props.value}
                classList={{ selected: o.value === props.value }} disabled={o.disabled} onClick={() => pick(o)}>
                <Show when={o.swatch} fallback={<Show when={o.icon} fallback={<Icon name="check" size={14} />}><Icon name={o.icon!} size={14} /></Show>}>
                  <span class="mw-select-swatch" style={{ background: o.swatch }} />
                </Show>
                {o.label}
              </button>
            )}
          </For>
        </div>
      </Popover>
    </div>
  );
}
