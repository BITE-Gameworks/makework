import { copyText } from "../../../core/clipboard";
import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import Skeleton from "../../../ui/Skeleton";
import { userMessage } from "../../../api/client";
import { copyLink } from "../../../core/links";
import { relativeTime } from "../../../core/time";
import { decodeEmoji, emojiFor } from "../../../markdown/emoji";
import { Icon } from "../../../theme/icons";
import Avatar from "../../../ui/Avatar";
import ConfirmPrompt from "../../../ui/ConfirmPrompt";
import Collapse from "../../../ui/Collapse";
import ColorSwatches from "../../../ui/ColorSwatches";
import { closeContextMenu } from "../../../ui/contextMenu";
import Popover from "../../../ui/Popover";
import { motionMs } from "../../../ui/presence";
import Reactions from "../../../ui/Reactions";
import { solidMount } from "../../solid";
import type { ChannelContext, MenuEntry } from "../../types";
import {
  archivePage, createArchive, createBoard, getTask, issueStatuses, loadAutoAssign, loadMode, openDependencies, reactToTask, saveAutoAssign,
  savedFilter, saveFilter, saveMode, severities, tagColors, type Board, type Column, type Tag, type Task,
} from "./data";
import { Activity } from "./Activity";
import AddForm, { type AddKind } from "./AddForm";
import { AssigneesProperty, DependenciesProperty, TagsProperty } from "./Properties";
import IssueList, { severityColor } from "./IssueList";
import { TagChip } from "./TagChip";
import { taskActions, type Run, type TaskActions } from "./actions";
import HistoryControls from "../../../ui/HistoryControls";
import { historyKeys } from "../../../core/history";
import MemberSearch from "../../../ui/MemberSearch";
import RichEditor from "../../../editor/RichEditor";
import Select from "../../../ui/Select";
import "../views.css";
import "./tasks.css";
import { createCopied } from "../../../ui/clipboard";

const taskType = "application/x-makework-task";


