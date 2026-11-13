// Microphone choices, per device: noise suppression, voice activation's sensitivity, the input mode and push to
// talk's key.
import { createSignal } from "solid-js";
import { readJson, writeJson } from "../core/storage";
import { defaultPttKey, type InputMode, type PttKey } from "./pushToTalk";

// off: nothing; standard: the browser's own suppression; strong: RNNoise on top of that.
export type NoiseSuppression = "off" | "standard" | "strong";

const noiseKey = "mw.voice.noiseSuppression";
const sensitivityKey = "mw.voice.sensitivityDb";
const inputModeKey = "mw.voice.inputMode";
const pttKeyKey = "mw.voice.pttKey";
export const sensitivityRange = { min: -80, max: -10 };

const [noiseSuppression, setNoiseSignal] = createSignal<NoiseSuppression>(readJson(noiseKey, "standard"));
// The level (dBFS) speech has to reach to be sent; null decides automatically from the room's noise.
const [sensitivityDb, setSensitivitySignal] = createSignal<number | null>(readJson(sensitivityKey, null));
// voice: the gate decides when to send; push-to-talk: only while the key is held.
const [inputMode, setInputModeSignal] = createSignal<InputMode>(readJson<InputMode>(inputModeKey, "voice") === "push-to-talk" ? "push-to-talk" : "voice");
const [pttKey, setPttKeySignal] = createSignal<PttKey>(readJson(pttKeyKey, defaultPttKey));
// Set while Settings > Audio listens for the next key, so the push-to-talk listener leaves it alone.
const [capturingPttKey, setCapturingPttKey] = createSignal(false);
export { noiseSuppression, sensitivityDb, inputMode, pttKey, capturingPttKey, setCapturingPttKey };

export function setNoiseSuppression(value: NoiseSuppression): void {
  setNoiseSignal(value);
  writeJson(noiseKey, value);
}

export function setSensitivityDb(value: number | null): void {
  const clamped = value === null ? null : Math.min(sensitivityRange.max, Math.max(sensitivityRange.min, Math.round(value)));
  setSensitivitySignal(clamped);
  writeJson(sensitivityKey, clamped);
}

export function setInputMode(value: InputMode): void {
  setInputModeSignal(value);
  writeJson(inputModeKey, value);
}

export function setPttKey(value: PttKey): void {
  setPttKeySignal(value);
  writeJson(pttKeyKey, value);
}
