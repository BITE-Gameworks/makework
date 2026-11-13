// Call diagnostics for one member: the connection (WebRTC statistics) and what this device does with their
// sound. Refreshes every second while open.
import { copyText } from "../core/clipboard";
import { For, Show, createSignal, onCleanup } from "solid-js";
import { member } from "../core/members";
import { turnStatus } from "../p2p/ice";
import { activitySummary } from "./activity";
import { mediaLink } from "./media";
import { playbackInfo } from "./remote";
import { call, deafened, participants } from "./state";
import { userVolume } from "./volume";

type Info = Record<string, string | number | boolean>;

export default function Diagnostics(props: { workspaceId: string; userId?: number }) {
  const [connections, setConnections] = createSignal<Info[]>([]);
  const [playback, setPlayback] = createSignal<Info | null>(null);
  const [device, setDevice] = createSignal<Info>({});
  const [events, setEvents] = createSignal<string[]>([]);
  let stopped = false;
  let refreshing = false;
  const refresh = async () => {
    if (stopped || refreshing) return;
    refreshing = true;
    try {
      const here = call();
      setDevice({ ...mediaLink(props.workspaceId)?.deviceInfo?.(), TURN: turnStatus(), ...activitySummary(),
        "UI call channel": here?.workspaceId === props.workspaceId ? here.channelId : "none",
        "UI participants": JSON.stringify(here?.workspaceId === props.workspaceId ? participants(props.workspaceId, here.channelId).map((p) => p.userId) : []),
      });
      setEvents(mediaLink(props.workspaceId)?.callEvents?.() ?? []);
      if (props.userId !== undefined) {
        const playback = await playbackInfo(`${props.workspaceId}:${props.userId}`);
        const connections = await mediaLink(props.workspaceId)?.diagnose?.(props.userId) ?? [];
        if (!stopped) { setPlayback(playback); setConnections(connections); }
      }
    } catch (error) {
      if (!stopped) setDevice((before) => ({ ...before, "Diagnostics error": String(error) }));
    } finally { refreshing = false; }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), 1000);
  onCleanup(() => { stopped = true; clearInterval(timer); });

  return (
    <div class="voice-diagnostics">
      <p class="hint">
        You are {call()?.workspaceId === props.workspaceId ? "in a call" : "not in a call"}{deafened() ? ", deafened" : ""}.
        {props.userId !== undefined && ` ${member(props.workspaceId, props.userId).displayName}; their volume is ${Math.round(userVolume(props.userId) * 100)}%.`}
      </p>
      <Show when={props.userId !== undefined}>
        <h3>Connection</h3>
        <Show when={connections().length > 0} fallback={<p class="hint">Not connected to them.</p>}>
          <For each={connections()}>{(info) => <Table info={info} />}</For>
        </Show>
        <h3>Their sound on this device</h3>
        <Show when={playback()} fallback={<p class="hint">Nothing is playing for them (not in your call, or no audio received).</p>}>
          {(info) => <Table info={info()} />}
        </Show>
      </Show>
      <h3>This device</h3>
      <Table info={device()} />
      <h3>Call events</h3>
      <Show when={events().length > 0} fallback={<p class="hint mw-fade-in">Nothing has happened to the call's links yet.</p>}>
        <ol class="voice-call-events mw-scroll-fade mw-fade-in" reversed>
          <For each={events()}>{(line) => <li class="mw-fade-in">{line}</li>}</For>
        </ol>
      </Show>
      <button class="mw-button mw-box" onClick={() => void copyText(JSON.stringify({ connections: connections(), playback: playback(), device: device(), events: events() }, null, 2))}>
        Copy as text
      </button>
    </div>
  );
}

function Table(props: { info: Info }) {
  return (
    <dl class="details">
      <For each={Object.entries(props.info)}>
        {([key, value]) => (
          <>
            <dt>{key}</dt>
            <dd>{String(value)}</dd>
          </>
        )}
      </For>
    </dl>
  );
}
