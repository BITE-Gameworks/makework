import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on } from "solid-js";
import { matchMembers, memberListVisible, myId, type Member } from "../core/members";
import { can, canMentionRole, roleList, roleSlug } from "../core/roles";
import Avatar from "../ui/Avatar";
import { handleOf } from "../core/userServer";

type Hit =
  | { kind: "member"; name: string; member: Member }
  | { kind: "group"; name: string; label: string; hint: string; color?: string };

// Members whose display name or username matches the text typed after @, display name first, then @everyone,
// @here and roles that would notify someone. onPick gets what to write: <@id> for a member, the group's name else.
export default function MentionPicker(props: {
  workspaceId: string;
  at: { x: number; top: number; bottom: number };
  query: string;
  onPick: (name: string) => void;
  onClose: () => void;
  keys: (handler: (e: KeyboardEvent) => boolean) => void;
}) {
  // A memo, so the editor re-checking the same text (it does on every arrow key) doesn't reset the selection.
  const query = createMemo(() => props.query);
  const hits = (): Hit[] => {
    const q = query().toLowerCase();
    const members: Hit[] = matchMembers(memberListVisible(props.workspaceId), q)
      .map((m) => ({ kind: "member", name: `<@${m.id}>`, member: m }));
    const me = myId(props.workspaceId) ?? -1;
    const everyone = can(props.workspaceId, "mention_everyone");
    const groups: Hit[] = [
      ...(everyone ? [
        { kind: "group" as const, name: "everyone", label: "@everyone", hint: "Everyone in the workspace" },
        { kind: "group" as const, name: "here", label: "@here", hint: "Everyone online" },
      ] : []),
      ...roleList(props.workspaceId).filter((r) => !r.everyone && roleSlug(r.name) && canMentionRole(props.workspaceId, me, r))
        .map((r) => ({ kind: "group" as const, name: roleSlug(r.name), label: `@${r.name}`, hint: "Role", color: String(r.color || "") })),
    ].filter((g) => g.name.includes(q) || g.label.toLowerCase().includes(q));
    return [...members.slice(0, 6), ...groups].slice(0, 8);
  };
  const [index, setIndex] = createSignal(0);
  createEffect(on(query, () => setIndex(0)));

  props.keys((e) => {
    const count = hits().length;
    if (!count) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (count) setIndex((index() + (e.key === "ArrowDown" ? 1 : -1) + count) % count);
    } else if (e.key === "Enter" || e.key === "Tab") {
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
        <ul role="listbox" aria-label="Members and roles">
          <For each={hits()}>
            {(hit, i) => (
              <li role="option" aria-selected={i() === index()} classList={{ selected: i() === index() }}
                onMouseEnter={() => setIndex(i())} onClick={() => props.onPick(hit.name)}>
                <Switch>
                  <Match when={hit.kind === "member" && hit}>
                    {(m) => (
                      <>
                        <Avatar user={m().member} size={20} />
                        <span class="mw-link-picker-title">{m().member.displayName}</span>
                        <span class="mw-link-picker-where">{handleOf(m().member)}</span>
                      </>
                    )}
                  </Match>
                  <Match when={hit.kind === "group" && hit}>
                    {(g) => (
                      <>
                        <span class="mention-group-dot" style={{ background: g().color || "var(--mw-link)" }} />
                        <span class="mw-link-picker-title">{g().label}</span>
                        <span class="mw-link-picker-where">{g().hint}</span>
                      </>
                    )}
                  </Match>
                </Switch>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  );
}
