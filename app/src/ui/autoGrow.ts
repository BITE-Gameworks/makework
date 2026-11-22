import { createEffect, on, onCleanup } from "solid-js";

// Makes a textarea as tall as its text. `scrollHeight` leaves out the borders, which the border-box `height` includes.
export function fitHeight(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  if (!el.scrollHeight) {
    el.style.height = "";
    return;
  }
  el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
}

// Keeps a textarea as tall as its text: while it is typed in, when `value` changes and when its width changes (which
// also covers a hidden field being shown). Call it from a ref inside a component; use it with `rows={1}` and
// `overflow: hidden`.
export function autoGrow(el: HTMLTextAreaElement, value: () => string): void {
  const fit = () => fitHeight(el);
  el.addEventListener("input", fit);
  createEffect(on(value, fit));
  // Only the width: a change of height is this function's own doing.
  let width = -1;
  const observer = new ResizeObserver(([entry]) => {
    if (entry.contentRect.width === width) return;
    width = entry.contentRect.width;
    fit();
  });
  observer.observe(el);
  onCleanup(() => observer.disconnect());
}
