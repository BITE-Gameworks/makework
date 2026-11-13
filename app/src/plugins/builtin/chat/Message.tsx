import { For, Match, Show, Switch, createSignal } from "solid-js";
import { userMessage } from "../../../api/client";
import { fileFromUrl } from "../../../core/files";
import { viewersFor } from "../../registry";
import { formatBytes, relativeTime } from "../../../core/time";
import {
  cancelDownload, cancelSend, contentUrl, getAndOpen, isLocal, refHash, setSynced, transferBar, transferKind, transferLabel,
  uploadAction, uploadToNode,
} from "../../../core/content";
import { Icon } from "../../../theme/icons";
import Avatar from "../../../ui/Avatar";
import type { ChannelContext } from "../../types";
import {
  deleteMessage, editMessage, isMemberEvent, pinMessage, postMessage, react, snippet, vote, type Attachment, type ChatMessage, type Poll,
} from "./data";
import { mentions } from "./mentions";
import { groupMentionsMe, roleBySlug, rolesOf } from "../../../core/roles";
import { copyLink } from "../../../core/links";
import { type MentionLookup } from "../../../markdown/Markdown";
import SharedCard from "../../../messaging/MessageCard";
import { TransferProgress } from "../../../ui/UploadList";
import { handleOf } from "../../../core/userServer";
import { isBlockedMember } from "../../../dm/friends";
import { desktop } from "../../../core/desktop";
import VideoPlayer from "../../../ui/VideoPlayer";
import Popover from "../../../ui/Popover";
import Collapse from "../../../ui/Collapse";
import Disclosure from "../../../ui/Disclosure";
import { PollForm } from "./Composer";
import PartyCard, { partyLinks } from "../../../watch/PartyCard";
import { focusWhenShown } from "../../../ui/focus";