export default function TasksView(props: { context: ChannelContext }) {
  const ctx = props.context;
  const board = createBoard(ctx.api, ctx.channel.id);
  const [error, setError] = createSignal("");
  const [dragging, setDragging] = createSignal<number | null>(null);
  const [dropAt, setDropAt] = createSignal<{ columnId: number; beforeId: number | null } | null>(null);
  const [openTask, setOpenTask] = createSignal<number | null>(null);
  const [filter, setFilter] = createSignal<number[]>(savedFilter(ctx.channel.id));
  const [addingColumn, setAddingColumn] = createSignal(false);
  const [mode, setMode] = createSignal(loadMode(ctx.workspace.id, ctx.channel.id));
  const [addKind, setAddKind] = createSignal<AddKind>("task");
  const showMode = (next: "tasks" | "issues") => {
    setMode(next);
    saveMode(ctx.workspace.id, ctx.channel.id, next);
  };
  createEffect(() => saveFilter(ctx.channel.id, filter()));

  const run: Run = async (action) => {
    try {
      await action();
      setError("");
      return true;
    } catch (e) {
      setError(userMessage(e));
      ctx.playSound("error");
      return false;
    }
  };

  // Positive ids must be on the task, negative ids (an excluded tag) must not be.
  const [query, setQuery] = createSignal("");
  const shown = (task: Task) => {
    const q = query().trim().toLowerCase();
    return filter().every((id) => (id > 0 ? task.tagIds.includes(id) : !task.tagIds.includes(-id)))
      && (!q || decodeEmoji(task.title).toLowerCase().includes(q) || decodeEmoji(task.notes).toLowerCase().includes(q));
  };
  const doneColumn = () => board.value.columns.find((c) => c.isDone);
  const firstOpenColumn = () => board.value.columns.find((c) => !c.isDone) ?? board.value.columns[0];

  // Cards slide from where they were to where the board puts them (FLIP), after a move by this user.
  const cards = new Map<number, HTMLElement>();
  let before: Map<number, DOMRect> | null = null;
  const snapshot = () => (before = new Map([...cards].map(([id, el]) => [id, el.getBoundingClientRect()])));
  createEffect(on(() => board.value.tasks.map((t) => `${t.id}:${t.columnId}`).join() + board.value.columns.map((c) => c.id).join(), () => {
    const from = before;
    before = null;
    if (!from || motionMs() === 0) return;
    for (const [id, el] of cards) {
      const old = from.get(id);
      if (!old) continue;
      const now = el.getBoundingClientRect();
      const dx = old.left - now.left;
      const dy = old.top - now.top;
      if (Math.abs(dx) + Math.abs(dy) < 1) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
        { duration: motionMs() * 1.5, easing: "cubic-bezier(0.2, 0, 0, 1)" });
    }
  }, { defer: true }));

  const [autoAssign, setAutoAssign] = createSignal(loadAutoAssign(ctx.workspace.id, ctx.channel.id));
  const actions = taskActions(ctx, board.value, run, snapshot, autoAssign);
  // Ctrl+Z and friends while nothing else has focus, or something in this view does.
  let root!: HTMLDivElement;
  const undoKeys = historyKeys(ctx.history, (e) => setError(userMessage(e)));
  const onKey = (e: KeyboardEvent) => (e.target === document.body || root.contains(e.target as Node)) && undoKeys(e);
  document.addEventListener("keydown", onKey);
  onCleanup(() => document.removeEventListener("keydown", onKey));
  const move = (id: number, columnId: number, beforeId: number | null) => {
    const task = board.value.tasks.find((t) => t.id === id);
    if (task && id !== beforeId) void actions.move(task, columnId, beforeId);
  };
  const toggleDone = (task: Task) => {
    const done = doneColumn();
    const open = firstOpenColumn();
    if (!done || !open) return;
    move(task.id, task.columnId === done.id ? open.id : done.id, null);
  };

  // Adds a task to a column, or an issue; the new one is shown by switching to the view it belongs to.
  const addItem = async (title: string, kind: AddKind, columnId?: number) => {
    const added = kind === "issue"
      ? await actions.addIssue({ title, severity: "none", steps: "" })
      : await actions.add(title, columnId ?? firstOpenColumn().id);
    if (added) showMode(kind === "issue" ? "issues" : "tasks");
    return added;
  };

  // Clicking a card toggles its editor; links and the menu only open it.
  const showTask = (id: number, toggle = false) => {
    if (toggle && ctx.isSidePanelOpen(`task:${id}`)) return ctx.closeSidePanel();
    setOpenTask(id);
    ctx.openSidePanel(findTask(id)?.kind === "issue" ? "Issue" : "Task", solidMount(() => {
      onCleanup(() => openTask() === id && setOpenTask(null));
      return <TaskEditor context={ctx} board={board.value} task={() => findTask(id)} run={run} actions={actions} onOpen={(other) => showTask(other)} />;
    }), `task:${id}`);
  };
  const findTask = (id: number) => board.value.tasks.find((t) => t.id === id) ?? board.value.issues.find((t) => t.id === id);

  // Which task we have open, so others see it highlighted in our color.
  createEffect(() => ctx.presence.set({ open: openTask() }));
  onCleanup(() => ctx.presence.set(null));
  const viewersOf = (taskId: number) => ctx.presence.others()
    .filter((o) => (o.state as { open?: number | null } | null)?.open === taskId)
    .map((o) => ctx.users.get(o.userId));

  createEffect(() => {
    const id = openTask();
    if (id !== null && board.loaded && !findTask(id)) ctx.closeSidePanel();
  });

  // Archived tasks, in the side panel; `query` there starts as `search` (a link to an archived task).
  const archiveKey = (kind: "task" | "issue") => `archive-${kind}`;
  const archiveOpen = () => ctx.isSidePanelOpen(archiveKey(mode() === "issues" ? "issue" : "task"));
  const archivePanel = (kind: "task" | "issue", search = "") => solidMount(() => <ArchivePanel context={ctx} actions={actions} kind={kind} search={search} />);
  const toggleArchive = () => {
    const kind = mode() === "issues" ? "issue" : "task";
    ctx.toggleSidePanel(archiveKey(kind), `Archived ${kind}s`, archivePanel(kind));
  };

  // A followed link: open the task and bring its card into view, once the board is loaded.
  let handled: unknown = null;
  createEffect(() => {
    const target = ctx.target();
    if (target?.kind !== "task" || target === handled || !board.loaded) return;
    handled = target;
    const id = Number(target.id);
    if (!findTask(id)) {
      // Off the board: archived (still resolves as a link), or deleted.
      void getTask(ctx.api, id).then((task) => {
        if (task.archivedAt) ctx.openSidePanel(`Archived ${task.kind}s`, archivePanel(task.kind, task.title), archiveKey(task.kind));
        else setError("That task no longer exists.");
      }, () => setError("That task no longer exists."));
      return;
    }
    setFilter([]);
    showMode(findTask(id)!.kind === "issue" ? "issues" : "tasks");
    showTask(id);
    requestAnimationFrame(() => {
      const card = cards.get(id);
      card?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
      card?.classList.remove("flash");
      void card?.offsetWidth;
      card?.classList.add("flash");
    });
  });

  const selfAssignEntry = (task: Task): MenuEntry[] => {
    const me = ctx.users.me();
    if (me === null) return [];
    const assigned = task.assigneeIds.includes(me);
    return [{ label: assigned ? "Unassign me" : "Assign to me", icon: "assignee", action: () => void actions.assign(task, me, !assigned) }];
  };

  const taskMenu = (task: Task): MenuEntry[] => [
    { label: "Open", icon: task.kind === "issue" ? "info" : "channel-tasks", action: () => showTask(task.id) },
    { label: "Copy link", icon: "link", action: () => copyLink(ctx.linkTo({ kind: "task", id: task.id })) },
    { label: task.kind === "issue" ? "Convert to task" : "Convert to issue", icon: "forward", action: () => void actions.convert(task) },
    { label: "Copy title", icon: "copy", action: () => void copyText(task.title) },
    ...(task.kind === "issue" && task.status === "resolved" ? [{ label: "Archive", icon: "archive", action: () => void actions.archive(task) }] : []),
    "separator",
    ...(task.kind === "issue" ? [
      {
        label: "Status", icon: "forward",
        items: issueStatuses.map((s) => ({
          label: s.label, icon: s.value === task.status ? "check" : undefined, disabled: s.value === task.status,
          action: () => void actions.setStatus(task, s.value),
        })),
      },
      {
        label: "Severity", icon: "activity",
        items: severities.map((s) => ({
          label: s.label, swatch: severityColor[s.value], icon: s.value === task.severity ? "check" : undefined, disabled: s.value === task.severity,
          action: () => void actions.setSeverity(task, s.value),
        })),
      },
    ] : [{
      label: "Move to", icon: "forward",
      items: board.value.columns.map((c) => ({
        label: decodeEmoji(c.name), icon: c.id === task.columnId ? "check" : undefined, disabled: c.id === task.columnId,
        action: () => move(task.id, c.id, null),
      })),
    }]),
    {
      label: "Tags", icon: "tag",
      items: [
        ...board.value.tags.map((tag) => ({
          label: `#${tag.name}`, swatch: tag.color, icon: task.tagIds.includes(tag.id) ? "check" : undefined,
          action: () => void actions.toggleTag(task, tag),
        })),
        { render: () => <NewTagItem onAdd={(name) => actions.tagByName(task, name)} /> },
      ],
    },
    ...selfAssignEntry(task),
    // Who is assigned (click to take them off), then a search for anyone else: servers can be too big to list all.
    {
      label: "Assignees", icon: "assignee",
      items: [
        ...task.assigneeIds.map((id) => ({
          label: ctx.users.get(id).displayName, icon: "check", action: () => void actions.assign(task, id, false),
        })),
        ...(task.assigneeIds.length ? ["separator" as const] : []),
        {
          render: () => (
            <MemberSearch inline members={ctx.users.assignable()} exclude={task.assigneeIds} label="Assign someone" placeholder="Add person..."
              onPick={(id) => {
                closeContextMenu();
                void actions.assign(task, id, true);
              }} />
          ),
        },
      ],
    },
    "separator",
    { label: "Delete", icon: "delete", danger: true, action: () => void actions.remove(task) },
  ];

  const columnMenu = (column: Column, index: number, rename: () => void): MenuEntry[] => {
    const cols = board.value.columns;
    return [
      { label: "Rename", icon: "rename", action: rename },
      { label: column.isDone ? "Tasks here are not done" : "Tasks here are done", icon: "check",
        action: () => void actions.editColumn(column, { ...column, isDone: !column.isDone }) },
      ...(column.isDone ? [{
        label: `Keep on board: ${column.keepDone === 0 ? "all" : column.keepDone}`, icon: "archive",
        items: [10, 20, 50, 100, 0].map((keep) => ({
          label: keep === 0 ? "All done tasks" : `${keep} newest done`, icon: keep === column.keepDone ? "check" : undefined,
          disabled: keep === column.keepDone, action: () => void actions.keepDone(column, keep),
        })),
      }] : []),
      "separator",
      { label: "Move left", icon: "back", disabled: index === 0, action: () => void actions.moveColumn(column, cols[index - 1].id) },
      { label: "Move right", icon: "forward", disabled: index === cols.length - 1,
        action: () => void actions.moveColumn(column, cols[index + 2]?.id ?? null) },
      "separator",
      { label: "Delete column", icon: "delete", danger: true, disabled: cols.length < 2,
        action: () => void actions.removeColumn(column) },
    ];
  };

  return (
    <div class="view tasks" ref={root}>
      <header class="view-header">
        <div class="tasks-mode">
          <Select label="View" value={mode()} onChange={showMode}
            options={[
              { value: "tasks", label: "Tasks", icon: "channel-tasks" },
              { value: "issues", label: "Issues", icon: "info" },
            ]} />
        </div>
        <label class="tasks-search mw-box"><Icon name="search" size={14} />
          <input type="search" value={query()} placeholder={mode() === "tasks" ? "Search tasks" : "Search issues"} aria-label="Search"
            onInput={(e) => setQuery(e.currentTarget.value)} />
        </label>
        <TagBar context={ctx} tags={board.value.tags} filter={filter()} setFilter={setFilter} actions={actions} />
        <label class="tasks-auto-assign" title="New tasks, and tasks with no assignee moved to a done column, are assigned to you">
          <input type="checkbox" checked={autoAssign()}
            onChange={(e) => {
              setAutoAssign(e.currentTarget.checked);
              saveAutoAssign(ctx.workspace.id, ctx.channel.id, e.currentTarget.checked);
            }} />
          Auto assign self
        </label>
        <Show when={(mode() === "tasks" ? board.value.archived : board.value.archivedIssues) > 0 || archiveOpen()}>
          <button class="tasks-archive-button mw-fade-in" classList={{ open: archiveOpen() }} aria-pressed={archiveOpen()}
            title={mode() === "tasks" ? "Older done tasks, off the board" : "Resolved issues, off the list"} onClick={toggleArchive}>
            <Icon name="archive" size={14} /> {mode() === "tasks" ? board.value.archived : board.value.archivedIssues} archived
          </button>
        </Show>
        <div class="view-tools view-history mw-box">
          <HistoryControls history={ctx.history} onError={(e) => setError(userMessage(e))} />
        </div>
      </header>
      <Collapse open={!!error()}><p class="view-error">{error()}</p></Collapse>
      <Show when={board.loaded} fallback={<Skeleton kind="board" header={false} />}>
        <Show when={mode() === "tasks"} fallback={
          <IssueList context={ctx} board={board.value} shown={shown} openTask={openTask()} viewersOf={viewersOf} actions={actions}
            onOpen={(id) => showTask(id, true)} onMenu={(e, task) => ctx.openContextMenu(e, taskMenu(task))} onAdd={async (issue) => {
              const added = await actions.addIssue(issue);
              if (added) showMode("issues");
              return added;
            }} />
        }>
        <div class="tasks-board" style={{ "--columns": board.value.columns.length }}>
          <For each={board.value.columns}>
            {(column, index) => {
              const list = () => board.value.tasks.filter((t) => t.columnId === column.id);
              const visible = () => list().filter(shown);
              const [adding, setAdding] = createSignal(false);
              const [renaming, setRenaming] = createSignal(false);
              const beforeIdAt = (el: HTMLElement, y: number) => {
                for (const card of el.querySelectorAll<HTMLElement>(".task-card")) {
                  const r = card.getBoundingClientRect();
                  if (y < r.top + r.height / 2) return Number(card.dataset.id);
                }
                return null;
              };
              return (
                <section class="tasks-column mw-box mw-fade-in" aria-label={decodeEmoji(column.name)}
                  classList={{ "drop-end": dropAt()?.columnId === column.id && dropAt()?.beforeId === null }}
                  onDragOver={(e) => {
                    if (!e.dataTransfer?.types.includes(taskType)) return;
                    e.preventDefault();
                    const beforeId = beforeIdAt(e.currentTarget, e.clientY);
                    const at = dropAt();
                    if (at?.columnId !== column.id || at.beforeId !== beforeId) setDropAt({ columnId: column.id, beforeId });
                  }}
                  onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropAt(null)}
                  onDrop={(e) => {
                    const id = Number(e.dataTransfer?.getData(taskType));
                    const at = dropAt();
                    setDropAt(null);
                    if (!id || !at) return;
                    e.preventDefault();
                    move(id, at.columnId, at.beforeId);
                  }}>
                  <header class="tasks-column-header" onContextMenu={(e) => ctx.openContextMenu(e, columnMenu(column, index(), () => setRenaming(true)))}
                    onDblClick={() => setRenaming(true)}>
                    <span class="tasks-status" classList={{ done: column.isDone }} title={column.isDone ? "Tasks here are done" : undefined} />
                    <Show when={!renaming()} fallback={
                      <NameInput value={decodeEmoji(column.name)} label="Column name" onDone={(name) => {
                        setRenaming(false);
                        if (name && name !== decodeEmoji(column.name)) void actions.editColumn(column, { ...column, name });
                      }} />
                    }>
                      <span class="tasks-column-name">{decodeEmoji(column.name)}</span>
                    </Show>
                    <span class="tasks-count">{filter().length ? `${visible().length}/${list().length}` : list().length}</span>
                    <button class="icon-button" title={`Add to ${decodeEmoji(column.name)}`} aria-label="Add task" onClick={() => setAdding(!adding())}>
                      <Icon name="add" />
                    </button>
                    <button class="icon-button" title="Column options" aria-label="Column options"
                      onClick={(e) => ctx.openContextMenu(e, columnMenu(column, index(), () => setRenaming(true)))}>
                      <Icon name="more" />
                    </button>
                  </header>
                  <Collapse open={adding()}>
                    <AddForm active={adding()} placeholder="New task, Enter to add" onDone={() => setAdding(false)}
                      onAdd={(title, kind) => addItem(title, kind, column.id)} kind={{ value: addKind(), onChange: setAddKind }} />
                  </Collapse>
                  <ul class="tasks-cards mw-scroll-fade">
                    <For each={visible()}>
                      {(task) => (
                        <TaskCard context={ctx} task={task} tags={board.value.tags} selected={openTask() === task.id} viewers={viewersOf(task.id)}
                          canFinish={!!doneColumn()} waiting={openDependencies(board.value, task)} done={doneColumn()?.id === task.columnId || column.isDone}
                          dropBefore={dropAt()?.beforeId === task.id && dropAt()?.columnId === column.id}
                          dragging={dragging() === task.id}
                          ref={(el) => {
                            cards.set(task.id, el);
                            onCleanup(() => cards.get(task.id) === el && cards.delete(task.id));
                          }}
                          onOpen={() => showTask(task.id, true)}
                          onMenu={(e) => ctx.openContextMenu(e, taskMenu(task))}
                          onToggleDone={() => toggleDone(task)}
                          onDragStart={() => setDragging(task.id)}
                          onDragEnd={() => { setDragging(null); setDropAt(null); }} />
                      )}
                    </For>
                  </ul>
                  <Show when={visible().length === 0 && !adding()}>
                    <p class="tasks-empty mw-fade-in">{list().length ? "No tasks with these tags." : "Nothing here."}</p>
                  </Show>
                </section>
              );
            }}
          </For>
          <section class="tasks-column tasks-new-column mw-box" classList={{ adding: addingColumn() }}>
            <Show when={addingColumn()} fallback={
              <button class="tasks-add-column" onClick={() => setAddingColumn(true)}><Icon name="add" /> Add column</button>
            }>
              <AddForm active placeholder="Column name, Enter to add" onDone={() => setAddingColumn(false)}
                onAdd={async (name) => {
                  const added = await actions.addColumn(name);
                  if (added) setAddingColumn(false);
                  return added;
                }} />
            </Show>
          </section>
        </div>
        </Show>
      </Show>
    </div>
  );
}

