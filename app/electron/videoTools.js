// Video the page's player can't decode, converted with the computer's own ffmpeg when it has one. Chromium never uses
// the system's codecs, but ffmpeg does: natively and on every core it is many times faster than ffmpeg.wasm, and it
// reads the file from disk, so any size works. The page falls back to ffmpeg.wasm without it (core/videoConvert.ts).
// Results are kept in `dir` by content hash and kind: "<hash>-sound.m4a" (the sound alone, beside the picture),
// "<hash>-video.mp4" (picture and sound, full size), "<hash>-sound.none" when the file has no sound.
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const keepConverted = 20;
const outputs = { sound: "m4a", video: "mp4" };

// GUI apps on macOS don't get the shell's PATH, so the usual install places are tried too.
const candidates = () => process.platform === "win32"
  ? ["ffmpeg.exe", "ffmpeg"]
  : ["ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg", "/snap/bin/ffmpeg"];

let found;
export function findFfmpeg() {
  found ??= (async () => {
    for (const candidate of candidates()) {
      const works = await new Promise((resolve) =>
        execFile(candidate, ["-hide_banner", "-version"], { timeout: 5000, windowsHide: true }, (error) => resolve(!error)));
      if (works) return candidate;
    }
    return null;
  })();
  return found;
}

export const convertedName = (hash, kind) => `${hash}-${kind}.${outputs[kind]}`;
export const isConvertedName = (name) => /^[0-9a-f]{64}-(sound\.m4a|video\.mp4)$/.test(name);

// A conversion made before: its file name, "none" for a file without sound, or null.
export async function cachedConversion(dir, hash, kind) {
  if (kind === "sound" && await exists(path.join(dir, `${hash}-sound.none`))) return "none";
  const name = convertedName(hash, kind);
  return (await exists(path.join(dir, name))) ? name : null;
}

const exists = (file) => fs.access(file).then(() => true, () => false);

const cpuEncoder = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"];
const gpuEncoder = ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "21", "-b:v", "0"];

// NVIDIA's encoder when ffmpeg has it and it works on this computer (many times faster than libx264, and the CPU stays
// free), else libx264. ffmpeg lists NVENC whether or not there is a card to run it, so it encodes one frame to find out.
let encoder;
function videoEncoder(ffmpeg) {
  encoder ??= new Promise((resolve) =>
    execFile(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=size=256x256", "-frames:v", "1", ...gpuEncoder, "-f", "null", "-"],
      { timeout: 15000, windowsHide: true }, (error) => resolve(error ? cpuEncoder : gpuEncoder)));
  return encoder;
}

const argsFor = (kind, input, output, videoArgs) => kind === "sound"
  ? ["-y", "-i", input, "-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-f", "mp4", output]
  : ["-y", "-i", input, "-map", "0:v:0", "-map", "0:a:0?", ...videoArgs,
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-f", "mp4", output];

const seconds = (h, m, s) => Number(h) * 3600 + Number(m) * 60 + Number(s);

// Converts `input` (a content file) and resolves with the result's name, or "none" for sound when there is none.
// `onProgress` gets 0..1 when the length is known.
export async function convert({ dir, hash, kind, input, onProgress, signal }) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg isn't installed on this computer.");
  await fs.mkdir(dir, { recursive: true });
  const name = convertedName(hash, kind);
  // A part file of its own: two conversions of one video at once (two viewers) must not write into the same file.
  const part = path.join(dir, `${name}.${randomBytes(6).toString("hex")}.part`);
  const videoArgs = kind === "video" ? await videoEncoder(ffmpeg) : [];
  let duration = 0;
  let log = "";
  const code = await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-nostats", "-progress", "pipe:1", ...argsFor(kind, input, part, videoArgs)], { windowsHide: true });
    const stop = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", stop);
    child.stderr.on("data", (chunk) => {
      log = (log + chunk).slice(-20000);
      const match = !duration && /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
      if (match) duration = seconds(match[1], match[2], match[3]);
    });
    child.stdout.on("data", (chunk) => {
      const done = /out_time_us=(\d+)/g;
      let last;
      for (let m; (m = done.exec(String(chunk)));) last = Number(m[1]) / 1e6;
      if (duration && last !== undefined) onProgress?.(Math.min(1, last / duration));
    });
    child.on("error", reject);
    child.on("close", (exit) => {
      signal?.removeEventListener("abort", stop);
      resolve(exit);
    });
  });
  if (signal?.aborted) {
    await fs.rm(part, { force: true });
    throw new Error("Cancelled.");
  }
  if (code !== 0) {
    await fs.rm(part, { force: true });
    if (kind === "sound" && /matches no streams/i.test(log)) {
      await fs.writeFile(path.join(dir, `${hash}-sound.none`), "");
      return "none";
    }
    throw new Error(`ffmpeg couldn't convert this video: ${log.trim().split("\n").at(-1) ?? `exit ${code}`}`);
  }
  await fs.rename(part, path.join(dir, name));
  await prune(dir);
  return name;
}

