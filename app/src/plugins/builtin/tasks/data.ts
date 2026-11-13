import { readJson, writeJson } from "../../../core/storage";
import type { Accessor } from "solid-js";
import type { PluginClient } from "../../../api/client";
import type { ApiValue } from "../../../api/types";
import { decodeEmoji, encodeEmoji } from "../../../markdown/emoji";
import type { ReactionSummary } from "../../../ui/Reactions";
import { createLive } from "../../live";
import { defaultKeepDone } from "../../../system/tasks";

export interface Column {
  id: number;
  name: string;
  isDone: boolean;
  // Done tasks kept on the board; older ones are archived. 0 keeps all.
  keepDone: number;
}

export interface Tag {
  id: number;
  name: string;
  color: string;
}

export type Severity = "none" | "low" | "medium" | "high" | "severe";
export type IssueStatus = "triage" | "in_progress" | "needs_testing" | "resolved";

export const severities: { value: Severity; label: string }[] = [
  { value: "none", label: "None" }, { value: "low", label: "Low" }, { value: "medium", label: "Medium" },
  { value: "high", label: "High" }, { value: "severe", label: "Severe" },
];
export const issueStatuses: { value: IssueStatus; label: string }[] = [
  { value: "triage", label: "Triage" }, { value: "in_progress", label: "In progress" },
  { value: "needs_testing", label: "Needs testing" }, { value: "resolved", label: "Resolved" },
];
export const severityLabel = (s: string) => severities.find((x) => x.value === s)?.label ?? s;
export const statusLabel = (s: string) => issueStatuses.find((x) => x.value === s)?.label ?? s;

export interface Task {
  id: number;
  kind: "task" | "issue";
  // Issues are in no column (columnId 0) and have a severity and a status.
  severity: Severity;
  status: IssueStatus;
  // Ids of the tasks and issues this one waits for, and of those waiting for this one.
  dependsOn: number[];
  blocks: number[];
  columnId: number;
  title: string;
  notes: string;
  // How to make an issue happen again (markdown); empty for tasks.
  steps: string;
  assigneeIds: number[];
  authorId: number;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
  archivedAt: string | null;
  tagIds: number[];
  commentCount: number;
  lastComment: { authorId: number; body: string; createdAt: string } | null;
  reactions: ReactionSummary[];
}

export interface Board {
  columns: Column[];
  tags: Tag[];
  tasks: Task[];
  issues: Task[];
  // How many tasks are archived (off the board).
  archived: number;
  archivedIssues: number;
}

export interface Comment {
  id: number;
  authorId: number;
  body: string;
  createdAt: string;
  editedAt: string | null;
}

type Raw = Record<string, ApiValue>;
type RawTask = Raw & { last_comment?: { author_id: number; body: string; created_at: string } | null; tag_ids: number[]; assignee_ids?: number[]; depends_on?: number[]; blocks?: number[]; reactions: ReactionSummary[] };

export const tagColors = ["#e5484d", "#f76b15", "#ffc53d", "#46a758", "#12a594", "#3e63dd", "#8e4ec6", "#d6409f", "#8b8d98"];

export function toTask(row: RawTask): Task {
  return {
    id: Number(row.id),
    kind: row.kind === "issue" ? "issue" : "task",
    severity: (row.severity as Severity) || "none",
    status: (row.status as IssueStatus) || "triage",
    dependsOn: (row.depends_on ?? []).map(Number),
    blocks: (row.blocks ?? []).map(Number),
    columnId: Number(row.column_id) || 0,
    title: decodeEmoji(String(row.title ?? "")),
    notes: String(row.notes ?? ""),
    steps: String(row.steps ?? ""),
    assigneeIds: (row.assignee_ids ?? []).map(Number),
    authorId: Number(row.author_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at || row.created_at),
    doneAt: row.done_at ? String(row.done_at) : null,
    archivedAt: row.archived_at ? String(row.archived_at) : null,
    tagIds: (row.tag_ids ?? []).map(Number),
    commentCount: Number(row.comment_count ?? 0),
    lastComment: row.last_comment
      ? { authorId: Number(row.last_comment.author_id), body: String(row.last_comment.body ?? ""), createdAt: String(row.last_comment.created_at) }
      : null,
    reactions: row.reactions ?? [],
  };
}