// Archived tasks, searchable, 50 more at a time; each can go back onto the board.
function ArchivePanel(props: { context: ChannelContext; actions: TaskActions; kind: "task" | "issue"; search: string }) {
  const [query, setQuery] = createSignal(props.search);
  const [pages, setPages] = createSignal(1);
  const archive = createArchive(props.context.api, props.context.channel.id, props.kind, query, pages);
  let timer = 0;
  onCleanup(() => clearTimeout(timer));
  return (
    <div class="tasks-archive">
      <input class="mw-input mw-box" placeholder={`Search archived ${props.kind}s`} aria-label={`Search archived ${props.kind}s`} value={query()}
        onInput={(e) => {
          const value = e.currentTarget.value;
          clearTimeout(timer);
          timer = window.setTimeout(() => {
            setPages(1);
            setQuery(value);
          }, 200);
        }} />
      <Show when={archive.loaded} fallback={<Skeleton kind="line" />}>
        <ul class="tasks-archive-list mw-scroll-fade">
          <For each={archive.value.tasks} fallback={<li class="muted">{query().trim() ? `No archived ${props.kind}s match.` : "Nothing is archived."}</li>}>
            {(task) => (
              <li class="tasks-archive-item mw-box mw-fade-in">
                <span class="tasks-archive-text">
                  <span class="tasks-archive-title">{task.title}</span>
                  <span class="muted">{task.doneAt ? `Done ${relativeTime(task.doneAt)}` : `Added ${relativeTime(task.createdAt)}`}</span>
                </span>
                <Show when={props.context.can("edit_content")}>
                  <button class="mw-button mw-box" onClick={() => void props.actions.unarchive(task)}>Restore</button>
                </Show>
              </li>
            )}
          </For>
        </ul>
        <Show when={archive.value.tasks.length < archive.value.total}>
          <button class="mw-button mw-box" onClick={() => setPages(pages() + 1)}>
            Show {Math.min(archivePage, archive.value.total - archive.value.tasks.length)} more
          </button>
        </Show>
      </Show>
    </div>
  );
}

