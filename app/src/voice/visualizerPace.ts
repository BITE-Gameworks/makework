// How often a sound visualizer (SoundVisualizer.tsx) draws. Every frame it draws makes the window draw, so it draws
// only while someone can see it and there is sound to show.

export interface PaceState {
  // On screen: not in a hidden view, not scrolled away, the page not hidden.
  visible: boolean;
  // The sound has something to show, or the bars are still settling after it.
  sound: boolean;
  focused: boolean;
  // Power saving (core/power.ts).
  saving: boolean;
  reducedMotion: boolean;
}

export interface Pace {
  // How long until the next look at the sound; null: stopped until it is visible again.
  waitMs: number | null;
  // Whether that look draws.
  draw: boolean;
  // Whether the ring of ticks turns.
  turn: boolean;
}

export function pace(state: PaceState): Pace {
  if (!state.visible) return { waitMs: null, draw: false, turn: false };
  if (!state.sound) return { waitMs: 125, draw: false, turn: false };
  const front = state.focused && !state.saving;
  return { waitMs: front ? 33 : 66, draw: true, turn: front && !state.reducedMotion };
}

// Below this (0-1 of full scale) a bar, the bass or a frequency bin counts as nothing to show.
const nothing = 0.02;

// Whether a visualizer has anything to draw: a frequency heard now (`data`, the analyser's bytes), or bars or bass
// still falling after the sound stopped. Once neither, one last still frame is drawn and it rests (`pace`).
export function hasSound(data: Uint8Array, heights: Float32Array, bass: number): boolean {
  if (bass > nothing) return true;
  for (const h of heights) if (h > nothing) return true;
  for (const d of data) if (d / 255 > nothing) return true;
  return false;
}

// Canvas pixels per CSS pixel at most, and canvas pixels a side at most: the bars are soft, and every pixel drawn
// is uploaded and composited on each frame.
const maxScale = 1.5;
const maxSide = 1200;

// The canvas's own size for a box of `cssWidth` x `cssHeight` CSS pixels, and its pixels per CSS pixel.
export function backingSize(cssWidth: number, cssHeight: number, dpr: number): { width: number; height: number; scale: number } {
  const scale = Math.min(dpr, maxScale, maxSide / Math.max(cssWidth, cssHeight, 1));
  return { width: Math.round(cssWidth * scale), height: Math.round(cssHeight * scale), scale };
}
