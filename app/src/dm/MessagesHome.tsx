// Private messages in the shell: a button at the top of the workspace bar, the conversations in the channel bar and
// the open conversation in the main view (dm/messages.ts does the work).
import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { account } from "../core/account";
import { contentRef, contentUrl } from "../core/content";
import { fileFromUrl, openFile } from "../core/files";
import { current, messagesHome, openConversation, openFriends, openInNewTab } from "../core/navigation";
import { formatBytes } from "../core/time";
import { closeOverlays } from "../core/ui";
import { hostOf } from "../core/userServer";
import MessageComposer, { type ComposerApi } from "../messaging/MessageComposer";
import SharedCard from "../messaging/MessageCard";
import { installScrollPlace, type ScrollPlaceHandle } from "../messaging/scrollPlace";
import { createMessageWindow } from "../messaging/messageWindow";
import DayDivider from "../messaging/DayDivider";
import { continuesFrom, startsNewDay } from "../messaging/grouping";
import { playSound } from "../theme/sounds";
import { DropHint, createFileDrop } from "../ui/FileDrop";
import { encodeEmoji } from "../markdown/emoji";
import { Icon } from "../theme/icons";
import Avatar from "../ui/Avatar";
import StatusDot from "../ui/StatusDot";
import { openContextMenu, type MenuEntry } from "../ui/contextMenu";
import { ProgressBar } from "../ui/UploadList";
import { ConfirmItem } from "../shell/channelMenu";
import { personEntries } from "../shell/personEntries";
import FriendsPage from "./FriendsPage";
import { addNote, deleteNote, editNote, loadNotes, notes, notesError, notesPeer, syncNotes, type Note } from "./notes";
import { askedBy, askedThem, changeFriend, isBlocked, isFriend, requestCount } from "./friends";
import {
  appearsStatus, closeConversationLink, conversation, conversations, deleteConversation, deleteMessage, downloadAttachment, editMessage, isOnline,
  linkOf, loadMessages, markRead, messagesBlocked, messagesWith, react, retry, sendMessage, startConversation, unreadTotal, type Attachment, type Conversation,
  type DmMessage,
} from "./messages";
import "../plugins/builtin/views.css";
import "../plugins/builtin/chat/chat.css";
import "./dm.css";
import { focusWhenShown } from "../ui/focus";

export const showingMessages = () => current()?.workspaceId === messagesHome;

export function MessagesButton() {
  return (
    <button class="workspace-button messages-button mw-box" classList={{ active: showingMessages(), unread: !showingMessages() && unreadTotal() > 0 }}
      title="Private messages" aria-label="Private messages" aria-current={showingMessages() ? "page" : undefined}
      onClick={() => {
        closeOverlays();
        openConversation();
      }}>
      <Icon name="messages" size={22} />
      <Show when={unreadTotal() + requestCount()}>
        {(count) => <span class="mention-badge workspace-mentions mw-fade-in" aria-label={`${count()} unread messages and friend requests`}>{count()}</span>}
      </Show>
    </button>
  );
}