export function MessageCard(props: {
  context: ChannelContext;
  message: ChatMessage;
  place?: string;
  selected?: boolean;
  highlighted?: boolean;
  continued?: boolean;
  onOpenThread?: () => void;
}) {
  const ctx = props.context;
  const author = () => ctx.users.get(props.message.authorId);
  const mine = () => props.message.authorId === ctx.users.me();
  const [error, setError] = createSignal("");
  const [revealed, setRevealed] = createSignal(false);
  const [editingPoll, setEditingPoll] = createSignal(false);
  const [pollEditedAt, setPollEditedAt] = createSignal<string | null>(null);
  const hidden = () => !mine() && !revealed() && isBlockedMember(props.message.authorId);
  const run = (action: Promise<unknown>) => void action.then(() => setError(""), (e) => {
    setError(userMessage(e));
    ctx.playSound("error");
  });
  const pinned = () => props.message.pinnedBy !== null;
  const canPin = () => ctx.can("manage_messages") && !isMemberEvent(props.message);
  const togglePin = () => run(pinMessage(ctx.api, props.message.id, !pinned()));
  const userMenu = (e: MouseEvent) => ctx.openUserMenu(e, props.message.authorId);
  const mentionsMe = () => {
    const me = ctx.users.me();
    return !mine() && me !== null && (mentions(props.message.body, ctx.users.get(me))
      || groupMentionsMe(ctx.workspace.id, props.message.body, props.message.authorId));
  };

  return (
    <Show when={props.message.deleted || !hidden()} fallback={
      <article class="chat-message chat-message-deleted mw-box mw-fade-in" data-message-id={props.message.id} onContextMenu={userMenu}>
        <span />
        <p class="muted">
          Message from someone you blocked. <button class="chat-reveal" onClick={() => setRevealed(true)}>Show</button>
        </p>
      </article>
    }>
      <SharedCard id={props.message.id} place={props.place} author={{ ...author(), handle: handleOf(author()) }} onAuthorMenu={userMenu}
        createdAt={props.message.createdAt} editedAt={props.message.editedAt ?? pollEditedAt()} body={props.message.body} deleted={props.message.deleted}
        workspaceId={ctx.workspace.id} mentions={mentionLookup(ctx)}
        canEdit={mine() && props.message.kind === "message" && !props.message.locked} canDelete={mine() || ctx.can("manage_messages")}
        onEdit={(markdown) => editMessage(ctx.api, props.message.id, markdown)} onDelete={() => deleteMessage(ctx.api, props.message.id)}
        run={run} error={error()}
        beforeBody={<>
          <Show when={props.message.locked}>
            <p class="muted chat-locked"><Icon name="lock" size={14} /> Encrypted. Its key comes from a member who has it, the next time one is online.</p>
          </Show>
          <Show when={props.message.steps.length > 0}><Steps steps={props.message.steps} /></Show>
          <Show when={props.message.threadParent}>
            {(parent) => (
              <button class="chat-thread-parent" title="Open the thread" onClick={() => props.onOpenThread?.()}>
                <Icon name="reply" size={14} /> replied in a thread
                <Show when={parent().authorId !== null}>
                  {" "}to <b>{ctx.users.get(parent().authorId!).displayName}</b>: <span class="muted">{snippet(parent().body, 60)}</span>
                </Show>
              </button>
            )}
          </Show>
        </>}
        continued={props.continued} footerBusy={props.message.replyCount > 0 || !!props.message.threadParent}
        classList={{ selected: props.selected, highlighted: props.highlighted, mentioned: mentionsMe(), "chat-action": props.message.action }}
        menuStart={[
          ...(props.onOpenThread ? [{ label: "Reply in thread", icon: "reply", action: () => props.onOpenThread!() }] : []),
          ...(mine() && props.message.kind === "poll" ? [{ label: "Edit poll", icon: "rename", action: () => setEditingPoll(true) }] : []),
        ]}
        menuEnd={[
          { label: "Copy link", icon: "link", action: () => copyLink(ctx.linkTo({ kind: "message", id: props.message.id })) },
          ...(canPin() ? [{ label: pinned() ? "Unpin" : "Pin message", icon: pinned() ? "unpin" : "pin", action: togglePin }] : []),
        ]}
        headerExtra={
          <Show when={props.message.pinnedBy}>
            {(by) => <span class="chat-pinned" title={`Pinned by ${ctx.users.get(by()).displayName}`}><Icon name="pin" size={14} /></span>}
          </Show>
        }
        actionsExtra={
          <>
            <Show when={mine() && props.message.kind === "poll"}>
              <button class="icon-button" title="Edit poll" aria-label="Edit poll" onClick={() => setEditingPoll(true)}>
                <Icon name="rename" />
              </button>
            </Show>
            <Show when={canPin()}>
              <button class="icon-button" title={pinned() ? "Unpin" : "Pin"} aria-label={pinned() ? "Unpin message" : "Pin message"}
                onClick={togglePin}><Icon name={pinned() ? "unpin" : "pin"} /></button>
            </Show>
          </>
        }
        footer={
          <Show when={props.onOpenThread}>
            <Show when={props.message.replyCount > 0 && props.message.repliers.length > 0}>
              <span class="chat-repliers">
                <For each={props.message.repliers}>{(id) => (
                  <span class="chat-replier" title={ctx.users.get(id).displayName} onContextMenu={(e) => ctx.openUserMenu(e, id)}>
                    <Avatar user={ctx.users.get(id)} size={20} />
                  </span>
                )}</For>
              </span>
            </Show>
            <button class="chat-replies" classList={{ idle: props.message.replyCount === 0 && !props.message.threadParent }} onClick={() => props.onOpenThread?.()}>
              <Show when={props.message.replyCount > 0} fallback={props.message.threadParent ? "view thread" : "reply"}>
                {props.message.replyCount} {props.message.replyCount === 1 ? "reply" : "replies"}{" "}
                <span class="muted">(last {relativeTime(props.message.lastReplyAt)})</span>
              </Show>
            </button>
          </Show>
        }
        reactions={{
          list: props.message.reactions, me: ctx.users.me(), nameOf: (id) => ctx.users.get(id).displayName,
          onToggle: (code) => run(react(ctx.api, props.message.id, code)),
        }}>
        <Show when={props.message.poll}>
          {(poll) => (
            <Show when={editingPoll()} fallback={<PollView context={ctx} poll={poll()} onVote={(id) => run(vote(ctx.api, id))} />}>
              <PollForm context={ctx} threadId={props.message.threadId} messageId={props.message.id} question={props.message.body} poll={poll()}
                onDone={() => {
                  setPollEditedAt(new Date().toISOString());
                  setEditingPoll(false);
                }} />
            </Show>
          )}
        </Show>
        <Show when={props.message.buttons.length > 0}>
          <div class="chat-bot-buttons">
            <For each={props.message.buttons}>{(b) =>
              <BotButton button={b} onSend={(command) => run(postMessage(ctx.api, props.message.channelId, props.message.threadId, `<@${props.message.authorId}> ${command}`, []))} />
            }</For>
          </div>
        </Show>
        <For each={props.message.attachments}>
          {(a) => <AttachmentView context={ctx} attachment={a} mine={mine()} />}
        </For>
        <For each={partyLinks(props.message.body).filter((l) => l.workspaceId === ctx.workspace.id)}>
          {(l) => <PartyCard workspaceId={l.workspaceId} partyId={l.partyId} />}
        </For>
      </SharedCard>
    </Show>
  );
}

