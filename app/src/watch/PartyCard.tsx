// A watch party in the message that announced it: what is watched and when, joining (which gets the videos onto
// this device ahead of time), and once it started, the way into its voice channel.
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { userMessage } from "../api/client";
import { isLocal, transferBar } from "../core/content";
import { member, myId } from "../core/members";
import { openChannel } from "../core/navigation";
import { formatBytes } from "../core/time";
import { canInChannel, channelLabel, findChannel } from "../core/workspaces";
import { Icon } from "../theme/icons";
import { ProgressBar } from "../ui/UploadList";
import { call, joinVoice } from "../voice/state";
import { createPartyById, fetchVideos, hasStarted, joinParty, partyLinkKind, startPartyNow } from "./data";
import { parseLink } from "../core/links";
import "./watch.css";
import Skeleton from "../ui/Skeleton";
import { trimEnd } from "../core/text";

// The parties a message links to.
export function partyLinks(body: string): { workspaceId: string; partyId: number }[] {
  const found: { workspaceId: string; partyId: number }[] = [];
  for (const [raw] of body.matchAll(/makework:\/\/[^\s<>()[\]]+/g)) {
    const ref = parseLink(trimEnd(raw, ".,!?;:'\""));
    if (ref?.target?.kind === partyLinkKind && typeof ref.target.id === "number" && !found.some((f) => f.partyId === ref.target!.id))
      found.push({ workspaceId: ref.workspaceId, partyId: ref.target.id });
  }
  return found;
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function PartyCard(props: { workspaceId: string; partyId: number }) {
  const party = createPartyById(props.workspaceId, () => props.partyId);
  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 15_000);
  onCleanup(() => clearInterval(tick));
  const [error, setError] = createSignal("");
  const me = () => myId(props.workspaceId);
  const run = (action: Promise<unknown>) => void action.then(() => setError(""), (e) => setError(userMessage(e)));

  return (
    <Show when={party.value} fallback={
      <Show when={party.error} fallback={<Skeleton kind="line" />}><p class="muted">This watch party is gone.</p></Show>
    }>
      {(p) => {
        const joined = () => me() !== null && p().guests.includes(me()!);
        const started = () => hasStarted(p(), now());
        const voice = () => findChannel(props.workspaceId, p().channelId);
        const inCall = () => call()?.workspaceId === props.workspaceId && call()?.channelId === p().channelId;
        const here = () => p().items.filter((i) => isLocal(i.url)).length;
        const total = () => p().items.reduce((sum, i) => sum + i.size, 0);
        const join = () => run(joinParty(props.workspaceId, p().id, true).then(() => void fetchVideos(props.workspaceId, p())));
        createEffect(() => joined() && !p().ended && void fetchVideos(props.workspaceId, p()));
        const canStart = () => me() === p().hostId || canInChannel(props.workspaceId, p().channelId, "manage_messages");
        const startNow = () => run(startPartyNow(props.workspaceId, p().id).then(() => {
          setNow(Date.now());
          enter();
        }));
        const enter = () => {
          if (!joined()) join();
          else void fetchVideos(props.workspaceId, p());
          if (!inCall()) run(joinVoice(props.workspaceId, p().channelId));
          openChannel(props.workspaceId, p().channelId, { kind: partyLinkKind, id: p().id });
        };
        return (
          <div class="watch-card mw-box mw-fade-in" classList={{ ended: p().ended }}>
            <header class="watch-card-head">
              <Icon name="watch-party" size={22} />
              <div>
                <b>{p().title}</b>
                <p class="muted">
                  <Show when={!p().ended} fallback="Ended">
                    {started() ? "Started" : "Starts"} {when(p().startsAt)}
                  </Show>
                  {" in "}{voice() ? channelLabel(props.workspaceId, voice()!) : "a voice channel"}
                  {" · hosted by "}{member(props.workspaceId, p().hostId).displayName}
                </p>
              </div>
            </header>
            <ol class="watch-card-items">
              <For each={p().items}>
                {(item) => (
                  <li>
                    <span class="watch-card-name">{item.name}</span>
                    <span class="muted">{formatBytes(item.size)}</span>
                    <Show when={isLocal(item.url)} fallback={
                      <Show when={transferBar(props.workspaceId, item.url)}>{(b) => <ProgressBar value={b().value} label={b().label} />}</Show>
                    }>
                      <Icon name="check" size={14} />
                    </Show>
                  </li>
                )}
              </For>
            </ol>
            <Show when={!p().ended}>
              <div class="watch-card-actions">
                <span class="muted">
                  {p().guests.length} joined
                  <Show when={joined()}> · {here()} of {p().items.length} videos on this device ({formatBytes(total())} in all)</Show>
                </span>
                <span class="watch-card-buttons">
                <Show when={joined() && !started()}>
                  <button class="mw-button mw-box" onClick={() => run(joinParty(props.workspaceId, p().id, false))}>Leave</button>
                </Show>
                <Show when={!started() && canStart()}>
                  <button class="mw-button mw-box" title="Start the party now instead of at its time" onClick={startNow}>
                    <Icon name="play" /> Start now
                  </button>
                </Show>
                <Show when={started()} fallback={
                  <Show when={!joined()}>
                    <button class="mw-button primary mw-box" title="Gets the videos onto this device ahead of time" onClick={join}>Join</button>
                  </Show>
                }>
                  <button class="mw-button primary mw-box" onClick={enter}>
                    <Icon name="channel-voice" /> {inCall() ? "Watch" : `Join ${voice() ? channelLabel(props.workspaceId, voice()!) : "the call"}`}
                  </button>
                </Show>
                </span>
              </div>
            </Show>
            <Show when={error()}><p class="warning">{error()}</p></Show>
          </div>
        );
      }}
    </Show>
  );
}
