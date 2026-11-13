import { For, Show, createSignal, type JSX } from "solid-js";
import { Icon } from "../../../theme/icons";
import Avatar from "../../../ui/Avatar";
import MemberSearch from "../../../ui/MemberSearch";
import Popover from "../../../ui/Popover";
import type { ChannelContext } from "../../types";
import type { TaskActions } from "./actions";
import { isFinished, type Board, type Tag, type Task } from "./data";
import { TagChip } from "./TagChip";

// One property of a task in the side panel: its label, what it holds as chips, a button that opens the picker, and
// `quick`, a shortcut shown after it.
function PropertyRow(props: { label: string; icon: string; chips: JSX.Element; picker: JSX.Element; empty: boolean; quick?: JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="task-prop">
      <span class="task-prop-label"><Icon name={props.icon} size={14} /> {props.label}</span>
      <div class="task-prop-value">
        {props.chips}
        <div class="mw-popover-anchor">
          <button class="task-prop-add" classList={{ open: open() }} aria-expanded={open()} aria-label={`Add to ${props.label}`}
            title={`Add to ${props.label}`} onClick={() => setOpen(!open())}>
            <Icon name="add" size={13} />{props.empty && <> Add</>}
          </button>
          <Popover open={open()} onClose={() => setOpen(false)} label={props.label} placement="below" align="start">
            <div class="task-prop-picker">{props.picker}</div>
          </Popover>
        </div>
        {props.quick}
      </div>
    </div>
  );
}

export function AssigneesProperty(props: { context: ChannelContext; task: Task; actions: TaskActions }) {
  const ctx = props.context;
  const me = () => ctx.users.me();
  return (
    <PropertyRow label="Assignees" icon="assignee" empty={props.task.assigneeIds.length === 0}
      quick={
        <Show when={me() !== null && !props.task.assigneeIds.includes(me()!)}>
          <button class="task-prop-add" title="Assign this to yourself" onClick={() => void props.actions.assign(props.task, me()!, true)}>
            <Icon name="assignee" size={13} /> Assign me
          </button>
        </Show>
      }
      chips={
        <For each={props.task.assigneeIds}>
          {(id) => (
            <span class="task-person mw-box mw-fade-in" onContextMenu={(e) => ctx.openUserMenu(e, id)}>
              <Avatar user={ctx.users.get(id)} size={16} />
              {ctx.users.get(id).displayName}
              <button class="task-tag-remove" aria-label={`Unassign ${ctx.users.get(id).displayName}`} onClick={() => void props.actions.assign(props.task, id, false)}>
                <Icon name="close" size={12} />
              </button>
            </span>
          )}
        </For>
      }
      picker={
        <MemberSearch members={ctx.users.assignable()} exclude={props.task.assigneeIds} label="Assign someone" placeholder="Find a person..."
          onPick={(id) => void props.actions.assign(props.task, id, true)} />
      } />
  );
}

export function TagsProperty(props: { task: Task; tags: Tag[]; actions: TaskActions }) {
  const [text, setText] = createSignal("");
  const own = () => props.task.tagIds.map((id) => props.tags.find((t) => t.id === id)).filter((t): t is Tag => !!t);
  const name = () => text().trim().replace(/^#/, "").toLowerCase();
  const add = async () => {
    const n = name();
    if (!n) return;
    setText("");
    await props.actions.tagByName(props.task, n);
  };
  return (
    <PropertyRow label="Tags" icon="tag" empty={own().length === 0}
      chips={<For each={own()}>{(tag) => <TagChip tag={tag} onRemove={() => void props.actions.toggleTag(props.task, tag)} />}</For>}
      picker={
        <>
          <input class="mw-input mw-box view-input" placeholder="Find or create a tag" aria-label="Find or create a tag" value={text()}
            onInput={(e) => setText(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void add())} />
          <div class="task-prop-options">
            <For each={props.tags.filter((t) => t.name.includes(name()))}>
              {(tag) => (
                <button class="task-prop-option" onClick={() => void props.actions.toggleTag(props.task, tag)}>
                  <span class="task-prop-dot" style={{ background: tag.color }} /> #{tag.name}
                  <Show when={props.task.tagIds.includes(tag.id)}><Icon name="check" size={13} /></Show>
                </button>
              )}
            </For>
            <Show when={name() && !props.tags.some((t) => t.name === name())}>
              <button class="task-prop-option" onClick={() => void add()}><Icon name="add" size={13} /> Create #{name()}</button>
            </Show>
          </div>
        </>
      } />
  );
}

// The tasks and issues this one waits for ("depends"), or that wait for it ("blocks").
export function DependenciesProperty(props: {
  board: Board; task: Task; direction: "depends" | "blocks"; actions: TaskActions; onOpen: (id: number) => void;
}) {
  const [text, setText] = createSignal("");
  const everything = () => [...props.board.tasks, ...props.board.issues];
  const linkedIds = () => (props.direction === "depends" ? props.task.dependsOn : props.task.blocks);
  const linked = () => linkedIds().map((id) => ({ id, task: everything().find((t) => t.id === id) }));
  const query = () => text().trim().toLowerCase();
  const options = () => everything()
    .filter((t) => t.id !== props.task.id && !linkedIds().includes(t.id) && t.title.toLowerCase().includes(query()))
    .slice(0, 8);
  const link = (other: Task, on: boolean) =>
    props.direction === "depends" ? props.actions.setDependency(props.task, other, on) : props.actions.setDependency(other, props.task, on);
  const icon = (t: Task) => (isFinished(props.board, t) ? "check" : t.kind === "issue" ? "info" : "channel-tasks");
  return (
    <PropertyRow label={props.direction === "depends" ? "Depends on" : "Blocks"} icon="link" empty={linked().length === 0}
      chips={
        <For each={linked()}>
          {(item) => (
            <span class="task-dependency mw-box mw-fade-in" classList={{ done: !!item.task && isFinished(props.board, item.task) }}>
              <Show when={item.task} fallback={<span class="muted">An archived task</span>}>
                {(other) => (
                  <>
                    <Icon name={icon(other())} size={13} />
                    <button class="task-dependency-title" title="Open" onClick={() => props.onOpen(other().id)}>{other().title}</button>
                    <button class="task-tag-remove" aria-label={`Remove ${other().title}`} onClick={() => void link(other(), false)}>
                      <Icon name="close" size={12} />
                    </button>
                  </>
                )}
              </Show>
            </span>
          )}
        </For>
      }
      picker={
        <>
          <input class="mw-input mw-box view-input" placeholder="Find a task or issue" aria-label="Find a task or issue" value={text()}
            onInput={(e) => setText(e.currentTarget.value)} />
          <div class="task-prop-options">
            <For each={options()} fallback={<span class="muted">No match.</span>}>
              {(other) => (
                <button class="task-prop-option" onClick={() => void link(other, true)}>
                  <Icon name={icon(other)} size={13} /> <span class="task-prop-text">{other.title}</span>
                </button>
              )}
            </For>
          </div>
        </>
      } />
  );
}
