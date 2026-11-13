// The loudness guard (loudness.ts) as an AudioWorklet processor, "mw-loudness". Messages in: { boost, on }.
import { createLoudnessGuard, type LoudnessGuard } from "./loudness";

// The AudioWorklet global scope (the project's lib is the DOM one).
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;
declare const sampleRate: number;

class LoudnessNode extends AudioWorkletProcessor {
  private readonly guard: LoudnessGuard = createLoudnessGuard(sampleRate);
  private boost = 1;
  private on = true;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<{ boost?: number; on?: boolean }>) => {
      if (typeof event.data.boost === "number") this.boost = event.data.boost;
      if (typeof event.data.on === "boolean") this.on = event.data.on;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const output = outputs[0];
    if (!output?.length) return true;
    if (!input?.length) {
      for (const channel of output) channel.fill(0);
      return true;
    }
    this.guard.process(input, output, this.boost, this.on);
    return true;
  }
}

registerProcessor("mw-loudness", LoudnessNode);
