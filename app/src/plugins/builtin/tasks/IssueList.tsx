import { For, Show, createSignal } from "solid-js";
import { relativeTime } from "../../../core/time";
import { emojiFor } from "../../../markdown/emoji";
import Markdown from "../../../markdown/Markdown";
import { Icon } from "../../../theme/icons";
import Avatar from "../../../ui/Avatar";
import Dialog from "../../../ui/Dialog";
import Popover from "../../../ui/Popover";
import { createProgressive } from "../../../ui/progressive";
import Select from "../../../ui/Select";
import type { ChannelContext } from "../../types";
import type { TaskActions } from "./actions";
import RichEditor, { type EditorApi } from "../../../editor/RichEditor";
import {
  issueStatuses, openDependencies, severities, type Board, type IssueStatus, type NewIssue, type Severity, type Tag, type Task,
} from "./data";
import { TagChip } from "./TagChip";
import { createCopied } from "../../../ui/clipboard";

export const severityColor: Record<Severity, string> = {
  none: "var(--mw-text-disabled)",
  low: "var(--mw-success)",
  medium: "var(--mw-warning)",
  high: "color-mix(in srgb, var(--mw-warning) 50%, var(--mw-danger))",
  severe: "var(--mw-danger)",
};
const statusColor: Record<IssueStatus, string> = {
  triage: "var(--mw-text-disabled)",
  in_progress: "var(--mw-accent)",
  needs_testing: "var(--mw-warning)",
  resolved: "var(--mw-success)",
};
const severityOptions = severities.map((s) => ({ value: s.value, label: s.label, swatch: severityColor[s.value] }));
const statusOptions = issueStatuses.map((s) => ({ value: s.value, label: s.label, swatch: statusColor[s.value] }));
const rank = (s: Severity) => severities.findIndex((x) => x.value === s);
const statusRank = (s: IssueStatus) => issueStatuses.findIndex((x) => x.value === s);

type SortBy = "severity" | "status" | "added" | "updated";
const sortOptions: { value: SortBy; label: string }[] = [
  { value: "severity", label: "Severity" }, { value: "status", label: "Status" },
  { value: "added", label: "Date added" }, { value: "updated", label: "Last updated" },
];
// The first-listed end of each order: most severe, furthest along, newest, most recently changed.
const compare: Record<SortBy, (a: Task, b: Task) => number> = {
  severity: (a, b) => rank(b.severity) - rank(a.severity),
  status: (a, b) => statusRank(b.status) - statusRank(a.status),
  added: (a, b) => b.createdAt.localeCompare(a.createdAt),
  updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
};

// Orders apply in turn: later ones only separate issues the earlier ones consider equal. Descending is the first-listed end above.
type SortRule = { by: SortBy; descending: boolean };
const sortLabel = (by: SortBy) => sortOptions.find((o) => o.value === by)!.label;

