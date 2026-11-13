// A task board per tasks channel with its own columns and tags, and comments and
// reactions on tasks.
import type { MockPlugin } from "./backend";
import { groupRows, type JsonRow } from "./data";
import { InvalidRequest } from "./errors";

export const defaultColumns: [name: string, isDone: boolean][] = [["To do", false], ["Doing", false], ["Done", true]];
// Done tasks a done column keeps on the board; older ones are archived. A column's keep_done overrides it, 0 keeps all.
export const defaultKeepDone = 20;
const archivePage = 50;
export const severities = ["none", "low", "medium", "high", "severe"] as const;
export const issueStatuses = ["triage", "in_progress", "needs_testing", "resolved"] as const;
export const tagColors = ["#e5484d", "#f76b15", "#ffc53d", "#46a758", "#12a594", "#3e63dd", "#8e4ec6", "#d6409f", "#8b8d98"];

const tagName = (name: unknown) => {
  const n = String(name).trim().replace(/^#/, "").toLowerCase().replace(/\s+/g, "-");
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(n)) throw new InvalidRequest("Tag names are a-z, digits and '-', up to 32 characters.");
  return n;
};
const colorFor = (name: string) => tagColors[[...name].reduce((h, c) => h + c.charCodeAt(0), 0) % tagColors.length];