// The channel bar while private messages show.
export function ConversationList() {
  loadNotes();
  const [adding, setAdding] = createSignal(false);
  const [name, setName] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  const start = async (e: SubmitEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await startConversation(name());
      setName("");
      setAdding(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="workspace-channels">
      <header class="channel-bar-header" data-drag-region /* lint-allow: the channel bar's header */>
        <h1 data-drag-region /* lint-allow: the channel bar's header */>Messages</h1>
        <button class="icon-button" classList={{ on: adding() }} title="New message" aria-label="New message" aria-expanded={adding()}
          onClick={() => setAdding(!adding())}>
          <Icon name="add" />
        </button>
      </header>
      <Show when={adding()}>
        <form class="dm-new mw-fade-in" onSubmit={start}>
          <input class="mw-input mw-box" placeholder="Email or name·tag" aria-label="Email or name with tag to message" spellcheck={false} ref={focusWhenShown}
            value={name()} onInput={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Escape" && setAdding(false)} />
          <button type="submit" class="mw-button primary mw-box" disabled={busy() || !name().trim()}>Start</button>
        </form>
        <Show when={error()}><p class="warning dm-note">{error()}</p></Show>
      </Show>
      <Show when={messagesBlocked()}>{(why) => <p class="warning dm-note">{why()}</p>}</Show>
      <button class="dm-row dm-friends-row mw-box" classList={{ active: showingMessages() && !current()?.peer }}
        aria-current={showingMessages() && !current()?.peer ? "page" : undefined}
        onClick={() => {
          closeOverlays();
          openFriends();
        }}>
        <Icon name="profile" size={22} />
        <span class="dm-row-text"><span class="dm-row-name">Friends</span></span>
        <Show when={requestCount()}>
          {(count) => <span class="mention-badge mw-box mw-fade-in" title={`${count()} friend requests`}>{count()}</span>}
        </Show>
      </button>
      <button class="dm-row dm-friends-row mw-box" classList={{ active: showingMessages() && current()?.peer === notesPeer }}
        aria-current={showingMessages() && current()?.peer === notesPeer ? "page" : undefined}
        onClick={() => {
          closeOverlays();
          openConversation(notesPeer);
        }}>
        <Icon name="notes" size={22} />
        <span class="dm-row-text">
          <span class="dm-row-name">Notes</span>
          <Show when={notes().at(-1)}>{(last) => <span class="dm-row-last">{last().text}</span>}</Show>
        </span>
      </button>
      <div class="dm-list mw-scroll-fade">
        <For each={conversations()} fallback={
          <p class="channel-bar-note">No conversations yet. Press + and enter someone's email or name·tag (like ada·4f2a) on {hostOf()}.</p>
        }>
          {(c) => <ConversationRow conversation={c} />}
        </For>
      </div>
    </div>
  );
}

function ConversationRow(props: { conversation: Conversation }) {
  const c = () => props.conversation;
  const active = () => showingMessages() && current()?.peer === c().id;
  const menu = (e: MouseEvent) => openContextMenu(e, personMenu(c()));
  return (
    <button class="dm-row mw-box" classList={{ active: active(), unread: c().unread > 0 }} aria-current={active() ? "page" : undefined}
      onContextMenu={menu}
      onAuxClick={(e) => e.button === 1 && openInNewTab({ workspaceId: messagesHome, channelId: null, peer: c().id })}
      onMouseDown={(e) => e.button === 1 && e.preventDefault()}
      onClick={(e) => {
        closeOverlays();
        if (e.ctrlKey || e.metaKey) openInNewTab({ workspaceId: messagesHome, channelId: null, peer: c().id });
        else openConversation(c().id);
      }}>
      <span class="dm-row-avatar">
        <Avatar user={c()} size={32} />
        <StatusDot status={appearsStatus(c().id)} />
      </span>
      <span class="dm-row-text">
        <span class="dm-row-name">{c().displayName}</span>
        <span class="dm-row-last">{c().lastText || `@${c().username}`}</span>
      </span>
      <Show when={c().unread}>
        {(count) => <span class="mention-badge mw-box mw-fade-in" title={`${count()} unread`}>{count()}</span>}
      </Show>
    </button>
  );
}

// Friend, block and report actions for someone you have a conversation with (row menu, conversation header).
function personMenu(c: Conversation): MenuEntry[] {
  return [
    ...personEntries(c.id, c.displayName, { onBlocked: () => closeConversationLink(c.id) }),
    "separator" as const,
    {
      render: () => (
        <ConfirmItem label="Delete conversation" icon="delete" confirmLabel="Delete"
          question={`Delete your conversation with ${c.displayName} from this computer? They keep their copy.`}
          onConfirm={() => deleteConversation(c.id)} />
      ),
    },
  ];
}

// The main view while private messages show: a conversation, else the friends page.
export function MessagesView() {
  const peer = () => current()?.peer;
  return (
    <Show when={peer() !== notesPeer} fallback={<NotesView />}>
      <Show when={conversation(peer())} keyed fallback={<FriendsPage />}>
        {(c) => <ConversationView conversation={c} />}
      </Show>
    </Show>
  );
}

// Your notes: a conversation with yourself.
function NotesView() {
  let scroller!: HTMLDivElement;
  let list!: HTMLDivElement;
  let top!: HTMLDivElement;
  let scroll: ScrollPlaceHandle | undefined;
  loadNotes();
  const key = `dm:${account()!.id}:${notesPeer}`;
  const shown = createMessageWindow(notes, key);
  const onFocus = () => void syncNotes();
  onMount(() => {
    window.addEventListener("focus", onFocus);
    scroll = installScrollPlace({ key, scroller, content: list, isReady: () => true, onReaderUp: shown.readerUp });
    const stopWatching = shown.watch(top, scroller);
    onCleanup(() => {
      window.removeEventListener("focus", onFocus);
      stopWatching();
      scroll?.dispose();
    });
  });
  createEffect(on(() => notes().length, () => scroll?.onChange()));

  return (
    <div class="chat dm-view">
      <header class="view-header dm-header">
        <Icon name="notes" size={22} />
        <h2 class="view-title">Notes <span class="dm-handle">only you can read these</span></h2>
      </header>
      <Show when={notesError()}>{(why) => <p class="warning dm-note">{why()}</p>}</Show>
      <div class="chat-scroll mw-scroll-fade" ref={scroller}>
        <div class="chat-list" ref={list}>
          <div class="chat-older" ref={top} aria-hidden="true" />
          <For each={shown.shown()}>{(n) => <NoteCard note={n} />}</For>
          <Show when={notes().length === 0}>
            <div class="chat-end mw-box">Write anything down here. Your notes are encrypted so only your account can read them, and they
              follow you to your other computers.</div>
          </Show>
        </div>
      </div>
      <MessageComposer place={`dm:${notesPeer}`} workspaceId="" placeholder="Write a note" noFiles
        lastOwn={() => notes().at(-1)?.id}
        send={(markdown) => addNote(encodeEmoji(markdown.trim()))} />
    </div>
  );
}

// A card's own actions (edit, delete, react): a failure shows under the card, with the error sound.
const showingFailure = (setError: (text: string) => void) => (action: Promise<unknown>) => void action.then(() => setError(""), (e) => {
  setError(e instanceof Error ? e.message : String(e));
  playSound("error");
});

function NoteCard(props: { note: Note }) {
  const n = () => props.note;
  const [error, setError] = createSignal("");
  const run = showingFailure(setError);
  return (
    <SharedCard id={n().id} place={`dm:${notesPeer}`} author={account()!} createdAt={new Date(n().at).toISOString()}
      editedAt={n().editedAt ? new Date(n().editedAt!).toISOString() : null} body={n().text}
      workspaceId="" canEdit canDelete
      onEdit={(markdown) => editNote(n().id, encodeEmoji(markdown.trim()))} onDelete={() => deleteNote(n().id)}
      run={run} error={error()}
      headerExtra={<Show when={n().pending}>
        <span class="dm-status muted" title="Not on your other computers yet"><Icon name="history" size={14} /></span>
      </Show>} />
  );
}

function ConversationView(props: { conversation: Conversation }) {
  const c = props.conversation;
  let scroller!: HTMLDivElement;
  let list!: HTMLDivElement;
  let top!: HTMLDivElement;
  let scroll: ScrollPlaceHandle | undefined;
  void loadMessages(c.id);
  const messages = () => messagesWith(c.id);
  const key = `dm:${account()!.id}:${c.id}`;
  const shown = createMessageWindow(() => messages() ?? [], key);

  const read = () => document.hasFocus() && markRead(c.id);
  createEffect(on(() => [messages()?.length, c.unread], read));
  onMount(() => window.addEventListener("focus", read));
  onCleanup(() => window.removeEventListener("focus", read));

  onMount(() => {
    scroll = installScrollPlace({
      key, scroller, content: list, isReady: () => messages() !== undefined,
      isSettled: () => messages() !== undefined && !shown.filling(), onReaderUp: shown.readerUp,
    });
    const stopWatching = shown.watch(top, scroller);
    onCleanup(() => {
      stopWatching();
      scroll?.dispose();
    });
  });

  // Comes back to the reading place the conversation was left at, else starts at the newest.
  createEffect(on(() => [messages()?.length, messages() !== undefined], () => scroll?.onChange()));

  let composer: ComposerApi | undefined;
  const drop = createFileDrop((data) => composer?.addFiles([...data.files]));

  return (
    <div class="chat dm-view" {...drop.on}>
      <header class="view-header dm-header">
        <span class="dm-row-avatar">
          <Avatar user={c} size={28} />
          <StatusDot status={appearsStatus(c.id)} />
        </span>
        <h2 class="view-title">{c.displayName} <span class="dm-handle">@{c.username} · {
          appearsStatus(c.id) === "dnd" ? "Do not disturb" : appearsStatus(c.id) ?? "offline"
        }</span></h2>
        <Show when={!isFriend(c.id) && !isBlocked(c.id)}>
          <button class="mw-button mw-box" disabled={askedThem(c.id)}
            onClick={() => void changeFriend(askedBy(c.id) ? "accept" : "request", c.id).catch((e) => console.warn(e))}>
            <Icon name={askedBy(c.id) ? "check" : "add"} /> {askedBy(c.id) ? "Accept friend request" : askedThem(c.id) ? "Request sent" : "Add friend"}
          </button>
        </Show>
        <button class="icon-button" title="More" aria-label="More" onClick={(e) => openContextMenu(e, personMenu(c))}>
          <Icon name="more" />
        </button>
      </header>
      <div class="chat-scroll mw-scroll-fade" ref={scroller}>
        <div class="chat-list" ref={list}>
          <div class="chat-older" ref={top} aria-hidden="true" />
          <For each={shown.shown()}>
            {(m, i) => {
              const entry = (x: DmMessage) => ({ authorId: x.mine, createdAt: new Date(x.at).toISOString() });
              const previous = () => shown.shown()[i() - 1];
              const at = () => entry(m).createdAt;
              return (
                <>
                  <Show when={startsNewDay(previous() && entry(previous()), at())}><DayDivider at={at()} /></Show>
                  <MessageCard conversation={c} message={m} continued={!!previous() && !previous().deleted && !m.deleted && continuesFrom(entry(previous()), entry(m))} />
                </>
              );
            }}
          </For>
          <Show when={messages()?.length === 0}>
            <div class="chat-end mw-box">This is the start of your conversation with {c.displayName}.</div>
          </Show>
        </div>
      </div>
      <Composer conversation={c} ref={(api) => (composer = api)} />
      <DropHint show={drop.over() && !!composer} label={`Drop to send to ${c.displayName}`} />
    </div>
  );
}

function MessageCard(props: { conversation: Conversation; message: DmMessage; continued: boolean }) {
  const m = () => props.message;
  const author = () => (m().mine ? account()! : props.conversation);
  const [error, setError] = createSignal("");
  const run = showingFailure(setError);
  // Reactions count people: you are 1, they are 2.
  const reactions = () => Object.entries(m().reactions ?? {}).map(([code, by]) => ({
    code, count: by.length, users: by.map((id) => (id === props.conversation.id ? 2 : 1)),
  }));
  return (
    <SharedCard id={m().id} place={`dm:${props.conversation.id}`} author={author()} createdAt={new Date(m().at).toISOString()}
      editedAt={m().editedAt ? new Date(m().editedAt!).toISOString() : null} body={m().text} deleted={m().deleted}
      workspaceId="" canEdit={m().mine && m().status !== "failed"} canDelete={m().mine && m().status !== "failed"}
      onEdit={(markdown) => editMessage(m(), encodeEmoji(markdown.trim()))} onDelete={() => deleteMessage(m())}
      run={run} error={error()} continued={props.continued} classList={{ "dm-failed": m().status === "failed" }}
      headerExtra={<Show when={m().mine}><Status message={m()} /></Show>}
      reactions={{
        list: reactions(), me: 1, nameOf: (id) => (id === 2 ? props.conversation.displayName : account()?.displayName ?? ""),
        onToggle: (code) => run(react(m(), code)),
      }}>
      <For each={m().attachments}>
        {(a) => <AttachmentView peer={props.conversation.id} attachment={a} mine={m().mine} />}
      </For>
    </SharedCard>
  );
}

const statusText: Record<DmMessage["status"], string> = {
  sending: "Sending...",
  waiting: "Waiting for them to come online",
  delivered: "Delivered",
  received: "",
  failed: "Not sent",
};

function Status(props: { message: DmMessage }) {
  return (
    <Show when={props.message.status === "failed"} fallback={
      <span class="dm-status muted" title={statusText[props.message.status]}>
        <Icon name={props.message.status === "delivered" ? "check" : "history"} size={14} />
      </span>
    }>
      <span class="dm-retry">
        {props.message.error ?? "Not sent."}{" "}
        <button class="auth-link" onClick={() => void retry(props.message)}>Try again</button>
      </span>
    </Show>
  );
}

// Attachments stay on the sender's computer: the recipient sees the preview and downloads the file from the
// sender while both are online.
function AttachmentView(props: { peer: string; attachment: Attachment; mine: boolean }) {
  const a = () => props.attachment;
  const ref = () => contentRef(a().hash);
  const src = () => contentUrl(ref());
  const isImage = () => a().type.startsWith("image/");
  const [error, setError] = createSignal("");
  const progress = () => linkOf(props.peer)?.streams.progress(a().hash);
  const download = async () => {
    setError("");
    setError(await downloadAttachment(props.peer, a()));
  };
  const open = () => openFile(fileFromUrl(a().name, a().type, a().size, ref()));

  return (
    <div class="chat-attachment">
      <Show when={isImage() && (src() || a().thumb)} fallback={
        <div class="chat-file mw-box">
          <Icon name={isImage() ? "image" : "file"} size={28} />
          <div class="chat-file-info">
            <span class="chat-file-name">{a().name}</span>
            <span class="muted">{formatBytes(a().size)} {a().type}</span>
          </div>
          <Show when={src()} fallback={
            <button class="mw-button mw-box" disabled={!isOnline(props.peer) || progress() !== undefined} onClick={() => void download()}
              title={isOnline(props.peer) ? undefined : "Both of you must be online"}>
              <Icon name="download" /> Get
            </button>
          }>
            <button class="mw-button mw-box" onClick={open}>Open</button>
            <a class="mw-button mw-box" href={src()!} download={a().name}><Icon name="download" /> Save</a>
          </Show>
        </div>
      }>
        <button class="chat-image mw-box mw-fade-in" classList={{ ghost: !src() }}
          title={src() ? `Open ${a().name}` : `${a().name} (${formatBytes(a().size)}): click to download`}
          onClick={() => (src() ? open() : void download())}>
          <img src={src() ?? a().thumb!} alt={a().name} loading="lazy" width={a().width ?? undefined} height={a().height ?? undefined} />
          <Show when={!src()}>
            <span class="chat-image-badge mw-box">
              <Icon name="download" /> {isOnline(props.peer) || props.mine ? formatBytes(a().size) : "Sender offline"}
            </span>
          </Show>
        </button>
      </Show>
      <Show when={progress()}>{(p) => <ProgressBar value={p()} label={`Downloading ${a().name}`} />}</Show>
      <Show when={error()}><p class="warning">{error()}</p></Show>
    </div>
  );
}

function Composer(props: { conversation: Conversation; ref: (api: ComposerApi) => void }) {
  return (
    <MessageComposer place={`dm:${props.conversation.id}`} workspaceId="" placeholder={`Message ${props.conversation.displayName}`}
      ref={props.ref} lastOwn={() => [...(messagesWith(props.conversation.id) ?? [])].reverse()
        .find((m) => m.mine && !m.deleted && m.status !== "failed")?.id}
      send={(markdown, uploads) => sendMessage(props.conversation.id, encodeEmoji(markdown.trim()), uploads)}
      unavailable={messagesBlocked() ?? (isBlocked(props.conversation.id)
        ? `You blocked @${props.conversation.username}. Unblock them to send messages.` : null)} />
  );
}
