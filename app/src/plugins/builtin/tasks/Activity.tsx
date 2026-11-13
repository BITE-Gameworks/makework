import { copyText } from "../../../core/clipboard";
import { For, Show, createEffect, createMemo, createSignal, type JSX } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { prepareUpload } from "../../../core/files";
import { relativeTime } from "../../../core/time";
import RichEditor, { type EditorApi } from "../../../editor/RichEditor";
import { decodeEmoji } from "../../../markdown/emoji";
import Markdown from "../../../markdown/Markdown";
import { Icon } from "../../../theme/icons";
import Avatar from "../../../ui/Avatar";
import ConfirmPrompt from "../../../ui/ConfirmPrompt";
import type { ChannelContext } from "../../types";
import type { Run } from "./actions";
import {
  addComment, createComments, createHistory, editComment, removeComment, severityLabel, statusLabel,
  type Board, type Comment, type HistoryEntry, type Task,
} from "./data";

type Entry = { key: string; at: string; event?: HistoryEntry & { text?: string }; comment?: Comment };

// A task's story, oldest first: when it was added, every change to it (who moved it, changed its status or
// severity, assigned someone, changed a dependency...) and its comments, with the box to comment at the end.
export function Activity(props: { context: ChannelContext; board: Board; task: Task; run: Run }) {
  const ctx = props.context;
  const taskId = () => props.task.id;
  const comments = createComments(ctx.api, taskId);
  const history = createHistory(ctx.api, taskId);
  let editor!: EditorApi;
  const pasteImages = (api: () => EditorApi) => (files: File[]) => {
    for (const file of files.filter((f) => f.type.startsWith("image/"))) {
      void props.run(async () => {
        const upload = await prepareUpload(file, { workspaceId: ctx.workspace.id });
        api().insertText(`![image](${upload.url})`);
      });
    }
  };
  const send = (md: string) => {
    if (!md.trim()) return;
    void props.run(async () => {
      await addComment(ctx.api, taskId(), md);
      editor.clear();
    });
  };
  const titleOf = (id: string) => {
    const found = [...props.board.tasks, ...props.board.issues].find((t) => t.id === Number(id));
    return found ? `"${found.title}"` : "another task";
  };
  const person = (id: string) => ctx.users.get(Number(id)).displayName;
  const said = (e: HistoryEntry): JSX.Element => {
    switch (e.field) {
      case "column": return <>moved this from <b>{decodeEmoji(e.from)}</b> to <b>{decodeEmoji(e.to)}</b></>;
      case "status": return <>changed the status from <b>{statusLabel(e.from)}</b> to <b>{statusLabel(e.to)}</b></>;
      case "severity": return <>changed the severity from <b>{severityLabel(e.from)}</b> to <b>{severityLabel(e.to)}</b></>;
      case "title": return <>renamed this from <b>{decodeEmoji(e.from)}</b> to <b>{decodeEmoji(e.to)}</b></>;
      case "notes": return <>edited the notes</>;
      case "steps": return <>edited the problem description</>;
      case "kind": return <>turned this {e.from} into {e.to === "issue" ? "an issue" : "a task"}</>;
      case "assignee": return e.to ? <>assigned <b>{person(e.to)}</b></> : <>unassigned <b>{person(e.from)}</b></>;
      case "tag": return e.to ? <>added the tag <b>#{e.to}</b></> : <>removed the tag <b>#{e.from}</b></>;
      case "depends_on": return e.to ? <>made this depend on <b>{titleOf(e.to)}</b></> : <>removed the dependency on <b>{titleOf(e.from)}</b></>;
      case "blocks": return e.to ? <>made <b>{titleOf(e.to)}</b> depend on this</> : <>removed the dependency of <b>{titleOf(e.from)}</b> on this</>;
      default: return <>changed {e.field}</>;
    }
  };
  const entries = createMemo<Entry[]>(() => [
    ...history.value.map((e) => ({ key: `h${e.id}`, at: e.at, event: e })),
    ...comments.value.map((c) => ({ key: `c${c.id}`, at: c.createdAt, comment: c })),
  ].sort((a, b) => a.at.localeCompare(b.at)));
  // Entries keep their identity between refetches, so only new ones are built (and fade in).
  const [shown, setShown] = createStore<{ list: Entry[] }>({ list: [] });
  createEffect(() => setShown("list", reconcile(entries(), { key: "key" })));
  const noun = () => (props.task.kind === "issue" ? "issue" : "task");
  return (
    <section class="task-comments" aria-label="Activity">
      <h3>Activity</h3>
      <ol class="task-timeline">
        <li class="task-step mw-fade-in">
          <div class="task-event">
            <Avatar user={ctx.users.get(props.task.authorId)} size={16} />
            <span><b>{ctx.users.get(props.task.authorId).displayName}</b> added this {noun()}</span>
            <time datetime={props.task.createdAt} title={new Date(props.task.createdAt).toLocaleString()}>{relativeTime(props.task.createdAt)}</time>
          </div>
        </li>
        <For each={shown.list}>
          {(entry) => (
            <li class="task-step mw-fade-in" classList={{ comment: !entry.event }}>
              <Show when={entry.event} fallback={<CommentView context={ctx} comment={entry.comment!} run={props.run} />}>
                {(e) => (
                  <div class="task-event" onContextMenu={(ev) => ctx.openUserMenu(ev, e().actorId)}>
                    <Avatar user={ctx.users.get(e().actorId)} size={16} />
                    <span><b>{ctx.users.get(e().actorId).displayName}</b> {said(e())}</span>
                    <time datetime={e().at} title={new Date(e().at).toLocaleString()}>{relativeTime(e().at)}</time>
                  </div>
                )}
              </Show>
            </li>
          )}
        </For>
      </ol>
      <RichEditor workspaceId={ctx.workspace.id} placeholder="Comment, Enter to send" ref={(api) => (editor = api)} onSubmit={send} onPasteFiles={pasteImages(() => editor)}
        actions={<button type="button" class="icon-button accent" title="Send" aria-label="Send comment" onClick={() => send(editor.markdown())}><Icon name="send" /></button>} />
    </section>
  );
}

