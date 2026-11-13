// The main view of a voice channel: join screen, or the stage with shared screen, tiles and controls.
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js";
import { member, myId } from "../core/members";
import { Icon } from "../theme/icons";
import Avatar from "../ui/Avatar";
import { openContextMenu } from "../ui/contextMenu";
import { userMenu } from "../shell/userMenu";
import type { ChannelContext } from "../plugins/types";
import { CameraButton, HangUpButton, HeadsetButton, MicButton, ScreenButton } from "./Controls";
import {
  call, callConnecting, callConnectingLong, cameraStream, deafened, isInCall, isSoundOnly, isSpeaking, sharedSoundAnalyser, joinVoice, participants, screenStream, sharingLabel, voiceError,
  type Participant,
} from "./state";
import { canCarryMedia, remoteStream, watchPicture } from "./media";
import { setStreamVolume, setUserVolume, streamVolume, userVolume } from "./volume";
import VolumeSlider from "./VolumeSlider";
import SpeakerName from "./SpeakerName";
import SoundVisualizer, { bassSwell, centerSize } from "./SoundVisualizer";
import VoiceState from "./VoiceState";
import Popover from "../ui/Popover";
import "./voice.css";
import { setSidePanel } from "../core/ui";
import Diagnostics from "./Diagnostics";
import { createParties, hasStarted, partyLinkKind, type Party } from "../watch/data";
import PartyPlayer from "../watch/PartyPlayer";
import { compareText } from "../core/text";

// The mounted stage, so the call panel's full screen button can find it.
export const [stage, setStage] = createSignal<HTMLElement | null>(null);

export default function VoiceView(props: { context: ChannelContext }) {
  const workspaceId = props.context.workspace.id;
  const channelId = props.context.channel.id;
  const people = () => participants(workspaceId, channelId);
  const [joining, setJoining] = createSignal(false);
  const parties = createParties(workspaceId, () => channelId);
  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 15_000);
  onCleanup(() => clearInterval(tick));
  // The watch party going on here, if any.
  const party = () => parties.value.find((p) => hasStarted(p, now()));

  const join = async () => {
    setJoining(true);
    await joinVoice(workspaceId, channelId);
    setJoining(false);
  };

  return (
    <Show when={isInCall(workspaceId, channelId)} fallback={
      <div class="voice-lobby mw-fade-only">
        <h2>{props.context.channel.name}</h2>
        <div class="voice-tiles">
          <For each={people()} fallback={<p class="muted">Nobody is here yet.</p>}>
            {(p) => <Tile workspaceId={workspaceId} participant={p} />}
          </For>
        </div>
        <Show when={party()}>
          {(p) => <p class="voice-party-note"><Icon name="watch-party" /> Watch party: <b>{p().title}</b></p>}
        </Show>
        <Show when={call()}>
          <p class="muted">Joining moves you out of your current call.</p>
        </Show>
        <button class="mw-button primary mw-box voice-join" disabled={joining()} onClick={() => void join()}>
          <Show when={joining()} fallback={<><Icon name="channel-voice" /> Join voice</>}>
            <span class="mw-spinner" /> Joining…
          </Show>
        </button>
        <Show when={voiceError()}><p class="warning">{voiceError()}</p></Show>
      </div>
    }>
      <Stage context={props.context} workspaceId={workspaceId} channelId={channelId} people={people()} active={props.context.active()} party={party()} />
    </Show>
  );
}

// A camera or shared screen in the call.
interface Feed {
  key: string;
  userId: number;
  kind: "camera" | "screen";
  stream: MediaStream | null;
  mine: boolean;
  label: string;
  soundOnly: boolean;
}

