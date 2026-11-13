// A watch party on the call's stage: this device's own copy of the video, kept in step with the other members.
// Every play, pause, seek or change of video goes to the members viewing the voice channel at once (its events) and
// into the party's row (for those who come later). The playing member with the lowest id leads: it answers members
// who ask where the party is, and tells everyone where it is every few seconds so copies that drift get put back.
// A member who doesn't have the video yet waits for it and then joins where the others are.
import { Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { userMessage } from "../api/client";
import { contentUrl, isLocal, transferBar } from "../core/content";
import { readJson, writeJson } from "../core/storage";
import { formatBytes } from "../core/time";
import type { ChannelContext } from "../plugins/types";
import { Icon } from "../theme/icons";
import ConfirmPrompt from "../ui/ConfirmPrompt";
import { rangeFill } from "../ui/range";
import Select from "../ui/Select";
import { ProgressBar } from "../ui/UploadList";
import { createSoundFix } from "../ui/videoSound";
import VolumeSlider from "../voice/VolumeSlider";
import { endParty, estimatedPosition, fetchVideos, savePlayback, type Party, type Playback } from "./data";
import "./watch.css";

// Copies further apart than this are put back in step.
const driftSeconds = 0.75;
const beatMs = 3000;
const volumeKey = "mw.watch.volume";

const clock = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
};

type Wanted = Playback & { at: number };

