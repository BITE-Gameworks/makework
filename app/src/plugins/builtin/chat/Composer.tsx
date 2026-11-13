import { For, Index, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { userMessage } from "../../../api/client";
import { sendTyping } from "../../../core/typing";
import { isNode } from "../../../core/nodes";
import MessageComposer, { type ComposerApi } from "../../../messaging/MessageComposer";
import { decodeEmoji } from "../../../markdown/emoji";
import { Icon } from "../../../theme/icons";
import Avatar from "../../../ui/Avatar";
import Collapse from "../../../ui/Collapse";
import type { ChannelContext, UserInfo } from "../../types";
import { editPoll, postMessage, postPoll, type ChatMessage, type Poll, type PollOptionInput } from "./data";

export type { ComposerApi };

// The message box's place: where its uploads, draft and Up-to-edit belong.
export const placeOf = (ctx: ChannelContext, threadId: number | null) => `${ctx.workspace.id}:${ctx.channel.id}:${threadId ?? ""}`;

// Your last message in a list that can still be edited.
export function lastOwn(ctx: ChannelContext, messages: ChatMessage[]): number | undefined {
  const me = ctx.users.me();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.authorId === me && m.kind === "message" && !m.deleted) return m.id;
  }
  return undefined;
}

// The shared message box (messaging/MessageComposer) with polls and "... is typing" for this channel.
export default function Composer(props: {
  context: ChannelContext; threadId: number | null; placeholder: string; ref?: (api: ComposerApi) => void;
  messages: () => ChatMessage[];
}) {
  const [polling, setPolling] = createSignal(false);
  const [inChannel, setInChannel] = createSignal(false);

  // While writing, other members see "... is typing" (unless switched off in Settings > Account). It stops
  // on send, after a few seconds without typing, or when the composer goes.
  const typingIn = props.threadId ?? 0;
  let typingTimer: ReturnType<typeof setTimeout> | undefined;
  const stopTyping = () => {
    if (typingTimer === undefined) return;
    clearTimeout(typingTimer);
    typingTimer = undefined;
    props.context.presence.set(null);
  };
  const typed = (markdown: string) => {
    if (!sendTyping() || !markdown.trim()) return stopTyping();
    if (typingTimer === undefined) props.context.presence.set({ typing: typingIn });
    clearTimeout(typingTimer);
    typingTimer = setTimeout(stopTyping, 5000);
  };
  onCleanup(stopTyping);

  return (
    <MessageComposer place={placeOf(props.context, props.threadId)} lastOwn={() => lastOwn(props.context, props.messages())}
      workspaceId={props.context.workspace.id} placeholder={props.placeholder} ref={props.ref}
      send={async (markdown, uploads) => {
        await postMessage(props.context.api, props.context.channel.id, props.threadId, markdown, uploads, inChannel());
      }}
      onInput={typed} onSent={stopTyping}
      actions={
        <button type="button" class="icon-button" classList={{ on: polling() }} title="Poll" aria-label="Create a poll"
          onClick={() => setPolling(!polling())}>
          <Icon name="poll" />
        </button>
      }
      below={
        <Show when={props.threadId !== null}>
          <label class="chat-in-channel">
            <input type="checkbox" checked={inChannel()} onChange={(e) => setInChannel(e.currentTarget.checked)} />
            Also send in #{props.context.channel.name}
          </label>
        </Show>
      }
      above={
        <>
          <TypingLine context={props.context} threadId={props.threadId} />
          <Collapse open={polling()}>
            <PollForm context={props.context} threadId={props.threadId} onDone={() => setPolling(false)} />
          </Collapse>
        </>
      } />
  );
}

