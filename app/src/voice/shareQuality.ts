// Screen-share quality (ADR 0006, 0025): the resolution, frame rate, trade-off and bitrate a member picks for their
// share on this device, what they mean for the capture and for every sender carrying the share, and the live numbers
// shown under the control. Calls in a mesh (p2p/voice.ts) and through a node (p2p/sfu.ts) both tune their senders
// here, so the two paths can't drift apart.
import { readJson, writeJson } from "../core/storage";

// The resolution by its height (1440 is "2K"), and what gives way when the bandwidth runs short.
export type ShareResolution = 720 | 1080 | 1440;
export type ShareFrameRate = 30 | 60;
export type ShareFavour = "motion" | "balanced" | "detail";
// bitrate: "auto" (worked out from the size and rate) or one of bitrateStops, in Mbit/s. A chosen bitrate is the
// whole upload of the share: a mesh call splits it between the viewers' copies (ADR 0025).
export type ShareQuality = { resolution: ShareResolution; frameRate: ShareFrameRate; favour: ShareFavour; bitrate: "auto" | number };

export const defaultShareQuality: ShareQuality = { resolution: 1080, frameRate: 30, favour: "balanced", bitrate: "auto" };

export const shareResolutions: Record<ShareResolution, { width: number; height: number }> = {
  720: { width: 1280, height: 720 },
  1080: { width: 1920, height: 1080 },
  1440: { width: 2560, height: 1440 },
};
export const shareResolutionOrder: ShareResolution[] = [720, 1080, 1440];
export const shareFrameRates: ShareFrameRate[] = [30, 60];
// The favour menu's order, and the bitrates on the bitrate slider (Mbit/s; finer where small steps matter).
export const shareFavourOrder: ShareFavour[] = ["motion", "balanced", "detail"];
// Every Auto rate is a stop, so switching Auto off with one viewer keeps the bitrate exactly.
export const bitrateStops = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30];

// What the encoder is told the picture is, and what it gives up first when the bandwidth runs short.
export const favourSettings: Record<ShareFavour, { contentHint: "motion" | "detail"; degradationPreference: RTCDegradationPreference }> = {
  motion: { contentHint: "motion", degradationPreference: "maintain-framerate" },
  balanced: { contentHint: "detail", degradationPreference: "balanced" },
  detail: { contentHint: "detail", degradationPreference: "maintain-resolution" },
};

// On Auto all copies of the picture together stay under this (a chosen bitrate is its own budget, ADR 0025), so a
// share never takes the whole upload from the call's voices (home uploads are often 10 to 20 Mbit/s, and a congested
// link delays every packet, voice too). A mesh call sends a copy to each viewer only (ADR 0019), each at least
// floorMbps: the budget holds up to 16 viewers. Cameras the same with their own budget, a copy at most `cameraMaxMbps`.
const uploadBudgetMbps = 8;
const floorMbps = 0.5;
const cameraBudgetMbps = 3;
const cameraFloorMbps = 0.25;
const cameraMaxMbps = 1.5;
// The computer's sound beside the picture.
const soundBitrate = 128_000;

// Calls put voice first (ADR 0011): when the upload runs short the browser shares it out by priority and marks the
// packets for routers by networkPriority, so a member's voice never waits behind a picture. The share's sound comes
// next, pictures (screen, camera) last.
type Priority = Pick<RTCRtpEncodingParameters, "priority" | "networkPriority">;
export const voicePriority: Priority = { priority: "high", networkPriority: "high" };
export const soundPriority: Priority = { priority: "medium", networkPriority: "medium" };
export const picturePriority: Priority = { priority: "low", networkPriority: "low" };

const bits = (mbps: number) => Math.round(mbps * 1_000_000);

// The capture's box. The chosen height holds the screen's shorter side (a 4K screen is scaled down to it, a portrait
// one turned on its side the same), the longer side may go to 32:9 so an ultrawide keeps its shape. Before the screen
// is known (`source`: what the capture gives) both sides get the long limit. Only maxima: the browser scales down,
// keeping the shape, and never up.
export function captureConstraints(quality: ShareQuality, source?: { width?: number; height?: number }): MediaTrackConstraints {
  const short = shareResolutions[quality.resolution].height;
  const long = Math.round((short * 32) / 9);
  const frameRate = { ideal: quality.frameRate, max: quality.frameRate };
  if (!source?.width || !source.height) return { width: { max: long }, height: { max: long }, frameRate };
  const portrait = source.height > source.width;
  return { width: { max: portrait ? short : long }, height: { max: portrait ? long : short }, frameRate };
}

