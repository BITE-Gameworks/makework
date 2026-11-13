import { For, Show, createEffect, createMemo, createResource, createSignal, on } from "solid-js";
import { commandsOf } from "../core/botCommands";
import { workspaceApi } from "../core/workspaces";
import Avatar from "../ui/Avatar";
import { member } from "../core/members";

// Suggestions for "/" typed after an @mentioned bot: that bot's commands with their usage. onPick gets the command
// name to write.
export default function CommandPicker(props: {
  workspaceId: string;
  at: { x: number; top: number; bottom: number };
  query: string;
  bots: number[];
  onPick: (name: string) => void;
  onClose: () => void;
  keys: (handler: (e: KeyboardEvent) => boolean) => void;
}) {
  const [rows] = createResource(() => props.workspaceId, (id) => workspaceApi(id).plugin("bots").read("bots_bots"));
  const query = createMemo(() => props.query);
  const hits = () => {
    const q = query().toLowerCase();
    return commandsOf(rows() ?? []).filter((c) => props.bots.includes(c.botId) && c.name.startsWith(q)).slice(0, 8);
  };
  const [index, setIndex] = createSignal(0);
  createEffect(on(query, () => setIndex(0)));

  props.keys((e) => {
    const count = hits().length;
    if (!count) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") setIndex((index() + (e.key === "ArrowDown" ? 1 : -1) + count) % count);
    else if (e.key === "Enter" || e.key === "Tab") {
      const pick = hits()[index()];
      if (!pick) return false;
      props.onPick(pick.name);
    } else if (e.key === "Escape") props.onClose();
    else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  });

  const above = () => props.at.top > innerHeight / 2;
  const style = () => ({
    left: `${Math.min(props.at.x, innerWidth - 340)}px`,
    ...(above() ? { bottom: `${innerHeight - props.at.top + 4}px` } : { top: `${props.at.bottom + 4}px` }),
  });

  return (
    <Show when={hits().length > 0}>
      <div class="mw-link-picker mw-scroll-fade mw-box mw-fade-in" role="presentation" style={style()} onMouseDown={(e) => e.preventDefault()}>
        <ul role="listbox" aria-label="Bot commands">
          <For each={hits()}>{(hit, i) => (
            <li role="option" aria-selected={i() === index()} classList={{ selected: i() === index() }}
              onMouseEnter={() => setIndex(i())} onClick={() => props.onPick(hit.name)}>
              <Avatar user={member(props.workspaceId, hit.botId)} size={20} />
              <span class="mw-link-picker-title">{hit.usage}</span>
              <span class="mw-link-picker-where">{hit.help}</span>
            </li>
          )}</For>
        </ul>
      </div>
    </Show>
  );
}
