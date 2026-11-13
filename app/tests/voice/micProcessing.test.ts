import { describe, expect, it } from "vitest";
import { createMicProcessor, type MicProcessor } from "../../src/voice/micProcessing";

const sampleRate = 48000;
const block = 128;
const amplitude = (db: number) => 10 ** (db / 20) * Math.SQRT2;

// A voice at an RMS level (dBFS): a 220 Hz tone in syllables (150 ms on, 100 ms off) over faint noise.
function voice(db: number) {
  return (t: number, noise: number) => (t % 0.25 < 0.15 ? amplitude(db) * Math.sin(2 * Math.PI * 220 * t) : 0) + noise;
}
const steady = (db: number) => (t: number, noise: number) => amplitude(db) * Math.sin(2 * Math.PI * 220 * t) + noise;
const silence = () => (_t: number, noise: number) => noise;

// Feeds `seconds` of a signal in audio-thread blocks; returns the input and output RMS of the last 100 ms.
function run(mic: MicProcessor, clock: { n: number; seed: number }, seconds: number, signal: (t: number, noise: number) => number) {
  const input = new Float32Array(block);
  const output = new Float32Array(block);
  const tail = Math.round(0.1 * sampleRate);
  const total = Math.round(seconds * sampleRate);
  let inSum = 0;
  let outSum = 0;
  for (let done = 0; done < total; done += block) {
    for (let i = 0; i < block; i++) {
      clock.seed = (clock.seed * 1664525 + 1013904223) >>> 0;
      const noise = (clock.seed / 2 ** 32 - 0.5) * amplitude(-72);
      input[i] = signal((clock.n + i) / sampleRate, noise);
    }
    clock.n += block;
    mic.process(input, output);
    if (done >= total - tail) {
      for (let i = 0; i < block; i++) {
        inSum += input[i] ** 2;
        outSum += output[i] ** 2;
      }
    }
  }
  return { inDb: 10 * Math.log10(inSum), outDb: 10 * Math.log10(outSum) };
}

describe("microphone processing", () => {
  it("brings a quiet voice up to speech level", () => {
    const mic = createMicProcessor({ sampleRate });
    const clock = { n: 0, seed: 1 };
    run(mic, clock, 1, silence());
    run(mic, clock, 10, voice(-50));
    expect(mic.state().speechDb).toBeCloseTo(-50, 0);
    expect(mic.state().gainDb).toBeCloseTo(28, 0);
  });

  it("starts from the level measured last time", () => {
    const mic = createMicProcessor({ sampleRate, speechDb: -46 });
    expect(mic.state().gainDb).toBe(24);
  });

  it("doesn't turn the voice down after a short loud sound", () => {
    const mic = createMicProcessor({ sampleRate, speechDb: -50 });
    const clock = { n: 0, seed: 2 };
    run(mic, clock, 1, silence());
    run(mic, clock, 8, voice(-50));
    const before = mic.state().gainDb;
    // A laugh or a knock: a second far louder than the voice.
    run(mic, clock, 1, voice(-15));
    expect(before - mic.state().gainDb).toBeLessThan(3);
    run(mic, clock, 2, voice(-50));
    expect(Math.abs(mic.state().gainDb - before)).toBeLessThan(1);
  });

  it("follows a voice that stays louder", () => {
    const mic = createMicProcessor({ sampleRate, speechDb: -50 });
    const clock = { n: 0, seed: 3 };
    run(mic, clock, 1, silence());
    run(mic, clock, 20, voice(-34));
    expect(mic.state().gainDb).toBeCloseTo(12, 0);
  });

  it("sends speech and holds the gate down in silence", () => {
    const mic = createMicProcessor({ sampleRate, speechDb: -40 });
    const clock = { n: 0, seed: 4 };
    run(mic, clock, 1, silence());
    const speaking = run(mic, clock, 2, steady(-40));
    expect(mic.state().speaking).toBe(true);
    expect(speaking.outDb - speaking.inDb).toBeCloseTo(mic.state().gainDb, 0);
    const quiet = run(mic, clock, 2, silence());
    expect(mic.state().speaking).toBe(false);
    // Gate closed: -34 dB on top of the gain.
    expect(quiet.outDb - quiet.inDb).toBeCloseTo(mic.state().gainDb - 34, 0);
  });

  it("stops treating a steady noise as speech", () => {
    const mic = createMicProcessor({ sampleRate });
    const clock = { n: 0, seed: 5 };
    run(mic, clock, 1, silence());
    run(mic, clock, 1, steady(-35));
    expect(mic.state().speaking).toBe(true);
    run(mic, clock, 6, steady(-35));
    expect(mic.state().speaking).toBe(false);
  });

  it("uses the sensitivity setting when there is one", () => {
    const mic = createMicProcessor({ sampleRate, threshold: -40 });
    const clock = { n: 0, seed: 6 };
    run(mic, clock, 1, voice(-50));
    expect(mic.state().speaking).toBe(false);
    mic.setThreshold(-60);
    run(mic, clock, 0.5, voice(-50));
    expect(mic.state().speaking).toBe(true);
  });

  it("holds the gate open while push to talk is held", () => {
    const mic = createMicProcessor({ sampleRate, speechDb: -40 });
    const clock = { n: 0, seed: 7 };
    mic.setPushToTalk(true);
    run(mic, clock, 1, silence());
    const open = run(mic, clock, 2, silence());
    // Open: silence passes at the gain, but the detector still says nobody speaks.
    expect(mic.state().speaking).toBe(false);
    expect(open.outDb - open.inDb).toBeCloseTo(mic.state().gainDb, 0);
    mic.setPushToTalk(false);
    const closed = run(mic, clock, 2, silence());
    // Closed again: -34 dB on top of the gain.
    expect(closed.outDb - closed.inDb).toBeCloseTo(mic.state().gainDb - 34, 0);
  });
});
