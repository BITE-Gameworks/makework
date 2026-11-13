// One message in a chat or private conversation: author, time, text (edited in place), what the place adds
// (attachments, polls, delivery status), replies and reactions in the footer, and the right-click menu.
import { copyText } from "../core/clipboard";
import { copyImageFrom } from "../core/clipboardImage";
import { For, Show, createEffect, createSignal, type JSX } from "solid-js";
import { clearEditRequest, editRequest } from "./editing";
import { clockTime } from "./grouping";
import { showToast } from "../core/notices";
import { decodeEmoji, splitEmoji } from "../markdown/emoji";
import { customEmojiByName } from "../core/customEmoji";
import Markdown, { type MentionLookup } from "../markdown/Markdown";
import RichEditor from "../editor/RichEditor";
import { videoEmbeds } from "./embeds";
import { VideoEmbedView } from "./VideoEmbedView";
import { Icon } from "../theme/icons";
import Avatar, { type AvatarUser } from "../ui/Avatar";
import ConfirmPrompt from "../ui/ConfirmPrompt";
import { openContextMenu, type MenuEntry } from "../ui/contextMenu";
import { botDisplayName } from "../core/members";
import Reactions, { quickReactions, type ReactionSummary } from "../ui/Reactions";

export interface MessageAuthor extends AvatarUser {
  username: string;
  tag?: string;
  bot?: boolean;
  botType?: string;
  // Shown on hover over the @username (name·tag).
  handle?: string;
}

