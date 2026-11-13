// Video Chromium's built-in decoders don't cover (it never uses the system's codecs): pictures (HEVC/H.265 from phones)
// converted to H.264, and sound (AC3, E-AC3, DTS in MKV files) converted alone to AAC, played beside the picture
// (ui/videoSound.ts). With the computer's own ffmpeg when the desktop app finds one, else with ffmpeg.wasm.
// Software decoding and encoding in one thread is slow, so it runs only when asked, one video at a time, and the
// result is kept in the Cache API by content hash: a video converts once per computer. Loaded on first use only
// (ui/VideoPlayer imports it dynamically), since ffmpeg's core is about 30 MB. The hosted browser build
// (`npm run build:browser`) leaves ffmpeg.wasm out: its 32 MB core is too big for static hosts.
import { FFmpeg, FFFSType } from "@ffmpeg/ffmpeg";
import { desktop } from "./desktop";

const wasmCore = import.meta.env.MODE === "browser"
  ? null
  : async () => ({ coreURL: (await import("@ffmpeg/core?url")).default, wasmURL: (await import("@ffmpeg/core/wasm?url")).default });

async function loadWasm(ffmpeg: FFmpeg) {
  if (!wasmCore) throw new ConvertError("Converting this video needs the MakeWork desktop app.");
  await ffmpeg.load(await wasmCore());
}

// The file and its conversion both live in the wasm memory.
export const maxConvertBytes = 700 * 1024 * 1024;
const cacheName = "mw-converted-videos";
const keepConverted = 20;
const outputWidth = 1280;

const keyOf = (src: string) => /^mwc:\/\/content\/([0-9a-f]{64})/.exec(src)?.[1] ?? null;
const cacheKey = (key: string) => `https://converted.makework.invalid/${key}`;
const converted = new Map<string, string>();

async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches === "undefined" ? null : await caches.open(cacheName);
  } catch {
    return null;
  }
}

// A conversion made before, on this computer (or earlier in this session for files without a hash).
export async function convertedUrl(src: string): Promise<string | null> {
  const known = converted.get(src);
  if (known) return known;
  const system = await systemCached(src, "video");
  if (system) return system;
  const key = keyOf(src);
  const cache = key ? await openCache() : null;
  const hit = cache && key ? await cache.match(cacheKey(key)).catch(() => undefined) : undefined;
  if (!hit) return null;
  const url = URL.createObjectURL(await hit.blob());
  converted.set(src, url);
  return url;
}

export class ConvertError extends Error {}

// The video's bytes; a missing one (404, a ghost not here yet) says so rather than reaching ffmpeg as an error page.
async function fetchVideo(src: string, signal: AbortSignal): Promise<Response> {
  const response = await fetch(src, { signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ConvertError(`The video couldn't be read (${response.status}).`);
  }
  return response;
}

// The computer's own ffmpeg (desktop app, electron/videoTools.js): native, on every core and from the file on disk,
// so much faster than ffmpeg.wasm and with no size limit. Used whenever it is installed and the video is content.
type Kind = "sound" | "video";
let systemFfmpeg: Promise<boolean> | undefined;
const hasSystemFfmpeg = () => (systemFfmpeg ??= desktop?.video?.hasFfmpeg().catch(() => false) ?? Promise.resolve(false));
const convertedRef = (name: string) => `mwc://converted/${name}`;

// Whether this computer converts with its own ffmpeg (desktop app): quick enough to start without asking.
export const convertsNatively = () => hasSystemFfmpeg();

// What the player needs to play `src` converted as it plays (ui/videoStream.ts): only content (known by its hash) on a
// computer with its own ffmpeg, and only a file with a picture. Null otherwise.
export async function streamInfo(src: string): Promise<{ hash: string; duration: number; sound: boolean } | null> {
  const hash = keyOf(src);
  const video = desktop?.video;
  if (!hash || !video || !(await hasSystemFfmpeg())) return null;
  const probe = await video.probe(hash).catch(() => null);
  return probe?.picture ? { hash, duration: probe.duration, sound: probe.sound } : null;
}

// undefined when nothing was converted on this computer; null for sound when the file has none.
async function systemCached(src: string, kind: Kind): Promise<string | null | undefined> {
  const hash = keyOf(src);
  if (!hash || !desktop?.video) return undefined;
  const name = await desktop.video.cached(hash, kind).catch(() => null);
  return name === "none" ? null : name ? convertedRef(name) : undefined;
}

async function systemConvert(src: string, kind: Kind, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<string | null | undefined> {
  const hash = keyOf(src);
  const video = desktop?.video;
  if (!hash || !video || !(await hasSystemFfmpeg())) return undefined;
  const id = crypto.randomUUID();
  const stopProgress = video.onProgress((from, value) => from === id && onProgress(value));
  const cancel = () => video.cancel(id);
  signal.addEventListener("abort", cancel);
  try {
    const name = await video.convert(id, hash, kind);
    return name === "none" ? null : convertedRef(name);
  } catch (e) {
    signal.throwIfAborted();
    throw new ConvertError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));
  } finally {
    stopProgress();
    signal.removeEventListener("abort", cancel);
  }
}

