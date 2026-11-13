// Bot icons' eyes follow the pointer and blink. One listener for all icons, and only icons on screen are moved, in one
// animation frame per pointer move; the eyes shift with a transform (nothing that triggers layout).
// A blink is one short animation started on the icon's own rhythm, never an endless one: an endless CSS animation inside
// an SVG runs on the main thread, and while any ran (even in a hidden kept view) the whole page was restyled and
// painted on every frame, about half the main thread on a 165 Hz display.
import { createEffect, createRoot, on } from "solid-js";
import { powerSaving } from "../core/power";

const visible = new Set<SVGSVGElement>();
const rhythms = new Map<SVGSVGElement, { everyMs: number; next: number }>();
// While waiting for its host, a bot blinks this often.
const waitingEveryMs = 2000;
let blinkTimer: ReturnType<typeof setInterval> | undefined;
let pointer: { x: number; y: number } | null = null;
let frame = 0;
let observer: IntersectionObserver | null = null;
let listening = false;
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// How far the eyes may move, in the icon's 100 unit box, and how far away the pointer counts as "fully there".
const reach = 7;
const farPx = 200;

function update() {
  frame = 0;
  if (!pointer) return;
  for (const icon of visible) {
    const rect = icon.getBoundingClientRect();
    const dx = pointer.x - (rect.left + rect.width / 2);
    const dy = pointer.y - (rect.top + rect.height / 2);
    const distance = Math.hypot(dx, dy) || 1;
    const amount = Math.min(1, distance / farPx) * reach;
    icon.style.setProperty("--bot-look-x", `${((dx / distance) * amount).toFixed(2)}px`);
    icon.style.setProperty("--bot-look-y", `${((dy / distance) * amount).toFixed(2)}px`);
  }
}

function listen() {
  if (listening) return;
  listening = true;
  addEventListener("pointermove", (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    if (!frame && visible.size) frame = requestAnimationFrame(update);
  }, { passive: true });
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target as SVGSVGElement);
      else visible.delete(entry.target as SVGSVGElement);
    }
    if (pointer && !frame && visible.size) frame = requestAnimationFrame(update);
  });
}

// Icons on screen whose blink is due blink once; hidden ones (a hidden kept view still intersects) skip their turn.
function blinkDue() {
  const now = performance.now();
  for (const icon of visible) {
    const rhythm = rhythms.get(icon);
    if (!rhythm || now < rhythm.next) continue;
    const eyes = icon.querySelector(".bot-blink");
    rhythm.next = now + (eyes?.classList.contains("waiting") ? waitingEveryMs : rhythm.everyMs);
    if (!eyes || eyes.classList.contains("blinking") || !icon.checkVisibility({ visibilityProperty: true })) continue;
    eyes.classList.add("blinking");
    eyes.addEventListener("animationend", () => eyes.classList.remove("blinking"), { once: true });
  }
}

// The blink timer runs while icons are tracked, except while the app saves power (core/power.ts): no blinks then, and
// no timer waking the page four times a second for nothing.
let watchingPower = false;
function timeBlinks() {
  const wanted = rhythms.size > 0 && !powerSaving();
  if (wanted && blinkTimer === undefined) blinkTimer = setInterval(blinkDue, 250);
  else if (!wanted && blinkTimer !== undefined) {
    clearInterval(blinkTimer);
    blinkTimer = undefined;
  }
}

// `everyMs` and `offsetMs`: the icon's own blinking rhythm, so a row of bots never blinks together.
export function trackEyes(icon: SVGSVGElement, everyMs: number, offsetMs: number): () => void {
  if (reduced() || typeof IntersectionObserver === "undefined") return () => {};
  listen();
  observer!.observe(icon);
  rhythms.set(icon, { everyMs, next: performance.now() + offsetMs });
  if (!watchingPower) {
    watchingPower = true;
    createRoot(() => createEffect(on(powerSaving, timeBlinks)));
  }
  timeBlinks();
  return () => {
    observer!.unobserve(icon);
    visible.delete(icon);
    rhythms.delete(icon);
    timeBlinks();
  };
}
