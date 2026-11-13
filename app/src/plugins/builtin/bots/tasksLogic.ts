// Taskbot's decisions as plain functions over task rows, so they can be tested without a workspace.
export interface TaskRow { id: number; channelId: number; columnId: number; title: string; createdAt: string; doneAt: string | null; assignees: number[] }

export const milestoneSize = 10;
const dayMs = 86_400_000;

export function toTask(row: Record<string, unknown>, assignees: Map<number, number[]>): TaskRow | null {
  if (row.deleted === true || row.archived_at || row.kind === "issue") return null;
  const id = Number(row.id);
  const legacy = row.assignee_id === null || row.assignee_id === undefined ? [] : [Number(row.assignee_id)];
  return {
    id, channelId: Number(row.channel_id), columnId: Number(row.column_id), title: String(row.title ?? ""),
    createdAt: String(row.created_at ?? ""), doneAt: row.done_at ? String(row.done_at) : null,
    assignees: [...new Set([...legacy, ...(assignees.get(id) ?? [])])],
  };
}

export const openTasks = (tasks: TaskRow[]) => tasks.filter((t) => t.doneAt === null);

// The next group of finished tasks to announce: once `milestoneSize` tasks were done after `since`, the earliest of them.
export function nextMilestone(tasks: TaskRow[], since: string): TaskRow[] | null {
  const done = tasks.filter((t) => t.doneAt !== null && t.doneAt > since).sort((a, b) => a.doneAt!.localeCompare(b.doneAt!));
  return done.length >= milestoneSize ? done.slice(0, milestoneSize) : null;
}

export function staleTasks(tasks: TaskRow[], now: number, staleDays: number): TaskRow[] {
  return openTasks(tasks).filter((t) => now - Date.parse(t.createdAt) > staleDays * dayMs)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// Stale tasks not reminded about within `remindDays` (`reminded` maps task id to the last reminder's time).
export function dueReminders(stale: TaskRow[], reminded: Map<number, number>, now: number, remindDays: number): TaskRow[] {
  return stale.filter((t) => now - (reminded.get(t.id) ?? 0) > remindDays * dayMs);
}

export function ageDays(task: TaskRow, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(task.createdAt)) / dayMs));
}