// `active`: the call's view is the one shown (a kept view stays mounted while another channel is open).
function Stage(props: { context: ChannelContext; workspaceId: string; channelId: number; people: Participant[]; active: boolean; party: Party | undefined }) {
  const me = () => myId(props.workspaceId);
  const name = (userId: number) => member(props.workspaceId, userId).displayName;
  const feeds = createMemo((): Feed[] => props.people.flatMap((p) => {
    const mine = p.userId === me();
    const list: Feed[] = [];
    const screen = mine ? screenStream() : p.sharing ? remoteStream(props.workspaceId, p.userId, "screen") ?? null : undefined;
    if (screen !== undefined && (screen || p.sharing))
      list.push({
        key: `${p.userId}:screen`, userId: p.userId, kind: "screen", stream: screen, mine,
        label: mine ? sharingLabel(screen) ?? "Screen" : p.sharing ?? "Screen", soundOnly: mine ? isSoundOnly(screen) : p.soundOnly,
      });
    const camera = mine ? cameraStream() : p.camera ? remoteStream(props.workspaceId, p.userId, "camera") ?? null : undefined;
    if (camera !== undefined && (camera || p.camera))
      list.push({ key: `${p.userId}:camera`, userId: p.userId, kind: "camera", stream: camera, mine, label: "Camera", soundOnly: false });
    return list;
  }));
  const feed = (key: string) => feeds().find((f) => f.key === key);
  // Over the mesh only a picture's viewers get it (ADR 0019), and every picture of the call shows on this stage: while
  // the stage is shown, this device views each one. By key, so a stream arriving doesn't stop and start the viewing.
  // `applied`: what this device was told it views, so leaving takes back exactly that.
  const viewed = createMemo(() => (props.active ? feeds().filter((f) => !f.mine).map((f) => f.key).sort(compareText).join(",") : ""));
  const view = (key: string, viewing: boolean) => {
    const [userId, kind] = key.split(":");
    watchPicture(props.workspaceId, Number(userId), kind as "screen" | "camera", viewing);
  };
  let applied = new Set<string>();
  createEffect(on(viewed, (now) => {
    const is = new Set(now ? now.split(",") : []);
    for (const key of is) if (!applied.has(key)) view(key, true);
    for (const key of applied) if (!is.has(key)) view(key, false);
    applied = is;
  }));
  onCleanup(() => applied.forEach((key) => view(key, false)));
  // Screens in the order they started, so the newest one comes to the front.
  const [started, setStarted] = createSignal<string[]>([]);
  createEffect(() => {
    const screens = feeds().filter((f) => f.kind === "screen").map((f) => f.key);
    const kept = untrack(started).filter((key) => screens.includes(key));
    setStarted([...kept, ...screens.filter((key) => !kept.includes(key))]);
  });
  const newestScreen = () => {
    const order = started().map(feed).filter((f): f is Feed => !!f).reverse();
    return order.find((f) => !f.mine) ?? order[0];
  };
  // The feed shown large: the one picked in the top bar, else the newest shared screen (others' first), else the tile grid.
  const [picked, setPicked] = createSignal<string | null>(null);
  const shown = () => (picked() ? feed(picked()!) : undefined) ?? (picked() === "grid" ? undefined : newestScreen());
  const toggle = (key: string) => setPicked(shown()?.key === key ? "grid" : key);
  // A watch party takes the stage unless something else was picked; a link to it shows it.
  const partyShown = () => !!props.party && (picked() === "party" || picked() === null);
  createEffect(on(props.context.target, (t) => t?.kind === partyLinkKind && setPicked("party")));

  return (
    <div class="voice-stage mw-fade-only" ref={(el) => {
      setStage(el);
      onCleanup(() => stage() === el && setStage(null));
    }}>
      <header class="voice-stage-header">
        <div class="voice-stage-info">
          <Show when={!partyShown() && shown()} fallback={
            <span class="voice-stage-title">
              <Show when={partyShown() && props.party} fallback={`${props.people.length} in call`}>
                {(p) => <><Icon name="watch-party" /> Watch party: {p().title}
                  <button class="mw-button mw-box voice-show-all" onClick={() => setPicked("grid")}>Show everyone</button></>}
              </Show>
            </span>
          }>
            {(f) => (
              <span class="voice-stage-title">
                <Avatar user={member(props.workspaceId, f().userId)} size={28} />
                {f().kind === "camera"
                  ? `${f().mine ? "Your" : `${name(f().userId)}'s`} camera`
                  : f().soundOnly ? `${f().mine ? "You are" : `${name(f().userId)} is`} sharing sound`
                  : `${f().mine ? "You are" : `${name(f().userId)} is`} sharing '${f().label}'`}
                <Show when={f().kind === "screen" && !f().mine}>
                  <StreamVolume workspaceId={props.workspaceId} userId={f().userId} />
                </Show>
                <button class="mw-button mw-box voice-show-all" onClick={() => setPicked("grid")}>Show everyone</button>
              </span>
            )}
          </Show>
          <Show when={callConnecting()}>
            <span class="voice-connecting mw-fade-in" role="status" aria-live="polite">
              <span class="mw-spinner" />
              {callConnectingLong() ? "Still connecting to the call…" : "Connecting to the call…"}
            </span>
          </Show>
        </div>
        <div class="voice-thumbs mw-box">
          <Show when={props.party}>
            <button class="voice-feed voice-party-thumb mw-box mw-fade-in" classList={{ active: partyShown() }} title="Watch party"
              onClick={() => setPicked(partyShown() ? "grid" : "party")}>
              <span class="voice-feed-wait"><Icon name="watch-party" /></span>
              <span class="voice-feed-label"><Icon name="watch-party" size={12} /> Watch party</span>
            </button>
          </Show>
          {/* By key, so presence changes don't restart every video. */}
          <For each={feeds().map((f) => f.key)}>
            {(key) => {
              const f = () => feed(key)!;
              const icon = () => (f().kind === "camera" ? "camera" : f().soundOnly ? "volume" : "screen-share");
              return (
                <Show when={feed(key)}>
                  <button class="voice-feed mw-box" classList={{ active: shown()?.key === key, speaking: isSpeaking(props.workspaceId, f().userId) }}
                    title={`${name(f().userId)}: ${f().kind === "camera" ? "camera" : f().soundOnly ? "sound" : f().label}`} onClick={() => toggle(key)}
                    onContextMenu={(e) => openContextMenu(e, userMenu(props.workspaceId, f().userId))}>
                    <Show when={f().soundOnly} fallback={
                      <Show when={f().stream} fallback={<span class="voice-feed-wait"><Icon name={icon()} /></span>}>
                        {(stream) => <StreamVideo class="voice-feed-video" stream={stream()} />}
                      </Show>
                    }>
                      {/* The stage showing this share draws it already: one visualizer per share. */}
                      <Show when={partyShown() || shown()?.key !== key || !shown()?.stream} fallback={<span class="voice-feed-wait"><Icon name={icon()} /></span>}>
                        <SoundVisualizer analyser={() => sharedSoundAnalyser(props.workspaceId, f().userId)} />
                      </Show>
                    </Show>
                    <span class="voice-feed-label"><Icon name={icon()} size={12} /> <SpeakerName workspaceId={props.workspaceId} userId={f().userId} /></span>
                  </button>
                </Show>
              );
            }}
          </For>
          <For each={props.people.filter((p) => !feeds().some((f) => f.userId === p.userId))}>
            {(p) => (
              <span class="voice-thumb mw-box" classList={{ speaking: isSpeaking(props.workspaceId, p.userId) }} title={name(p.userId)}
                onContextMenu={(e) => openContextMenu(e, userMenu(props.workspaceId, p.userId))}>
                <Avatar user={member(props.workspaceId, p.userId)} size={36} />
              </span>
            )}
          </For>
        </div>
      </header>

      <div class="voice-stage-main">
        {/* iPhones can't put a page element in full screen. */}
        <Show when={document.fullscreenEnabled}><FullscreenButton /></Show>
        <Show when={!partyShown()} fallback={
          <Show when={props.party} keyed>{(p) => <PartyPlayer context={props.context} party={p} />}</Show>
        }>
        <Show when={shown()} fallback={<TileGrid workspaceId={props.workspaceId} people={props.people} />}>
          {(f) => (
            <Show when={f().stream} fallback={
              <p class="muted voice-stage-note">
                {canCarryMedia(props.workspaceId) ? "Connecting..." : "This workspace can't carry video between members."}
              </p>
            }>
              {/* Switch, not a ternary: Show runs this once, and a share can gain or lose its picture. */}
              {(stream) => (
                <Switch fallback={<StreamVideo class="voice-screen" stream={stream()} />}>
                  <Match when={f().soundOnly}><SoundShare workspaceId={props.workspaceId} feed={f()} /></Match>
                  <Match when={f().mine && f().kind === "screen"}><ScreenPreview stream={stream()} /></Match>
                  <Match when={f().kind === "screen"}>
                    <StreamVideo class="voice-screen" stream={stream()} />
                    <ShareVolume userId={f().userId} hover />
                  </Match>
                </Switch>
              )}
            </Show>
          )}
        </Show>
        </Show>
      </div>

      <div class="voice-stage-controls">
        <CameraButton />
        <ScreenButton />
        <MicButton />
        <HeadsetButton />
        <button class="mw-button mw-box" title="Call diagnostics" aria-label="Call diagnostics"
          onClick={() => setSidePanel({ title: "Call diagnostics", render: () => <Diagnostics workspaceId={props.workspaceId} /> })}>
          <Icon name="info" />
        </button>
        <HangUpButton wide />
      </div>
    </div>
  );
}