export default function PartyPlayer(props: { context: ChannelContext; party: Party }) {
  const ctx = props.context;
  const workspaceId = ctx.workspace.id;
  const partyId = props.party.id;
  const me = () => ctx.users.me();
  const [item, setItem] = createSignal(props.party.item);
  const current = () => props.party.items[item()] ?? props.party.items[0];
  const here = () => !!current() && isLocal(current().url);
  const original = () => (here() ? contentUrl(current().url) : null);
  // Videos the app's built-in decoders don't cover (HEVC from phones) play from an H.264 copy made in the app (core/videoConvert.ts),
  // by the original's url.
  const [copies, setCopies] = createSignal<Record<string, string>>({});
  const [converting, setConverting] = createSignal<number | null>(null);
  const [convertError, setConvertError] = createSignal("");
  const copy = () => copies()[current()?.url ?? ""];
  const src = () => (converting() !== null || convertError() ? null : copy() ?? original());
  const [ready, setReady] = createSignal(false);
  const [paused, setPaused] = createSignal(true);
  const [time, setTime] = createSignal(0);
  const [duration, setDuration] = createSignal(0);
  const [volume, setVolume] = createSignal(readJson(volumeKey, 1));
  const [confirmEnd, setConfirmEnd] = createSignal(false);
  const [endError, setEndError] = createSignal("");
  // While the seek bar is dragged, the video's own time doesn't move its thumb back under the pointer.
  let seeking = false;
  let video: HTMLVideoElement | undefined;
  const [videoElement, setVideoElement] = createSignal<HTMLVideoElement>();
  const sound = createSoundFix(videoElement, src, () => volume());

  createEffect(() => void fetchVideos(workspaceId, props.party, item()));

  let conversion: AbortController | undefined;
  onCleanup(() => conversion?.abort());
  createEffect(on(item, () => {
    conversion?.abort();
    setConverting(null);
    setConvertError("");
  }, { defer: true }));
  const convert = async () => {
    const url = current()?.url;
    const from = original();
    if (!url || !from || copies()[url] || converting() !== null) return;
    setReady(false);
    const controller = (conversion = new AbortController());
    setConvertError("");
    setConverting(0);
    try {
      const { convertVideo } = await import("../core/videoConvert");
      const made = await convertVideo(from, setConverting, controller.signal);
      setCopies({ ...copies(), [url]: made });
    } catch (e) {
      if (!controller.signal.aborted) setConvertError(userMessage(e));
    } finally {
      if (conversion === controller) setConverting(null);
    }
  };
  // Sound with no picture, or a demuxer or decoder error: the format, not the file.
  const checkPicture = (el: HTMLVideoElement) => {
    if (!copy() && el.videoWidth === 0 && el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) void convert();
  };
  const failed = (el: HTMLVideoElement) => {
    const error = el.error;
    if (!error || error.code === MediaError.MEDIA_ERR_ABORTED || copy()) return;
    const detail = error.message || `Error ${error.code}`;
    if (error.code === MediaError.MEDIA_ERR_DECODE || /DEMUXER_ERROR_NO_SUPPORTED_STREAMS|DECODE|codec/i.test(detail)) void convert();
    else setConvertError(`Couldn't load this video: ${detail}`);
  };

  let wanted: Wanted = { item: props.party.item, playing: props.party.playing, position: estimatedPosition(props.party), at: performance.now() };
  const wantedNow = () => wanted.position + (wanted.playing ? (performance.now() - wanted.at) / 1000 : 0);
  const applyWanted = () => {
    if (!video || !ready() || wanted.item !== item()) return;
    const target = Math.min(wantedNow(), video.duration || Infinity);
    if (Math.abs(video.currentTime - target) > driftSeconds) video.currentTime = target;
    if (wanted.playing && video.paused) void video.play().catch(() => setPaused(true));
    if (!wanted.playing && !video.paused) video.pause();
  };
  const apply = (p: Playback) => {
    wanted = { ...p, at: performance.now() };
    if (p.item !== item() && props.party.items[p.item]) {
      setReady(false);
      setItem(p.item);
    } else applyWanted();
  };
  const where = (): Playback => ({ item: item(), playing: !!video && !video.paused, position: video?.currentTime ?? wantedNow() });
  const send = (p: Playback, to?: number) => ctx.events.send({ watch: partyId, item: p.item, playing: p.playing, position: p.position }, to);
  // Something this member did: for everyone now, and kept for later.
  const act = (p: Playback) => {
    apply(p);
    send(p);
    void savePlayback(workspaceId, partyId, p).catch((e) => console.warn("Watch party: playback not saved:", e));
  };

  // Who is ready to play, through the voice channel's presence; the lowest id leads.
  createEffect(() => ctx.presence.set({ watch: partyId, ready: ready() }));
  onCleanup(() => ctx.presence.set(null));
  const leader = createMemo(() => {
    const ids = ctx.presence.others()
      .filter((p) => { const s = p.state as Record<string, unknown> | null; return s?.watch === partyId && s.ready === true; })
      .map((p) => p.userId);
    const mine = me();
    if (ready() && mine !== null) ids.push(mine);
    return ids.length ? Math.min(...ids) : null;
  });
  const leading = () => leader() !== null && leader() === me();

  let heardAt = 0;
  onCleanup(ctx.events.listen((userId, message) => {
    const m = message as Record<string, unknown> | null;
    if (m?.watch !== partyId) return;
    if (m.ask === true) {
      if (leading()) send(where(), userId);
      return;
    }
    if (typeof m.item !== "number" || typeof m.position !== "number") return;
    heardAt = Date.now();
    apply({ item: m.item, playing: m.playing === true, position: m.position });
  }));
  // Ready for the first time with this video: ask where everyone is.
  createEffect(on(ready, (now) => {
    if (!now) return;
    applyWanted();
    ctx.events.send({ watch: partyId, ask: true });
  }));
  const beat = setInterval(() => leading() && ready() && video && !video.paused && send(where()), beatMs);
  onCleanup(() => clearInterval(beat));
  // A change saved by a member whose message didn't reach this device.
  createEffect(on(() => props.party.changedAt, () => {
    if (props.party.changedBy === me() || Date.now() - heardAt < 2000) return;
    apply({ item: props.party.item, playing: props.party.playing, position: estimatedPosition(props.party) });
  }, { defer: true }));

  createEffect(() => {
    const el = videoElement();
    if (el) el.volume = Math.min(1, volume());
  });
  const ended = () => {
    if (!leading()) return;
    const next = item() + 1;
    act(next < props.party.items.length ? { item: next, playing: true, position: 0 } : { item: item(), playing: false, position: duration() });
  };
  const toggle = () => act({ ...where(), playing: !!video && video.paused });
  const seek = (position: number) => act({ ...where(), position });
  const go = (index: number) => act({ item: index, playing: !paused(), position: 0 });
  const isHost = () => props.party.hostId === me();
  const bar = () => transferBar(workspaceId, current()?.url);

  return (
    <div class="watch-player mw-fade-in">
      <Show when={src()} fallback={
        <Show when={!here() || (converting() === null && !convertError())} fallback={
          <div class="watch-waiting">
            <Icon name="play" size={28} />
            <p><b>{current()?.name}</b> is in a format the app's built-in player can't decode (it doesn't use your system's codecs), so the app makes a copy it can play (once per computer).</p>
            <Show when={converting() !== null}>
              <ProgressBar value={converting()!} label="Converting" />
              <p class="muted">Converting {Math.round(converting()! * 100)}%. Slow for long videos; you join where the others are once it is done.</p>
            </Show>
            <Show when={convertError()}>
              <p class="warning">{convertError()}</p>
              <button class="mw-button mw-box" onClick={() => { setConvertError(""); void convert(); }}><Icon name="refresh" /> Try again</button>
            </Show>
          </div>
        }>
        <div class="watch-waiting">
          <Icon name="download" size={28} />
          <p>Getting <b>{current()?.name}</b> ({formatBytes(current()?.size ?? 0)}) onto this device before you can watch.</p>
          <Show when={bar()} fallback={<p class="muted">Waiting for a member who has it...</p>}>
            {(b) => <><ProgressBar value={b().value} label={b().label} /><p class="muted">{b().label}</p></>}
          </Show>
          <p class="muted">You join where the others are once it is here.</p>
        </div>
        </Show>
      }>
        {(url) => (
          <video ref={(el) => { video = el; setVideoElement(el); }} class="watch-video" src={url()} playsinline preload="auto"
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
            onCanPlay={(e) => e.currentTarget.videoWidth > 0 && setReady(true)} onEmptied={() => setReady(false)}
            onLoadedData={(e) => checkPicture(e.currentTarget)} onError={(e) => failed(e.currentTarget)}
            onPlay={() => setPaused(false)} onPause={() => setPaused(true)}
            onTimeUpdate={(e) => !seeking && setTime(e.currentTarget.currentTime)} onEnded={ended}
            onClick={() => ready() && toggle()} />
        )}
      </Show>
      <div class="watch-controls mw-box">
        <button class="icon-button" title={paused() ? "Play for everyone" : "Pause for everyone"} aria-label={paused() ? "Play" : "Pause"}
          disabled={!ready()} onClick={toggle}>
          <Icon name={paused() ? "play" : "pause"} />
        </button>
        <button class="icon-button" title="Previous video" aria-label="Previous video" disabled={item() === 0} onClick={() => go(item() - 1)}>
          <Icon name="back" />
        </button>
        <button class="icon-button" title="Next video" aria-label="Next video" disabled={item() >= props.party.items.length - 1} onClick={() => go(item() + 1)}>
          <Icon name="forward" />
        </button>
        <span class="watch-time">{clock(time())} / {clock(duration())}</span>
        <Show when={sound.progress() !== null}>
          <span class="watch-time mw-fade-in" title="The app's built-in player can't decode this sound format (it doesn't use your system's codecs); the app converts it">
            Converting sound {Math.round(sound.progress()! * 100)}%
          </span>
        </Show>
        <Show when={sound.error()}><span class="warning mw-fade-in" title={sound.error()}>No sound</span></Show>
        <input class="watch-seek" type="range" min="0" max={duration() || 0} step="0.1" value={time()} disabled={!ready()}
          style={rangeFill(time(), 0, duration() || 1)} aria-label="Seek for everyone"
          onInput={(e) => {
            seeking = true;
            setTime(Number(e.currentTarget.value));
          }}
          onChange={(e) => {
            seeking = false;
            seek(Number(e.currentTarget.value));
          }}
          onPointerUp={() => (seeking = false)} onPointerCancel={() => (seeking = false)} onBlur={() => (seeking = false)} />
        <Show when={props.party.items.length > 1}>
          <Select label="Video" class="watch-playlist" value={item()} onChange={go}
            options={props.party.items.map((v, i) => ({ value: i, label: `${i + 1}. ${v.name}${isLocal(v.url) ? "" : " (not here yet)"}` }))} />
        </Show>
        <div class="watch-volume">
          <VolumeSlider label="Volume" max={1} value={volume()} onChange={(v) => { setVolume(v); writeJson(volumeKey, v); }} />
        </div>
        <Show when={isHost() || ctx.can("manage_messages")}>
          <button class="mw-button mw-box" classList={{ confirming: confirmEnd() }} aria-expanded={confirmEnd()} onClick={() => setConfirmEnd(!confirmEnd())}>
            End party
          </button>
        </Show>
      </div>
      <ConfirmPrompt open={confirmEnd()} question={`End the watch party "${props.party.title}" for everyone?`} confirmLabel="End party"
        onConfirm={() => {
          setConfirmEnd(false);
          setEndError("");
          void endParty(workspaceId, partyId).catch((e) => setEndError(userMessage(e)));
        }} onCancel={() => setConfirmEnd(false)} />
      <Show when={endError()}><p class="warning mw-fade-in">{endError()}</p></Show>
    </div>
  );
}
