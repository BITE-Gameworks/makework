// Every <video> that plays a file (chat attachments, linked video files, the file viewer). Some formats only play
// with hardware decoding (HEVC/H.265 on Linux: Chromium uses VA-API on Intel and AMD only), and then the element
// plays the sound with no picture or stays blank; this says why, offers to convert it in the app (core/videoConvert.ts)
// and another way to watch it.
import { Show, createSignal, onCleanup, type JSX } from "solid-js";
import { userMessage } from "../api/client";
import { Icon } from "../theme/icons";
import { createSoundFix } from "./videoSound";
import VolumeSlider from "../voice/VolumeSlider";
import "./VideoPlayer.css";

type Failure = { kind: "format" | "load"; detail: string };

export default function VideoPlayer(props: {
  src: string; width?: number; height?: number; autoplay?: boolean; preload?: "none" | "metadata" | "auto";
  // Buttons for watching it elsewhere, shown when it can't play here.
  fallback?: JSX.Element;
}) {
  const [failure, setFailure] = createSignal<Failure | null>(null);
  // The H.264 copy, once converted (or converted before on this computer).
  const [copy, setCopy] = createSignal<string | null>(null);
  const [progress, setProgress] = createSignal<number | null>(null);
  const [convertError, setConvertError] = createSignal("");
  let converting: AbortController | undefined;
  onCleanup(() => converting?.abort());
  const src = () => copy() ?? props.src;
  const formatFailed = () => {
    setFailure({ kind: "format", detail: "" });
    if (!copy()) void import("../core/videoConvert").then((m) => m.convertedUrl(props.src)).then((url) => url && play(url)).catch(() => {});
  };
  const play = (url: string) => {
    setCopy(url);
    setFailure(null);
    setAttempt((n) => n + 1);
  };
  const convert = async () => {
    converting = new AbortController();
    const signal = converting.signal;
    setConvertError("");
    setProgress(0);
    try {
      const { convertVideo } = await import("../core/videoConvert");
      play(await convertVideo(props.src, setProgress, signal));
    } catch (e) {
      if (!signal.aborted) setConvertError(userMessage(e));
    } finally {
      setProgress(null);
    }
  };
  const [video, setVideo] = createSignal<HTMLVideoElement>();
  const sound = createSoundFix(video, src);
  // Bumped by "Try again" to make a new element.
  const [attempt, setAttempt] = createSignal(0);
  let safetyRetries = 0;
  let retryTimer: number | undefined;
  onCleanup(() => {
    if (retryTimer !== undefined) window.clearTimeout(retryTimer);
  });
  // Data for the current frame is here and still no picture: no decoder for the video track. Judged only then:
  // at loadedmetadata a player Chromium hasn't fully set up yet can still report width 0.
  const checkPicture = (video: HTMLVideoElement) => {
    if (video.videoWidth === 0 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) formatFailed();
  };
  const onError = (video: HTMLVideoElement) => {
    const error = video.error;
    if (!error || error.code === MediaError.MEDIA_ERR_ABORTED) return;
    const detail = error.message || `Error ${error.code}`;
    // A missing or unreadable file also reports "not supported"; only the demuxer and decoder mean the format.
    const format = error.code === MediaError.MEDIA_ERR_DECODE || /DEMUXER_ERROR_NO_SUPPORTED_STREAMS|DECODE|codec/i.test(detail);
    if (format) formatFailed();
    else setFailure({ kind: "load", detail });
    console.warn("Video failed:", src(), detail);
    // The content protocol can briefly be unavailable while a workspace is opening. Chromium rejects that first
    // request with this error rather than waiting, so retry through the startup race with backoff.
    if (safetyRetries < 4 && /URL safety check/i.test(detail)) {
      retryTimer = window.setTimeout(retry, 250 * 2 ** safetyRetries);
      safetyRetries++;
    }
  };
  const retry = () => {
    setFailure(null);
    setAttempt((n) => n + 1);
  };

  return (
    <Show when={!failure()} fallback={
      <div class="video-unplayable mw-fade-in">
        <Icon name="play" size={28} />
        <strong>{failure()!.kind === "format" ? "MakeWork's player can't play this video" : "Couldn't load this video"}</strong>
        <span class="hint">
          {failure()!.kind === "format"
            ? "The app plays video with its own built-in decoders, not your system's, and they don't cover this format (often HEVC/H.265 from phones). Players like mpv or VLC use your system's codecs."
            : failure()!.detail}
        </span>
        <Show when={convertError()}><span class="warning">{convertError()}</span></Show>
        <Show when={progress() !== null}>
          <div class="video-convert-progress mw-fade-in" role="progressbar" aria-valuenow={Math.round(progress()! * 100)}>
            <span>Converting {Math.round(progress()! * 100)}%</span>
            <div class="video-convert-bar mw-box"><div style={{ transform: `scaleX(${progress()})` }} /></div>
          </div>
        </Show>
        <div class="video-unplayable-actions">
          <Show when={progress() === null} fallback={
            <button class="mw-button mw-box" onClick={() => converting?.abort()}><Icon name="close" /> Cancel</button>
          }>
            <Show when={failure()!.kind === "format" && !copy()}>
              <button class="mw-button mw-box" title="Makes a copy the app can play. Slow for long videos." onClick={() => void convert()}>
                <Icon name="play" /> Convert to play in the app
              </button>
            </Show>
            <button class="mw-button mw-box" onClick={retry}><Icon name="refresh" /> Try again</button>
            {props.fallback}
          </Show>
        </div>
      </div>
    }>
      <Show when={attempt() + 1} keyed>
        <video ref={setVideo} src={src()} controls playsinline autoplay={props.autoplay} preload={props.preload ?? "metadata"}
          width={props.width} height={props.height}
          onLoadedData={(e) => checkPicture(e.currentTarget)}
          onError={(e) => onError(e.currentTarget)} />
      </Show>
      <Show when={sound.fixed()}>
        <div class="video-sound-volume mw-fade-in" title="This video's sound plays through the app, so it has its own volume">
          <VolumeSlider label="Sound" max={1} value={sound.ownVolume()} onChange={sound.setOwnVolume} />
        </div>
      </Show>
      <Show when={sound.progress() !== null}>
        <div class="video-convert-progress mw-fade-in" role="progressbar" aria-valuenow={Math.round(sound.progress()! * 100)}>
          <span class="hint">Converting the sound for the app's player (its built-in decoders don't cover this format): {Math.round(sound.progress()! * 100)}%</span>
          <div class="video-convert-bar mw-box"><div style={{ transform: `scaleX(${sound.progress()})` }} /></div>
        </div>
      </Show>
      <Show when={sound.error()}><span class="hint warning mw-fade-in">No sound: {sound.error()}</span></Show>
    </Show>
  );
}
