// Volume sliders and the loudness guard.
//
// Sliders follow perceived loudness: the gain is the slider's position cubed (about 60 dB from bottom to top), so
// the quiet end has room and 100% sits at about two thirds of a 300% slider.
//
// The guard keeps boosts (volumes over 100%) for quiet sound: when what plays gets louder than `ceilingDb`, it takes
// the boost back, down to the sound's own level at most. Sound at 100% or less passes untouched, so a member
// turned up for a quiet microphone can't blast loud music at the listener. Runs per player in an AudioWorklet
// (loudnessWorklet.ts), after the player's gain.

export const positionSteps = 1000;

export const gainAt = (position: number, max: number) => max * Math.min(1, Math.max(0, position)) ** 3;
export const positionOf = (gain: number, max: number) => (max > 0 ? Math.min(1, Math.max(0, gain / max)) ** (1 / 3) : 0);

// "5%", "0.4%" below 10%, so the quiet end shows its steps.
export function volumeLabel(gain: number): string {
  const percent = gain * 100;
  return `${percent < 10 && percent > 0 ? Math.round(percent * 10) / 10 : Math.round(percent)}%`;
}

// About 6 dB over the level microphones are brought to (micProcessing speechTargetDb).
export const ceilingDb = -16;
const levelAttackMs = 10;
const levelReleaseMs = 400;
const gainAttackMs = 5;
const gainReleaseMs = 600;

export interface LoudnessGuard {
  // `boost`: the gain already applied before the guard (the player's volume); `on`: the setting.
  process(channels: Float32Array[], outputs: Float32Array[], boost: number, on: boolean): void;
  // How much the guard took back, 0..1 (1: nothing), for diagnostics.
  factor(): number;
}

export function createLoudnessGuard(sampleRate: number): LoudnessGuard {
  const coefficient = (ms: number) => Math.exp(-1 / ((ms / 1000) * sampleRate));
  const levelAttack = coefficient(levelAttackMs);
  const levelRelease = coefficient(levelReleaseMs);
  const gainAttack = coefficient(gainAttackMs);
  const gainRelease = coefficient(gainReleaseMs);
  const ceiling = 10 ** (ceilingDb / 20);
  let meanSquare = 0;
  let applied = 1;

  return {
    process(channels, outputs, boost, on) {
      const length = outputs[0]?.length ?? 0;
      const floor = on && boost > 1 ? 1 / boost : 1;
      for (let i = 0; i < length; i++) {
        let square = 0;
        for (const channel of channels) square = Math.max(square, channel[i] * channel[i]);
        const c = square > meanSquare ? levelAttack : levelRelease;
        meanSquare = c * meanSquare + (1 - c) * square;
        const level = Math.sqrt(meanSquare);
        const wanted = floor >= 1 ? 1 : Math.min(1, Math.max(floor, level > ceiling ? ceiling / level : 1));
        const g = wanted < applied ? gainAttack : gainRelease;
        applied = g * applied + (1 - g) * wanted;
        for (let ch = 0; ch < outputs.length; ch++) outputs[ch][i] = (channels[ch] ?? channels[0])[i] * applied;
      }
    },
    factor: () => applied,
  };
}