// What the encoder is told the picture is, set as soon as a share starts and whenever the favour changes.
export function hintCapture(track: MediaStreamTrack, quality: ShareQuality): void {
  track.contentHint = favourSettings[quality.favour].contentHint;
}

// A capture taking the quality: the hint, and the box for the screen's shape as the capture now gives it (its
// shape stays the same however it is scaled).
export function applyCapture(track: MediaStreamTrack, quality: ShareQuality): void {
  hintCapture(track, quality);
  track.applyConstraints(captureConstraints(quality, track.getSettings())).catch((e) => console.warn("Screen share: capture not changed:", e));
}

export interface EffectiveBitrate {
  // bit/s for each copy.
  bitrate: number;
  // The upload budget lowered it, and how that reads for the member.
  capped: boolean;
  reason?: string;
}

// What each copy of a camera may use (bit/s) with this many copies going out.
export function cameraBitrate(copies: number): number {
  return bits(Math.max(cameraFloorMbps, Math.min(cameraMaxMbps, cameraBudgetMbps / Math.max(1, copies))));
}

// What Auto means (Mbit/s per copy): VP8 screen content at about 0.05 bits per pixel, rounded up.
const autoTable: Record<ShareResolution, Record<ShareFrameRate, number>> = {
  720: { 30: 2, 60: 3 },
  1080: { 30: 4, 60: 7 },
  1440: { 30: 7, 60: 12 },
};

export function autoMbps(quality: Pick<ShareQuality, "resolution" | "frameRate">): number {
  return autoTable[quality.resolution][quality.frameRate];
}

// `copies`: how many copies of the share this device uploads, one per viewer in a mesh call, one through a node.
// A chosen bitrate is the whole upload, split between the copies (never more in all than chosen, but at least the
// floor each). Auto gives each copy its own rate, all of them together within the upload budget.
export function effectiveBitrate(quality: ShareQuality, copies: number): EffectiveBitrate {
  if (quality.bitrate !== "auto") {
    if (copies <= 1) return { bitrate: bits(quality.bitrate), capped: false };
    const each = Math.max(floorMbps, Math.floor((quality.bitrate / copies) * 10) / 10);
    return { bitrate: bits(each), capped: true, reason: `${each} Mbit/s each for ${copies} viewers` };
  }
  const wanted = autoMbps(quality);
  if (copies > 1 && wanted * copies > uploadBudgetMbps) {
    const each = Math.max(floorMbps, Math.round((uploadBudgetMbps / copies) * 10) / 10);
    if (each < wanted) return { bitrate: bits(each), capped: true, reason: `lowered to ${each} Mbit/s for ${copies} viewers` };
  }
  return { bitrate: bits(wanted), capped: false };
}

// The bitrate the slider starts at when Auto is switched off: the stop nearest what Auto's copies used together (a
// chosen bitrate is the whole upload; the higher stop on a tie), so no viewer's picture drops. A bitrate already
// chosen stays.
export function manualBitrate(quality: ShareQuality, copies: number): number {
  if (quality.bitrate !== "auto") return quality.bitrate;
  const total = (effectiveBitrate(quality, copies).bitrate / 1_000_000) * Math.max(1, copies);
  return bitrateStops.reduce((best, stop) => (Math.abs(stop - total) <= Math.abs(best - total) ? stop : best), bitrateStops[0]);
}

// Above this a call through a node may be too much for a viewer's download: the node passes the one copy on as it is
// (no smaller copies for slow viewers until simulcast, the node's phase 2).
export const nodeStutterBits = 10_000_000;

const mbit = (bitrate: number) => Number((bitrate / 1_000_000).toFixed(1));

// The line under the bitrate slider: what Auto works out to, or the chosen bitrate, and what each copy gets when
// there are several (the real total when the floor raised it above the chosen one).
export function describeBitrate(quality: ShareQuality, copies: number): string {
  const each = mbit(effectiveBitrate(quality, copies).bitrate);
  if (quality.bitrate === "auto") return `Auto (${each} Mbit/s${copies > 1 ? " each" : ""})`;
  if (copies <= 1) return `${quality.bitrate} Mbit/s`;
  return `${Math.max(quality.bitrate, mbit(bits(each) * copies))} Mbit/s in all, ${each} each`;
}

