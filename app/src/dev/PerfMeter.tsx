// Dev only: Ctrl+Alt+P shows frames per second, the longest main-thread stall of the last second, how many frames
// in it took over 50 ms to draw (long animation frames, where the browser reports them), how many endless animations
// run (each one makes the window draw on every frame: one spinner left turning kept a laptop's GPU busy)
// and whether the app saves power (core/power.ts). It measures only while shown.
import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { powerSaving } from "../core/power";

// Running animations without an end (spinners, pulses), hidden kept views' paused ones not counted.
const endless = () => document.getAnimations()
  .filter((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations === Infinity).length;

export default function PerfMeter() {
  const [visible, setVisible] = createSignal(false);
  const [stats, setStats] = createSignal({ fps: 0, stall: 0, long: 0, endless: 0 });

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === "p") setVisible(!visible());
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  createEffect(() => {
    if (!visible()) return;
    let frames = 0;
    let stall = 0;
    let long = 0;
    let last = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      frames++;
      stall = Math.max(stall, now - last);
      last = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    let observer: PerformanceObserver | undefined;
    if (PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame")) {
      observer = new PerformanceObserver((list) => void (long += list.getEntries().length));
      observer.observe({ type: "long-animation-frame" });
    }
    const report = setInterval(() => {
      setStats({ fps: frames, stall: Math.round(stall), long, endless: endless() });
      frames = 0;
      stall = 0;
      long = 0;
    }, 1000);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      clearInterval(report);
      observer?.disconnect();
    });
  });

  return (
    <Show when={visible()}>
      <div style={{
        position: "fixed", left: "8px", bottom: "8px", "z-index": 99999, padding: "4px 8px", background: "#000",
        color: stats().fps < 30 ? "#f55" : "#5f5", font: "12px monospace", "pointer-events": "none",
      }}>
        {stats().fps} fps, longest frame {stats().stall} ms, {stats().long} slow frames, {stats().endless} endless animations
        {powerSaving() ? ", saving power" : ""}
      </div>
    </Show>
  );
}
