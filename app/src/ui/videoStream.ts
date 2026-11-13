// Video the player can't decode, played while the computer's ffmpeg converts it (desktop app, mwc://stream in
// electron/main.js). The converted pieces (fragmented MP4, timed from where the stream starts) go into a MediaSource
// at that place as they arrive, so it starts within a second, like a player that decodes it itself. A stream converts from one point
// on; seeking where nothing is buffered yet, or playing up to the end of what is, starts a new one from there. It
// stays about a minute ahead of playback and keeps half a minute behind.

const aheadSeconds = 60;
const behindSeconds = 30;
// How close to the end of what is buffered playback gets before the next stream starts.
const refillSeconds = 20;
// A new stream starts a little before the end of what is buffered, so its pieces overlap instead of leaving a gap.
const overlapSeconds = 1;

export type StreamInfo = { hash: string; duration: number; sound: boolean };

const mimeType = (sound: boolean) => `video/mp4; codecs="avc1.640028${sound ? ",mp4a.40.2" : ""}"`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function canStream(sound: boolean): boolean {
  return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(mimeType(sound));
}

// Plays `info`'s video in `video`. `onError` runs when ffmpeg can't convert it (nothing came) or a stream fails.
// Returns the function that stops it.
export function streamVideo(video: HTMLVideoElement, info: StreamInfo, onError: (message: string) => void): () => void {
  const source = new MediaSource();
  const url = URL.createObjectURL(source);
  let buffer: SourceBuffer | undefined;
  let closed = false;
  let filling: { from: number; controller: AbortController } | undefined;

  const end = () => (info.duration > 0 ? info.duration : Infinity);
  const rangeAt = (time: number) => {
    const ranges = buffer?.buffered;
    if (!ranges) return null;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) - 0.3 <= time && time <= ranges.end(i) + 0.3) return { start: ranges.start(i), end: ranges.end(i) };
    }
    return null;
  };
  const idle = async () => {
    while (buffer?.updating) await new Promise((resolve) => buffer!.addEventListener("updateend", resolve, { once: true }));
  };
  const trimBehind = async (keep: number) => {
    const until = video.currentTime - keep;
    const ranges = buffer?.buffered;
    if (!buffer || !ranges?.length || until <= ranges.start(0)) return false;
    await idle();
    buffer.remove(0, until);
    await idle();
    return true;
  };
  const append = async (chunk: Uint8Array<ArrayBuffer>, signal: AbortSignal) => {
    while (!signal.aborted) {
      await idle();
      if (signal.aborted) return;
      try {
        buffer!.appendBuffer(chunk);
        return;
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "QuotaExceededError")) throw e;
        if (!(await trimBehind(2))) await sleep(1000);
      }
    }
  };
  // How far the running stream has buffered past playback.
  const ahead = (from: number) => {
    const range = rangeAt(from);
    return range && range.end > video.currentTime ? range.end - Math.max(range.start, video.currentTime) : 0;
  };

  const start = (from: number) => {
    filling?.controller.abort();
    const controller = new AbortController();
    const current = { from, controller };
    filling = current;
    void (async () => {
      const signal = controller.signal;
      let received = 0;
      try {
        await idle();
        // A stream cut off mid-piece leaves the parser waiting for the rest; the next one starts clean, placed where
        // it starts in the video.
        if (source.readyState === "open") buffer!.abort();
        buffer!.timestampOffset = from;
        const response = await fetch(`mwc://stream/${info.hash}?t=${Math.round(from * 1000) / 1000}`, { signal });
        if (!response.ok || !response.body) throw new Error(`The video couldn't be read (${response.status}).`);
        const reader = response.body.getReader();
        signal.addEventListener("abort", () => void reader.cancel().catch(() => {}));
        for (;;) {
          while (!signal.aborted && ahead(from) > aheadSeconds) await sleep(500);
          if (signal.aborted) return;
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          await append(value as Uint8Array<ArrayBuffer>, signal);
          await trimBehind(behindSeconds);
        }
        if (signal.aborted) return;
        if (!received) throw new Error("ffmpeg couldn't convert this video.");
        await idle();
        if (source.readyState === "open" && (rangeAt(from)?.end ?? 0) >= end() - 1) source.endOfStream();
      } catch (e) {
        if (signal.aborted || closed) return;
        onError(e instanceof Error ? e.message : String(e));
      } finally {
        if (filling === current) filling = undefined;
      }
    })();
  };

  // Starts a stream wherever playback is about to run out of converted video.
  const ensure = () => {
    if (closed || !buffer) return;
    const time = video.currentTime;
    const here = rangeAt(time);
    if (!here) {
      if (!filling || Math.abs(filling.from - time) > 1) start(time);
      return;
    }
    if (here.end >= end() - 0.5) return;
    const fillingHere = filling && filling.from >= here.start - 0.5 && filling.from <= here.end + 0.5;
    if (!fillingHere && here.end - time < refillSeconds) start(Math.max(0, here.end - overlapSeconds));
  };

  source.addEventListener("sourceopen", () => {
    if (buffer || closed) return;
    buffer = source.addSourceBuffer(mimeType(info.sound));
    if (info.duration > 0) source.duration = info.duration;
    start(video.currentTime);
  }, { once: true });
  const events = ["seeking", "waiting", "timeupdate"];
  for (const name of events) video.addEventListener(name, ensure);
  video.src = url;

  return () => {
    closed = true;
    filling?.controller.abort();
    for (const name of events) video.removeEventListener(name, ensure);
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  };
}