// Every issue in one long column, the unresolved first and the most severe first, each with what is known about it.
export default function IssueList(props: {
  context: ChannelContext;
  board: Board;
  shown: (task: Task) => boolean;
  openTask: number | null;
  viewersOf: (taskId: number) => ReturnType<ChannelContext["users"]["get"]>[];
  actions: TaskActions;
  onOpen: (id: number) => void;
  onMenu: (e: MouseEvent, task: Task) => void;
  // Resolves false when the add failed (its error is shown on the board): the form then stays with what was typed.
  onAdd: (issue: NewIssue) => Promise<boolean>;
}) {
  // Like the tags: a click cycles a status through normal, including and excluding. Resolved issues start out excluded.
  const [statusFilter, setStatusFilter] = createSignal<Partial<Record<IssueStatus, "include" | "exclude">>>({ resolved: "exclude" });
  const cycleStatus = (s: IssueStatus) => {
    const { [s]: current, ...others } = statusFilter();
    setStatusFilter(current === undefined ? { ...others, [s]: "include" } : current === "include" ? { ...others, [s]: "exclude" } : others);
  };
  const statusShown = (i: Task) => {
    const filter = statusFilter();
    const included = issueStatuses.filter((x) => filter[x.value] === "include");
    return filter[i.status] !== "exclude" && (included.length === 0 || filter[i.status] === "include");
  };
  const [adding, setAdding] = createSignal(false);
  const count = (s: IssueStatus) => props.board.issues.filter((i) => i.status === s).length;
  const [rules, setRules] = createSignal<SortRule[]>([{ by: "severity", descending: true }]);
  const [sortOpen, setSortOpen] = createSignal(false);
  const changeRule = (index: number, change: Partial<SortRule>) => setRules(rules().map((r, i) => (i === index ? { ...r, ...change } : r)));
  const unusedSort = () => sortOptions.find((o) => !rules().some((r) => r.by === o.value));
  const sorted = () => {
    const order = rules();
    return props.board.issues
      .filter((i) => props.shown(i) && statusShown(i))
      .sort((a, b) => {
        for (const rule of order) {
          const result = compare[rule.by](a, b);
          if (result) return rule.descending ? result : -result;
        }
        return b.id - a.id;
      });
  };
  const list = createProgressive(sorted, { from: "start", first: 60 });
  return (
    <div class="issues">
      <div class="issues-bar">
        <div class="issues-filter" role="group" aria-label="Status">
          <button class="task-tag mw-box clickable" classList={{ on: Object.keys(statusFilter()).length === 0 }}
            aria-pressed={Object.keys(statusFilter()).length === 0} onClick={() => setStatusFilter({})}>
            All {props.board.issues.length}
          </button>
          <For each={issueStatuses}>
            {(s) => (
              <button class="task-tag mw-box clickable" classList={{ on: statusFilter()[s.value] === "include", off: statusFilter()[s.value] === "exclude" }}
                title="Click to show only these, again to hide them, again to clear"
                style={{ "--tag": statusColor[s.value] }} onClick={() => cycleStatus(s.value)}>
                {s.label} {count(s.value)}
              </button>
            )}
          </For>
        </div>
        <div class="mw-popover-anchor">
          <button class="mw-button mw-box" classList={{ confirming: sortOpen() }} aria-expanded={sortOpen()} title="Order of the list" onClick={() => setSortOpen(!sortOpen())}>
            <Icon name="sort-reverse" /> <For each={rules()}>
              {(r, i) => <>{i() > 0 && ","} {sortLabel(r.by)} <Icon name={r.descending ? "sort-down" : "sort-up"} size={13} /></>}
            </For>
          </button>
          <Popover open={sortOpen()} onClose={() => setSortOpen(false)} label="Order" placement="below" align="end">
            <div class="issues-sort">
              <For each={rules()}>
                {(rule, index) => (
                  <div class="issues-sort-rule">
                    <Select label={index() === 0 ? "Sort by" : "Then by"} value={rule.by} onChange={(by) => changeRule(index(), { by })}
                      options={sortOptions.filter((o) => o.value === rule.by || !rules().some((r) => r.by === o.value))} />
                    <button class="icon-button" title={rule.descending ? "Descending" : "Ascending"} aria-label={rule.descending ? "Descending" : "Ascending"}
                      onClick={() => changeRule(index(), { descending: !rule.descending })}>
                      <Icon name={rule.descending ? "sort-down" : "sort-up"} />
                    </button>
                    <button class="icon-button" title="Remove this order" aria-label="Remove this order" disabled={rules().length < 2}
                      onClick={() => setRules(rules().filter((_, i) => i !== index()))}><Icon name="close" /></button>
                  </div>
                )}
              </For>
              <Show when={unusedSort()}>
                {(next) => (
                  <button class="mw-button mw-box" onClick={() => setRules([...rules(), { by: next().value, descending: true }])}>
                    <Icon name="add" /> Then by...
                  </button>
                )}
              </Show>
            </div>
          </Popover>
        </div>
        <button class="mw-button mw-box" classList={{ confirming: adding() }} aria-expanded={adding()} onClick={() => setAdding(!adding())}>
          <Icon name="add" /> New issue
        </button>
      </div>
      <Dialog open={adding()} title="New issue" onClose={() => setAdding(false)}>
        <NewIssueForm context={props.context} onCancel={() => setAdding(false)}
          onAdd={async (issue) => { if (await props.onAdd(issue)) setAdding(false); }} />
      </Dialog>
      <ul class="issues-list mw-scroll-fade">
        <For each={list.shown()}>
          {(issue) => (
            <IssueCard context={props.context} board={props.board} issue={issue} selected={props.openTask === issue.id}
              viewers={props.viewersOf(issue.id)} actions={props.actions} onOpen={() => props.onOpen(issue.id)}
              onMenu={(e) => props.onMenu(e, issue)} />
          )}
        </For>
      </ul>
      <Show when={sorted().length === 0}>
        <p class="tasks-empty mw-fade-in">
          {props.board.issues.length ? "No issues match." : "No issues yet."}
        </p>
      </Show>
    </div>
  );
}