// What a bot did before its answer: one line that opens to the operations.
function Steps(props: { steps: string[] }) {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="chat-steps">
      <Disclosure open={open()} onToggle={() => setOpen(!open())}>
        Performed {props.steps.length} {props.steps.length === 1 ? "operation" : "operations"}
      </Disclosure>
      <Collapse open={open()}>
        <ol class="chat-steps-list">
          <For each={props.steps}>{(step) => <li>{step}</li>}</For>
        </ol>
      </Collapse>
    </div>
  );
}

// Shows @username as the member's display name; your own name stands out.
// @username shows the member's name; @everyone, @here and @role_name show as group mentions.
export function mentionLookup(ctx: ChannelContext): MentionLookup {
  return (username) => {
    if (typeof username === "number")
      return { name: ctx.users.get(username).displayName, me: username === ctx.users.me(), openMenu: (e) => ctx.openUserMenu(e, username) };
    const user = ctx.users.list().find((u) => u.username.toLowerCase() === username);
    if (user) return { name: user.displayName, me: user.id === ctx.users.me(), openMenu: (e) => ctx.openUserMenu(e, user.id) };
    if (username === "everyone" || username === "here") return { name: username, me: false, group: true };
    const role = roleBySlug(ctx.workspace.id, username);
    if (!role) return undefined;
    const me = ctx.users.me();
    return { name: String(role.name), me: me !== null && rolesOf(ctx.workspace.id, me).some((r) => r.id === role.id), group: true, color: String(role.color || "") };
  };
}

// Answers as bars filled by their share of the votes; clicking one votes or takes the vote back.
function PollView(props: { context: ChannelContext; poll: Poll; onVote: (optionId: number) => void }) {
  const total = () => props.poll.options.reduce((n, o) => n + o.count, 0);
  const voterIds = () => [...new Set(props.poll.options.flatMap((o) => o.users))];
  const voters = () => voterIds().length;
  const me = () => props.context.users.me() ?? -1;
  const [votersOpen, setVotersOpen] = createSignal(false);
  return (
    <div class="chat-poll">
      <For each={props.poll.options}>
        {(option) => {
          const share = () => (total() ? option.count / total() : 0);
          const mine = () => option.users.includes(me());
          return (
            <button class="chat-poll-option mw-box" classList={{ mine: mine() }} onClick={() => props.onVote(option.id)}
              title={option.users.map((u) => props.context.users.get(u).displayName).join(", ") || "No votes yet"}>
              <span class="chat-poll-bar" style={{ transform: `scaleX(${share()})` }} />
              <span class="chat-poll-check"><Show when={mine()}><Icon name="check" /></Show></span>
              <span class="chat-poll-label">{option.label}</span>
              <span class="chat-poll-count">{option.count} ({Math.round(share() * 100)}%)</span>
            </button>
          );
        }}
      </For>
      <div class="chat-poll-note">
        <div class="mw-popover-anchor">
          <button class="chat-poll-voters" aria-expanded={votersOpen()} onClick={() => setVotersOpen(!votersOpen())}>
            {voters()} {voters() === 1 ? "voter" : "voters"}
          </button>
          <Popover open={votersOpen()} onClose={() => setVotersOpen(false)} label="Poll voters">
            <div class="chat-poll-voter-list mw-scroll-fade">
              <Show when={voterIds().length} fallback={<span class="muted">No votes yet</span>}>
                <For each={voterIds()}>
                  {(id) => {
                    const user = () => props.context.users.get(id);
                    return <span class="chat-poll-voter"><Avatar user={user()} size={24} />{user().displayName}</span>;
                  }}
                </For>
              </Show>
            </div>
          </Popover>
        </div>
        <span>{props.poll.multiple ? "pick any" : "pick one"}</span>
      </div>
    </div>
  );
}