let queue: Promise<unknown> = Promise.resolve();

// Resolves with a URL of the H.264 copy. `onProgress` gets 0..1; aborting stops ffmpeg.
export function convertVideo(src: string, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<string> {
  const run = queue.catch(() => {}).then(() => convert(src, onProgress, signal));
  queue = run;
  return run;
}

async function convert(src: string, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const done = await convertedUrl(src);
  if (done) return done;
  const system = await systemConvert(src, "video", onProgress, signal);
  if (system) {
    converted.set(src, system);
    return system;
  }
  const response = await fetchVideo(src, signal);
  const length = Number(response.headers.get("content-length"));
  if (length > maxConvertBytes) {
    await response.body?.cancel();
    throw new ConvertError("This video is too big to convert in the app.");
  }
  const input = new Uint8Array(await response.arrayBuffer());
  if (input.length > maxConvertBytes) throw new ConvertError("This video is too big to convert in the app.");

  return withWasm(onProgress, signal, async (ffmpeg) => {
    await ffmpeg.writeFile("in", input);
    const code = await ffmpeg.exec([
      "-i", "in", "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", `scale='min(${outputWidth},iw)':-2`, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "out.mp4",
    ]);
    if (code !== 0) throw new ConvertError("ffmpeg couldn't read this video.");
    const output = await ffmpeg.readFile("out.mp4");
    if (typeof output === "string") throw new ConvertError("ffmpeg couldn't read this video.");
    const blob = new Blob([output as Uint8Array<ArrayBuffer>], { type: "video/mp4" });
    await remember(keyOf(src), blob);
    const url = URL.createObjectURL(blob);
    converted.set(src, url);
    return url;
  });
}

// ffmpeg.wasm for one conversion: loaded, reporting progress, stopped when `signal` aborts (then the abort is what
// the caller sees, not ffmpeg's error), and always ended afterwards. `log` holds what ffmpeg wrote.
async function withWasm<T>(onProgress: (fraction: number) => void, signal: AbortSignal, work: (ffmpeg: FFmpeg, log: string[]) => Promise<T>): Promise<T> {
  const ffmpeg = new FFmpeg();
  const stop = () => ffmpeg.terminate();
  signal.addEventListener("abort", stop);
  const log: string[] = [];
  ffmpeg.on("log", ({ message }) => log.push(message));
  ffmpeg.on("progress", ({ progress }) => onProgress(Math.min(1, Math.max(0, progress))));
  try {
    await loadWasm(ffmpeg);
    return await work(ffmpeg, log);
  } catch (e) {
    signal.throwIfAborted();
    throw e;
  } finally {
    signal.removeEventListener("abort", stop);
    ffmpeg.terminate();
  }
}

async function remember(key: string | null, blob: Blob) {
  const cache = key ? await openCache() : null;
  if (!cache || !key) return;
  try {
    await cache.put(cacheKey(key), new Response(blob, { headers: { "Content-Type": blob.type || "video/mp4" } }));
    const keys = await cache.keys();
    for (const old of keys.slice(0, Math.max(0, keys.length - keepConverted))) await cache.delete(old);
  } catch {
    // Kept for this session only.
  }
}

// The sound alone: the file is read from where it is (mounted, never copied into the wasm memory), so any size works,
// and only the sound is kept. Null when the file has no sound.
const soundKey = (src: string) => { const key = keyOf(src); return key && `${key}-sound`; };
const sounds = new Map<string, string | null>();

export async function convertedSoundUrl(src: string): Promise<string | null | undefined> {
  if (sounds.has(src)) return sounds.get(src);
  const system = await systemCached(src, "sound");
  if (system !== undefined) return system;
  const key = soundKey(src);
  const cache = key ? await openCache() : null;
  const hit = cache && key ? await cache.match(cacheKey(key)).catch(() => undefined) : undefined;
  if (!hit) return undefined;
  const url = URL.createObjectURL(await hit.blob());
  sounds.set(src, url);
  return url;
}

export function convertSound(src: string, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<string | null> {
  const run = queue.catch(() => {}).then(() => soundOf(src, onProgress, signal));
  queue = run;
  return run;
}

async function soundOf(src: string, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<string | null> {
  signal.throwIfAborted();
  const done = await convertedSoundUrl(src);
  if (done !== undefined) return done;
  const system = await systemConvert(src, "sound", onProgress, signal);
  if (system !== undefined) {
    sounds.set(src, system);
    return system;
  }
  const input = await (await fetchVideo(src, signal)).blob();
  return withWasm(onProgress, signal, async (ffmpeg, log) => {
    await ffmpeg.createDir("/in");
    await ffmpeg.mount(FFFSType.WORKERFS, { blobs: [{ name: "video", data: input }] }, "/in");
    const code = await ffmpeg.exec(["-i", "/in/video", "-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "sound.m4a"]);
    if (code !== 0) {
      if (log.some((line) => /matches no streams/i.test(line))) {
        sounds.set(src, null);
        return null;
      }
      throw new ConvertError("ffmpeg couldn't read this video's sound.");
    }
    const output = await ffmpeg.readFile("sound.m4a");
    if (typeof output === "string") throw new ConvertError("ffmpeg couldn't read this video's sound.");
    const blob = new Blob([output as Uint8Array<ArrayBuffer>], { type: "audio/mp4" });
    await remember(soundKey(src), blob);
    const url = URL.createObjectURL(blob);
    sounds.set(src, url);
    return url;
  });
}

// Sound codecs Chromium decodes itself.
const playableSound = /^(aac|mp3|opus|vorbis|flac|pcm_\w+)$/;

// How this file's sound can play, decided before it plays (desktop app with the computer's ffmpeg): "native" when the
// player decodes it, "none" without sound, else a function giving the mwc://sound stream from a time on (decoded by
// ffmpeg as it plays, electron/videoTools.js `streamSound`). undefined when it can't be known here.
export async function soundPlan(src: string): Promise<"native" | "none" | ((seconds: number) => string) | undefined> {
  const hash = keyOf(src);
  const video = desktop?.video;
  if (!hash || !video || !(await hasSystemFfmpeg())) return undefined;
  const codec = await video.probeSound(hash).catch(() => undefined);
  if (codec === undefined) return undefined;
  if (codec === null) return "none";
  if (playableSound.test(codec)) return "native";
  return (seconds) => `mwc://sound/${hash}?t=${Math.round(seconds * 1000) / 1000}`;
}