function TypingLine(props: { context: ChannelContext; threadId: number | null }) {
  const names = () => props.context.presence.others()
    .filter((p) => typeof p.state === "object" && p.state !== null && !Array.isArray(p.state) && p.state.typing === (props.threadId ?? 0))
    .filter((p) => !isNode(props.context.workspace.id, p.userId))
    .map((p) => props.context.users.get(p.userId));
  const text = () => {
    const people = names().filter((u) => !u.bot).map((u) => u.displayName);
    const bots = names().filter((u) => u.bot).map((u) => u.displayName);
    const part = (n: string[], one: string, many: string) =>
      n.length === 0 ? "" : n.length === 1 ? `${n[0]} ${one}` : n.length <= 3 ? `${n.slice(0, -1).join(", ")} and ${n.at(-1)} ${many}` : "";
    const typing = people.length > 3 ? "Several people are typing" : part(people, "is typing", "are typing");
    const working = bots.length > 3 ? "Several agents are working" : part(bots, "is working", "are working");
    return people.length + bots.length === 0 ? "" : `${[typing, working].filter(Boolean).join(", ")}...`;
  };
  // The bots that are working, kept while the line fades out.
  const [bots, setBots] = createSignal<UserInfo[]>([]);
  createEffect(() => { const now = names().filter((u) => u.bot); if (now.length) setBots(now); });
  const workingBots = () => bots();
  // Keeps the last text while it fades out.
  const [shown, setShown] = createSignal("");
  createEffect(() => text() && setShown(text()));
  return (
    <Collapse open={!!text()}>
      <p class="chat-typing" classList={{ visible: !!text() }} aria-live="polite">
        <span class="chat-typing-bots">
          <For each={workingBots()}>{(user) => <Avatar user={user} size={24} />}</For>
        </span>
        <span class="chat-typing-dots" aria-hidden="true"><span /><span /><span /></span>
        {shown()}
      </p>
    </Collapse>
  );
}

export function PollForm(props: {
  context: ChannelContext; threadId: number | null; onDone: () => void;
  messageId?: number; question?: string; poll?: Poll;
}) {
  const editing = () => props.messageId !== undefined;
  const [question, setQuestion] = createSignal(props.question ? decodeEmoji(props.question) : "");
  const [options, setOptions] = createSignal<PollOptionInput[]>(
    props.poll ? props.poll.options.map((option) => ({ id: option.id, label: decodeEmoji(option.label) })) : [{ label: "" }, { label: "" }],
  );
  const [multiple, setMultiple] = createSignal(props.poll?.multiple ?? false);
  const [error, setError] = createSignal("");
  const filled = () => options().map((option) => ({ ...option, label: option.label.trim() })).filter((option) => Boolean(option.label));

  // A new empty answer appears once the last one is filled, up to 10.
  const setOption = (i: number, value: string) => {
    const next = options().map((option, j) => (j === i ? { ...option, label: value } : option));
    if (i === next.length - 1 && value.trim() && next.length < 10) next.push({ label: "" });
    setOptions(next);
  };

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    try {
      if (editing()) await editPoll(props.context.api, props.messageId!, question().trim(), filled(), multiple());
      else await postPoll(props.context.api, props.context.channel.id, props.threadId, question().trim(), filled().map((option) => option.label), multiple());
      setQuestion("");
      setOptions([{ label: "" }, { label: "" }]);
      setMultiple(false);
      setError("");
      props.onDone();
    } catch (err) {
      setError(userMessage(err));
      props.context.playSound("error");
    }
  };

  return (
    <form class="chat-poll-form mw-box" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && props.onDone()}>
      <input class="mw-input mw-box" placeholder="Ask a question" value={question()} aria-label="Question"
        onInput={(e) => setQuestion(e.currentTarget.value)} />
      <Index each={options()}>
        {(option, i) => (
          <div class="chat-poll-form-option mw-fade-in">
            <input class="mw-input mw-box" placeholder={`Answer ${i + 1}`} value={option().label} aria-label={`Answer ${i + 1}`}
              onInput={(e) => setOption(i, e.currentTarget.value)} />
            <Show when={options().length > 2}>
              <button type="button" class="icon-button" aria-label={`Remove answer ${i + 1}`}
                onClick={() => setOptions(options().filter((_, j) => j !== i))}>
                <Icon name="close" />
              </button>
            </Show>
          </div>
        )}
      </Index>
      <div class="chat-poll-form-row">
        <label><input type="checkbox" checked={multiple()} onChange={(e) => setMultiple(e.currentTarget.checked)} /> Allow several answers</label>
        <span class="mw-editor-spacer" />
        <button type="button" class="mw-button mw-box" onClick={props.onDone}>Cancel</button>
        <button type="submit" class="mw-button primary mw-box" disabled={!question().trim() || filled().length < 2}>
          {editing() ? "Save poll" : "Post poll"}
        </button>
      </div>
      <Show when={error()}><p class="warning">{error()}</p></Show>
    </form>
  );
}