const tileMax = { w: 260, h: 180 };
const tileGap = 10;

// The largest tile size (at most tileMax, same shape) at which `count` tiles fit in width x height.
function fitTiles(count: number, width: number, height: number) {
  const aspect = tileMax.w / tileMax.h;
  let best = 0;
  for (let cols = 1; cols <= Math.max(1, count); cols++) {
    const rows = Math.ceil(count / cols);
    const w = Math.min(tileMax.w, (width - tileGap * (cols - 1)) / cols, ((height - tileGap * (rows - 1)) / rows) * aspect);
    best = Math.max(best, w);
  }
  const w = Math.max(0, Math.floor(best));
  return { w, h: Math.floor(w / aspect) };
}

// Everyone in the call as tiles that shrink to fit the stage, so the grid never runs under the controls or scrolls.
function TileGrid(props: { workspaceId: string; people: Participant[] }) {
  const [room, setRoom] = createSignal({ width: 0, height: 0 });
  const observer = new ResizeObserver(([entry]) => setRoom({ width: entry.contentRect.width, height: entry.contentRect.height }));
  onCleanup(() => observer.disconnect());
  const size = createMemo(() => (room().width ? fitTiles(props.people.length, room().width, room().height) : tileMax));
  return (
    <div class="voice-tiles big" ref={(el) => observer.observe(el)}
      style={{ "--tile-w": `${size().w}px`, "--tile-h": `${size().h}px`, gap: `${tileGap}px` }}>
      <For each={props.people}>
        {(p) => <Tile workspaceId={props.workspaceId} participant={p} large avatar={Math.max(20, Math.min(72, Math.round(size().h * 0.4)))} />}
      </For>
    </div>
  );
}

