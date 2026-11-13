// What happens to the microphone before others hear it, sample by sample: automatic gain that brings speech to one
// level (some headsets deliver speech around -50 dBFS), then a noise gate that closes while nobody speaks (the boost
// would raise background hiss just as much). It runs in an AudioWorklet (micWorklet.ts), on the audio thread: driven
// by animation frames it stopped whenever the window was hidden or covered, leaving the gate closed (-34 dB) while
// the voice still went out.
import { createSpeakingDetector } from "./levels";

export const speechTargetDb = -22;
export const maxAutoGainDb = 30;
export const gateClosed = 0.02;
const frameSeconds = 0.01;
// The speech level is a high percentile of the last few seconds of speech, so a laugh, cough or knock (a small
// part of that window) barely moves it, and the gain never chases single loud moments; the limiter after the
// chain catches their peaks.
const speechWindowFrames = 800;
const speechPercentile = 0.8;
// Until this much speech was heard, the level saved from the last call counts.
const minSpeechFrames = 100;
const gainDbPerSecond = 6;
const gainSmoothSeconds = 0.05;
const gateOpenSeconds = 0.005;
const gateCloseSeconds = 0.12;

export interface MicState {
  // This 10 ms reading, dBFS.
  db: number;
  // How far above the noise floor, 0-1.
  level: number;
  floorDb: number;
  speaking: boolean;
  speechDb: number;
  gainDb: number;
}

export interface MicProcessor {
  // Writes the processed input to output (same length).
  process(input: Float32Array, output: Float32Array): void;
  state(): MicState;
  // The sensitivity setting: speech is anything above it (dBFS); null decides from the room's noise.
  setThreshold(db: number | null): void;
  // Push to talk: hold the gate open while the key is held, so the first syllable isn't clipped by the detector.
  // state().speaking still follows the detector, so the speaking dot doesn't light while holding in silence.
  setPushToTalk(open: boolean): void;
}

export const autoGainDbFor = (speechDb: number) => Math.min(maxAutoGainDb, Math.max(0, speechTargetDb - speechDb));

export function createMicProcessor(options: { sampleRate: number; threshold?: number | null; speechDb?: number }): MicProcessor {
  const { sampleRate } = options;
  let threshold = options.threshold ?? null;
  const detector = createSpeakingDetector(() => threshold);
  const frameLength = Math.max(1, Math.round(sampleRate * frameSeconds));
  const smooth = (seconds: number) => 1 - Math.exp(-1 / (seconds * sampleRate));
  const gainSmooth = smooth(gainSmoothSeconds);
  const gateOpen = smooth(gateOpenSeconds);
  const gateClose = smooth(gateCloseSeconds);

  const speech = new Float32Array(speechWindowFrames);
  let speechCount = 0;
  let newSpeech = 0;
  let speechDb = options.speechDb ?? speechTargetDb;
  let gainDb = autoGainDbFor(speechDb);
  let gainTarget = 10 ** (gainDb / 20);
  let gain = gainTarget;
  let gate = gateClosed;
  let gateTarget = gateClosed;
  let pushToTalk = false;

  let sum = 0;
  let count = 0;
  let frames = 0;
  let state: MicState = { db: -Infinity, level: 0, floorDb: detector.floorDb(), speaking: false, speechDb, gainDb };

  // Sorted in a second buffer, so the audio thread allocates nothing.
  const sorted = new Float32Array(speechWindowFrames);
  function speechLevel(): number {
    const n = Math.min(speechCount, speechWindowFrames);
    const heard = sorted.subarray(0, n);
    heard.set(speech.subarray(0, n));
    heard.sort();
    return heard[Math.min(n - 1, Math.floor(n * speechPercentile))];
  }

  function frame() {
    const db = 20 * Math.log10(Math.sqrt(sum / count) + 1e-9);
    sum = 0;
    count = 0;
    frames++;
    const result = detector.update(db, frames * frameSeconds * 1000);
    if (result.loud) {
      speech[speechCount % speechWindowFrames] = db;
      speechCount++;
      // Sorting the window is cheap, but not worth doing every 10 ms.
      if (++newSpeech >= 10 && speechCount >= minSpeechFrames) {
        newSpeech = 0;
        speechDb = speechLevel();
      }
    }
    const step = gainDbPerSecond * frameSeconds;
    gainDb += Math.max(-step, Math.min(step, autoGainDbFor(speechDb) - gainDb));
    gainTarget = 10 ** (gainDb / 20);
    gateTarget = pushToTalk || result.speaking ? 1 : gateClosed;
    state = { db, level: result.level, floorDb: detector.floorDb(), speaking: result.speaking, speechDb, gainDb };
  }

  return {
    process(input, output) {
      for (let i = 0; i < input.length; i++) {
        const sample = input[i];
        sum += sample * sample;
        if (++count >= frameLength) frame();
        gain += (gainTarget - gain) * gainSmooth;
        gate += (gateTarget - gate) * (gateTarget > gate ? gateOpen : gateClose);
        output[i] = sample * gain * gate;
      }
    },
    state: () => state,
    setThreshold(db) {
      threshold = db;
    },
    setPushToTalk(open) {
      pushToTalk = open;
    },
  };
}