// Tag filter in the header, and a popover to add, rename, recolor and delete tags.
function TagBar(props: { context: ChannelContext; tags: Tag[]; filter: number[]; setFilter: (ids: number[]) => void; actions: TaskActions }) {
  const [open, setOpen] = createSignal(false);
  // A click cycles a tag through normal, including (id) and excluding (-id).
  const cycle = (id: number) => {
    const others = props.filter.filter((x) => Math.abs(x) !== id);
    props.setFilter(props.filter.includes(id) ? [...others, -id] : props.filter.includes(-id) ? others : [...others, id]);
  };
  return (
    <div class="tasks-tagbar">
      <For each={props.tags}>{(tag) => <TagChip tag={tag} on={props.filter.includes(tag.id)} off={props.filter.includes(-tag.id)} onClick={() => cycle(tag.id)} />}</For>
      <Show when={props.filter.length}>
        <button class="icon-button" title="Show all tasks" aria-label="Clear tag filter" onClick={() => props.setFilter([])}><Icon name="close" /></button>
      </Show>
      <div class="mw-popover-anchor">
        <button class="icon-button" title="Manage tags" aria-label="Manage tags" aria-expanded={open()} onClick={() => setOpen(!open())}>
          <Icon name="tag" />
        </button>
        <Popover open={open()} onClose={() => setOpen(false)} label="Tags" placement="below" align="end">
          <div class="tasks-tag-manager">
            <For each={props.tags} fallback={<p class="muted">No tags yet.</p>}>
              {(tag) => <TagRow tag={tag} actions={props.actions} />}
            </For>
            <form onSubmit={(e) => {
              e.preventDefault();
              const input = e.currentTarget.elements.namedItem("tag") as HTMLInputElement;
              const name = input.value.trim();
              if (name) void props.actions.addTag(name).then(() => (input.value = ""));
            }}>
              <input name="tag" class="mw-input mw-box view-input" placeholder="New tag, e.g. needs-testing" aria-label="New tag" />
            </form>
          </div>
        </Popover>
      </div>
    </div>
  );
}

