import { describe, expect, it } from "vitest";
import { createSpeakingDetector, stepLevel } from "../../src/voice/levels";

// Feeds readings every 100 ms (like the players) and returns the last result.
function feed(detector: ReturnType<typeof createSpeakingDetector>, clock: { t: number }, db: (t: number) => number, ms: number) {
  let last = detector.update(db(clock.t), clock.t);
  for (const end = clock.t + ms; clock.t < end; clock.t += 100) last = detector.update(db(clock.t), clock.t);
  return last;
}

describe("speaking detector", () => {
  it("follows speech with pauses", () => {
    const d = createSpeakingDetector();
    const clock = { t: 0 };
    feed(d, clock, () => -65, 2000);
    expect(feed(d, clock, () => -30, 400).speaking).toBe(true);
    expect(feed(d, clock, () => -65, 600).speaking).toBe(false);
    expect(feed(d, clock, () => -30, 400).speaking).toBe(true);
  });

  it("stops counting a steady noise as speech within a few seconds", () => {
    const d = createSpeakingDetector();
    const clock = { t: 0 };
    feed(d, clock, () => -65, 2000);
    expect(feed(d, clock, () => -35, 1000).speaking).toBe(true);
    expect(feed(d, clock, () => -35, 3000).speaking).toBe(false);
    // Still quiet about it later on.
    expect(feed(d, clock, () => -35, 5000).speaking).toBe(false);
  });

  it("hears speech again once the noise stops", () => {
    const d = createSpeakingDetector();
    const clock = { t: 0 };
    feed(d, clock, () => -65, 2000);
    feed(d, clock, () => -35, 8000);
    feed(d, clock, () => -65, 500);
    expect(feed(d, clock, () => -30, 400).speaking).toBe(true);
  });
});

// The share of readings every 100 ms, from `from` on, that counted as speaking.
function speakingShare(readings: (t: number) => number, from: number, to: number) {
  const detector = createSpeakingDetector();
  let speaking = 0;
  let total = 0;
  for (let t = 0; t <= to; t += 100) {
    const result = detector.update(readings(t), t);
    if (t >= from) {
      total++;
      if (result.speaking) speaking++;
    }
  }
  return speaking / total;
}

describe("speaking detector with long speech", () => {
  it("keeps counting speech without pauses as speaking", () => {
    // Settle on the room's noise, then talk for 10 s: loudness swings with each syllable but never drops to the floor.
    const speech = (t: number) => (t < 2000 ? -65 : -30 + 8 * Math.sin(t / 50));
    expect(speakingShare(speech, 2000, 12000)).toBeGreaterThan(0.95);
  });
});

// The speaking dots show the level in a few sizes: each change makes the page draw, so a level wavering inside a step
// changes nothing.
describe("level steps", () => {
  it("rounds a level to quarters, inside 0 to 1", () => {
    expect([0, 0.1, 0.13, 0.37, 0.5, 0.62, 0.88, 1, 1.4, -0.2].map(stepLevel)).toEqual([0, 0, 0.25, 0.25, 0.5, 0.5, 1, 1, 1, 0]);
  });
});
