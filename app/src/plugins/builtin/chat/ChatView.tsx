import { For, Match, Show, Switch, createEffect, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import Skeleton from "../../../ui/Skeleton";
import { can as canAnywhere, isMuted } from "../../../core/roles";
import { userMessage } from "../../../api/client";
import { solidMount } from "../../solid";
import type { ChannelContext } from "../../types";
import Composer, { placeOf, type ComposerApi } from "./Composer";
import { DropHint, createFileDrop } from "../../../ui/FileDrop";
import SearchBox from "../../../ui/SearchBox";
import { memberListVisible } from "../../../core/members";
import { memberMatches, parseSearch } from "../../../core/searchQuery";
import { decodeEmoji } from "../../../markdown/emoji";
import { createMessage, createMessages, createPins, getMessage, isMemberEvent, pinMessage, snippet, type ChatMessage } from "./data";
import { relativeTime } from "../../../core/time";
import { Icon } from "../../../theme/icons";
import Avatar from "../../../ui/Avatar";
import { MemberEvent, MessageCard } from "./Message";
import { installScrollPlace, type ScrollPlaceHandle } from "../../../messaging/scrollPlace";
import { createMessageWindow } from "../../../messaging/messageWindow";
import DayDivider from "../../../messaging/DayDivider";
import { continuesFrom, startsNewDay } from "../../../messaging/grouping";
import "./chat.css";

export default function ChatView(props: { context: ChannelContext }) {
  const ctx = props.context;
  const messages = createMessages(ctx.api, ctx.channel.id, () => null);
  const threadKey = (id: number) => `thread:${id}`;
  const threadPanel = (id: number, focus?: number) =>
    solidMount(() => <ThreadPanel context={ctx} parentId={id} focus={focus === undefined ? undefined : { id: focus }} />);
  // A link or a pin opens the thread; its reply button toggles it.
  const showThread = (id: number, focus?: number) => ctx.openSidePanel("Thread", threadPanel(id, focus), threadKey(id));
  const toggleThread = (id: number) => ctx.toggleSidePanel(threadKey(id), "Thread", threadPanel(id));

  // A followed link: scroll to the message, or open the thread it is a reply in.
  const [focus, setFocus] = createSignal<{ id: number } | null>(null);
  createEffect(on(ctx.target, (target) => {
    if (target?.kind !== "message") return;
    void getMessage(ctx.api, Number(target.id)).then((m) => {
      if (m.threadId !== null) showThread(m.threadId, m.id);
      else setFocus({ id: m.id });
    }, () => undefined);
  }));

  const pins = createPins(ctx.api, ctx.channel.id);
  const pinsOpen = () => ctx.isSidePanelOpen("pins");
  const togglePins = () => ctx.toggleSidePanel("pins", "Pinned messages", solidMount(() => (
    <PinnedList context={ctx} pins={pins.value} onOpen={(m) => {
      if (m.threadId !== null) showThread(m.threadId, m.id);
      else setFocus({ id: m.id });
    }} />
  )));

  const searchOpen = () => ctx.isSidePanelOpen("search");
  const toggleSearch = () => ctx.toggleSidePanel("search", "Search messages", solidMount(() => (
    <SearchPanel context={ctx} messages={() => messages.value} onOpen={(m) => setFocus({ id: m.id })} />
  )));

  let composer: ComposerApi | undefined;
  const drop = createFileDrop((data) => composer?.addFiles([...data.files]));

  return (
    <div class="chat" {...drop.on}>
      <div class="chat-tools">
        <button class="chat-pins-bar" classList={{ open: searchOpen() }} aria-pressed={searchOpen()} onClick={toggleSearch}>
          <Icon name="search" size={14} /> Search
        </button>
        <Show when={pins.value.length > 0}>
          <button class="chat-pins-bar mw-fade-in" classList={{ open: pinsOpen() }} aria-pressed={pinsOpen()} onClick={togglePins}>
            <Icon name="pin" size={14} /> {pins.value.length} pinned
          </button>
        </Show>
      </div>
      <MessageList state={messages} context={ctx} empty="No messages yet. Say hello!" focus={focus()}
        scrollKey={`${ctx.workspace.id}:${ctx.channel.id}`}>
        {(m, continued) => {
          // A thread reply also sent here opens its thread.
          const thread = () => m.threadId ?? m.id;
          return <MessageCard context={ctx} message={m} place={placeOf(ctx, null)} continued={continued()} selected={ctx.isSidePanelOpen(threadKey(thread()))} onOpenThread={() => toggleThread(thread())} />;
        }}
      </MessageList>
      <Show when={ctx.can("send_messages")} fallback={<NoSending context={ctx} />}>
        <Composer context={ctx} threadId={null} placeholder={`Message ${ctx.channel.name}`} ref={(api) => (composer = api)}
          messages={() => messages.value} />
      </Show>
      <DropHint show={drop.over() && !!composer} label={`Drop to send in #${ctx.channel.name}`} />
    </div>
  );
}

function ThreadPanel(props: { context: ChannelContext; parentId: number; focus?: { id: number } }) {
  const parent = createMessage(props.context.api, () => props.parentId);
  const replies = createMessages(props.context.api, props.context.channel.id, () => props.parentId);
  let composer: ComposerApi | undefined;
  const drop = createFileDrop((data) => composer?.addFiles([...data.files]));
  return (
    <div class="chat chat-thread" {...drop.on}>
      <MessageList state={replies} context={props.context} empty="No replies yet." focus={props.focus}
        scrollKey={`${props.context.workspace.id}:${props.context.channel.id}:${props.parentId}`}
        header={<Show when={parent.value}>{(p) => <MessageCard context={props.context} message={p()} highlighted />}</Show>}>
        {(m, continued) => <MessageCard context={props.context} message={m} place={placeOf(props.context, props.parentId)} continued={continued()} />}
      </MessageList>
      <Show when={props.context.can("send_messages")} fallback={<NoSending context={props.context} />}>
        <Composer context={props.context} threadId={props.parentId} placeholder="Reply in thread" ref={(api) => (composer = api)}
          messages={() => replies.value} />
      </Show>
      <DropHint show={drop.over() && !!composer} label="Drop to reply with it" />
    </div>
  );
}

// Opens at the newest message and follows new ones while the reader is there; stays put while they read history.
// Coming back to the list returns to their reading place (scrollPlace.ts). A long history shows in pieces
// (messageWindow.ts).
function MessageList(props: {
  state: { value: ChatMessage[]; loaded: boolean; error: unknown };
  context: ChannelContext;
  empty: string;
  header?: JSX.Element;
  // A message to scroll to and flash once it is loaded; a new object each time.
  focus?: { id: number } | null;
  scrollKey: string;
  children: (message: ChatMessage, continued: () => boolean) => JSX.Element;
}) {
  let scroller!: HTMLDivElement;
  let list!: HTMLDivElement;
  let top!: HTMLDivElement;
  let scroll: ScrollPlaceHandle | undefined;
  const shown = createMessageWindow(() => props.state.value, props.scrollKey);

  onMount(() => {
    scroll = installScrollPlace({
      key: props.scrollKey, scroller, content: list, isReady: () => props.state.loaded,
      isSettled: () => props.state.loaded && !shown.filling(), active: () => props.context.active(),
      onReaderUp: shown.readerUp,
    });
    const stopWatching = shown.watch(top, scroller);
    onCleanup(() => {
      stopWatching();
      scroll?.dispose();
    });
  });

  let focused: { id: number } | null | undefined;
  createEffect(() => {
    const target = props.focus;
    if (!target || target === focused || !props.state.loaded || !props.state.value.some((m) => m.id === target.id)) return;
    focused = target;
    const id = target.id;
    const message = props.state.value.find((m) => m.id === id);
    if (message) shown.reveal(message);
    scroll?.jump(() => {
      const card = scroller.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
      if (!card) return;
      card.scrollIntoView({ block: "center", behavior: "auto" });
      card.classList.remove("flash");
      void card.offsetWidth;
      card.classList.add("flash");
    });
  });

  // Loaded is set after the first messages arrive, so both are watched.
  createEffect(on(() => [props.state.value.length, props.state.loaded], () => scroll?.onChange()));

  return (
    <div class="chat-scroll mw-scroll-fade" ref={scroller}>
      <div class="chat-list" ref={list} role="log" aria-label="Messages">
        {/* Wrapped so the thread's parent, loaded on its own, never becomes the reading place (scrollPlace.ts). */}
        <div class="chat-list-header">{props.header}</div>
        <div class="chat-older" ref={top} aria-hidden="true" />
        <Switch>
          <Match when={props.state.error}>
            <p class="warning chat-note">{userMessage(props.state.error)}</p>
          </Match>
          <Match when={!props.state.loaded}><Skeleton kind="messages" header={false} /></Match>
          <Match when={props.state.loaded}>
            <For each={shown.shown()}>
              {(m, i) => {
                const previous = () => shown.shown()[i() - 1];
                const plain = (x: ChatMessage) => !isMemberEvent(x) && x.kind === "message" && !x.deleted && !x.threadParent;
                const continued = () => plain(m) && !!previous() && plain(previous()) && continuesFrom(previous(), m);
                return (
                  <>
                    <Show when={startsNewDay(previous(), m.createdAt)}><DayDivider at={m.createdAt} /></Show>
                    {isMemberEvent(m) ? <MemberEvent context={props.context} message={m} /> : props.children(m, continued)}
                  </>
                );
              }}
            </For>
            <div class="chat-end mw-box">{props.state.value.length ? "End of conversation." : props.empty}</div>
          </Match>
        </Switch>
      </div>
    </div>
  );
}

function NoSending(props: { context: ChannelContext }) {
  const me = props.context.users.me();
  const muted = me !== null && isMuted(props.context.workspace.id, me, "chat");
  return (
    <p class="chat-no-sending muted">
      {muted ? "A moderator muted you in chat on this workspace."
        : canAnywhere(props.context.workspace.id, "send_messages") ? "This channel is read-only for you."
        : `You don't have the "Send messages" permission in this workspace.`}
    </p>
  );
}

// The channel's pinned messages in the side panel; clicking one shows it in the channel.
function PinnedList(props: { context: ChannelContext; pins: ChatMessage[]; onOpen: (message: ChatMessage) => void }) {
  const ctx = props.context;
  return (
    <ul class="chat-pins">
      <For each={props.pins} fallback={<li class="muted">Nothing is pinned.</li>}>
        {(m) => {
          const author = () => ctx.users.get(m.authorId);
          return (
            <li class="chat-pin mw-box">
              <button class="chat-pin-open" onClick={() => props.onOpen(m)} title="Show in the channel">
                <Avatar user={author()} size={24} />
                <span class="chat-pin-text">
                  <span><strong>{author().displayName}</strong> <span class="muted">{relativeTime(m.createdAt)}</span></span>
                  <span>{snippet(m.body, 140)}</span>
                </span>
              </button>
              <Show when={ctx.can("manage_messages")}>
                <button class="icon-button" title="Unpin" aria-label="Unpin message" onClick={() => void pinMessage(ctx.api, m.id, false)}>
                  <Icon name="unpin" />
                </button>
              </Show>
            </li>
          );
        }}
      </For>
    </ul>
  );
}

// Finds messages of the channel by their text, attachment names or author; clicking one shows it in the channel.
function SearchPanel(props: { context: ChannelContext; messages: () => ChatMessage[]; onOpen: (message: ChatMessage) => void }) {
  const ctx = props.context;
  const [query, setQuery] = createSignal("");
  const found = () => {
    const q = parseSearch(query());
    if (q.words.length + q.authors.length === 0) return [];
    const people = memberListVisible(ctx.workspace.id);
    const list: ChatMessage[] = [];
    for (let i = props.messages().length - 1; i >= 0 && list.length < 100; i--) {
      const m = props.messages()[i];
      if (m.deleted || m.kind !== "message") continue;
      const text = `${decodeEmoji(m.body)} ${m.attachments.map((a) => a.name).join(" ")} ${ctx.users.get(m.authorId).displayName}`.toLowerCase();
      const byAuthors = q.authors.every((a) => people.some((p) => p.id === m.authorId && memberMatches(p, a)));
      if (byAuthors && q.words.every((w) => text.includes(w))) list.push(m);
    }
    return list;
  };
  return (
    <div class="chat-search">
      <SearchBox workspaceId={ctx.workspace.id} value={query()} onInput={setQuery} operators={["by"]} focusOnShow
        placeholder="Search this channel, or by:member" label="Search messages" />
      <ul class="chat-pins mw-scroll-fade">
        <For each={found()} fallback={<li class="muted">{query().trim() ? "No messages found." : "Type to search this channel's messages. Use by:member to narrow it."}</li>}>
          {(m) => {
            const author = () => ctx.users.get(m.authorId);
            return (
              <li class="chat-pin mw-box">
                <button class="chat-pin-open" onClick={() => props.onOpen(m)} title="Show in the channel">
                  <Avatar user={author()} size={24} />
                  <span class="chat-pin-text">
                    <span><strong>{author().displayName}</strong> <span class="muted">{relativeTime(m.createdAt)}</span></span>
                    <span>{snippet(m.body, 140)}</span>
                  </span>
                </button>
              </li>
            );
          }}
        </For>
      </ul>
    </div>
  );
}