function Tile(props: { workspaceId: string; participant: Participant; large?: boolean; avatar?: number }) {
  const who = () => member(props.workspaceId, props.participant.userId);
  const mine = () => props.participant.userId === myId(props.workspaceId) && call()?.workspaceId === props.workspaceId;
  const camera = () => (mine() ? cameraStream() : props.participant.camera
    ? remoteStream(props.workspaceId, props.participant.userId, "camera") : undefined) ?? null;
  const [volumeOpen, setVolumeOpen] = createSignal(false);
  return (
    <div class="voice-tile mw-box mw-fade-in" classList={{ large: props.large }}
      onContextMenu={(e) => openContextMenu(e, userMenu(props.workspaceId, props.participant.userId))}>
      <Show when={camera()} fallback={<Avatar user={who()} size={props.avatar ?? (props.large ? 72 : 48)} />}>
        {(stream) => <StreamVideo class="voice-camera" stream={stream()} />}
      </Show>
      <span class="voice-tile-name">
        <SpeakerName workspaceId={props.workspaceId} userId={props.participant.userId} />
        <VoiceState workspaceId={props.workspaceId} participant={props.participant} />
      </span>
      <Show when={!mine() && isInCall(props.workspaceId, props.participant.channelId)}>
        <div class="voice-tile-volume">
          <button class="icon-button" title={`Volume of ${who().displayName}`} aria-expanded={volumeOpen()}
            onClick={() => setVolumeOpen(!volumeOpen())}>
            <Icon name={userVolume(props.participant.userId) === 0 ? "volume-off" : "volume"} />
          </button>
          <Popover open={volumeOpen()} onClose={() => setVolumeOpen(false)} label={`Volume of ${who().displayName}`} placement="below" align="end">
            <div class="voice-volume-popover">
              <VolumeSlider label={who().displayName} value={userVolume(props.participant.userId)}
                onChange={(v) => setUserVolume(props.participant.userId, v)} />
            </div>
          </Popover>
        </div>
      </Show>
    </div>
  );
}

// Bottom right of the stage: the stage fills the screen, Esc or the button again leaves.
function FullscreenButton() {
  const [full, setFull] = createSignal(!!document.fullscreenElement);
  const sync = () => setFull(!!document.fullscreenElement);
  document.addEventListener("fullscreenchange", sync);
  onCleanup(() => document.removeEventListener("fullscreenchange", sync));
  // The browser may refuse (no user gesture it trusts, an iframe without permission); then it just stays as it is.
  const toggle = () => {
    const change = document.fullscreenElement ? document.exitFullscreen() : stage()?.requestFullscreen?.();
    void change?.catch((e: unknown) => console.warn("Full screen not changed:", e));
  };
  return (
    <button class="voice-button plain voice-fullscreen" title={full() ? "Exit full screen" : "Full screen"}
      aria-label={full() ? "Exit full screen" : "Full screen"} aria-pressed={full()} onClick={toggle}>
      <Icon name={full() ? "fullscreen-exit" : "fullscreen"} />
    </button>
  );
}

