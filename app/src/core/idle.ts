import { createSignal } from "solid-js";

export const awayAfterMs = 15 * 60_000;
const [idle, setIdle] = createSignal(false);
export { idle };

let started = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let lastInput = 0;
let activity: (() => void) | undefined;

export function startIdleTracker(): void {
  if (started) return;
  started = true;
  lastInput = Date.now();
  activity = () => {
    lastInput = Date.now();
    setIdle(false);
    clearTimeout(timer);
    timer = setTimeout(() => setIdle(Date.now() - lastInput >= awayAfterMs), awayAfterMs);
  };
  for (const name of ["pointermove", "pointerdown", "keydown", "wheel", "focus"])
    window.addEventListener(name, activity, { passive: true });
  activity();
}

// Activity without input: talking in a call. Called often, so it does anything at most once a second.
export function markActive(): void {
  if (activity && Date.now() - lastInput >= 1000) activity();
}

export function stopIdleTracker(): void {
  if (!started || !activity) return;
  for (const name of ["pointermove", "pointerdown", "keydown", "wheel", "focus"])
    window.removeEventListener(name, activity);
  clearTimeout(timer);
  timer = undefined;
  activity = undefined;
  started = false;
  setIdle(false);
}
