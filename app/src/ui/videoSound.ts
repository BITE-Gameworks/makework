// Video files whose sound the app's built-in decoders (Chromium's, never the system's) don't cover (AC3, E-AC3, DTS,
// common in MKV files) play their picture in silence and report no error. With the computer's own ffmpeg (desktop app)
// the sound's codec is known before it plays, and such sound plays at once, decoded by ffmpeg as it plays, in an audio
// element kept in step with the video (`followStream`). Without it, Chromium's decoded byte counts tell: once the
// picture has decoded through a moment of playing and the sound nothing, the sound alone is converted
// (core/videoConvert.ts) and played beside the picture (`follow`). Sound converted before plays at once.
import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js";
import { userMessage } from "../api/client";
import { readJson, writeJson } from "../core/storage";

type Counted = HTMLVideoElement & { webkitVideoDecodedByteCount?: number; webkitAudioDecodedByteCount?: number };

const checkAfterMs = 1500;
const driftSeconds = 0.15;

// A stream can't seek: it starts where the picture is, waits when it arrived early, plays a little faster to catch up
// when it is late, and starts again after a seek or when too far off.
function followStream(video: HTMLVideoElement, audio: HTMLAudioElement, level: () => number, streamAt: (seconds: number) => string): () => void {
  audio.preload = "auto";
  let offset = 0;
  let starting = false;
  // How long a new stream takes to start playing, learned as it goes.
  let lead = 0.3;
  let wait: ReturnType<typeof setTimeout> | undefined;
  const restart = () => {
    clearTimeout(wait);
    offset = video.currentTime + (video.paused ? 0 : lead);
    starting = true;
    audio.playbackRate = 1;
    audio.src = streamAt(offset);
  };
  const align = () => {
    clearTimeout(wait);
    audio.volume = level();
    audio.muted = video.muted;
    if (starting) return;
    if (video.paused || video.seeking || video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return audio.pause();
    const drift = offset + audio.currentTime - video.currentTime;
    if (drift > 1.5 || drift < -0.3) {
      if (drift < 0) lead = Math.min(2, lead - drift);
      return restart();
    }
    if (drift > 0.04) {
      audio.pause();
      wait = setTimeout(align, (drift * 1000) / video.playbackRate);
      return;
    }
    audio.playbackRate = video.playbackRate * (drift < -0.04 ? 1.06 : 1);
    void audio.play().catch(() => {});
  };
  const onReady = () => {
    if (!starting) return;
    starting = false;
    align();
  };
  const onSeeked = () => (Math.abs(offset + audio.currentTime - video.currentTime) > 0.25 ? restart() : align());
  audio.addEventListener("canplay", onReady);
  const events: [string, () => void][] = [
    ["seeked", onSeeked], ["play", align], ["playing", align], ["pause", align], ["waiting", align], ["ratechange", align],
    ["volumechange", align], ["ended", align],
  ];
  for (const [name, handler] of events) video.addEventListener(name, handler);
  const check = setInterval(() => !video.paused && align(), 250);
  restart();
  return () => {
    clearTimeout(wait);
    clearInterval(check);
    for (const [name, handler] of events) video.removeEventListener(name, handler);
    audio.removeEventListener("canplay", onReady);
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  };
}

function follow(video: HTMLVideoElement, audio: HTMLAudioElement, level: () => number): () => void {
  const sync = () => {
    audio.volume = level();
    audio.muted = video.muted;
    audio.playbackRate = video.playbackRate;
    if (Math.abs(audio.currentTime - video.currentTime) > driftSeconds) audio.currentTime = video.currentTime;
    if (video.paused || video.seeking || video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) audio.pause();
    else void audio.play().catch(() => {});
  };
  const events = ["play", "playing", "pause", "seeking", "seeked", "waiting", "ratechange", "volumechange", "ended"];
  for (const name of events) video.addEventListener(name, sync);
  const drift = setInterval(() => !video.paused && sync(), 1000);
  sync();
  return () => {
    for (const name of events) video.removeEventListener(name, sync);
    clearInterval(drift);
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  };
}

// Chromium counts a video whose sound it can't decode as silent and hides its own volume control, so the sound played
// beside it has its own volume: `volume` from the caller (the watch party's slider), else `ownVolume`, which the
// player shows a slider for while `fixed`.
const volumeKey = "mw.video.soundVolume";

export function createSoundFix(video: Accessor<HTMLVideoElement | undefined>, src: Accessor<string | null | undefined>, volume?: Accessor<number>) {
  const [progress, setProgress] = createSignal<number | null>(null);
  const [error, setError] = createSignal("");
  const [fixed, setFixed] = createSignal(false);
  const [ownVolume, setOwnVolumeSignal] = createSignal<number>(readJson(volumeKey, 1));
  const setOwnVolume = (value: number) => {
    setOwnVolumeSignal(value);
    writeJson(volumeKey, value);
  };
  const level = () => Math.min(1, Math.max(0, (volume ?? ownVolume)()));
  let playing: HTMLAudioElement | undefined;
  createEffect(() => {
    const value = level();
    if (playing) playing.volume = value;
  });

  createEffect(on([video, src], ([element, url]) => {
    setProgress(null);
    setError("");
    setFixed(false);
    const el = element as Counted | undefined;
    if (!el || !url || el.webkitAudioDecodedByteCount === undefined) return;
    let stopFollowing: (() => void) | undefined;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let started = false;
    let stopped = false;
    const attach = (sound: string) => {
      stopFollowing?.();
      playing = new Audio(sound);
      stopFollowing = follow(el, playing, level);
      setFixed(true);
    };
    const convert = async () => {
      if (started) return;
      started = true;
      controller = new AbortController();
      setProgress(0);
      try {
        const { convertSound } = await import("../core/videoConvert");
        const sound = await convertSound(url, setProgress, controller.signal);
        if (sound) attach(sound);
      } catch (e) {
        if (!controller.signal.aborted) setError(userMessage(e));
      } finally {
        setProgress(null);
      }
    };
    const check = () => {
      if ((el.webkitVideoDecodedByteCount ?? 0) > 0 && el.webkitAudioDecodedByteCount === 0) void convert();
    };
    const onPlaying = () => {
      clearTimeout(timer);
      timer = setTimeout(check, checkAfterMs);
    };
    el.addEventListener("playing", onPlaying);
    void import("../core/videoConvert").then(async (m) => {
      const plan = await m.soundPlan(url);
      if (stopped) return;
      if (plan === "none") return void (started = true);
      if (plan === "native") return;
      if (plan) {
        started = true;
        playing = new Audio();
        stopFollowing = followStream(el, playing, level, plan);
        return setFixed(true);
      }
      const sound = await m.convertedSoundUrl(url);
      if (sound && !stopped) {
        started = true;
        attach(sound);
      }
    });
    onCleanup(() => {
      stopped = true;
      el.removeEventListener("playing", onPlaying);
      clearTimeout(timer);
      controller?.abort();
      stopFollowing?.();
      playing = undefined;
    });
  }));

  // `progress` while the sound converts (0..1), `fixed` once it plays beside the picture.
  return { progress, error, fixed, ownVolume, setOwnVolume };
}
