// Tells speech from background noise for one microphone. The noise floor drops at once to quieter readings and
// creeps up slowly, so speech doesn't raise it. A sound that stays loud for a while at an even level (a fan, hum,
// steady noise) is treated as noise and the floor catches up quickly; speech, even without pauses, rises and falls
// with every syllable. Speaking is judged against that floor, not a fixed level: WebKitGTK delivers the same mic
// about 20 dB quieter than browsers.
const marginDb = 12;
const silenceDb = -70;
const slowRiseDbPerSecond = 1.5;
const fastRiseDbPerSecond = 12;
const steadyAfterMs = 2500;
// Loudness range over the last steadyAfterMs below which a loud sound counts as steady noise.
const steadyRangeDb = 6;
const holdMs = 350;

export interface SpeakingDetector {
  // Feeds one reading. speaking includes a short hold after speech; loud is this reading alone (speech, not
  // steady noise); level is how far above the floor it is (0-1).
  update(db: number, timeMs: number): { speaking: boolean; loud: boolean; level: number };
  floorDb(): number;
}

// With a threshold (dBFS), speech is simply anything above it; without one, the floor decides.
export function createSpeakingDetector(threshold: () => number | null = () => null): SpeakingDetector {
  let floorDb = -60;
  let lastTime: number | null = null;
  let lastLoud = -Infinity;
  let loudSince: number | null = null;
  let recent: { time: number; db: number }[] = [];

  return {
    update(db, time) {
      const seconds = lastTime === null ? 0 : Math.min(0.25, (time - lastTime) / 1000);
      lastTime = time;
      const fixed = threshold();
      const loud = fixed !== null ? db > fixed : db > silenceDb && db > floorDb + marginDb;
      if (loud) loudSince ??= time;
      else loudSince = null;
      recent = loud ? [...recent.filter((r) => time - r.time <= steadyAfterMs), { time, db }] : [];
      const range = recent.length ? Math.max(...recent.map((r) => r.db)) - Math.min(...recent.map((r) => r.db)) : 0;
      const steady = fixed === null && loudSince !== null && time - loudSince > steadyAfterMs && range < steadyRangeDb;
      floorDb = db < floorDb ? db : floorDb + (steady ? fastRiseDbPerSecond : slowRiseDbPerSecond) * seconds;
      if (loud && !steady) lastLoud = time;
      return {
        speaking: time - lastLoud < holdMs,
        loud: loud && !steady,
        level: Math.min(1, Math.max(0, (db - floorDb) / 30)),
      };
    },
    floorDb: () => floorDb,
  };
}

// A level (0-1) in the few sizes the speaking indicators show, so a level wavering inside one changes nothing: every
// change makes the page draw again (mesh-test s14: a call of 8 drew every frame while anyone spoke).
export function stepLevel(level: number): number {
  return stepTo(level, 4);
}

// A 0-1 value rounded to the nearest of `count` steps (and 0), for anything shown that would change on every reading.
export function stepTo(value: number, count: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * count) / count;
}