function CommentView(props: { context: ChannelContext; comment: Comment; run: Run }) {
  const ctx = props.context;
  const c = props.comment;
  const who = () => ctx.users.get(c.authorId);
  const mine = () => c.authorId === ctx.users.me();
  const canDelete = () => mine() || ctx.can("manage_messages");
  const [editing, setEditing] = createSignal(false);
  let editEditor!: EditorApi;
  const pasteImages = (files: File[]) => {
    for (const file of files.filter((f) => f.type.startsWith("image/"))) {
      void props.run(async () => {
        const upload = await prepareUpload(file, { workspaceId: ctx.workspace.id });
        editEditor.insertText(`![image](${upload.url})`);
      });
    }
  };
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  // A save that fails opens the edit again with what was typed (messaging/MessageCard does the same).
  const [failedEdit, setFailedEdit] = createSignal<string | null>(null);
  const save = (markdown: string) => {
    if (!markdown.trim()) return;
    setEditing(false);
    if (markdown.trim() === decodeEmoji(c.body).trim()) return;
    void props.run(() => editComment(ctx.api, c.id, markdown).catch((e) => {
      setFailedEdit(markdown);
      setEditing(true);
      throw e;
    }));
  };
  const menu = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("a, .mw-link-chip, .mw-editor")) return;
    ctx.openContextMenu(e, [
      ...(mine() ? [{ label: "Edit", icon: "rename", action: () => { setFailedEdit(null); setEditing(true); } }] : []),
      { label: "Copy text", icon: "copy", action: () => void copyText(decodeEmoji(c.body)) },
      ...(canDelete() ? ["separator" as const, { label: "Delete", icon: "delete", danger: true, action: () => setConfirmDelete(true) }] : []),
    ]);
  };
  return (
    <article class="task-comment mw-box" onContextMenu={menu}>
      <span class="task-comment-avatar" onContextMenu={(e) => ctx.openUserMenu(e, c.authorId)}>
        <Avatar user={who()} size={24} />
      </span>
      <div class="task-comment-main">
        <header>
          <span class="task-comment-name" onContextMenu={(e) => ctx.openUserMenu(e, c.authorId)}>{who().displayName}</span>
          <time datetime={c.createdAt} title={new Date(c.createdAt).toLocaleString()}>{relativeTime(c.createdAt)}</time>
          <Show when={c.editedAt}>
            {(at) => <span class="task-comment-edited" title={`Edited ${new Date(at()).toLocaleString()}`}>(edited)</span>}
          </Show>
          <Show when={canDelete() && !editing()}>
            <span class="task-comment-actions">
              <Show when={mine()}>
                <button class="icon-button" title="Edit" aria-label="Edit comment" onClick={() => { setFailedEdit(null); setEditing(true); }}><Icon name="rename" /></button>
              </Show>
              <button class="icon-button" title="Delete" aria-label="Delete comment" aria-expanded={confirmDelete()}
                onClick={() => setConfirmDelete(!confirmDelete())}><Icon name="delete" /></button>
            </span>
          </Show>
        </header>
        <Show when={editing()} fallback={<Markdown source={c.body} breaks class="task-comment-body" workspaceId={ctx.workspace.id} />}>
          <div class="task-comment-edit mw-fade-in">
            <RichEditor workspaceId={ctx.workspace.id} value={failedEdit() ?? decodeEmoji(c.body)}
              ref={(api) => { editEditor = api; requestAnimationFrame(() => api.focus(true)); }} onSubmit={save} onPasteFiles={pasteImages}
              onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), e.stopPropagation(), setEditing(false))} />
            <p class="task-comment-hint muted">Enter to save, Esc to cancel</p>
          </div>
        </Show>
        <ConfirmPrompt open={confirmDelete()} question="Are you sure you want to delete this comment?" confirmLabel="Delete"
          onConfirm={() => { setConfirmDelete(false); void props.run(() => removeComment(ctx.api, c.id)); }}
          onCancel={() => setConfirmDelete(false)} />
      </div>
    </article>
  );
}
