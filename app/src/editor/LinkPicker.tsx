import { For, Show, createEffect, createMemo, createResource, createSignal, on } from "solid-js";
import { searchLinks, type SearchHit } from "../core/links";
import { Icon } from "../theme/icons";
import { focusWhenShown } from "../ui/focus";

export type Pick = { url: string; title: string; external?: boolean; embed?: boolean };

const looksLikeUrl = (text: string) => /^(https?:\/\/|mailto:)\S+$/.test(text.trim());

// Finds channels and objects to link, or takes a web address. With `query` it follows the text typed
// after # in the editor; without, it has its own search box.
export default function LinkPicker(props: {
  workspaceId: string;
  at: { x: number; top: number; bottom: number };
  query?: string;
  onPick: (pick: Pick) => void;
  onClose: () => void;
  // Lets the editor drive the list with its own arrow keys while the caret stays in the text.
  keys?: (handler: (e: KeyboardEvent) => boolean) => void;
}) {
  const [own, setOwn] = createSignal("");
  // A memo, so the editor re-checking the same text (it does on every arrow key) doesn't reset the selection.
  const query = createMemo(() => props.query ?? own());
  const [hits] = createResource(query, (q) => (looksLikeUrl(q) ? Promise.resolve([] as SearchHit[]) : searchLinks(props.workspaceId, q)));
  const [index, setIndex] = createSignal(0);
  createEffect(on(query, () => setIndex(0)));

  const options = (): Pick[] => looksLikeUrl(query())
    ? [{ url: query().trim(), title: query().trim(), external: true }]
    : (hits.latest ?? []).map((h) => ({ url: h.url, title: h.title, embed: h.kind === "export" }));

  const onKey = (e: KeyboardEvent): boolean => {
    const count = options().length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (count) setIndex((index() + (e.key === "ArrowDown" ? 1 : -1) + count) % count);
    } else if (e.key === "Enter" || e.key === "Tab") {
      const pick = options()[index()];
      if (!pick) return false;
      props.onPick(pick);
    } else if (e.key === "Escape") props.onClose();
    else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  };
  props.keys?.(onKey);

  // Above the caret when there is more room there (the chat composer sits at the bottom).
  const above = () => props.at.top > innerHeight / 2;
  const style = () => ({
    left: `${Math.min(props.at.x, innerWidth - 340)}px`,
    ...(above() ? { bottom: `${innerHeight - props.at.top + 4}px` } : { top: `${props.at.bottom + 4}px` }),
  });

  return (
    <div class="mw-link-picker mw-box mw-fade-in" role="presentation" style={style()} onMouseDown={(e) => e.target instanceof HTMLInputElement || e.preventDefault()}>
      <Show when={props.query === undefined}>
        <input class="mw-input mw-box" placeholder="Search, or paste a web address" value={own()} ref={focusWhenShown}
          onInput={(e) => setOwn(e.currentTarget.value)} onKeyDown={onKey} onBlur={props.onClose} />
      </Show>
      <ul role="listbox">
        <For each={looksLikeUrl(query()) ? [] : hits.latest ?? []}>
          {(hit, i) => (
            <li role="option" aria-selected={i() === index()} classList={{ selected: i() === index() }}
              onMouseEnter={() => setIndex(i())} onClick={() => props.onPick({ url: hit.url, title: hit.title, embed: hit.kind === "export" })}>
              <Icon name={hit.icon} />
              <span class="mw-link-picker-title">{hit.title}</span>
              <span class="mw-link-picker-where">{hit.kind === "channel" || hit.kind === "export" ? hit.detail : hit.where}</span>
            </li>
          )}
        </For>
        <Show when={looksLikeUrl(query())}>
          <li class="selected" onClick={() => props.onPick(options()[0])}>
            <Icon name="link" /> <span class="mw-link-picker-title">Link to {query().trim()}</span>
          </li>
        </Show>
        <Show when={!looksLikeUrl(query()) && !hits.loading && (hits.latest ?? []).length === 0}>
          <li class="mw-link-picker-empty">Nothing found</li>
        </Show>
      </ul>
    </div>
  );
}
