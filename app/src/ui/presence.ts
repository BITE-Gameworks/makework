// Keeps an element mounted while it animates out. `visible` turns on a frame after mounting, so CSS
// transitions run on the way in as well.
import { createEffect, createSignal, on, onCleanup } from "solid-js";

// Matches --mw-duration in theme/base.css.
const durationMs = 180;

export function motionMs(): number {
  return matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : durationMs;
}

export function createPresence(show: () => boolean) {
  const [mounted, setMounted] = createSignal(show());
  const [visible, setVisible] = createSignal(show());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame: number | undefined;

  createEffect(on(show, (shown) => {
    clearTimeout(timer);
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (shown) {
      setMounted(true);
      frame = requestAnimationFrame(() => (frame = requestAnimationFrame(() => setVisible(true))));
    } else {
      setVisible(false);
      timer = setTimeout(() => setMounted(false), motionMs());
    }
  }, { defer: true }));

  onCleanup(() => {
    clearTimeout(timer);
    if (frame !== undefined) cancelAnimationFrame(frame);
  });

  return { mounted, visible };
}