// Per device on purpose (not synced through the account): a laptop and a desktop can want different settings.
const storageKey = "mw.voice.shareQuality";

// What an older version saved: one of three profiles and a maximum bitrate.
const olderProfiles: Record<string, Omit<ShareQuality, "bitrate">> = {
  smooth: { resolution: 720, frameRate: 60, favour: "motion" },
  balanced: { resolution: 1080, frameRate: 30, favour: "balanced" },
  sharp: { resolution: 1080, frameRate: 30, favour: "detail" },
};
type Saved = Partial<Record<keyof ShareQuality | "profile" | "maxBitrate", unknown>>;

// A quality held to the choices on offer, with the default for anything it doesn't know (an older, hand-edited or
// scripted value), so the slider, the Auto table and the senders only ever see known values.
export function shareQualityFrom(value: unknown): ShareQuality {
  const saved: Saved = value && typeof value === "object" ? value : {};
  const older = typeof saved.profile === "string" && Object.hasOwn(olderProfiles, saved.profile) ? olderProfiles[saved.profile] : null;
  const pick = <T>(choices: readonly T[], value: unknown, fallback: T): T => choices.find((c) => c === value) ?? fallback;
  const d = defaultShareQuality;
  return {
    resolution: pick(shareResolutionOrder, saved.resolution, older?.resolution ?? d.resolution),
    frameRate: pick(shareFrameRates, saved.frameRate, older?.frameRate ?? d.frameRate),
    favour: pick(shareFavourOrder, saved.favour, older?.favour ?? d.favour),
    bitrate: pick<ShareQuality["bitrate"]>(["auto", ...bitrateStops], saved.bitrate ?? saved.maxBitrate, d.bitrate),
  };
}

// What this device saved.
export function loadShareQuality(): ShareQuality {
  return shareQualityFrom(readJson<unknown>(storageKey, null));
}

export function saveShareQuality(quality: ShareQuality): void {
  writeJson(storageKey, quality);
}

// The part of RTCRtpSender the tuning uses (a mediasoup producer's rtpSender is one too), and a share's senders with
// its picture and its sound apart.
export type ShareSender = Pick<RTCRtpSender, "getParameters" | "setParameters">;
export type ScreenSenders<T extends ShareSender = ShareSender> = { video: T[]; audio: T[] };

interface SenderSettings {
  encoding: Pick<RTCRtpEncodingParameters, "maxBitrate" | "maxFramerate" | "priority" | "networkPriority">;
  degradationPreference?: RTCDegradationPreference;
}

// The picture gets the bitrate, frame rate and the favour's trade-off, the sound a fixed bitrate, so the two stop
// taking from each other; both rank below the call's voices.
export function screenSenderSettings(quality: ShareQuality, copies: number): { video: SenderSettings; audio: SenderSettings } {
  return {
    video: {
      encoding: { maxBitrate: effectiveBitrate(quality, copies).bitrate, maxFramerate: quality.frameRate, ...picturePriority },
      degradationPreference: favourSettings[quality.favour].degradationPreference,
    },
    audio: { encoding: { maxBitrate: soundBitrate, ...soundPriority } },
  };
}

// Tunes every sender carrying the share. One refusing (a browser without a field) never stops the others.
export async function applyShareQuality(senders: ScreenSenders, quality: ShareQuality, copies: number): Promise<void> {
  const settings = screenSenderSettings(quality, copies);
  await Promise.all([...senders.video.map((s) => tune(s, settings.video)), ...senders.audio.map((s) => tune(s, settings.audio))]);
}

// The call's other senders: microphones first, cameras with the pictures. `cameraCopies`: a mesh call's camera goes one
// copy per viewer and the copies share the camera budget (through a node there is one copy, left uncapped).
export async function applyCallPriorities(senders: { mic: ShareSender[]; camera: ShareSender[] }, cameraCopies?: number): Promise<void> {
  const camera = cameraCopies === undefined ? picturePriority : { maxBitrate: cameraBitrate(cameraCopies), ...picturePriority };
  await Promise.all([
    ...senders.mic.map((s) => tune(s, { encoding: voicePriority })),
    ...senders.camera.map((s) => tune(s, { encoding: camera })),
  ]);
}