export const tasks: MockPlugin = {
  manifest: {
    name: "tasks",
    version: "0.6.0",
    description: "Task boards with custom columns, tags, comments and reactions, plus issues, dependencies and a task history.",
    tables: [
      { name: "tasks_columns", parent: null, columns: { channel_id: "bigint", name: "text", position: "int", is_done: "bool", keep_done: "int", deleted: "bool" } },
      {
        name: "tasks_tasks", parent: null,
        columns: {
          channel_id: "bigint", column_id: "bigint", title: "text", notes: "text", position: "int", assignee_id: "bigint",
          author_id: "bigint", created_at: "timestamp", done_at: "timestamp", archived_at: "timestamp", deleted: "bool",
          kind: "text", severity: "text", status: "text", updated_at: "timestamp", steps: "text",
        },
      },
      { name: "tasks_tags", parent: null, columns: { channel_id: "bigint", name: "text", color: "text", deleted: "bool" } },
      { name: "tasks_task_tags", parent: "tasks_tasks", columns: { task_id: "bigint", tag_id: "bigint" } },
      { name: "tasks_assignees", parent: "tasks_tasks", columns: { task_id: "bigint", user_id: "bigint" } },
      { name: "tasks_comments", parent: "tasks_tasks", columns: { task_id: "bigint", author_id: "bigint", body: "text", created_at: "timestamp", edited_at: "timestamp", deleted: "bool" } },
      { name: "tasks_reactions", parent: "tasks_tasks", columns: { task_id: "bigint", user_id: "bigint", code: "text" } },
      { name: "tasks_dependencies", parent: "tasks_tasks", columns: { task_id: "bigint", depends_on_id: "bigint" } },
      {
        name: "tasks_history", parent: "tasks_tasks",
        columns: { task_id: "bigint", actor_id: "bigint", field: "text", from_value: "text", to_value: "text", created_at: "timestamp" },
      },
    ],
  },

  // Deleting only hides tasks, tags and columns, so undo can bring them back with the same ids. Archived tasks
  // (archived_at set) are off the board but kept, with their old position, until restored.
  // Issues are tasks with kind "issue": they have a severity and a status instead of a column (column_id stays null),
  // so only list-board's `issues` lists them. Tasks from before 0.5.0 have no kind and are tasks.
  // tasks_dependencies: task_id depends on depends_on_id. tasks_history: one row per change, written by the function
  // that makes it (field names: column, status, severity, title, notes, assignee, tag, depends_on, blocks).
  // Assignees are tasks_assignees rows. Tasks from before 0.3.0 name one person in assignee_id: it still counts,
  // and moves into a row the first time the task's assignees change.
  register({ data, onApi, onApiRead }) {
    const live = (row: JsonRow) => row.deleted !== true;
    const one = (table: string, id: unknown, what: string) => {
      const [row] = data.select(table, { id: id as number });
      if (!row) throw new InvalidRequest(`Unknown ${what} ${id}`);
      return row;
    };
    const task = (id: unknown) => one("tasks_tasks", id, "task");
    const column = (id: unknown) => one("tasks_columns", id, "column");
    const tag = (id: unknown) => one("tasks_tags", id, "tag");
    const byPosition = (a: JsonRow, b: JsonRow) => Number(a.position) - Number(b.position) || a.id - b.id;
    const columnsOf = (channelId: unknown) => {
      const where = { channel_id: channelId as number };
      if (data.select("tasks_columns", where).length === 0)
        defaultColumns.forEach(([name, is_done], position) => data.insert("tasks_columns", { ...where, name, position, is_done }));
      return data.select("tasks_columns", where).filter(live).sort(byPosition);
    };
    const onBoard = (row: JsonRow) => live(row) && !row.archived_at;
    const tasksIn = (columnId: unknown) => data.select("tasks_tasks", { column_id: columnId as number }).filter(onBoard).sort(byPosition);
    const archivedIn = (channelId: unknown, issues: boolean) => data.select("tasks_tasks", { channel_id: channelId as number })
      .filter((t) => live(t) && !!t.archived_at && isIssue(t) === issues);
    const keepOf = (col: JsonRow) => (col.keep_done === null || col.keep_done === undefined ? defaultKeepDone : Number(col.keep_done));
    // A done column over its limit archives the tasks done longest ago, in the same change that filled it.
    const archiveExtra = (col: JsonRow): number[] => {
      const keep = keepOf(col);
      if (col.is_done !== true || keep <= 0) return [];
      const doneAt = (t: JsonRow) => (t.done_at ? String(t.done_at) : "");
      const newestFirst = tasksIn(col.id).sort((a, b) => doneAt(b).localeCompare(doneAt(a)) || b.id - a.id);
      const extra = newestFirst.slice(keep);
      const at = new Date().toISOString();
      for (const t of extra) data.update("tasks_tasks", { archived_at: at }, { id: t.id });
      return extra.map((t) => t.id);
    };
    const isIssue = (row: JsonRow) => row.kind === "issue";
    const log = (taskId: unknown, userId: unknown, field: string, from: unknown, to: unknown) => {
      data.update("tasks_tasks", { updated_at: new Date().toISOString() }, { id: taskId as number });
      return data.insert("tasks_history", {
        task_id: taskId, actor_id: userId, field, from_value: from === null ? "" : String(from), to_value: to === null ? "" : String(to),
        created_at: new Date().toISOString(),
      });
    };
    const issuesIn = (channelId: unknown) => data.select("tasks_tasks", { channel_id: channelId as number }).filter((t) => onBoard(t) && isIssue(t));
    const liveTags = (channelId: unknown) => data.select("tasks_tags", { channel_id: channelId as number }).filter(live);
    // Each table read once per call, grouped by task (groupRows): per-task lookups scanned whole tables.
    const lastComment = (comments: JsonRow[]) => {
      const last = comments.reduce<JsonRow | null>((found, c) => (!found || String(c.created_at) >= String(found.created_at) ? c : found), null);
      return last ? { author_id: last.author_id, body: last.body, created_at: last.created_at } : null;
    };
    const detailsOf = (rows: JsonRow[]) => {
      if (rows.length === 0) return [];
      const reactionsOf = groupRows(data.select("tasks_reactions"), "task_id");
      const assigneesOf = groupRows(data.select("tasks_assignees"), "task_id");
      const tagsOf = groupRows(data.select("tasks_task_tags"), "task_id");
      const liveTasks = new Set(data.select("tasks_tasks").filter(live).map((t) => t.id));
      const dependenciesOf = groupRows(data.select("tasks_dependencies"), "task_id");
      const dependentsOf = groupRows(data.select("tasks_dependencies"), "depends_on_id");
      const commentsOf = groupRows(data.select("tasks_comments").filter(live), "task_id");
      const liveTags = new Set(data.select("tasks_tags").filter(live).map((t) => t.id));
      return rows.map((row) => {
        const reactions = new Map<string, number[]>();
        for (const r of reactionsOf.get(row.id) ?? [])
          reactions.set(String(r.code), [...(reactions.get(String(r.code)) ?? []), Number(r.user_id)]);
        const assignees = (assigneesOf.get(row.id) ?? []).map((a) => Number(a.user_id));
        const legacy = row.assignee_id === null || row.assignee_id === undefined ? null : Number(row.assignee_id);
        if (legacy !== null && !assignees.includes(legacy)) assignees.unshift(legacy);
        return {
          ...row,
          assignee_ids: assignees,
          depends_on: (dependenciesOf.get(row.id) ?? []).map((d) => d.depends_on_id).filter((id) => liveTasks.has(id as number)),
          blocks: (dependentsOf.get(row.id) ?? []).map((d) => d.task_id).filter((id) => liveTasks.has(id as number)),
          tag_ids: (tagsOf.get(row.id) ?? []).map((t) => t.tag_id).filter((id) => liveTags.has(id as number)),
          comment_count: (commentsOf.get(row.id) ?? []).length,
          last_comment: lastComment(commentsOf.get(row.id) ?? []),
          reactions: [...reactions].map(([code, users]) => ({ code, count: users.length, users })),
        };
      });
    };
    const details = (row: JsonRow) => detailsOf([row])[0];
    // Puts a task in a column before another one, or last, and renumbers the column.
    const place = (row: JsonRow, columnId: unknown, beforeId: unknown) => {
      const target = column(columnId);
      if (target.channel_id !== row.channel_id) throw new InvalidRequest("That column is on another board.");
      const order = tasksIn(target.id).filter((t) => t.id !== row.id);
      const at = beforeId === null ? -1 : order.findIndex((t) => t.id === beforeId);
      order.splice(at < 0 ? order.length : at, 0, row);
      const wasDone = row.column_id !== null && column(row.column_id).is_done === true && row.done_at !== null;
      const doneAt = target.is_done === true ? (wasDone ? row.done_at : new Date().toISOString()) : null;
      data.update("tasks_tasks", { column_id: target.id, done_at: doneAt }, { id: row.id });
      order.forEach((t, position) => (t.position !== position || t.id === row.id) && data.update("tasks_tasks", { position }, { id: t.id }));
    };
    const checkTitle = (title: unknown) => {
      if (!String(title ?? "").trim()) throw new InvalidRequest("'title' can't be empty.");
    };

    onApi("list-board", "A board's columns, tags, tasks and issues (with tag_ids, depends_on, blocks, comment_count, reactions): { columns, tags, tasks, issues, archived, archived_issues }.",
      [{ name: "channel_id", type: "bigint", description: "The tasks channel." }],
      (r) => {
        const columns = columnsOf(r.args.channel_id);
        return {
          columns,
          tags: liveTags(r.args.channel_id).sort((a, b) => String(a.name).localeCompare(String(b.name))),
          tasks: detailsOf(columns.flatMap((c) => tasksIn(c.id))),
          issues: detailsOf(issuesIn(r.args.channel_id)),
          archived: archivedIn(r.args.channel_id, false).length,
          archived_issues: archivedIn(r.args.channel_id, true).length,
        };
      });

    onApi("get-task", "One task with its details: { task }.",
      [{ name: "task_id", type: "bigint", description: "The task." }],
      (r) => ({ task: details(task(r.args.task_id)) }));

    onApi("add-column", "Adds a column at the end of a board; returns its id.",
      [
        { name: "channel_id", type: "bigint", description: "The tasks channel." },
        { name: "name", type: "text", description: "Column name." },
        { name: "is_done", type: "bool", required: false, description: "Tasks in it count as done." },
      ],
      (r) => {
        if (!String(r.args.name).trim()) throw new InvalidRequest("'name' can't be empty.");
        const position = columnsOf(r.args.channel_id).length;
        return { id: data.insert("tasks_columns", { channel_id: r.args.channel_id, name: r.args.name, position, is_done: r.args.is_done === true, deleted: false }) };
      });

    onApi("edit-column", "Renames a column and sets whether its tasks count as done; returns { updated }.",
      [
        { name: "column_id", type: "bigint", description: "The column." },
        { name: "name", type: "text", description: "Column name." },
        { name: "is_done", type: "bool", description: "Tasks in it count as done." },
      ],
      (r) => {
        const row = column(r.args.column_id);
        if (!String(r.args.name).trim()) throw new InvalidRequest("'name' can't be empty.");
        if (r.args.is_done !== row.is_done)
          for (const t of tasksIn(row.id)) data.update("tasks_tasks", { done_at: r.args.is_done ? new Date().toISOString() : null }, { id: t.id });
        const updated = data.update("tasks_columns", { name: r.args.name, is_done: r.args.is_done }, { id: row.id });
        return { updated, archived: archiveExtra(column(row.id)) };
      });

    onApi("set-keep-done", "Sets how many done tasks a done column keeps on the board (0: all) and archives the extra; returns { archived } ids.",
      [
        { name: "column_id", type: "bigint", description: "The column." },
        { name: "keep", type: "int", description: "Done tasks to keep; 0 keeps all." },
      ],
      (r) => {
        const keep = Number(r.args.keep);
        if (!Number.isInteger(keep) || keep < 0) throw new InvalidRequest("'keep' must be 0 or more.");
        const row = column(r.args.column_id);
        data.update("tasks_columns", { keep_done: keep }, { id: row.id });
        return { archived: archiveExtra(column(row.id)) };
      });

    onApi("move-column", "Moves a column before another one, or to the end; returns { updated }.",
      [
        { name: "column_id", type: "bigint", description: "The column." },
        { name: "before_id", type: "bigint", required: false, description: "The column to place it before." },
      ],
      (r) => {
        const row = column(r.args.column_id);
        const order = columnsOf(row.channel_id).filter((c) => c.id !== row.id);
        const at = r.args.before_id === null ? -1 : order.findIndex((c) => c.id === r.args.before_id);
        order.splice(at < 0 ? order.length : at, 0, row);
        order.forEach((c, position) => c.position !== position && data.update("tasks_columns", { position }, { id: c.id }));
        return { updated: 1 };
      });

    onApi("remove-column", "Deletes a column; its tasks move to the end of the first other column. Returns { deleted }.",
      [{ name: "column_id", type: "bigint", description: "The column." }],
      (r) => {
        const row = column(r.args.column_id);
        const other = columnsOf(row.channel_id).find((c) => c.id !== row.id);
        if (!other) throw new InvalidRequest("A board needs at least one column.");
        for (const t of tasksIn(row.id)) place(task(t.id), other.id, null);
        return { deleted: data.update("tasks_columns", { deleted: true }, { id: row.id }) };
      });

    onApi("restore-column", "Brings back a deleted column, empty, where it was; returns { restored }.",
      [{ name: "column_id", type: "bigint", description: "The column." }],
      (r) => ({ restored: data.update("tasks_columns", { deleted: false }, { id: column(r.args.column_id).id }) }));

    onApi("add-task", "Adds a task at the end of a column (the first one by default), or an issue (kind 'issue': in triage, in no column, with an optional severity and problem description); returns its id.",
      [
        { name: "channel_id", type: "bigint", description: "The tasks channel." },
        { name: "title", type: "text", description: "What needs doing." },
        { name: "column_id", type: "bigint", required: false, description: "The column." },
        { name: "kind", type: "text", required: false, description: "'task' (default) or 'issue'." },
        { name: "severity", type: "text", required: false, description: "An issue's severity: none (default), low, medium, high or severe." },
        { name: "steps", type: "text", required: false, description: "An issue's problem description, markdown." },
      ],
      (r) => {
        checkTitle(r.args.title);
        if (r.args.kind === "issue") {
          const severity = r.args.severity ?? "none";
          if (!(severities as readonly string[]).includes(String(severity))) throw new InvalidRequest("Unknown severity.");
          const id = data.insert("tasks_tasks", {
            channel_id: r.args.channel_id, column_id: null, title: r.args.title, notes: "", position: 0, assignee_id: null,
            author_id: r.userId, created_at: new Date().toISOString(), done_at: null, deleted: false,
            kind: "issue", severity, status: "triage", steps: r.args.steps ?? "",
          });
          return { id, archived: [] };
        }
        const target = r.args.column_id === null ? columnsOf(r.args.channel_id)[0] : column(r.args.column_id);
        const id = data.insert("tasks_tasks", {
          channel_id: r.args.channel_id, column_id: null, title: r.args.title, notes: "", position: 0,
          assignee_id: null, author_id: r.userId, created_at: new Date().toISOString(), done_at: null, deleted: false,
        });
        place(task(id), target.id, null);
        return { id, archived: archiveExtra(column(target.id)) };
      });

    onApi("edit-task", "Sets a task's title and notes; returns { updated }.",
      [
        { name: "task_id", type: "bigint", description: "The task." },
        { name: "title", type: "text", description: "What needs doing." },
        { name: "notes", type: "text", required: false, description: "Details, markdown." },
      ],
      (r) => {
        const row = task(r.args.task_id);
        checkTitle(r.args.title);
        const notes = r.args.notes ?? "";
        if (r.args.title !== row.title) log(row.id, r.userId, "title", row.title, r.args.title);
        if (notes !== (row.notes ?? "")) log(row.id, r.userId, "notes", null, null);
        return { updated: data.update("tasks_tasks", { title: r.args.title, notes }, { id: r.args.task_id }) };
      });

    onApi("set-steps", "Sets an issue's problem description (what goes wrong, how to make it happen); returns { updated }.",
      [
        { name: "task_id", type: "bigint", description: "The issue." },
        { name: "steps", type: "text", description: "What goes wrong and how to make it happen, markdown." },
      ],
      (r) => {
        const row = task(r.args.task_id);
        if (!isIssue(row)) throw new InvalidRequest("Only issues have a problem description.");
        if (String(r.args.steps ?? "") === String(row.steps ?? "")) return { updated: 0 };
        log(row.id, r.userId, "steps", null, null);
        return { updated: data.update("tasks_tasks", { steps: r.args.steps ?? "" }, { id: row.id }) };
      });

    onApi("assign-task", "Assigns a member to a task, or takes them off it; returns { changed }.",
      [
        { name: "task_id", type: "bigint", description: "The task." },
        { name: "user_id", type: "bigint", description: "The member." },
        { name: "assigned", type: "bool", description: "True to assign them, false to take them off." },
      ],
      (r) => {
        const row = task(r.args.task_id);
        if (row.assignee_id !== null && row.assignee_id !== undefined) {
          const legacy = { task_id: row.id, user_id: row.assignee_id };
          if (!data.select("tasks_assignees", legacy).length) data.insert("tasks_assignees", legacy);
          data.update("tasks_tasks", { assignee_id: null }, { id: row.id });
        }
        const link = { task_id: row.id, user_id: r.args.user_id };
        const has = data.select("tasks_assignees", link).length > 0;
        if ((r.args.assigned === true) === has) return { changed: false };
        if (has) data.delete("tasks_assignees", link);
        else data.insert("tasks_assignees", link);
        log(row.id, r.userId, "assignee", has ? r.args.user_id : null, has ? null : r.args.user_id);
        return { changed: true };
      });

    onApi("move-task", "Moves a task to a column, before another task or to the end; returns { updated }.",
      [
        { name: "task_id", type: "bigint", description: "The task." },
        { name: "column_id", type: "bigint", description: "The column." },
        { name: "before_id", type: "bigint", required: false, description: "The task to place it before." },
      ],
      (r) => {
        const row = task(r.args.task_id);
        if (isIssue(row)) throw new InvalidRequest("Issues are not in a column.");
        const was = row.column_id;
        place(row, r.args.column_id, r.args.before_id);
        if (was !== r.args.column_id) log(row.id, r.userId, "column", column(was).name, column(r.args.column_id).name);
        return { updated: 1, archived: archiveExtra(column(r.args.column_id)) };
      });

    onApi("list-archived", "A board's archived tasks, last archived first, 50 at a time: { tasks, total }.",
      [
        { name: "channel_id", type: "bigint", description: "The tasks channel." },
        { name: "query", type: "text", required: false, description: "Only tasks whose title contains this." },
        { name: "offset", type: "int", required: false, description: "Tasks to skip." },
        { name: "kind", type: "text", required: false, description: "'issue' for archived issues; tasks otherwise." },
      ],
      (r) => {
        const query = String(r.args.query ?? "").trim().toLowerCase();
        const found = archivedIn(r.args.channel_id, r.args.kind === "issue")
          .filter((t) => !query || String(t.title).toLowerCase().includes(query))
          .sort((a, b) => String(b.archived_at).localeCompare(String(a.archived_at)) || b.id - a.id);
        const offset = Math.max(0, Number(r.args.offset ?? 0) || 0);
        return { tasks: found.slice(offset, offset + archivePage).map(details), total: found.length };
      });

    onApi("archive-task", "Takes a task, or a resolved issue, off the board into the archive; returns { archived }.",
      [{ name: "task_id", type: "bigint", description: "The task." }],
      (r) => {
        const row = task(r.args.task_id);
        if (!onBoard(row) || (isIssue(row) && row.status !== "resolved")) return { archived: 0 };
        return { archived: data.update("tasks_tasks", { archived_at: new Date().toISOString() }, { id: row.id }) };
      });

    onApi("unarchive-task", "Brings an archived task back to the board where it was (the first column if its column is gone); returns { restored }.",
      [
        { name: "task_id", type: "bigint", description: "The task." },
        { name: "fresh", type: "bool", required: false, description: "In a done column, counts as done now, so it isn't archived again first." },
      ],
      (r) => {
        const row = task(r.args.task_id);
        if (!live(row) || !row.archived_at) return { restored: 0 };
        if (isIssue(row)) {
          data.update("tasks_tasks", { archived_at: null }, { id: row.id });
          return { restored: 1 };
        }
        const home = live(column(row.column_id)) ? column(row.column_id) : columnsOf(row.channel_id)[0];
        const before = tasksIn(home.id)[Number(row.position)]?.id ?? null;
        data.update("tasks_tasks", { archived_at: null }, { id: row.id });
        place(task(row.id), home.id, before);
        if (r.args.fresh === true && home.is_done === true) data.update("tasks_tasks", { done_at: new Date().toISOString() }, { id: row.id });
        return { restored: 1 };
      });

    onApi("remove-task", "Deletes a task (restore-task undoes it, with its tags and comments); returns { deleted }.",
      [{ name: "task_id", type: "bigint", description: "The task." }],
      (r) => ({ deleted: data.update("tasks_tasks", { deleted: true }, { id: task(r.args.task_id).id }) }));

    onApi("restore-task", "Brings back a deleted task where it was (the first column if its column is gone); returns { restored }.",
      [{ name: "task_id", type: "bigint", description: "The task." }],
      (r) => {
        const row = task(r.args.task_id);
        if (live(row)) return { restored: 0 };
        data.update("tasks_tasks", { deleted: false }, { id: row.id });
        if (isIssue(row)) return { restored: 1 };
        const home = live(column(row.column_id)) ? column(row.column_id) : columnsOf(row.channel_id)[0];
        const others = tasksIn(home.id).filter((t) => t.id !== row.id);
        place(task(row.id), home.id, others[Number(row.position)]?.id ?? null);
        return { restored: 1 };
      });

    const issue = (id: unknown) => {
      const row = task(id);
      if (!isIssue(row)) throw new InvalidRequest("That is a task, not an issue.");
      return row;
    };
    onApi("set-status", "Sets an issue's status (triage, in_progress, needs_testing, resolved); returns { changed }.",
      [
        { name: "task_id", type: "bigint", description: "The issue." },
        { name: "status", type: "text", description: "triage, in_progress, needs_testing or resolved." },
      ],
      (r) => {
        const row = issue(r.args.task_id);
        if (!(issueStatuses as readonly string[]).includes(String(r.args.status))) throw new InvalidRequest("Unknown status.");
        if (row.status === r.args.status) return { changed: false };
        data.update("tasks_tasks", { status: r.args.status, done_at: r.args.status === "resolved" ? new Date().toISOString() : null }, { id: row.id });
        log(row.id, r.userId, "status", row.status ?? "triage", r.args.status);
        return { changed: true };
      });

    onApi("set-severity", "Sets an issue's severity (none, low, medium, high, severe); returns { changed }.",
      [
        { name: "task_id", type: "bigint", description: "The issue." },
        { name: "severity", type: "text", description: "none, low, medium, high or severe." },
      ],
      (r) => {
        const row = issue(r.args.task_id);
        if (!(severities as readonly string[]).includes(String(r.args.severity))) throw new InvalidRequest("Unknown severity.");
        if (row.severity === r.args.severity) return { changed: false };
        data.update("tasks_tasks", { severity: r.args.severity }, { id: row.id });
        log(row.id, r.userId, "severity", row.severity ?? "none", r.args.severity);
        return { changed: true };
      });

    // Whether following "depends on" from `from` reaches `target`.
    const reaches = (from: number, target: number) => {
      const seen = new Set<number>();
      const stack = [from];
      while (stack.length) {
        const id = stack.pop()!;
        if (id === target) return true;
        if (seen.has(id)) continue;
        seen.add(id);
        for (const d of data.select("tasks_dependencies", { task_id: id })) stack.push(Number(d.depends_on_id));
      }
      return false;
    };
    onApi("set-dependency", "Makes a task depend on another one of the same board, or removes that; returns { changed }.",
      [
        { name: "task_id", type: "bigint", description: "The task that depends on the other." },
        { name: "depends_on_id", type: "bigint", description: "The task or issue it depends on." },
        { name: "depends", type: "bool", description: "True to add the dependency, false to remove it." },
      ],
      (r) => {
        const row = task(r.args.task_id);
        const other = task(r.args.depends_on_id);
        if (row.channel_id !== other.channel_id) throw new InvalidRequest("That task is on another board.");
        const link = { task_id: row.id, depends_on_id: other.id };
        const has = data.select("tasks_dependencies", link).length > 0;
        if ((r.args.depends === true) === has) return { changed: false };
        if (has) data.delete("tasks_dependencies", link);
        else {
          if (row.id === other.id) throw new InvalidRequest("A task can't depend on itself.");
          if (reaches(other.id, row.id)) throw new InvalidRequest("That would make the tasks wait for each other.");
          data.insert("tasks_dependencies", link);
        }
        log(row.id, r.userId, "depends_on", has ? other.id : null, has ? null : other.id);
        log(other.id, r.userId, "blocks", has ? row.id : null, has ? null : row.id);
        return { changed: true };
      });

    onApi("list-history", "A task's changes, oldest first: { rows } with actor_id, field, from_value, to_value, created_at.",
      [{ name: "task_id", type: "bigint", description: "The task." }],
      (r) => ({ rows: data.select("tasks_history", { task_id: task(r.args.task_id).id }).sort((a, b) => a.id - b.id) }));

    onApi("convert-task", "Turns a task into an issue (in triage, severity none) or an issue into a task (in the first open column); returns { changed }.",
      [
        { name: "task_id", type: "bigint", description: "The task or issue." },
        { name: "kind", type: "text", description: "'task' or 'issue'." },
        { name: "column_id", type: "bigint", required: false, description: "To a task: its column." },
        { name: "severity", type: "text", required: false, description: "To an issue: its severity." },
        { name: "status", type: "text", required: false, description: "To an issue: its status." },
      ],
      (r) => {
        const row = task(r.args.task_id);
        if (r.args.kind !== "task" && r.args.kind !== "issue") throw new InvalidRequest("'kind' is 'task' or 'issue'.");
        if (row.archived_at) throw new InvalidRequest("Restore the task from the archive first.");
        const wasIssue = isIssue(row);
        if ((r.args.kind === "issue") === wasIssue) return { changed: false };
        if (r.args.kind === "issue") {
          const status = r.args.status ?? "triage";
          const severity = r.args.severity ?? "none";
          if (!(issueStatuses as readonly string[]).includes(String(status))) throw new InvalidRequest("Unknown status.");
          if (!(severities as readonly string[]).includes(String(severity))) throw new InvalidRequest("Unknown severity.");
          data.update("tasks_tasks", {
            kind: "issue", column_id: null, severity, status, done_at: status === "resolved" ? new Date().toISOString() : null,
          }, { id: row.id });
        } else {
          const target = r.args.column_id === null ? columnsOf(row.channel_id).find((c) => !c.is_done) ?? columnsOf(row.channel_id)[0] : column(r.args.column_id);
          data.update("tasks_tasks", { kind: "task", severity: null, status: null }, { id: row.id });
          place(task(row.id), target.id, null);
        }
        log(row.id, r.userId, "kind", wasIssue ? "issue" : "task", r.args.kind);
        return { changed: true };
      });

    onApi("add-tag", "Adds a tag to a board; returns its id. Names are a-z, digits and '-'.",
      [
        { name: "channel_id", type: "bigint", description: "The tasks channel." },
        { name: "name", type: "text", description: "Tag name, without #." },
        { name: "color", type: "text", required: false, description: "A CSS color; picked from the name by default." },
      ],
      (r) => {
        const name = tagName(r.args.name);
        if (liveTags(r.args.channel_id).some((t) => t.name === name)) throw new InvalidRequest(`#${name} already exists.`);
        return { id: data.insert("tasks_tags", { channel_id: r.args.channel_id, name, color: r.args.color ?? colorFor(name), deleted: false }) };
      });

    onApi("edit-tag", "Renames a tag and sets its color; returns { updated }.",
      [
        { name: "tag_id", type: "bigint", description: "The tag." },
        { name: "name", type: "text", description: "Tag name, without #." },
        { name: "color", type: "text", description: "A CSS color." },
      ],
      (r) => {
        const row = tag(r.args.tag_id);
        const name = tagName(r.args.name);
        if (liveTags(row.channel_id).some((t) => t.name === name && t.id !== row.id))
          throw new InvalidRequest(`#${name} already exists.`);
        return { updated: data.update("tasks_tags", { name, color: r.args.color }, { id: row.id }) };
      });

    onApi("remove-tag", "Deletes a tag, which takes it off every task (restore-tag undoes both); returns { deleted }.",
      [{ name: "tag_id", type: "bigint", description: "The tag." }],
      (r) => ({ deleted: data.update("tasks_tags", { deleted: true }, { id: tag(r.args.tag_id).id }) }));

    onApi("restore-tag", "Brings back a deleted tag on the tasks it was on; returns { restored }.",
      [{ name: "tag_id", type: "bigint", description: "The tag." }],
      (r) => {
        const row = tag(r.args.tag_id);
        if (liveTags(row.channel_id).some((t) => t.name === row.name)) throw new InvalidRequest(`#${row.name} exists again; rename it first.`);
        return { restored: data.update("tasks_tags", { deleted: false }, { id: row.id }) };
      });

    onApi("tag-task", "Puts a tag on a task, or takes it off; returns { added }.",
      [
        { name: "task_id", type: "bigint", description: "The task." },
        { name: "tag_id", type: "bigint", description: "The tag." },
      ],
      (r) => {
        const row = task(r.args.task_id);
        if (tag(r.args.tag_id).channel_id !== row.channel_id) throw new InvalidRequest("That tag is on another board.");
        const link = { task_id: row.id, tag_id: r.args.tag_id };
        if (data.select("tasks_task_tags", link).length) {
          data.delete("tasks_task_tags", link);
          log(row.id, r.userId, "tag", tag(r.args.tag_id).name, null);
          return { added: false };
        }
        data.insert("tasks_task_tags", link);
        log(row.id, r.userId, "tag", null, tag(r.args.tag_id).name);
        return { added: true };
      });

    onApi("list-comments", "A task's comments, oldest first: { rows }.",
      [{ name: "task_id", type: "bigint", description: "The task." }],
      (r) => ({ rows: data.select("tasks_comments", { task_id: task(r.args.task_id).id }).filter(live) }));

    onApi("add-comment", "Comments on a task as the signed-in user; returns its id.",
      [
        { name: "task_id", type: "bigint", description: "The task." },
        { name: "body", type: "text", description: "Markdown; emoji as :shortcodes:." },
      ],
      (r) => {
        if (!String(r.args.body).trim()) throw new InvalidRequest("'body' can't be empty.");
        const row = task(r.args.task_id);
        data.update("tasks_tasks", { updated_at: new Date().toISOString() }, { id: row.id });
        return {
          id: data.insert("tasks_comments", {
            task_id: row.id, author_id: r.userId, body: r.args.body, created_at: new Date().toISOString(),
          }),
        };
      });

    onApi("edit-comment", "Changes the text of a comment and sets edited_at; returns { updated }.",
      [
        { name: "comment_id", type: "bigint", description: "The comment." },
        { name: "body", type: "text", description: "Markdown; emoji as :shortcodes:." },
      ],
      (r) => {
        const row = one("tasks_comments", r.args.comment_id, "comment");
        if (!String(r.args.body).trim()) throw new InvalidRequest("'body' can't be empty.");
        return { updated: data.update("tasks_comments", { body: r.args.body, edited_at: new Date().toISOString() }, { id: row.id }) };
      });

    // Other people's comments need the manage_messages permission, which the workspace's policy checks.
    onApi("remove-comment", "Deletes a comment (kept, marked deleted); returns { deleted }.",
      [{ name: "comment_id", type: "bigint", description: "The comment." }],
      (r) => ({ deleted: data.update("tasks_comments", { deleted: true }, { id: one("tasks_comments", r.args.comment_id, "comment").id }) }));

    onApi("react", "Toggles the signed-in user's reaction on a task; returns { added }.",
      [
        { name: "task_id", type: "bigint", description: "The task." },
        { name: "code", type: "text", description: "Emoji shortcode without colons, e.g. smile." },
      ],
      (r) => {
        const mine = { task_id: task(r.args.task_id).id, user_id: r.userId, code: r.args.code };
        if (data.select("tasks_reactions", mine).length) {
          data.delete("tasks_reactions", mine);
          return { added: false };
        }
        data.insert("tasks_reactions", mine);
        return { added: true };
      });

    onApiRead((r) => data.select(r.table, r.where));
  },
};
