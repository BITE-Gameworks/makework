import { describe, expect, it } from "vitest";
import { createLoudnessGuard, gainAt, positionOf } from "../../src/voice/loudness";

const rate = 48000;
const tone = (amplitude: number, seconds: number) => Float32Array.from({ length: rate * seconds }, (_, i) => amplitude * Math.sin(i / 10));
const peak = (samples: Float32Array) => samples.slice(-rate / 10).reduce((m, v) => Math.max(m, Math.abs(v)), 0);

function run(input: Float32Array, boost: number, on = true) {
  const guard = createLoudnessGuard(rate);
  const out = new Float32Array(input.length);
  guard.process([input], [out], boost, on);
  return out;
}

describe("volume curve", () => {
  it("puts 100% of 300% near two thirds and round trips", () => {
    expect(positionOf(1, 3)).toBeCloseTo(0.693, 2);
    expect(gainAt(positionOf(0.05, 3), 3)).toBeCloseTo(0.05, 6);
  });
});

describe("loudness guard", () => {
  it("leaves quiet boosted sound alone", () => {
    const quiet = tone(0.01 * 3, 1);
    expect(peak(run(quiet, 3))).toBeCloseTo(peak(quiet), 3);
  });

  it("takes back the boost of loud sound, never below its own level", () => {
    const loud = tone(0.5 * 3, 1);
    expect(peak(run(loud, 3))).toBeCloseTo(0.5, 2);
  });

  it("does nothing at 100% or when off", () => {
    const loud = tone(0.9, 1);
    expect(peak(run(loud, 1))).toBeCloseTo(peak(loud), 3);
    expect(peak(run(tone(1.5, 1), 3, false))).toBeCloseTo(1.5, 3);
  });
});