function AttachmentView(props: { context: ChannelContext; attachment: Attachment; mine: boolean }) {
  const a = () => props.attachment;
  const workspaceId = props.context.workspace.id;
  // A running download can be cancelled, and so can what goes out of the user's own attachments: a send to a member,
  // or the upload to a node (running or waiting its turn), which is then held back until they send it on. Cancelling
  // removes nothing: the attachment stays.
  const downloading = () => transferKind(workspaceId, a().url) === "downloading";
  const going = () => (props.mine && !downloading() ? uploadAction(workspaceId, a().url) : undefined);
  const mark = () => ({ kind: "attachment" as const, id: a().id });
  const isImage = () => a().mime.startsWith("image/");
  // Video and audio play in the chat once their content is here; before that they are file cards with Get.
  const isMedia = () => /^(video|audio)\//.test(a().mime);
  const src = () => contentUrl(a().url);
  const open = () => {
    const url = a().url;
    if (url) void getAndOpen(workspaceId, mark(), url, () => props.context.openFile(fileFromUrl(a().name, a().mime, a().size, url)));
  };
  const get = () => setSynced(workspaceId, mark(), true);

  return (
    <>
      <div class="chat-attachment">
        <Show when={!(isMedia() && src())} fallback={
          <div class="chat-media mw-box mw-fade-in" classList={{ audio: a().mime.startsWith("audio/") }}>
            <Show when={a().mime.startsWith("video/")} fallback={
              <>
                <span class="chat-media-name"><Icon name="file" /> {a().name}</span>
                <audio src={src()!} controls preload="metadata" />
              </>
            }>
              <VideoPlayer src={src()!} width={a().width ?? undefined} height={a().height ?? undefined} fallback={
                <Show when={desktop?.openContent && refHash(a().url)}>
                  {(hash) => (
                    <button class="mw-button mw-box" onClick={() => void desktop!.openContent!(hash(), a().name).then((err) => err && console.warn(err))}>
                      <Icon name="play" /> Open in video player
                    </button>
                  )}
                </Show>
              } />
            </Show>
          </div>
        }>
        <Show when={isImage() && (src() || a().thumb)} fallback={<FileCard workspaceId={workspaceId} attachment={a()} onGet={get} onOpen={open} />}>
          <button class="chat-image mw-box mw-fade-in" classList={{ ghost: !src() }}
            title={src() ? `Open ${a().name}` : `${a().name} (${formatBytes(a().size)}): click to download`} onClick={open}>
            <img src={src() ?? a().thumb!} alt={a().name} loading="lazy" width={a().width ?? undefined} height={a().height ?? undefined} />
            <Show when={!src() || status(workspaceId, a())}>
              <span class="chat-image-badge mw-box">
                <Icon name={transferBar(workspaceId, a().url)?.done ? "check" : "download"} /> {status(workspaceId, a()) ?? formatBytes(a().size)}
              </span>
            </Show>
            <TransferProgress bar={transferBar(workspaceId, a().url)} />
          </button>
        </Show>
        </Show>
        <Show when={downloading()}>
          <button class="icon-button chat-transfer-cancel mw-box mw-fade-in" title="Cancel download"
            aria-label={`Cancel downloading ${a().name}`} onClick={() => void cancelDownload(workspaceId, mark(), a().url)}>
            <Icon name="close" />
          </button>
        </Show>
        <Show when={going() === "cancel"}>
          <button class="icon-button chat-transfer-cancel mw-box mw-fade-in" title="Cancel upload"
            aria-label={`Cancel uploading ${a().name}`} onClick={() => cancelSend(workspaceId, a().url)}>
            <Icon name="close" />
          </button>
        </Show>
        <Show when={going() === "resume"}>
          <button class="icon-button chat-transfer-cancel mw-box mw-fade-in" title="Upload to the node"
            aria-label={`Upload ${a().name} to the node`} onClick={() => uploadToNode(workspaceId, a().url, a().size)}>
            <Icon name="upload" />
          </button>
        </Show>
      </div>
    </>
  );
}

function status(workspaceId: string, a: Attachment): string | undefined {
  return transferLabel(workspaceId, a.url);
}