export default function MessageCard(props: {
  id: string | number;
  // The message box it belongs to (MessageComposer `place`), for editing the last message with Up there.
  place?: string;
  author: MessageAuthor;
  onAuthorMenu?: (e: MouseEvent) => void;
  createdAt: string;
  editedAt?: string | null;
  body: string;
  deleted?: boolean;
  // For mentions in the editor; "" outside servers.
  workspaceId: string;
  mentions?: MentionLookup;
  canEdit: boolean;
  canDelete: boolean;
  // Saves an edit (only called when the text changed) or deletes; errors go to `run`.
  onEdit: (markdown: string) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
  run: (action: Promise<unknown>) => void;
  error?: string;
  // Menu entries before Edit, and after Copy text.
  menuStart?: MenuEntry[];
  menuEnd?: MenuEntry[];
  classList?: Record<string, boolean | undefined>;
  // Runs on from the message above (messaging/grouping.ts): no avatar or name of its own.
  continued?: boolean;
  // The footer has something to read (replies); without it and reactions its buttons only show on hover.
  footerBusy?: boolean;
  // Next to the time (pin, delivery status), and among the hover buttons (pin).
  headerExtra?: JSX.Element;
  actionsExtra?: JSX.Element;
  // Between the header and the text (what a bot did before it answered).
  beforeBody?: JSX.Element;
  // Attachments, polls.
  children?: JSX.Element;
  // Before the reactions (the replies button).
  footer?: JSX.Element;
  reactions?: {
    list: ReactionSummary[];
    me: number | null;
    nameOf: (userId: number) => string;
    onToggle: (code: string) => void;
  };
}) {
  const [editing, setEditing] = createSignal(false);
  // The edit closes at once; a save that fails opens it again with what was typed, so nothing written is lost.
  const [failedEdit, setFailedEdit] = createSignal<string | null>(null);
  const startEdit = () => {
    setFailedEdit(null);
    setEditing(true);
  };
  const [picking, setPicking] = createSignal(false);
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  let card: HTMLElement | undefined;
  createEffect(() => {
    const asked = editRequest();
    if (!asked || asked.place !== props.place || asked.id !== props.id || !props.canEdit) return;
    clearEditRequest();
    startEdit();
    card?.scrollIntoView({ block: "nearest" });
  });

  const menu = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("a, .mw-link-chip, .mw-editor")) return;
    const image = (e.target as HTMLElement).closest<HTMLImageElement>(".chat-image:not(.ghost) img");
    openContextMenu(e, [
      ...(props.menuStart ?? []),
      ...(props.reactions ? [{
        label: "React", icon: "add-reaction", items: [
          ...quickReactions().map(([code, emoji]) => ({ label: `${emoji}  :${code}:`, action: () => props.reactions!.onToggle(code) })),
          "separator" as const,
          { label: "More reactions", icon: "emoji", action: () => setPicking(true) },
        ],
      }] : []),
      ...(props.canEdit ? [{ label: "Edit", icon: "rename", action: startEdit }] : []),
      image
        ? { label: "Copy image", icon: "copy", action: () => void copyImageFrom(image.src).then(() => showToast("Image copied"), () => showToast("That image couldn't be copied.")) }
        : { label: "Copy text", icon: "copy", disabled: !props.body, action: () => void copyText(decodeEmoji(props.body)) },
      ...(props.menuEnd ?? []),
      ...(props.canDelete ? ["separator" as const, { label: "Delete", icon: "delete", danger: true, action: () => setConfirmDelete(true) }] : []),
    ]);
  };
  const save = (markdown: string) => {
    setEditing(false);
    if (markdown.trim() === decodeEmoji(props.body).trim()) return;
    props.run(props.onEdit(markdown).catch((e) => {
      setFailedEdit(markdown);
      setEditing(true);
      throw e;
    }));
  };

  return (
    <Show when={!props.deleted} fallback={
      <article class="chat-message chat-message-deleted mw-box mw-fade-in" data-message-id={props.id}>
        <span />
        <p class="muted">This message was deleted.</p>
      </article>
    }>
      <article class="chat-message mw-box mw-fade-in" data-message-id={props.id} onContextMenu={menu} classList={{ ...props.classList, continued: props.continued }}
        ref={card}>
        <Show when={!props.continued} fallback={
          <time class="chat-gutter-time" datetime={props.createdAt} title={new Date(props.createdAt).toLocaleString()}>{clockTime(props.createdAt)}</time>
        }>
          <span class="chat-avatar" onContextMenu={props.onAuthorMenu}>
            <Avatar user={props.author} size={40} />
          </span>
        </Show>
        <div class="chat-message-main">
          <header class="chat-message-header">
            <Show when={!props.continued}>
              <span class="chat-name" onContextMenu={props.onAuthorMenu}>
                {botDisplayName({ ...props.author, bot: props.author.bot === true, botType: props.author.botType ?? "" })}
                <Show when={props.author.bot}><span class="bot-badge" title="MakeWork bot">makeworker</span></Show>
              </span>
              <span class="chat-handle" title={props.author.handle} onContextMenu={props.onAuthorMenu}>
                @{props.author.username}{props.author.bot ? `#${props.author.tag}` : ""}
              </span>
              <time datetime={props.createdAt} title={new Date(props.createdAt).toLocaleString()}>{clockTime(props.createdAt)}</time>
            </Show>
            <Show when={props.editedAt}>
              {(at) => <span class="chat-edited" title={`Edited ${new Date(at()).toLocaleString()}`}>(edited)</span>}
            </Show>
            {props.headerExtra}
            <Show when={(props.canEdit || props.canDelete || props.actionsExtra) && !editing()}>
              <span class="chat-message-actions">
                {props.actionsExtra}
                <Show when={props.canEdit}>
                  <button class="icon-button" title="Edit" aria-label="Edit message" onClick={startEdit}><Icon name="rename" /></button>
                </Show>
                <Show when={props.canDelete}>
                  <button class="icon-button" title="Delete" aria-label="Delete message" aria-expanded={confirmDelete()}
                    onClick={() => setConfirmDelete(!confirmDelete())}><Icon name="delete" /></button>
                </Show>
              </span>
            </Show>
          </header>
          <ConfirmPrompt open={confirmDelete()} question="Are you sure you want to delete this message?" confirmLabel="Delete"
            onConfirm={() => { setConfirmDelete(false); props.run(props.onDelete()); }}
            onCancel={() => setConfirmDelete(false)} />
          {props.beforeBody}
          <Show when={editing()} fallback={
            <Show when={props.body}>
              <div classList={{ "chat-jumbo": isJumbo(props.body, props.workspaceId) }}>
                <Markdown source={props.body} breaks class="chat-markdown" mentions={props.mentions} workspaceId={props.workspaceId} />
              </div>
            </Show>
          }>
            <div class="chat-edit mw-fade-in">
              <RichEditor workspaceId={props.workspaceId} value={failedEdit() ?? decodeEmoji(props.body)} class="chat-editor"
                ref={(api) => requestAnimationFrame(() => api.focus(true))} onSubmit={save}
                onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), setEditing(false))} />
              <p class="chat-edit-hint muted">Enter to save, Esc to cancel</p>
            </div>
          </Show>
          <Show when={!editing()}>
            <For each={videoEmbeds(props.body)}>{(embed) => <VideoEmbedView embed={embed} />}</For>
          </Show>
          {props.children}
        </div>
        <Show when={props.footer || props.reactions}>
          <footer class="chat-message-footer" classList={{ quiet: !props.footerBusy && !props.reactions?.list.length }}>
            {props.footer}
            <Show when={props.reactions}>
              {(r) => <Reactions reactions={r().list} me={r().me} nameOf={r().nameOf} onToggle={r().onToggle} workspaceId={props.workspaceId} picking={picking()} onPicking={setPicking} />}
            </Show>
          </footer>
        </Show>
        <Show when={props.error}><p class="warning chat-message-error">{props.error}</p></Show>
      </article>
    </Show>
  );
}

// Only emoji-only messages of up to three emoji get the large style.
function isJumbo(source: string, workspaceId?: string): boolean {
  const parts = splitEmoji(source.trim(), workspaceId ? (name) => !!customEmojiByName(workspaceId, name) : undefined);
  return parts.length > 0 && parts.length <= 3 && parts.every((p) => "emoji" in p || "custom" in p || !p.text.trim());
}
