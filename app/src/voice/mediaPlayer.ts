// Plays a media link on this device without a sound or a window of its own and gives the result as streams for a
// call (the media bot). The picture comes from a video element, the sound goes through Web Audio into a stream, so
// nothing is played on this device's speakers. A picture and a sound that arrive as two streams are kept in step.
import { desktop } from "../core/desktop";

export interface MediaInfo { title: string; duration: number | null; live: boolean; hasPicture: boolean }

const driftLimit = 0.3;
const watchMs = 500;
// How long a picture's track may take to appear in the captured stream after the first frame loaded.
const pictureWaitMs = 3_000;

// The players' elements sit in the page, invisible: Chromium may stop decoding the picture of a video that isn't in it.
function holder(): HTMLElement {
  let element = document.getElementById("mw-media-players");
  if (!element) {
    element = document.createElement("div");
    element.id = "mw-media-players";
    element.setAttribute("aria-hidden", "true");
    element.style.cssText = "position: fixed; left: 0; top: 0; width: 1px; height: 1px; overflow: hidden; opacity: 0; pointer-events: none;";
    document.body.append(element);
  }
  return element;
}

export class MediaPlayer {
  // Set once the media loaded (a video's captured stream has no picture track before that).
  picture: MediaStream | null = null;
  readonly sound: MediaStream;
  private readonly context = new AudioContext();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private finished = false;

  private constructor(
    readonly info: MediaInfo,
    private readonly session: string,
    private readonly video: HTMLVideoElement | null,
    private readonly audio: HTMLMediaElement,
    private readonly onChange: () => void,
  ) {
    const destination = this.context.createMediaStreamDestination();
    this.context.createMediaElementSource(audio).connect(destination);
    this.sound = destination.stream;
    const master = video ?? audio;
    master.addEventListener("ended", () => { this.finished = true; this.onChange(); });
    master.addEventListener("pause", () => this.onChange());
    master.addEventListener("play", () => { this.finished = false; this.onChange(); });
    master.addEventListener("waiting", () => this.onChange());
    master.addEventListener("playing", () => this.onChange());
    this.timer = setInterval(() => this.keepInStep(), watchMs);
  }

  // Finds the streams of the link on this computer (yt-dlp) and readies them; playing starts with `play`.
  static async open(address: string, audioOnly: boolean, onChange: () => void): Promise<MediaPlayer> {
    if (!desktop?.media) throw new Error("Playing links needs the desktop app on the bot host's computer.");
    const found = await desktop.media.resolve(address, audioOnly);
    const urlOf = (token: string) => `mwmedia://stream/${token}`;
    const make = <T extends HTMLMediaElement>(element: T, token: string): T => {
      element.crossOrigin = "anonymous";
      element.preload = "auto";
      element.src = urlOf(token);
      holder().append(element);
      return element;
    };
    let player: MediaPlayer | null = null;
    try {
      const video = found.picture ? make(document.createElement("video"), found.picture) : null;
      // One stream holding both serves as the picture and the sound.
      const audio = found.sound === found.picture && video ? video : make(document.createElement("audio"), found.sound ?? found.picture!);
      const info = { title: found.title, duration: found.duration, live: found.live, hasPicture: !!video };
      player = new MediaPlayer(info, found.session, video, audio, onChange);
      await player.ready();
      await player.capturePicture();
      return player;
    } catch (e) {
      if (player) player.close();
      else void desktop.media.release(found.session);
      throw e;
    }
  }

  private async capturePicture(): Promise<void> {
    if (!this.video) return;
    const captured = (this.video as HTMLVideoElement & { captureStream(): MediaStream }).captureStream();
    if (captured.getVideoTracks().length === 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pictureWaitMs);
        captured.addEventListener("addtrack", () => { if (captured.getVideoTracks().length) { clearTimeout(timer); resolve(); } });
      });
    }
    const track = captured.getVideoTracks()[0];
    this.picture = track ? new MediaStream([track]) : null;
  }

  private async ready(): Promise<void> {
    const elements = [this.video, this.audio].filter((e, i, all): e is HTMLMediaElement => !!e && all.indexOf(e) === i);
    await Promise.all(elements.map((element) => new Promise<void>((resolve, reject) => {
      if (element.readyState >= 2) return resolve();
      const timer = setTimeout(() => reject(new Error("The media did not start loading.")), 45_000);
      element.addEventListener("loadeddata", () => { clearTimeout(timer); resolve(); }, { once: true });
      element.addEventListener("error", () => { clearTimeout(timer); reject(new Error("The media could not be played.")); }, { once: true });
    })));
  }

  private get master(): HTMLMediaElement {
    return this.video ?? this.audio;
  }

  private keepInStep(): void {
    if (this.closed || !this.video || this.audio === this.video) return;
    if (this.video.paused !== this.audio.paused) {
      if (this.video.paused) this.audio.pause();
      else void this.audio.play().catch(() => {});
    }
    if (Math.abs(this.audio.currentTime - this.video.currentTime) > driftLimit) this.audio.currentTime = this.video.currentTime;
  }

  get position(): number {
    return this.master.currentTime;
  }

  get paused(): boolean {
    return this.master.paused;
  }

  get ended(): boolean {
    return this.finished;
  }

  get buffering(): boolean {
    return !this.master.paused && this.master.readyState < 3;
  }

  async play(): Promise<void> {
    await this.context.resume();
    if (this.finished) this.seek(0);
    await Promise.all([this.video?.play(), this.audio === this.video ? undefined : this.audio.play()]);
  }

  pause(): void {
    this.video?.pause();
    this.audio.pause();
  }

  seek(seconds: number): void {
    if (this.info.live) return;
    const limit = this.info.duration ?? this.master.duration;
    const at = Math.max(0, Number.isFinite(limit) ? Math.min(seconds, Math.max(0, limit - 0.5)) : seconds);
    this.finished = false;
    if (this.video) this.video.currentTime = at;
    if (this.audio !== this.video) this.audio.currentTime = at;
    this.onChange();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.pause();
    for (const element of [this.video, this.audio]) {
      if (!element) continue;
      element.removeAttribute("src");
      element.load();
      element.remove();
    }
    this.picture?.getTracks().forEach((track) => track.stop());
    this.sound.getTracks().forEach((track) => track.stop());
    void this.context.close();
    void desktop?.media?.release(this.session);
  }
}
