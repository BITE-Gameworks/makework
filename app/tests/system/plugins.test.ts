// The chat, files, tasks and artboard mock plugins, through ApiClient.
import { describe, expect, it } from "vitest";
import { ApiClient, ApiRequestError } from "../../src/api/client";
import { MockBackend } from "../../src/system/backend";
import { artboard } from "../../src/system/artboard";
import { chat } from "../../src/system/chat";
import { files } from "../../src/system/files";
import { git } from "../../src/system/git";
import { tasks } from "../../src/system/tasks";
import { MockTransport } from "../../src/mock/transport";

function client(name: string) {
  const backend = new MockBackend();
  for (const ext of [chat, files, tasks, artboard, git]) backend.load(ext);
  return new ApiClient(new MockTransport(backend, 0)).plugin(name);
}

async function errorCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    return (e as ApiRequestError).code;
  }
  throw new Error("expected an error");
}

describe("mock plugins", () => {
  it("files: folders, names, moves and recursive delete", async () => {
    const api = client("files");
    const { id: docs } = await api.call<{ id: number }>("add-folder", { channel_id: 1, name: "docs" });
    const { id: sub } = await api.call<{ id: number }>("add-folder", { channel_id: 1, parent_id: docs, name: "sub" });
    const { id: file } = await api.call<{ id: number }>("add-file", { channel_id: 1, parent_id: sub, name: "a.txt", mime: "text/plain", size: 1 });
    expect(await errorCode(api.call("add-file", { channel_id: 1, parent_id: sub, name: "a.txt", mime: "text/plain", size: 1 }))).toBe("invalid_request");
    const listing = await api.call<{ rows: { name: string }[]; path: { name: string }[] }>("list", { channel_id: 1, folder_id: sub });
    expect(listing.rows.map((r) => r.name)).toEqual(["a.txt"]);
    expect(listing.path.map((p) => p.name)).toEqual(["docs", "sub"]);
    expect(await errorCode(api.call("move", { entry_id: docs, parent_id: sub }))).toBe("invalid_request");
    await api.call("move", { entry_id: file, parent_id: null });
    expect(await api.call("remove", { entry_id: docs })).toEqual({ deleted: 1 });
    expect((await api.call<{ rows: unknown[] }>("list", { channel_id: 1 })).rows).toHaveLength(1);
    expect(await errorCode(api.call("list", { channel_id: 1, folder_id: sub }))).toBe("invalid_request");
    await api.call("add-folder", { channel_id: 1, name: "docs" });
    expect(await api.call("restore", { entry_id: docs })).toEqual({ name: "docs (restored)" });
    expect((await api.call<{ rows: unknown[] }>("list", { channel_id: 1, folder_id: sub })).rows).toHaveLength(0);
  });

  it("files: deleting for good removes a folder with everything in it, hidden entries too", async () => {
    const api = client("files");
    const add = (name: string, parent: number | null) =>
      api.call<{ id: number }>("add-file", { channel_id: 1, parent_id: parent, name, mime: "text/plain", size: 1 });
    const { id: docs } = await api.call<{ id: number }>("add-folder", { channel_id: 1, name: "docs" });
    const { id: sub } = await api.call<{ id: number }>("add-folder", { channel_id: 1, parent_id: docs, name: "sub" });
    const { id: deep } = await add("deep.txt", sub);
    const { id: hidden } = await add("hidden.txt", docs);
    await add("keep.txt", null);
    await api.call("remove", { entry_id: hidden });

    expect(await api.call("purge", { entry_id: docs })).toEqual({ deleted: 4 });
    expect((await api.read("files_entries")).map((e) => e.name)).toEqual(["keep.txt"]);
    for (const id of [docs, deep, hidden]) expect(await errorCode(api.call("restore", { entry_id: id }))).toBe("invalid_request");
    await expect(api.call("restore", { entry_id: docs })).rejects.toThrow("That file no longer exists.");
  });

  it("chat: edit and delete own messages", async () => {
    const api = client("chat");
    const { id: parent } = await api.call<{ id: number }>("post-message", { channel_id: 1, body: "hello" });
    const { id: reply } = await api.call<{ id: number }>("post-message", { channel_id: 1, body: "hi", thread_id: parent });
    await api.call("edit-message", { message_id: parent, body: "hello there" });
    const { message } = await api.call<{ message: { body: string; edited_at: string | null } }>("get-message", { message_id: parent });
    expect(message.body).toBe("hello there");
    expect(message.edited_at).not.toBeNull();
    expect(await errorCode(api.call("edit-message", { message_id: parent, body: " " }))).toBe("invalid_request");
    await api.call("delete-message", { message_id: reply });
    const list = await api.call<{ rows: { reply_count: number }[] }>("list-messages", { channel_id: 1 });
    expect(list.rows[0].reply_count).toBe(0);
    await api.call("delete-message", { message_id: parent });
    expect((await api.call<{ rows: unknown[] }>("list-messages", { channel_id: 1 })).rows).toHaveLength(0);
    expect(await errorCode(api.call("edit-message", { message_id: parent, body: "again" }))).toBe("invalid_request");
  });

  it("chat: detaching attachments, a message without text goes with its last one", async () => {
    const api = client("chat");
    const attach = async (messageId: number, name: string) =>
      (await api.call<{ id: number }>("attach", { message_id: messageId, name, mime: "text/plain", size: 1, url: `mwc:${name}` })).id;
    const attachments = async (messageId: number) =>
      (await api.call<{ message: { attachments: { name: string }[] } }>("get-message", { message_id: messageId })).message.attachments;
    const { id: bare } = await api.call<{ id: number }>("post-message", { channel_id: 1, body: "" });
    const [a, b] = [await attach(bare, "a"), await attach(bare, "b")];
    const { id: texted } = await api.call<{ id: number }>("post-message", { channel_id: 1, body: "see this" });
    const c = await attach(texted, "c");

    expect(await api.call("detach", { attachment_id: a })).toEqual({ removed: 1 });
    expect((await attachments(bare)).map((x) => x.name)).toEqual(["b"]);
    await api.call("detach", { attachment_id: b });
    await api.call("detach", { attachment_id: c });
    const list = await api.call<{ rows: { id: number }[] }>("list-messages", { channel_id: 1 });
    expect(list.rows.map((m) => m.id)).toEqual([texted]);
    expect(await errorCode(api.call("detach", { attachment_id: a }))).toBe("invalid_request");
  });

  it("git: history of a branch through merges, newest first, and where it is cut off", async () => {
    const api = client("git");
    expect(await api.call("get-repo", { channel_id: 1 })).toEqual({ repo: null, branches: [] });
    await api.call("set-repo", { channel_id: 1, provider: "local", host: "", path: "app" });
    // a - b - d (merge of b and c) - e; c's parent "f00" is not imported.
    const c = (sha: string, parents: string[], minute: number) =>
      ({ sha, parents, author_name: "Ann", author_email: "a@x", authored_at: `2026-01-01T00:0${minute}:00Z`, message: sha });
    await api.call("import-commits", { channel_id: 1, commits: JSON.stringify([
      c("aaaaaaa", [], 1), c("bbbbbbb", ["aaaaaaa"], 2), c("ccccccc", ["f00f00f"], 3), c("ddddddd", ["bbbbbbb", "ccccccc"], 4), c("eeeeeee", ["ddddddd"], 5),
    ]) });
    expect(await api.call("import-commits", { channel_id: 1, commits: JSON.stringify([c("aaaaaaa", [], 1)]) })).toEqual({ added: 0 });
    await api.call("set-branches", { channel_id: 1, branches: JSON.stringify([{ name: "main", head: "eeeeeee" }, { name: "old", head: "bbbbbbb" }]) });
    const main = await api.call<{ rows: { sha: string }[]; total: number; truncated: boolean }>("list-commits", { channel_id: 1, branch: "main" });
    expect(main.rows.map((r) => r.sha)).toEqual(["eeeeeee", "ddddddd", "ccccccc", "bbbbbbb", "aaaaaaa"]);
    expect(main.truncated).toBe(true);
    expect(await api.call("list-commits", { channel_id: 1, branch: "old" })).toMatchObject({ total: 2, truncated: false });
    expect(await api.call("frontier", { channel_id: 1 })).toEqual({ shas: "f00f00f" });
    // Without a branch: every head together, also commits only an unmerged branch has.
    await api.call("import-commits", { channel_id: 1, commits: JSON.stringify([c("1111111", ["bbbbbbb"], 6)]) });
    await api.call("set-branches", { channel_id: 1, branches: JSON.stringify([
      { name: "main", head: "eeeeeee" }, { name: "old", head: "bbbbbbb" }, { name: "spike", head: "1111111" },
    ]) });
    const all = await api.call<{ rows: { sha: string }[]; heads: { name: string }[] }>("list-commits", { channel_id: 1 });
    expect(all.rows.map((r) => r.sha)).toEqual(["1111111", "eeeeeee", "ddddddd", "ccccccc", "bbbbbbb", "aaaaaaa"]);
    expect(all.heads.map((h) => h.name)).toEqual(["main", "old", "spike"]);
    expect(await errorCode(api.call("import-commits", { channel_id: 1, commits: "nope" }))).toBe("invalid_request");
    await api.call("remove-repo", { channel_id: 1 });
    expect(await api.call("known-shas", { channel_id: 1 })).toEqual({ shas: "" });
  });

  it("tasks: columns, moves, tags, comments and reactions", async () => {
    const api = client("tasks");
    const { columns } = await api.call<{ columns: { id: number; name: string }[] }>("list-board", { channel_id: 1 });
    expect(columns.map((c) => c.name)).toEqual(["To do", "Doing", "Done"]);
    const [todo, , done] = columns.map((c) => c.id);
    const add = async (title: string) => (await api.call<{ id: number }>("add-task", { channel_id: 1, title })).id;
    const [a, b, c] = [await add("a"), await add("b"), await add("c")];
    type Board = { columns: { id: number }[]; tasks: { id: number; title: string; column_id: number; done_at: string | null; tag_ids: number[]; comment_count: number }[] };
    const board = () => api.call<Board>("list-board", { channel_id: 1 });
    await api.call("move-task", { task_id: c, column_id: todo, before_id: a });
    expect((await board()).tasks.map((t) => t.title)).toEqual(["c", "a", "b"]);
    await api.call("move-task", { task_id: a, column_id: done });
    expect((await board()).tasks.find((t) => t.id === a)?.done_at).not.toBeNull();
    const { id: bug } = await api.call<{ id: number }>("add-tag", { channel_id: 1, name: "#Bug" });
    expect(await errorCode(api.call("add-tag", { channel_id: 1, name: "bug" }))).toBe("invalid_request");
    expect(await api.call("tag-task", { task_id: b, tag_id: bug })).toEqual({ added: true });
    await api.call("add-comment", { task_id: b, body: "looks fine" });
    await api.call("react", { task_id: b, code: "smile" });
    const tb = (await board()).tasks.find((t) => t.id === b)!;
    expect(tb).toMatchObject({ tag_ids: [bug], comment_count: 1 });
    const { id: extra } = await api.call<{ id: number }>("add-comment", { task_id: b, body: "typo" });
    await api.call("edit-comment", { comment_id: extra, body: "fixed" });
    const comments = async () => (await api.call<{ rows: { id: number; body: string; edited_at: string | null }[] }>("list-comments", { task_id: b })).rows;
    expect((await comments()).find((r) => r.id === extra)).toMatchObject({ body: "fixed", edited_at: expect.any(String) });
    await api.call("remove-comment", { comment_id: extra });
    expect((await comments()).map((r) => r.body)).toEqual(["looks fine"]);
    expect((await board()).tasks.find((t) => t.id === b)).toMatchObject({ comment_count: 1 });
    await api.call("remove-task", { task_id: c });
    expect((await board()).tasks.map((t) => t.title)).toEqual(["b", "a"]);
    await api.call("restore-task", { task_id: c });
    expect((await board()).tasks.map((t) => t.title)).toEqual(["c", "b", "a"]);
    await api.call("remove-tag", { tag_id: bug });
    expect((await board()).tasks.find((t) => t.id === b)?.tag_ids).toEqual([]);
    await api.call("restore-tag", { tag_id: bug });
    expect((await board()).tasks.find((t) => t.id === b)?.tag_ids).toEqual([bug]);
    await api.call("remove-column", { column_id: todo });
    const after = await board();
    expect(after.columns).toHaveLength(2);
    expect(after.tasks.filter((t) => t.title !== "a").every((t) => t.column_id === after.columns[0].id)).toBe(true);
  });

  it("tasks: several assignees, and the old single assignee column", async () => {
    const backend = new MockBackend();
    backend.load(tasks);
    const api = new ApiClient(new MockTransport(backend, 0)).plugin("tasks");
    const add = async (title: string) => (await api.call<{ id: number }>("add-task", { channel_id: 1, title })).id;
    const [a, old] = [await add("a"), await add("old")];
    const assignees = async (id: number) =>
      (await api.call<{ task: { assignee_ids: number[] } }>("get-task", { task_id: id })).task.assignee_ids;
    const assign = (id: number, user: number, assigned: boolean) => api.call("assign-task", { task_id: id, user_id: user, assigned });

    expect(await assign(a, 7, true)).toEqual({ changed: true });
    expect(await assign(a, 7, true)).toEqual({ changed: false });
    await assign(a, 8, true);
    expect(await assignees(a)).toEqual([7, 8]);
    await api.call("edit-task", { task_id: a, title: "renamed", notes: "" });
    expect(await assignees(a)).toEqual([7, 8]);
    await assign(a, 7, false);
    expect(await assignees(a)).toEqual([8]);

    // A task from before several assignees names one in assignee_id; it moves into a row on the next change.
    backend.data("tasks").update("tasks_tasks", { assignee_id: 5 }, { id: old });
    expect(await assignees(old)).toEqual([5]);
    await assign(old, 6, true);
    expect(await assignees(old)).toEqual([5, 6]);
    expect(backend.data("tasks").select("tasks_tasks", { id: old })[0].assignee_id).toBeNull();
    await assign(old, 5, false);
    expect(await assignees(old)).toEqual([6]);
  });

  it("artboard: places and raises items", async () => {
    const api = client("artboard");
    const item = { channel_id: 1, name: "a.png", mime: "image/png", url: "data:,", width: 10, height: 10, x: 0, y: 0 };
    const { id: first } = await api.call<{ id: number }>("add-item", item);
    await api.call("add-item", item);
    expect(await api.call("raise-item", { item_id: first })).toEqual({ z: 3 });
    await api.call("place-item", { item_id: first, x: 5, y: -5, scale: 2, rotation: 90, flip: true });
    const { rows } = await api.call<{ rows: { id: number; x: number; flip: boolean }[] }>("list-items", { channel_id: 1 });
    expect(rows.at(-1)).toMatchObject({ id: first, x: 5, flip: true });
    await api.call("remove-item", { item_id: first });
    expect((await api.call<{ rows: unknown[] }>("list-items", { channel_id: 1 })).rows).toHaveLength(1);
    await api.call("restore-item", { item_id: first });
    expect((await api.call<{ rows: unknown[] }>("list-items", { channel_id: 1 })).rows).toHaveLength(2);
    expect(await errorCode(api.call("place-item", { item_id: first, x: 0, y: 0, scale: 0, rotation: 0, flip: false }))).toBe("invalid_request");
  });

  it("artboard: notes and drawings are items too", async () => {
    const api = client("artboard");
    const { id: note } = await api.call<{ id: number }>("add-note", { channel_id: 1, width: 200, height: 160, x: 1, y: 2 });
    const { id: line } = await api.call<{ id: number }>("add-drawing", {
      channel_id: 1, paths: JSON.stringify({ w: 10, h: 10, paths: [] }), stroke: 4, width: 10, height: 10, x: 0, y: 0,
    });
    await api.call("edit-note", { item_id: note, text: "hello", color: "#ffe58f" });
    await api.call("style-drawing", { item_id: line, color: "#e5484d", stroke: 8 });
    const { rows } = await api.call<{ rows: { id: number; kind: string; text: string; color: string; stroke: number; z: number }[] }>("list-items", { channel_id: 1 });
    expect(rows.map((r) => r.kind)).toEqual(["note", "drawing"]);
    expect(rows[0]).toMatchObject({ text: "hello", color: "#ffe58f" });
    expect(rows[1]).toMatchObject({ color: "#e5484d", stroke: 8 });
    expect(await errorCode(api.call("edit-note", { item_id: line, text: "x", color: "" }))).toBe("invalid_request");
    expect(await errorCode(api.call("style-drawing", { item_id: note, color: "", stroke: 2 }))).toBe("invalid_request");
    expect(await errorCode(api.call("add-note", { channel_id: 1, width: 0, height: 10, x: 0, y: 0 }))).toBe("invalid_request");
  });
});