// Shows your shared screen, or says so when the capture delivers no frames instead of staying black.
function ScreenPreview(props: { stream: MediaStream }) {
  const [noFrames, setNoFrames] = createSignal(false);
  let video!: HTMLVideoElement;
  createEffect(() => {
    video.srcObject = props.stream;
    setNoFrames(false);
    const timer = setTimeout(() => {
      if (video.videoWidth === 0) {
        setNoFrames(true);
        console.warn("Screen share: no frames after 3 s", props.stream.getVideoTracks().map((t) => ({
          label: t.label, state: t.readyState, muted: t.muted, settings: t.getSettings(),
        })));
      }
    }, 3000);
    onCleanup(() => clearTimeout(timer));
  });
  return (
    <>
      <video ref={video} class="voice-screen mw-fade-in" classList={{ hidden: noFrames() }} autoplay muted playsinline
        onLoadedMetadata={() => setNoFrames(false)} />
      <Show when={noFrames()}>
        <p class="muted voice-stage-note">Sharing started, but this system's screen capture isn't sending any picture.</p>
      </Show>
    </>
  );
}

// A share of sound alone: who it is from, and its volume here.
function SoundShare(props: { workspaceId: string; feed: Feed }) {
  let picture!: HTMLDivElement;
  let glow!: HTMLDivElement;
  return (
    <div class="voice-sound-share mw-fade-in">
      <div class="voice-sound-share-glow" ref={glow} aria-hidden="true" />
      <SoundVisualizer variant="radial" analyser={() => sharedSoundAnalyser(props.workspaceId, props.feed.userId)}
        onBass={(bass) => {
          picture.style.transform = `scale(${1 + bass * bassSwell})`;
          // The glow's color is at 0.45; this gives 0.1 in silence up to 0.45 at full bass.
          glow.style.opacity = String((0.1 + bass * 0.35) / 0.45);
        }} />
      <div class="voice-sound-share-center">
        <div class="voice-sound-share-avatar" ref={picture}>
          <Avatar user={member(props.workspaceId, props.feed.userId)} size={centerSize} />
        </div>
      </div>
      <div class="voice-sound-share-footer">
        <p class="muted">{props.feed.mine ? "You are sharing your computer's sound." : `${member(props.workspaceId, props.feed.userId).displayName} is sharing sound.`}</p>
      </div>
      <Show when={!props.feed.mine}><ShareVolume userId={props.feed.userId} /></Show>
    </div>
  );
}

// A shared sound's volume standing at the stage's right edge; with `hover`, over a shared screen, only while the pointer is on the stage.
function ShareVolume(props: { userId: number; hover?: boolean }) {
  return (
    <div class="voice-sound-share-volume mw-box mw-fade-in" classList={{ hover: props.hover }}>
      <VolumeSlider vertical label="Volume" value={streamVolume(props.userId)} onChange={(v) => setStreamVolume(props.userId, v)} />
    </div>
  );
}

// The volume of a member's shared sound, from the stage's top bar.
function StreamVolume(props: { workspaceId: string; userId: number }) {
  const [open, setOpen] = createSignal(false);
  const label = () => `Volume of ${member(props.workspaceId, props.userId).displayName}'s stream`;
  return (
    <span class="voice-menu-anchor">
      <button class="icon-button" title={label()} aria-label={label()} aria-expanded={open()} onClick={() => setOpen(!open())}>
        <Icon name={streamVolume(props.userId) === 0 || deafened() ? "volume-off" : "volume"} />
      </button>
      <Popover open={open()} onClose={() => setOpen(false)} label={label()} placement="below">
        <div class="voice-volume-popover">
          <VolumeSlider label="Stream volume" value={streamVolume(props.userId)} onChange={(v) => setStreamVolume(props.userId, v)} />
        </div>
      </Popover>
    </span>
  );
}

// Pictures only: voice and shared sound play through Web Audio (state.ts), so the volumes apply and switching
// what is shown never interrupts them.
function StreamVideo(props: { stream: MediaStream; class: string }) {
  let video!: HTMLVideoElement;
  createEffect(() => {
    video.srcObject = props.stream;
  });
  return <video ref={video} class={props.class} autoplay muted playsinline />;
}