// getParameters and setParameters run in the same task, as the browser requires. A sender not negotiated yet (no
// encodings) is left for the next pass, and one that already has the settings isn't renegotiated.
async function tune(sender: ShareSender, settings: SenderSettings): Promise<void> {
  const params = sender.getParameters();
  if (params.encodings.length === 0) return;
  const wanted = Object.entries(settings.encoding) as [keyof SenderSettings["encoding"], unknown][];
  const alreadySet = params.encodings.every((e) => wanted.every(([key, value]) => e[key] === value))
    && (!settings.degradationPreference || params.degradationPreference === settings.degradationPreference);
  if (alreadySet) return;
  params.encodings = params.encodings.map((e) => ({ ...e, ...settings.encoding }));
  if (settings.degradationPreference) params.degradationPreference = settings.degradationPreference;
  try {
    await sender.setParameters(params);
  } catch (e) {
    console.warn("Call: sender settings not applied:", e);
  }
}

// One sent stream's numbers from its sender's getStats() report.
export interface OutboundSample {
  id: string;
  // When it was measured (ms) and the bytes sent so far, for the bitrate between two polls.
  at: number;
  bytes: number;
  width?: number;
  height?: number;
  fps?: number;
  // The encoder's target (bit/s), and what holds it back.
  target?: number;
  limitation?: RTCQualityLimitationReason;
}

export function readOutbound(report: RTCStatsReport): OutboundSample | null {
  let sample: OutboundSample | null = null;
  report.forEach((s: Record<string, unknown>) => {
    if (s.type !== "outbound-rtp" || sample) return;
    const found: OutboundSample = { id: String(s.id), at: Number(s.timestamp ?? 0), bytes: Number(s.bytesSent ?? 0) };
    if (typeof s.frameWidth === "number" && typeof s.frameHeight === "number") Object.assign(found, { width: s.frameWidth, height: s.frameHeight });
    if (typeof s.framesPerSecond === "number") found.fps = s.framesPerSecond;
    if (typeof s.targetBitrate === "number") found.target = s.targetBitrate;
    if (typeof s.qualityLimitationReason === "string") found.limitation = s.qualityLimitationReason as RTCQualityLimitationReason;
    sample = found;
  });
  return sample;
}

// The numbers of the live line. The picture is the copy with the lowest frame rate (what the weakest viewer gets),
// the bitrate (bit/s) the average per copy.
export type ShareNumbers = { width?: number; height?: number; fps?: number; bitrate?: number; limitation?: RTCQualityLimitationReason };

export interface ShareStats extends ShareNumbers {
  copies: number;
  viaNode: boolean;
  cap: EffectiveBitrate;
  // The call's node is older than screen sound and can't carry the computer's sound.
  soundRefused: boolean;
}

// This poll's pictures against the previous poll's (by stats id) for the bitrate; the encoder's target until then.
export function summarizeShare(samples: OutboundSample[], previous: ReadonlyMap<string, OutboundSample>): ShareNumbers {
  const rates = samples.flatMap((s) => {
    const before = previous.get(s.id);
    if (before && s.at > before.at && s.bytes >= before.bytes) return [((s.bytes - before.bytes) * 8 * 1000) / (s.at - before.at)];
    return s.target === undefined ? [] : [s.target];
  });
  const worst = [...samples].sort((a, b) => (a.fps ?? Infinity) - (b.fps ?? Infinity))[0];
  const result: ShareNumbers = {};
  if (worst?.width !== undefined) Object.assign(result, { width: worst.width, height: worst.height });
  if (worst?.fps !== undefined) result.fps = worst.fps;
  if (rates.length > 0) result.bitrate = Math.round(rates.reduce((a, b) => a + b, 0) / rates.length);
  const limitation = samples.map((s) => s.limitation).find((l) => l && l !== "none");
  if (limitation) result.limitation = limitation;
  return result;
}

const limitationText: Partial<Record<RTCQualityLimitationReason, string>> = { bandwidth: "bandwidth", cpu: "the CPU" };

export function describeShareStats(stats: ShareStats): string {
  const parts: string[] = [];
  if (stats.width !== undefined && stats.height !== undefined) parts.push(`${stats.width}x${stats.height}`);
  if (stats.fps !== undefined) parts.push(`${Math.round(stats.fps)} fps`);
  if (stats.bitrate !== undefined) parts.push(`${(stats.bitrate / 1_000_000).toFixed(1)} Mbit/s`);
  if (stats.limitation && limitationText[stats.limitation]) parts.push(`limited by ${limitationText[stats.limitation]}`);
  if (stats.cap.capped && stats.cap.reason) parts.push(stats.cap.reason);
  return parts.join(", ");
}
