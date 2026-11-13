// Volume per member, of their voice and of the sound they share (and for your own microphone and overall output),
// 0 to 3 (300%). Kept on this device; a member's user id is the same in every workspace, so their volume follows them.
import { createSignal } from "solid-js";
import { readJson, writeJson } from "../core/storage";

export const maxVolume = 3;
const key = "mw.voice.volumes";
const streamKey = "mw.voice.streamVolumes";
const micKey = "mw.voice.micVolume";
const outputKey = "mw.voice.outputVolume";

const [volumes, setVolumes] = createSignal<Record<string, number>>(readJson(key, {}));
const [streamVolumes, setStreamVolumes] = createSignal<Record<string, number>>(readJson(streamKey, {}));
const [micVolume, setMicVolumeSignal] = createSignal<number>(readJson(micKey, 1));
const [outputVolume, setOutputVolumeSignal] = createSignal<number>(readJson(outputKey, 1));
export { micVolume, outputVolume };

// Volumes members start at here until they are changed (a media bot plays quieter), by user id.
const [defaults, setDefaults] = createSignal<Record<string, number>>({});

export function setDefaultVolume(userId: number, volume: number): void {
  if (defaults()[userId] !== volume) setDefaults({ ...defaults(), [userId]: volume });
}

const clamp = (v: number) => Math.min(maxVolume, Math.max(0, Number.isFinite(v) ? v : 1));

export function userVolume(userId: number): number {
  return volumes()[userId] ?? defaults()[userId] ?? 1;
}

export function setUserVolume(userId: number, volume: number): void {
  setVolumes(withVolume(volumes(), userId, volume));
  writeJson(key, volumes());
}

export function streamVolume(userId: number): number {
  return streamVolumes()[userId] ?? defaults()[userId] ?? 1;
}

export function setStreamVolume(userId: number, volume: number): void {
  setStreamVolumes(withVolume(streamVolumes(), userId, volume));
  writeJson(streamKey, streamVolumes());
}

function withVolume(all: Record<string, number>, userId: number, volume: number): Record<string, number> {
  const next: Record<string, number> = { ...all, [userId]: clamp(volume) };
  if (next[userId] === (defaults()[userId] ?? 1)) delete next[userId];
  return next;
}

export function setMicVolume(volume: number): void {
  setMicVolumeSignal(clamp(volume));
  writeJson(micKey, micVolume());
}

export function setOutputVolume(volume: number): void {
  setOutputVolumeSignal(clamp(volume));
  writeJson(outputKey, outputVolume());
}

// The loudness guard (loudness.ts): boosts stay for quiet sound only. On unless switched off in Settings > Audio.
const loudnessKey = "mw.voice.loudnessSafety";
const [loudnessSafety, setLoudnessSafetySignal] = createSignal<boolean>(readJson(loudnessKey, true));
export { loudnessSafety };

export function setLoudnessSafety(on: boolean): void {
  setLoudnessSafetySignal(on);
  writeJson(loudnessKey, on);
}

// Members muted for you only: their voice doesn't play here, but their speaking dot still moves.
const localMuteKey = "mw.voice.localMutes";
const [localMutes, setLocalMutes] = createSignal<number[]>(readJson(localMuteKey, []));

export function isLocallyMuted(userId: number): boolean {
  return localMutes().includes(userId);
}

export function toggleLocalMute(userId: number): void {
  setLocalMutes(isLocallyMuted(userId) ? localMutes().filter((id) => id !== userId) : [...localMutes(), userId]);
  writeJson(localMuteKey, localMutes());
}
