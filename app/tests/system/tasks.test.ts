import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../src/api/client";
import { MockTransport } from "../../src/mock/transport";
import { MockBackend } from "../../src/system/backend";
import { tasks } from "../../src/system/tasks";

type Board = { columns: { id: number; is_done: boolean }[]; tasks: { id: number; column_id: number }[]; archived: number };

function setup() {
  const backend = new MockBackend();
  backend.load(tasks);
  const api = new ApiClient(new MockTransport(backend)).plugin("tasks");
  const board = () => api.call<Board>("list-board", { channel_id: 1 });
  return { api, board };
}

describe("tasks archive", () => {
  it("archives the extra done tasks when a done column passes its limit, and brings them back", async () => {
    const { api, board } = setup();
    const done = (await board()).columns.find((c) => c.is_done)!;
    await api.call("set-keep-done", { column_id: done.id, keep: 2 });
    const ids: number[] = [];
    for (const title of ["a", "b", "c"]) ids.push((await api.call<{ id: number }>("add-task", { channel_id: 1, title, column_id: null })).id);
    await api.call("move-task", { task_id: ids[0], column_id: done.id, before_id: null });
    await api.call("move-task", { task_id: ids[1], column_id: done.id, before_id: null });
    const moved = await api.call<{ archived: number[] }>("move-task", { task_id: ids[2], column_id: done.id, before_id: null });
    expect(moved.archived).toHaveLength(1);

    const after = await board();
    expect(after.tasks.filter((t) => t.column_id === done.id)).toHaveLength(2);
    expect(after.archived).toBe(1);
    const archived = await api.call<{ tasks: { id: number }[]; total: number }>("list-archived", { channel_id: 1 });
    expect(archived.total).toBe(1);
    expect(archived.tasks[0].id).toBe(moved.archived[0]);

    await api.call("unarchive-task", { task_id: moved.archived[0], fresh: true });
    expect((await board()).archived).toBe(0);
    expect((await board()).tasks.filter((t) => t.column_id === done.id)).toHaveLength(3);
  });

  it("keeps every done task with a limit of 0", async () => {
    const { api, board } = setup();
    const done = (await board()).columns.find((c) => c.is_done)!;
    await api.call("set-keep-done", { column_id: done.id, keep: 0 });
    for (let i = 0; i < 25; i++) await api.call("add-task", { channel_id: 1, title: `t${i}`, column_id: done.id });
    expect((await board()).archived).toBe(0);
  });
});

// Like chat's messages (mesh-test s15): the board's reads must not grow with its tasks.
describe("listing a board", () => {
  it("reads each table a fixed number of times, however many tasks there are", async () => {
    const { MockPluginData } = await import("../../src/system/data");
    const reads = async (count: number) => {
      const { api, board } = setup();
      for (let i = 0; i < count; i++) {
        const { id } = await api.call<{ id: number }>("add-task", { channel_id: 1, title: `t${i}`, column_id: null });
        if (i % 4 === 0) await api.call("react", { task_id: id, code: "smile" });
      }
      const spy = vi.spyOn(MockPluginData.prototype, "select");
      const listed = await board();
      const n = spy.mock.calls.length;
      spy.mockRestore();
      expect(listed.tasks).toHaveLength(count);
      return n;
    };
    expect(await reads(100)).toBe(await reads(10));
  });
});

type Issue = { id: number; kind: string; status: string; severity: string; column_id: number | null; depends_on: number[]; blocks: number[] };
type Listed = { tasks: Issue[]; issues: Issue[]; columns: { id: number }[] };

describe("issues", () => {
  it("are listed apart from the board, start in triage and change status and severity", async () => {
    const { api } = setup();
    const task = await api.call<{ id: number }>("add-task", { channel_id: 1, title: "a task", column_id: null });
    const issue = await api.call<{ id: number }>("add-task", { channel_id: 1, title: "a bug", column_id: null, kind: "issue" });
    await api.call("set-status", { task_id: issue.id, status: "needs_testing" });
    await api.call("set-severity", { task_id: issue.id, severity: "severe" });
    const listed = await api.call<Listed>("list-board", { channel_id: 1 });
    expect(listed.tasks.map((t) => t.id)).toEqual([task.id]);
    expect(listed.issues).toHaveLength(1);
    expect(listed.issues[0]).toMatchObject({ id: issue.id, kind: "issue", status: "needs_testing", severity: "severe", column_id: null });
    await expect(api.call("set-status", { task_id: task.id, status: "resolved" })).rejects.toThrow();
    await expect(api.call("set-severity", { task_id: issue.id, severity: "huge" })).rejects.toThrow();
    await expect(api.call("move-task", { task_id: issue.id, column_id: listed.columns[0].id, before_id: null })).rejects.toThrow();
  });

  it("can be deleted and restored", async () => {
    const { api } = setup();
    const issue = await api.call<{ id: number }>("add-task", { channel_id: 1, title: "a bug", column_id: null, kind: "issue" });
    await api.call("remove-task", { task_id: issue.id });
    expect((await api.call<Listed>("list-board", { channel_id: 1 })).issues).toHaveLength(0);
    await api.call("restore-task", { task_id: issue.id });
    expect((await api.call<Listed>("list-board", { channel_id: 1 })).issues).toHaveLength(1);
  });
});