// Keeps the most recent conversions.
async function prune(dir) {
  const names = (await fs.readdir(dir).catch(() => [])).filter(isConvertedName);
  if (names.length <= keepConverted) return;
  const dated = await Promise.all(names.map(async (name) => ({ name, at: (await fs.stat(path.join(dir, name))).mtimeMs })));
  dated.sort((a, b) => a.at - b.at);
  for (const { name } of dated.slice(0, dated.length - keepConverted)) await fs.rm(path.join(dir, name), { force: true });
}

// The sound's codec ("ac3", "dts", ...), or null for a file without sound.
// The length in seconds (0 when ffmpeg can't tell) and whether the file has a picture and sound.
export async function probeMedia(input) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return null;
  const log = await new Promise((resolve) =>
    execFile(ffmpeg, ["-hide_banner", "-i", input], { timeout: 15000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (_error, _out, err) => resolve(String(err))));
  const length = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
  return {
    duration: length ? seconds(length[1], length[2], length[3]) : 0,
    picture: /Stream #\d+:\d+(?:[^:\d][^:]*)?: Video: /.test(log),
    sound: /Stream #\d+:\d+(?:[^:\d][^:]*)?: Audio: /.test(log),
  };
}

export async function probeSound(input) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return null;
  const log = await new Promise((resolve) =>
    execFile(ffmpeg, ["-hide_banner", "-i", input], { timeout: 15000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (_error, _out, err) => resolve(String(err))));
  return /Stream #\d+:\d+(?:[^:\d][^:]*)?: Audio: ([\w-]+)/.exec(log)?.[1] ?? null;
}

// The video from `start` seconds on, converted as it plays: fragmented MP4 (H.264 and AAC) that a MediaSource takes
// in as it arrives. Its timestamps start at 0; the page places them at `start` (ui/videoStream.ts). The CPU encoder
// runs at its fastest preset and at most 1080p, so it keeps ahead of playback. Ends ffmpeg when the reader stops.
export async function streamVideo(input, start) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg isn't installed on this computer.");
  const gpu = (await videoEncoder(ffmpeg)) === gpuEncoder;
  const from = Math.max(0, start);
  const child = spawn(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-ss", String(from), "-i", input, "-map", "0:v:0", "-map", "0:a:0?",
    ...(gpu ? gpuEncoder : ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "22", "-vf", "scale='min(1920,iw)':-2"]),
    "-profile:v", "high", "-pix_fmt", "yuv420p", "-g", "60", "-c:a", "aac", "-ac", "2", "-b:a", "192k",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1",
  ], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  const stop = () => child.kill("SIGKILL");
  child.stdout.on("close", stop);
  child.stdout.on("error", stop);
  child.on("error", () => child.stdout.destroy());
  return { stream: child.stdout, stop };
}

// The sound from `start` seconds on, decoded and encoded as it plays (AAC in ADTS, which plays while it arrives), so
// it starts at once like a player that decodes it itself. A seek asks for a new stream. Ends ffmpeg when the reader stops.
export async function streamSound(input, start) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg isn't installed on this computer.");
  const child = spawn(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-ss", String(Math.max(0, start)), "-i", input,
    "-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "192k", "-f", "adts", "pipe:1",
  ], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  const stop = () => child.kill("SIGKILL");
  child.stdout.on("close", stop);
  child.stdout.on("error", stop);
  // ffmpeg missing or unstartable after all: the stream just ends, never an unheard error in the main process.
  child.on("error", () => child.stdout.destroy());
  return { stream: child.stdout, stop };
}
