import { describe, expect, it } from "vitest";
import { stepTo } from "../../src/voice/levels";
import { backingSize, hasSound, pace } from "../../src/voice/visualizerPace";

const shown = { visible: true, sound: true, focused: true, saving: false, reducedMotion: false };

describe("sound visualizer pace", () => {
  it("stops while nobody can see it", () => {
    expect(pace({ ...shown, visible: false })).toEqual({ waitMs: null, draw: false, turn: false });
  });

  it("only listens, a few times a second, while there is no sound", () => {
    expect(pace({ ...shown, sound: false })).toEqual({ waitMs: 125, draw: false, turn: false });
  });

  it("draws about 30 times a second with the ticks turning while sound plays in front", () => {
    expect(pace(shown)).toEqual({ waitMs: 33, draw: true, turn: true });
  });

  it("draws half as often with the ticks still in an unfocused window or while saving power", () => {
    expect(pace({ ...shown, focused: false })).toEqual({ waitMs: 66, draw: true, turn: false });
    expect(pace({ ...shown, saving: true })).toEqual({ waitMs: 66, draw: true, turn: false });
  });

  it("keeps the ticks still with reduced motion", () => {
    expect(pace({ ...shown, reducedMotion: true })).toEqual({ waitMs: 33, draw: true, turn: false });
  });
});

describe("sound to show", () => {
  const settled = new Float32Array(48);

  it("is none in digital silence once the bars have settled", () => {
    expect(hasSound(new Uint8Array(256), settled, 0)).toBe(false);
  });

  it("is some when any frequency is heard", () => {
    const data = new Uint8Array(256);
    data[40] = 120;
    expect(hasSound(data, settled, 0)).toBe(true);
  });

  it("is some while the bars or the bass are still falling after the sound stopped", () => {
    const falling = new Float32Array(48);
    falling[3] = 0.3;
    expect(hasSound(new Uint8Array(256), falling, 0)).toBe(true);
    expect(hasSound(new Uint8Array(256), settled, 0.2)).toBe(true);
  });
});

describe("canvas backing size", () => {
  it("draws at the screen's density up to 1.5 pixels per point", () => {
    expect(backingSize(300, 100, 1)).toEqual({ width: 300, height: 100, scale: 1 });
    expect(backingSize(600, 600, 2)).toEqual({ width: 900, height: 900, scale: 1.5 });
  });

  it("draws at most 1200 pixels a side, however big the stage", () => {
    expect(backingSize(1600, 1600, 1)).toEqual({ width: 1200, height: 1200, scale: 0.75 });
    expect(backingSize(2400, 1200, 2)).toEqual({ width: 1200, height: 600, scale: 0.5 });
  });
});

describe("stepped values", () => {
  it("rounds a 0-1 value to the nearest of a few steps, so a wavering value changes nothing", () => {
    expect(stepTo(0.51, 4)).toBe(0.5);
    expect(stepTo(0.63, 4)).toBe(0.75);
    expect(stepTo(0.5, 32)).toBe(0.5);
    expect(stepTo(0.505, 32)).toBe(0.5);
  });

  it("keeps the result between 0 and 1", () => {
    expect(stepTo(-0.2, 4)).toBe(0);
    expect(stepTo(1.4, 4)).toBe(1);
  });
});