// A file that isn't an image, or an image without content or preview here: details, content on request.
function FileCard(props: { workspaceId: string; attachment: Attachment; onGet: () => void; onOpen: () => void }) {
  const a = () => props.attachment;
  const local = () => isLocal(a().url);
  const viewable = () => !!a().url && viewersFor(a().name, a().mime).length > 0;
  return (
    <div class="chat-file mw-box">
      <Icon name={a().mime.startsWith("image/") ? "image" : "file"} size={28} />
      <div class="chat-file-info">
        <span class="chat-file-name">{a().name}</span>
        <span class="muted">{status(props.workspaceId, a()) ?? `${formatBytes(a().size)} ${a().mime}`}</span>
      </div>
      <TransferProgress bar={transferBar(props.workspaceId, a().url)} />
      <Show when={viewable()}>
        <button class="mw-button mw-box" onClick={() => props.onOpen()}>Open</button>
      </Show>
      <Show when={a().url} fallback={<span class="muted" title="Sent without its content">Not available</span>}>
        <Show when={local()} fallback={
          <button class="mw-button mw-box" onClick={() => props.onGet()}><Icon name="download" /> Get</button>
        }>
          <a class="mw-button mw-box" href={contentUrl(a().url) ?? undefined} download={a().name}><Icon name="download" /> Save</a>
        </Show>
      </Show>
    </div>
  );
}

// "joined", "left" or "was kicked by" notes in the welcome channel.
export function MemberEvent(props: { context: ChannelContext; message: ChatMessage }) {
  const author = () => props.context.users.get(props.message.authorId);
  const kicked = () => {
    try {
      const { user_id, name, ban } = JSON.parse(props.message.body) as { user_id: number; name: string; ban?: boolean };
      return { id: Number(user_id), name: String(name), ban: ban === true };
    } catch {
      return null;
    }
  };
  // A move's body: { from_id, to_id, name } (core/memberMove.ts).
  const moved = () => {
    try {
      const { to_id, name } = JSON.parse(props.message.body) as { to_id: number; name: string };
      return { to: Number(to_id), name: String(name) };
    } catch {
      return null;
    }
  };
  const when = () => relativeTime(props.message.createdAt);
  return (
    <div class="chat-event mw-box mw-fade-in" data-message-id={props.message.id} title={new Date(props.message.createdAt).toLocaleString()}>
      <Switch>
        <Match when={props.message.kind === "kick" && kicked()}>
          {(k) => (
            <>
              <Icon name="sign-out" />
              <span class="chat-name">{k().name}</span>
              <span class="muted">was {k().ban ? "banned" : "kicked"} by</span>
              <span class="chat-name" onContextMenu={(e) => props.context.openUserMenu(e, props.message.authorId)}>{author().displayName}</span>
              <span class="muted">{when()}.</span>
            </>
          )}
        </Match>
        <Match when={props.message.kind === "move" && moved()}>
          {(m) => (
            <>
              <Icon name="profile" />
              <span class="chat-name">{m().name}</span>
              <span class="muted">moved to the account</span>
              <span class="chat-handle" onContextMenu={(e) => props.context.openUserMenu(e, m().to)}>
                {handleOf(props.context.users.get(m().to))}
              </span>
              <span class="muted">{when()}.</span>
            </>
          )}
        </Match>
        <Match when={props.message.kind !== "kick" && props.message.kind !== "move"}>
          <Avatar user={author()} size={24} />
          <span class="chat-handle">@{author().username}</span>
          <span class="chat-name">{author().displayName}</span>
          <span class="muted">{props.message.kind === "leave" ? "left" : "joined"} {when()}.</span>
        </Match>
      </Switch>
    </div>
  );
}

// A bot's button: sends its command, or (input buttons) opens a text box in the message and sends the command with
// what was typed.
function BotButton(props: { button: { label: string; command: string; input?: boolean }; onSend: (command: string) => void }) {
  const [open, setOpen] = createSignal(false);
  const [text, setText] = createSignal("");
  const send = () => {
    if (!text().trim()) return;
    props.onSend(`${props.button.command} ${text().trim()}`);
    setOpen(false);
    setText("");
  };
  return (
    <Show when={props.button.input} fallback={
      <button class="mw-button mw-box" title={props.button.command} onClick={() => props.onSend(props.button.command)}>{props.button.label}</button>
    }>
      <button class="mw-button mw-box" classList={{ active: open() }} aria-expanded={open()} onClick={() => setOpen(!open())}>{props.button.label}</button>
      <Show when={open()}>
        <input class="mw-input mw-box chat-bot-input mw-fade-in" placeholder="Type, then Enter" value={text()} ref={focusWhenShown}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(); else if (e.key === "Escape") setOpen(false); }} />
      </Show>
    </Show>
  );
}