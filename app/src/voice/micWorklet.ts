// The microphone's gain and gate (micProcessing.ts) as an AudioWorklet processor, "mw-mic". Runs on the audio
// thread, so it keeps working while the window is hidden. Messages in: { threshold }, { ptt }. Out, about every
// 60 ms: the MicState.
import { createMicProcessor, type MicProcessor } from "./micProcessing";

// The AudioWorklet global scope (the project's lib is the DOM one).
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: new (options: { processorOptions?: Options }) => AudioWorkletProcessor): void;
declare const sampleRate: number;
declare const currentTime: number;

interface Options {
  threshold: number | null;
  speechDb: number;
}

const postSeconds = 0.06;

class MicProcessorNode extends AudioWorkletProcessor {
  private readonly mic: MicProcessor;
  private lastPost = -Infinity;
  private silence = new Float32Array(128);

  constructor(options: { processorOptions?: Options }) {
    super();
    this.mic = createMicProcessor({ sampleRate, ...options.processorOptions });
    this.port.onmessage = (event: MessageEvent<{ threshold?: number | null; ptt?: boolean }>) => {
      if ("threshold" in event.data) this.mic.setThreshold(event.data.threshold ?? null);
      if ("ptt" in event.data) this.mic.setPushToTalk(event.data.ptt ?? false);
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    const first = output?.[0];
    if (first) {
      // Nothing connected still counts as silence, so the gate and its hold keep time.
      let input = inputs[0]?.[0];
      if (!input) {
        if (this.silence.length !== first.length) this.silence = new Float32Array(first.length);
        input = this.silence;
      }
      this.mic.process(input, first);
      for (let c = 1; c < output.length; c++) output[c].set(first);
    }
    if (currentTime - this.lastPost >= postSeconds) {
      this.lastPost = currentTime;
      this.port.postMessage(this.mic.state());
    }
    return true;
  }
}

registerProcessor("mw-mic", MicProcessorNode);