export function createBoard(api: PluginClient, channelId: number) {
  return createLive<Board>(api, { columns: [], tags: [], tasks: [], issues: [], archived: 0, archivedIssues: 0 }, () => channelId, async () => {
    const data = await api.call<{ columns: Raw[]; tags: Raw[]; tasks: RawTask[]; issues?: RawTask[]; archived?: number; archived_issues?: number }>("list-board", { channel_id: channelId });
    return {
      columns: data.columns.map((c) => ({
        id: Number(c.id), name: String(c.name), isDone: c.is_done === true,
        keepDone: c.keep_done === null || c.keep_done === undefined ? defaultKeepDone : Number(c.keep_done),
      })),
      tags: data.tags.map((t) => ({ id: Number(t.id), name: String(t.name), color: String(t.color ?? "") })),
      tasks: data.tasks.map(toTask),
      issues: (data.issues ?? []).map(toTask),
      archived: Number(data.archived ?? 0),
      archivedIssues: Number(data.archived_issues ?? 0),
    };
  });
}

export function createComments(api: PluginClient, taskId: Accessor<number>) {
  return createLive<Comment[]>(api, [], taskId, async () => {
    const { rows } = await api.call<{ rows: Raw[] }>("list-comments", { task_id: taskId() });
    return rows.map((r) => ({ id: Number(r.id), authorId: Number(r.author_id), body: String(r.body ?? ""), createdAt: String(r.created_at),
      editedAt: r.edited_at ? String(r.edited_at) : null }));
  });
}

export interface HistoryEntry {
  id: number;
  actorId: number;
  field: string;
  from: string;
  to: string;
  at: string;
}

export function createHistory(api: PluginClient, taskId: Accessor<number>) {
  return createLive<HistoryEntry[]>(api, [], taskId, async () => {
    const { rows } = await api.call<{ rows: Raw[] }>("list-history", { task_id: taskId() });
    return rows.map((r) => ({ id: Number(r.id), actorId: Number(r.actor_id), field: String(r.field), from: String(r.from_value ?? ""),
      to: String(r.to_value ?? ""), at: String(r.created_at) }));
  });
}

export async function getTask(api: PluginClient, id: number): Promise<Task> {
  return toTask((await api.call<{ task: RawTask }>("get-task", { task_id: id })).task);
}

export const addTask = (api: PluginClient, channelId: number, title: string, columnId: number | null, kind: Task["kind"] = "task") =>
  api.call<{ id: number } & Archived>("add-task", { channel_id: channelId, title: encodeEmoji(title), column_id: columnId, kind });
export const addIssue = (api: PluginClient, channelId: number, issue: NewIssue) =>
  api.call<{ id: number }>("add-task", {
    channel_id: channelId, title: encodeEmoji(issue.title), column_id: null, kind: "issue", severity: issue.severity, steps: encodeEmoji(issue.steps),
  });
export type NewIssue = { title: string; severity: Severity; steps: string };
export const setStatus = (api: PluginClient, id: number, status: IssueStatus) => api.call("set-status", { task_id: id, status });
export const setSeverity = (api: PluginClient, id: number, severity: Severity) => api.call("set-severity", { task_id: id, severity });
export const convertTask = (api: PluginClient, id: number, kind: Task["kind"], keep: { columnId?: number | null; severity?: Severity; status?: IssueStatus } = {}) =>
  api.call("convert-task", { task_id: id, kind, column_id: keep.columnId ?? null, severity: keep.severity ?? null, status: keep.status ?? null });
export const setDependency = (api: PluginClient, id: number, dependsOnId: number, depends: boolean) =>
  api.call("set-dependency", { task_id: id, depends_on_id: dependsOnId, depends });

export const editTask = (api: PluginClient, task: Pick<Task, "id" | "title" | "notes">) =>
  api.call("edit-task", { task_id: task.id, title: encodeEmoji(task.title), notes: encodeEmoji(task.notes) });
export const assignTask = (api: PluginClient, taskId: number, userId: number, assigned: boolean) =>
  api.call<{ changed: boolean }>("assign-task", { task_id: taskId, user_id: userId, assigned });

// Calls that can fill a done column return the tasks they archived.
type Archived = { archived?: number[] };
export const moveTask = (api: PluginClient, id: number, columnId: number, beforeId: number | null) =>
  api.call<Archived>("move-task", { task_id: id, column_id: columnId, before_id: beforeId });

export const removeTask = (api: PluginClient, id: number) => api.call("remove-task", { task_id: id });

export const addColumn = (api: PluginClient, channelId: number, name: string) =>
  api.call<{ id: number }>("add-column", { channel_id: channelId, name: encodeEmoji(name) });
export const editColumn = (api: PluginClient, column: Column) =>
  api.call<Archived>("edit-column", { column_id: column.id, name: encodeEmoji(column.name), is_done: column.isDone });
export const setKeepDone = (api: PluginClient, columnId: number, keep: number) =>
  api.call<Archived>("set-keep-done", { column_id: columnId, keep });
