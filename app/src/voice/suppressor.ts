// RNNoise (neural noise suppression) as an audio node. Loaded on first use only. Needs a 48 kHz context.
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";

let binary: Promise<ArrayBuffer> | undefined;
const loaded = new WeakSet<BaseAudioContext>();

export async function createSuppressor(context: AudioContext): Promise<AudioNode & { destroy(): void }> {
  if (context.sampleRate !== 48000) throw new Error(`RNNoise needs 48 kHz audio, not ${context.sampleRate} Hz.`);
  const { loadRnnoise, RnnoiseWorkletNode } = await import("@sapphi-red/web-noise-suppressor");
  binary ??= loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl }).catch((e) => {
    binary = undefined;
    throw e;
  });
  const wasmBinary = await binary;
  if (!loaded.has(context)) {
    await context.audioWorklet.addModule(rnnoiseWorkletUrl);
    loaded.add(context);
  }
  return new RnnoiseWorkletNode(context, { wasmBinary, maxChannels: 1 });
}