// A tag in the tag manager: its color (click for swatches), name and delete.
function TagRow(props: { tag: Tag; actions: TaskActions }) {
  const [picking, setPicking] = createSignal(false);
  return (
    <div>
      <div class="tasks-tag-row">
        <button class="tasks-tag-color" classList={{ on: picking() }} style={{ background: props.tag.color }} title="Change color"
          aria-label="Change color" aria-expanded={picking()} onClick={() => setPicking(!picking())} />
        <input class="mw-input mw-box view-input" value={props.tag.name} aria-label="Tag name"
          onChange={(e) => void props.actions.editTag(props.tag, { ...props.tag, name: e.currentTarget.value })} />
        <button class="icon-button" title="Delete tag" aria-label={`Delete #${props.tag.name}`}
          onClick={() => void props.actions.removeTag(props.tag)}>
          <Icon name="delete" />
        </button>
      </div>
      <Collapse open={picking()}>
        <div class="tasks-tag-swatches">
          <ColorSwatches colors={tagColors} label={`Color of #${props.tag.name}`} value={props.tag.color} small custom
            onPick={(color) => color !== props.tag.color && void props.actions.editTag(props.tag, { ...props.tag, color })} />
        </div>
      </Collapse>
    </div>
  );
}

function TaskCard(props: {
  context: ChannelContext;
  task: Task;
  tags: Tag[];
  selected: boolean;
  // Other members who have this task open.
  viewers: ReturnType<ChannelContext["users"]["get"]>[];
  canFinish: boolean;
  // Tasks and issues this one waits for that are not finished.
  waiting: number;
  done: boolean;
  dropBefore: boolean;
  dragging: boolean;
  ref: (el: HTMLElement) => void;
  onOpen: () => void;
  onMenu: (e: MouseEvent) => void;
  onToggleDone: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const assignees = () => props.task.assigneeIds;
  // Up to three avatars on the card; the rest as a count.
  const shown = () => assignees().slice(0, assignees().length > 3 ? 2 : 3);
  const { copied, copy } = createCopied();
  const copyTitle = () => void copy(props.task.title);
  const tags =() => props.task.tagIds.map((id) => props.tags.find((t) => t.id === id)).filter((t): t is Tag => !!t);
  return (
    <li ref={props.ref} data-id={props.task.id} class="task-card mw-box mw-fade-in" draggable="true"
      classList={{ selected: props.selected, viewed: props.viewers.length > 0, "drop-before": props.dropBefore, dragging: props.dragging, done: props.done }}
      style={props.viewers.length > 0 ? { "--who": props.viewers[0].color || "var(--mw-text-muted)" } : undefined}
      onContextMenu={props.onMenu}
      onDragStart={(e) => {
        e.dataTransfer?.setData(taskType, String(props.task.id));
        e.dataTransfer?.setData("text/plain", props.context.linkTo({ kind: "task", id: props.task.id }));
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        props.onDragStart();
      }}
      onDragEnd={props.onDragEnd}>
      <Show when={props.canFinish}>
        <button class="task-check" classList={{ on: props.done }} onClick={props.onToggleDone}
          title={props.done ? "Mark not done" : "Mark done"} aria-pressed={props.done}>
          <Icon name="check" />
        </button>
      </Show>
      <span class="task-copy">
        <button class="icon-button" title="Copy title" aria-label="Copy title" onClick={copyTitle}>
          <Icon name="copy" size={13} />
        </button>
        <Show when={copied()}><span class="task-copied mw-box mw-fade-in" role="status">Title copied to clipboard!</span></Show>
      </span>
      <button class="task-open" onClick={props.onOpen} title="Open task">
        <span class="task-title">{props.task.title}</span>
        <Show when={tags().length}>
          <span class="task-tags"><For each={tags()}>{(tag) => <TagChip tag={tag} />}</For></span>
        </Show>
        <Show when={props.task.commentCount || props.task.reactions.length || props.waiting || props.task.blocks.length}>
          <span class="task-meta">
            <Show when={props.waiting}>
              <span class="issue-blocked" title="Waiting for tasks or issues that are not finished"><Icon name="link" size={13} /> {props.waiting}</span>
            </Show>
            <Show when={props.task.blocks.length}>
              <span title="Tasks and issues that depend on this"><Icon name="link" size={13} /> Blocks {props.task.blocks.length}</span>
            </Show>
            <Show when={props.task.commentCount}>
              <span title="Comments"><Icon name="comment" size={13} /> {props.task.commentCount}</span>
            </Show>
            <For each={props.task.reactions}>
              {(r) => <span title={`:${r.code}:`}>{emojiFor(r.code) ?? `:${r.code}:`}{r.count > 1 ? ` ${r.count}` : ""}</span>}
            </For>
          </span>
        </Show>
      </button>
      <Show when={props.viewers.length > 0}>
        <span class="task-viewers mw-fade-in" title={`Open by ${props.viewers.map((v) => v.displayName).join(", ")}`}>
          <For each={props.viewers}>{(v) => <Avatar user={v} size={16} />}</For>
        </span>
      </Show>
      <Show when={assignees().length > 0}>
        <span class="task-assignees mw-fade-in" title={`Assigned to ${assignees().map((id) => props.context.users.get(id).displayName).join(", ")}`}>
          <For each={shown()}>
            {(id) => <span class="task-assignee mw-fade-in" onContextMenu={(e) => props.context.openUserMenu(e, id)}>
              <Avatar user={props.context.users.get(id)} size={20} />
            </span>}
          </For>
          <Show when={assignees().length > shown().length}>
            <span class="task-assignee-more">+{assignees().length - shown().length}</span>
          </Show>
        </span>
      </Show>
    </li>
  );
}

// A field in the task menu that puts a tag on the task, creating it if it is new.
function NewTagItem(props: { onAdd: (name: string) => Promise<unknown> }) {
  return (
    <form class="menu-rename" onSubmit={(e) => {
      e.preventDefault();
      const name = (e.currentTarget.elements.namedItem("tag") as HTMLInputElement).value.trim().replace(/^#/, "").toLowerCase();
      if (!name) return;
      closeContextMenu();
      void props.onAdd(name);
    }}>
      <input name="tag" class="mw-input mw-box" placeholder="New tag, Enter to add" aria-label="New tag" />
    </form>
  );
}

function NameInput(props: { value: string; label: string; onDone: (value: string) => void }) {
  let done = false;
  const finish = (value: string) => {
    if (done) return;
    done = true;
    props.onDone(value.trim());
  };
  return (
    <input class="mw-input mw-box view-input tasks-name-input" value={props.value} aria-label={props.label}
      ref={(el) => requestAnimationFrame(() => { el.focus(); el.select(); })}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(e.currentTarget.value);
        else if (e.key === "Escape") finish(props.value);
      }}
      onBlur={(e) => finish(e.currentTarget.value)} />
  );
}

