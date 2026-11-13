// Every change to a board as an undoable step: does it, then records how to undo and redo it.
import { decodeEmoji } from "../../../markdown/emoji";
import type { ChannelContext } from "../../types";
import {
  addColumn, addIssue, addTag, convertTask, addTask, archiveTask, assignTask, editColumn, editTag, editTask, moveColumn, moveTask, removeColumn, removeTag,
  removeTask, restoreColumn, restoreTag, restoreTask, setDependency, setKeepDone, setSeverity, setStatus, setSteps, tagTask, unarchiveTask,
  severityLabel, statusLabel, type Board, type Column, type IssueStatus, type NewIssue, type Severity, type Tag, type Task,
} from "./data";

// Runs an action and shows its error; resolves with whether it worked (a form keeps what was typed when it didn't).
export type Run = (action: () => Promise<unknown>) => Promise<boolean>;
type Steps = { undo: () => Promise<unknown>; redo: () => Promise<unknown> };

export type TaskActions = ReturnType<typeof taskActions>;

// beforeMove lets the board measure cards first, so moves (also undone ones) slide. Board objects are live and
// change after each step, so anything undo needs is copied when the step is made. With autoAssign on, new tasks
// and tasks with nobody assigned moved into a done column get the signed-in user as assignee, in the same undo step.
export function taskActions(ctx: ChannelContext, board: Board, run: Run, beforeMove: () => void, autoAssign: () => boolean) {
  const api = ctx.api;
  const record = <T,>(label: string, icon: string, perform: () => Promise<T>, steps: (result: T) => Steps) =>
    run(async () => {
      const result = await perform();
      ctx.history.push({ label, icon, ...steps(result) });
    });
  const simple = (label: string, icon: string, perform: () => Promise<unknown>, undo: () => Promise<unknown>) =>
    record(label, icon, perform, () => ({ undo, redo: perform }));

  const quote = (text: string) => `"${text.length > 30 ? `${text.slice(0, 29)}...` : text}"`;
  const columnName = (id: number) => decodeEmoji(board.columns.find((c) => c.id === id)?.name ?? "");
  const nextIn = (task: Task) => {
    const list = board.tasks.filter((t) => t.columnId === task.columnId);
    return list[list.findIndex((t) => t.id === task.id) + 1]?.id ?? null;
  };
  const moveTo = async (id: number, columnId: number, beforeId: number | null) => {
    beforeMove();
    return (await moveTask(api, id, columnId, beforeId)).archived ?? [];
  };
  // Undoing a change that filled a done column brings back what it archived, as it was.
  const unarchive = async (ids: number[]) => {
    for (const id of ids) await unarchiveTask(api, id, false);
  };

  const toggleTag = (task: Task, tag: Tag) => {
    const label = `${task.tagIds.includes(tag.id) ? "Untag" : "Tag"} ${quote(task.title)} #${tag.name}`;
    const toggle = () => tagTask(api, task.id, tag.id);
    return simple(label, "tag", toggle, toggle);
  };

  return {
    toggleTag,
    move(task: Task, columnId: number, beforeId: number | null) {
      const from = { column: task.columnId, before: nextIn(task) };
      if (from.column === columnId && from.before === beforeId) return Promise.resolve();
      const label = from.column === columnId ? `Reorder ${quote(task.title)}` : `Move ${quote(task.title)} to ${columnName(columnId)}`;
      const isDone = (id: number) => board.columns.find((c) => c.id === id)?.isDone === true;
      const finishing = isDone(columnId) && !isDone(from.column);
      if (finishing) ctx.playSound("task-done");
      const me = ctx.users.me();
      const id = task.id;
      const assign = finishing && autoAssign() && task.assigneeIds.length === 0 && me !== null;
      let archived: number[] = [];
      const perform = async () => {
        archived = await moveTo(id, columnId, beforeId);
        if (assign) await assignTask(api, id, me, true);
      };
      return record(label, "forward", perform, () => ({
        undo: async () => {
          await unarchive(archived);
          await moveTo(id, from.column, from.before);
          if (assign) await assignTask(api, id, me, false);
        },
        redo: perform,
      }));
    },
    add(title: string, columnId: number) {
      const me = autoAssign() ? ctx.users.me() : null;
      return record(`Add ${quote(title)}`, "add", async () => {
        const added = await addTask(api, ctx.channel.id, title, columnId);
        if (me !== null) await assignTask(api, added.id, me, true);
        return added;
      }, ({ id, archived }) => ({
        undo: async () => {
          await unarchive(archived ?? []);
          await removeTask(api, id);
        },
        redo: () => restoreTask(api, id),
      }));
    },
    addIssue(issue: NewIssue) {
      const me = autoAssign() ? ctx.users.me() : null;
      return record(`Add issue ${quote(issue.title)}`, "add", async () => {
        const added = await addIssue(api, ctx.channel.id, issue);
        if (me !== null) await assignTask(api, added.id, me, true);
        return added;
      }, ({ id }) => ({ undo: () => removeTask(api, id), redo: () => restoreTask(api, id) }));
    },
    // A task becomes an issue and back; undo restores the column, severity and status it had.
    convert(task: Task) {
      const id = task.id;
      const old = { kind: task.kind, columnId: task.columnId || null, severity: task.severity, status: task.status };
      const next = old.kind === "task" ? "issue" : "task";
      return simple(`Turn ${quote(task.title)} into ${next === "issue" ? "an issue" : "a task"}`, "forward",
        () => convertTask(api, id, next), () => convertTask(api, id, old.kind, old));
    },
    setStatus(task: Task, status: IssueStatus) {
      const id = task.id;
      const old = task.status;
      if (old === status) return Promise.resolve();
      return simple(`Set ${quote(task.title)} to ${statusLabel(status)}`, "forward", () => setStatus(api, id, status), () => setStatus(api, id, old));
    },
    setSeverity(task: Task, severity: Severity) {
      const id = task.id;
      const old = task.severity;
      if (old === severity) return Promise.resolve();
      return simple(`Set severity of ${quote(task.title)} to ${severityLabel(severity)}`, "forward",
        () => setSeverity(api, id, severity), () => setSeverity(api, id, old));
    },
    // `task` depends on `other` (or stops doing so).
    setDependency(task: Task, other: Task, depends: boolean) {
      const [id, otherId] = [task.id, other.id];
      const label = `${depends ? "Add" : "Remove"} dependency of ${quote(task.title)} on ${quote(other.title)}`;
      return simple(label, "link", () => setDependency(api, id, otherId, depends), () => setDependency(api, id, otherId, !depends));
    },
    // A finished task or resolved issue off the board into the archive, and undo restores it.
    archive(task: Task) {
      return simple(`Archive ${quote(task.title)}`, "archive", () => archiveTask(api, task.id), () => unarchiveTask(api, task.id, false));
    },
    // From the archive back onto the board, and undo puts it back in the archive.
    unarchive(task: Task) {
      return simple(`Restore ${quote(task.title)}`, "undo", () => unarchiveTask(api, task.id, true), () => archiveTask(api, task.id));
    },
    remove(task: Task) {
      return simple(`Delete ${quote(task.title)}`, "delete", () => removeTask(api, task.id), () => restoreTask(api, task.id));
    },
    edit(task: Task, next: Pick<Task, "title" | "notes">) {
      next = { title: next.title, notes: next.notes };
      const what = next.title !== task.title ? "Rename" : "Edit notes of";
      const before = { id: task.id, title: task.title, notes: decodeEmoji(task.notes) };
      return simple(`${what} ${quote(task.title)}`, "rename", () => editTask(api, { id: task.id, ...next }), () => editTask(api, before));
    },
    setSteps(task: Task, steps: string) {
      const before = decodeEmoji(task.steps);
      return simple(`Edit problem description of ${quote(task.title)}`, "rename", () => setSteps(api, task.id, steps), () => setSteps(api, task.id, before));
    },
    // Assigns a member to the task, or takes them off it.
    assign(task: Task, userId: number, assigned: boolean) {
      const id = task.id;
      const name = ctx.users.get(userId).displayName;
      const label = assigned ? `Assign ${name} to ${quote(task.title)}` : `Unassign ${name} from ${quote(task.title)}`;
      return simple(label, "assignee", () => assignTask(api, id, userId, assigned), () => assignTask(api, id, userId, !assigned));
    },
    // Puts a tag on a task by name, creating the tag first if the board has none by that name.
    tagByName(task: Task, name: string) {
      const existing = board.tags.find((t) => t.name === name);
      if (existing) return task.tagIds.includes(existing.id) ? Promise.resolve() : toggleTag(task, existing);
      return record(`Tag ${quote(task.title)} #${name}`, "tag", async () => {
        const { id } = await addTag(api, ctx.channel.id, name);
        await tagTask(api, task.id, id);
        return id;
      }, (id) => ({
        undo: async () => {
          await tagTask(api, task.id, id);
          await removeTag(api, id);
        },
        redo: async () => {
          await restoreTag(api, id);
          await tagTask(api, task.id, id);
        },
      }));
    },
    addTag(name: string) {
      return record(`Add #${name}`, "tag", () => addTag(api, ctx.channel.id, name),
        ({ id }) => ({ undo: () => removeTag(api, id), redo: () => restoreTag(api, id) }));
    },
    editTag(tag: Tag, next: Tag) {
      const before = { ...tag };
      const after = { ...next };
      const label = after.name !== before.name ? `Rename #${before.name}` : `Recolor #${before.name}`;
      return simple(label, "tag", () => editTag(api, after), () => editTag(api, before));
    },
    removeTag(tag: Tag) {
      return simple(`Delete #${tag.name}`, "delete", () => removeTag(api, tag.id), () => restoreTag(api, tag.id));
    },
    addColumn(name: string) {
      return record(`Add column ${quote(name)}`, "columns", () => addColumn(api, ctx.channel.id, name),
        ({ id }) => ({ undo: () => removeColumn(api, id), redo: () => restoreColumn(api, id) }));
    },
    editColumn(column: Column, next: Column) {
      const before = { ...column, name: decodeEmoji(column.name) };
      const after = { ...next };
      const label = after.name !== column.name ? `Rename column ${quote(before.name)}`
        : `Mark ${quote(before.name)} ${after.isDone ? "done" : "not done"}`;
      return record(label, "columns", () => editColumn(api, after), (result) => ({
        undo: async () => {
          await unarchive(result.archived ?? []);
          await editColumn(api, before);
        },
        redo: () => editColumn(api, after),
      }));
    },
    keepDone(column: Column, keep: number) {
      const id = column.id;
      const old = column.keepDone;
      const label = `Keep ${keep === 0 ? "all" : keep} done in ${quote(decodeEmoji(column.name))}`;
      return record(label, "columns", () => setKeepDone(api, id, keep), (result) => ({
        undo: async () => {
          await setKeepDone(api, id, old);
          await unarchive(result.archived ?? []);
        },
        redo: () => setKeepDone(api, id, keep),
      }));
    },
    moveColumn(column: Column, beforeId: number | null) {
      const index = board.columns.findIndex((c) => c.id === column.id);
      const oldBefore = board.columns[index + 1]?.id ?? null;
      return simple(`Move column ${quote(decodeEmoji(column.name))}`, "columns",
        () => moveColumn(api, column.id, beforeId), () => moveColumn(api, column.id, oldBefore));
    },
    // Undo brings the column back and its tasks into it, in their old order.
    removeColumn(column: Column) {
      const ids = board.tasks.filter((t) => t.columnId === column.id).map((t) => t.id);
      return simple(`Delete column ${quote(decodeEmoji(column.name))}`, "delete", () => removeColumn(api, column.id), async () => {
        await restoreColumn(api, column.id);
        beforeMove();
        for (const id of ids) await moveTask(api, id, column.id, null);
      });
    },
  };
}