export const moveColumn = (api: PluginClient, id: number, beforeId: number | null) =>
  api.call("move-column", { column_id: id, before_id: beforeId });
export const removeColumn = (api: PluginClient, id: number) => api.call("remove-column", { column_id: id });

export const addTag = (api: PluginClient, channelId: number, name: string) =>
  api.call<{ id: number }>("add-tag", { channel_id: channelId, name });
export const editTag = (api: PluginClient, tag: Tag) => api.call("edit-tag", { tag_id: tag.id, name: tag.name, color: tag.color });
export const removeTag = (api: PluginClient, id: number) => api.call("remove-tag", { tag_id: id });
export const tagTask = (api: PluginClient, taskId: number, tagId: number) =>
  api.call<{ added: boolean }>("tag-task", { task_id: taskId, tag_id: tagId });

export const addComment = (api: PluginClient, taskId: number, body: string) =>
  api.call("add-comment", { task_id: taskId, body: encodeEmoji(body) });
export const editComment = (api: PluginClient, id: number, body: string) =>
  api.call("edit-comment", { comment_id: id, body: encodeEmoji(body) });
export const removeComment = (api: PluginClient, id: number) => api.call("remove-comment", { comment_id: id });
export const reactToTask = (api: PluginClient, taskId: number, code: string) => api.call("react", { task_id: taskId, code });

// Tags show only these on the board, for this session.
const filters = new Map<number, number[]>();
// "Auto assign self" per tasks channel, kept on this device.
const autoAssignKey = (workspaceId: string, channelId: number) => `mw.tasks.autoAssign.${workspaceId}:${channelId}`;
export const loadAutoAssign = (workspaceId: string, channelId: number) => readJson<boolean>(autoAssignKey(workspaceId, channelId), false);
export const saveAutoAssign = (workspaceId: string, channelId: number, on: boolean) => writeJson(autoAssignKey(workspaceId, channelId), on);

// Task view or issue view, per tasks channel, kept on this device.
const modeKey = (workspaceId: string, channelId: number) => `mw.tasks.mode.${workspaceId}:${channelId}`;
export const loadMode = (workspaceId: string, channelId: number) => readJson<"tasks" | "issues">(modeKey(workspaceId, channelId), "tasks");
export const saveMode = (workspaceId: string, channelId: number, mode: "tasks" | "issues") => writeJson(modeKey(workspaceId, channelId), mode);

export const savedFilter = (channelId: number) => filters.get(channelId) ?? [];
export const saveFilter = (channelId: number, tagIds: number[]) => filters.set(channelId, tagIds);

export const setSteps = (api: PluginClient, id: number, steps: string) => api.call("set-steps", { task_id: id, steps: encodeEmoji(steps) });
export const restoreTask = (api: PluginClient, id: number) => api.call("restore-task", { task_id: id });
export const restoreTag = (api: PluginClient, id: number) => api.call("restore-tag", { tag_id: id });
export const restoreColumn = (api: PluginClient, id: number) => api.call("restore-column", { column_id: id });

export const archiveTask = (api: PluginClient, id: number) => api.call("archive-task", { task_id: id });
// `fresh`: a task restored into a done column counts as done now, so it isn't the first to be archived again.
export const unarchiveTask = (api: PluginClient, id: number, fresh: boolean) => api.call("unarchive-task", { task_id: id, fresh });

export const archivePage = 50;

// A board's archived tasks matching `query`, last archived first, `pages` pages of them.
export function createArchive(api: PluginClient, channelId: number, kind: "task" | "issue", query: Accessor<string>, pages: Accessor<number>) {
  return createLive<{ tasks: Task[]; total: number }>(api, { tasks: [], total: 0 }, () => [query(), pages()], async () => {
    const q = encodeEmoji(query().trim());
    const parts = await Promise.all(Array.from({ length: pages() }, (_, page) =>
      api.call<{ tasks: RawTask[]; total: number }>("list-archived", { channel_id: channelId, query: q, offset: page * archivePage, kind })));
    return { tasks: parts.flatMap((p) => p.tasks.map(toTask)), total: parts[0]?.total ?? 0 };
  });
}

// A task in a done column, or a resolved issue.
export const isFinished = (board: Pick<Board, "columns">, task: Task) =>
  task.kind === "issue" ? task.status === "resolved" : board.columns.find((c) => c.id === task.columnId)?.isDone === true;

// How many of the tasks and issues `task` waits for are not finished yet.
export const openDependencies = (board: Board, task: Task) =>
  task.dependsOn.filter((id) => {
    const found = [...board.tasks, ...board.issues].find((t) => t.id === id);
    return found && !isFinished(board, found);
  }).length;