function TaskEditor(props: {
  context: ChannelContext; board: Board; task: () => Task | undefined; run: Run; actions: TaskActions; onOpen: (id: number) => void;
}) {
  const ctx = props.context;
  const [confirming, setConfirming] = createSignal(false);
  const save = (changes: Partial<Pick<Task, "title" | "notes">>) => {
    const task = props.task();
    if (!task) return;
    const next = { ...task, ...changes };
    if (next.title === task.title && next.notes === task.notes) return;
    void props.actions.edit(task, next);
  };

  return (
    <Show when={props.task()} keyed={false}>
      {(task) => (
        <div class="task-editor">
          <input class="mw-input mw-box task-editor-title" value={task().title} aria-label="Title"
            onChange={(e) => e.currentTarget.value.trim() ? save({ title: e.currentTarget.value.trim() }) : (e.currentTarget.value = task().title)}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
          <Show when={task().kind === "issue"} fallback={
            <label class="task-editor-field">
              <span>Column</span>
              <Select label="Column" value={task().columnId}
                options={props.board.columns.map((c) => ({ value: c.id, label: decodeEmoji(c.name) }))}
                onChange={(id) => void props.actions.move(task(), id, null)} />
            </label>
          }>
            <label class="task-editor-field">
              <span>Severity</span>
              <Select label="Severity" value={task().severity}
                options={severities.map((s) => ({ value: s.value, label: s.label, swatch: severityColor[s.value] }))}
                onChange={(v) => void props.actions.setSeverity(task(), v)} />
            </label>
            <label class="task-editor-field">
              <span>Status</span>
              <Select label="Status" value={task().status} options={issueStatuses}
                onChange={(v) => void props.actions.setStatus(task(), v)} />
            </label>
          </Show>
          <Show when={task().kind === "issue"}>
            <div class="task-editor-field column">
              <span>Problem description</span>
              <For each={[task().id]}>
                {() => (
                  <RichEditor workspaceId={ctx.workspace.id} value={decodeEmoji(task().steps)} placeholder="What goes wrong, and how can someone make it happen?" minRows={3}
                    onBlur={(md) => md.trim() !== decodeEmoji(task().steps).trim() && void props.actions.setSteps(task(), md.trim())} />
                )}
              </For>
            </div>
          </Show>
          <div class="task-props">
            <AssigneesProperty context={ctx} task={task()} actions={props.actions} />
            <TagsProperty task={task()} tags={props.board.tags} actions={props.actions} />
            <DependenciesProperty board={props.board} task={task()} direction="depends" actions={props.actions} onOpen={props.onOpen} />
            <DependenciesProperty board={props.board} task={task()} direction="blocks" actions={props.actions} onOpen={props.onOpen} />
          </div>
          <div class="task-editor-row">
            <Reactions reactions={task().reactions} me={ctx.users.me()} nameOf={(id) => ctx.users.get(id).displayName} workspaceId={ctx.workspace.id}
              placement="below" onToggle={(code) => void props.run(() => reactToTask(ctx.api, task().id, code))} />
            <span class="mw-editor-spacer" />
            <button class="mw-button mw-box" onClick={() => void props.actions.convert(task())}>
              {task().kind === "issue" ? "Convert to task" : "Convert to issue"}
            </button>
            <button class="icon-button" title="Copy link" aria-label="Copy link" onClick={() => copyLink(ctx.linkTo({ kind: "task", id: task().id }))}>
              <Icon name="link" />
            </button>
          </div>
          <p class="task-editor-meta">
            Added by {ctx.users.get(task().authorId).displayName} {relativeTime(task().createdAt)}
            <Show when={task().doneAt}>, {task().kind === "issue" ? "resolved" : "done"} {relativeTime(task().doneAt)}</Show>
          </p>
          <Activity context={ctx} board={props.board} task={task()} run={props.run} />
          <div>
            <button class="mw-button mw-box task-editor-delete" classList={{ confirming: confirming() }}
              aria-expanded={confirming()} onClick={() => setConfirming(!confirming())}>
              <Icon name="delete" /> Delete {task().kind}
            </button>
            <ConfirmPrompt open={confirming()} question={`Are you sure you want to delete "${task().title}"?`}
              confirmLabel="Delete" onConfirm={() => void props.actions.remove(task())} onCancel={() => setConfirming(false)} />
          </div>
        </div>
      )}
    </Show>
  );
}