function IssueCard(props: {
  context: ChannelContext;
  board: Board;
  issue: Task;
  selected: boolean;
  viewers: ReturnType<ChannelContext["users"]["get"]>[];
  actions: TaskActions;
  onOpen: () => void;
  onMenu: (e: MouseEvent) => void;
}) {
  const ctx = props.context;
  const issue = () => props.issue;
  const tags = () => issue().tagIds.map((id) => props.board.tags.find((t) => t.id === id)).filter((t): t is Tag => !!t);
  const waiting = () => openDependencies(props.board, issue());
  const { copied, copy } = createCopied();
  const copyTitle = () => void copy(issue().title);
  return (
    <li class="task-card issue-card mw-box mw-fade-in" data-id={issue().id}
      classList={{ selected: props.selected, viewed: props.viewers.length > 0, done: issue().status === "resolved" }}
      style={{ "--sev": severityColor[issue().severity], ...(props.viewers.length > 0 ? { "--who": props.viewers[0].color || "var(--mw-text-muted)" } : {}) }}
      tabIndex={0} onContextMenu={props.onMenu}
      onClick={(e) => !(e.target as HTMLElement).closest("button, input, a, .mw-select, .task-assignee") && props.onOpen()}
      onKeyDown={(e) => e.target === e.currentTarget && e.key === "Enter" && props.onOpen()}>
      <div class="issue-main">
        <div class="issue-head">
          <span class="task-open"><span class="task-title">{issue().title}</span></span>
          <span class="task-copy">
            <button class="icon-button" title="Copy title" aria-label="Copy title" onClick={copyTitle}>
              <Icon name="copy" size={13} />
            </button>
            <Show when={copied()}><span class="task-copied mw-box mw-fade-in" role="status">Title copied to clipboard!</span></Show>
          </span>
          <Select label="Severity" value={issue().severity} options={severityOptions} class="issue-select"
            onChange={(v) => void props.actions.setSeverity(issue(), v)} />
          <Select label="Status" value={issue().status} options={statusOptions} class="issue-select"
            onChange={(v) => void props.actions.setStatus(issue(), v)} />
        </div>
        <Show when={tags().length}>
          <span class="task-tags"><For each={tags()}>{(tag) => <TagChip tag={tag} />}</For></span>
        </Show>
        <Show when={issue().steps.trim() || issue().lastComment}>
          <div class="issue-texts">
        <Show when={issue().steps.trim()}>
          <div class="issue-text">
            <span class="issue-text-label">Problem description</span>
            <Markdown source={issue().steps} breaks class="issue-text-body" workspaceId={ctx.workspace.id} />
          </div>
        </Show>
        <Show when={issue().lastComment}>
          {(comment) => (
            <div class="issue-text">
              <span class="issue-text-label">{ctx.users.get(comment().authorId).displayName} {relativeTime(comment().createdAt)}</span>
              <Markdown source={comment().body} breaks class="issue-text-body" workspaceId={ctx.workspace.id} />
            </div>
          )}
        </Show>
          </div>
        </Show>
        <div class="issue-meta">
          <span>Added by {ctx.users.get(issue().authorId).displayName} {relativeTime(issue().createdAt)}</span>
          <Show when={waiting() > 0}>
            <span class="issue-blocked" title="Waiting for tasks or issues that are not finished"><Icon name="link" size={13} /> Waiting for {waiting()}</span>
          </Show>
          <Show when={issue().blocks.length > 0}>
            <span title="Tasks and issues that depend on this"><Icon name="link" size={13} /> Blocks {issue().blocks.length}</span>
          </Show>
          <Show when={issue().commentCount}>
            <span title="Comments"><Icon name="comment" size={13} /> {issue().commentCount}</span>
          </Show>
          <For each={issue().reactions}>
            {(r) => <span title={`:${r.code}:`}>{emojiFor(r.code) ?? `:${r.code}:`}{r.count > 1 ? ` ${r.count}` : ""}</span>}
          </For>
          <Show when={issue().assigneeIds.length}>
            <span class="task-assignees" title={`Assigned to ${issue().assigneeIds.map((id) => ctx.users.get(id).displayName).join(", ")}`}>
              <For each={issue().assigneeIds.slice(0, 4)}>
                {(id) => <span class="task-assignee" onContextMenu={(e) => ctx.openUserMenu(e, id)}><Avatar user={ctx.users.get(id)} size={20} /></span>}
              </For>
              <Show when={issue().assigneeIds.length > 4}><span class="task-assignee-more">+{issue().assigneeIds.length - 4}</span></Show>
            </span>
          </Show>
        </div>
      </div>
    </li>
  );
}

// Everything a new issue starts with: a title, how severe it is and a description of the problem.
function NewIssueForm(props: { context: ChannelContext; onAdd: (issue: NewIssue) => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = createSignal("");
  const [severity, setSeverity] = createSignal<Severity>("none");
  const [busy, setBusy] = createSignal(false);
  let steps!: EditorApi;
  const submit = async (e?: Event) => {
    e?.preventDefault();
    if (!title().trim() || busy()) return;
    setBusy(true);
    try {
      await props.onAdd({ title: title().trim(), severity: severity(), steps: steps.markdown().trim() });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="issue-new" onSubmit={(e) => void submit(e)}>
      <label class="task-editor-field column">
        <span>Title</span>
        <input class="mw-input mw-box" value={title()} placeholder="What is wrong, in a few words" aria-label="Title"
          onInput={(e) => setTitle(e.currentTarget.value)} />
      </label>
      <div class="task-editor-field">
        <span>Severity</span>
        <Select label="Severity" value={severity()} options={severityOptions} onChange={setSeverity} />
      </div>
      <div class="task-editor-field column">
        <span>Problem description</span>
        <RichEditor workspaceId={props.context.workspace.id} placeholder="What goes wrong, and how can someone make it happen?" minRows={5}
          ref={(api) => (steps = api)} />
      </div>
      <div class="issue-new-actions">
        <button type="button" class="mw-button mw-box" onClick={props.onCancel}>Cancel</button>
        <button type="submit" class="mw-button primary mw-box" disabled={!title().trim() || busy()}><Icon name="add" /> Add issue</button>
      </div>
    </form>
  );
}