describe("dependencies", () => {
  it("show on both tasks, and refuse loops and other boards", async () => {
    const { api } = setup();
    const add = async (title: string, channel = 1, kind = "task") => (await api.call<{ id: number }>("add-task", { channel_id: channel, title, column_id: null, kind })).id;
    const [a, b, c, other] = [await add("a"), await add("b", 1, "issue"), await add("c"), await add("x", 2)];
    await api.call("set-dependency", { task_id: a, depends_on_id: b, depends: true });
    await api.call("set-dependency", { task_id: b, depends_on_id: c, depends: true });
    const listed = await api.call<Listed>("list-board", { channel_id: 1 });
    expect(listed.tasks.find((t) => t.id === a)!.depends_on).toEqual([b]);
    expect(listed.issues[0].blocks).toEqual([a]);
    expect(listed.issues[0].depends_on).toEqual([c]);
    await expect(api.call("set-dependency", { task_id: c, depends_on_id: a, depends: true })).rejects.toThrow("wait for each other");
    await expect(api.call("set-dependency", { task_id: a, depends_on_id: a, depends: true })).rejects.toThrow("itself");
    await expect(api.call("set-dependency", { task_id: a, depends_on_id: other, depends: true })).rejects.toThrow("another board");
    await api.call("set-dependency", { task_id: a, depends_on_id: b, depends: false });
    expect((await api.call<Listed>("list-board", { channel_id: 1 })).tasks.find((t) => t.id === a)!.depends_on).toEqual([]);
  });
});

describe("task history", () => {
  it("records who changed what, oldest first", async () => {
    const { api } = setup();
    const cols = (await api.call<Listed>("list-board", { channel_id: 1 })).columns;
    const { id } = await api.call<{ id: number }>("add-task", { channel_id: 1, title: "t", column_id: null });
    const other = (await api.call<{ id: number }>("add-task", { channel_id: 1, title: "o", column_id: null })).id;
    await api.call("move-task", { task_id: id, column_id: cols[1].id, before_id: null });
    await api.call("move-task", { task_id: id, column_id: cols[1].id, before_id: null });
    await api.call("edit-task", { task_id: id, title: "t2", notes: "n" });
    await api.call("assign-task", { task_id: id, user_id: 7, assigned: true });
    await api.call("set-dependency", { task_id: id, depends_on_id: other, depends: true });
    const { rows } = await api.call<{ rows: { field: string; from_value: string; to_value: string }[] }>("list-history", { task_id: id });
    expect(rows.map((r) => r.field)).toEqual(["column", "title", "notes", "assignee", "depends_on"]);
    expect(rows[1]).toMatchObject({ from_value: "t", to_value: "t2" });
    const theirs = await api.call<{ rows: { field: string }[] }>("list-history", { task_id: other });
    expect(theirs.rows.map((r) => r.field)).toEqual(["blocks"]);
  });
});

describe("converting", () => {
  it("turns a task into an issue and back, and logs it", async () => {
    const { api } = setup();
    const { id } = await api.call<{ id: number }>("add-task", { channel_id: 1, title: "t", column_id: null });
    await api.call("convert-task", { task_id: id, kind: "issue" });
    let listed = await api.call<Listed>("list-board", { channel_id: 1 });
    expect(listed.tasks).toHaveLength(0);
    expect(listed.issues[0]).toMatchObject({ id, status: "triage", severity: "none", column_id: null });
    await api.call("convert-task", { task_id: id, kind: "task" });
    listed = await api.call<Listed>("list-board", { channel_id: 1 });
    expect(listed.issues).toHaveLength(0);
    expect(listed.tasks[0].column_id).toBe(listed.columns[0].id);
    const { rows } = await api.call<{ rows: { field: string }[] }>("list-history", { task_id: id });
    expect(rows.map((r) => r.field)).toEqual(["kind", "kind"]);
  });
});
