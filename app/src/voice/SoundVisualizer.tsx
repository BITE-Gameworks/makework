import { onCleanup, onMount } from "solid-js";
import { powerSaving } from "../core/power";
import { stepTo } from "./levels";
import { backingSize, hasSound, pace } from "./visualizerPace";

// The ring's radius in the radial variant; the sharer's picture fills it (`centerSize`).
const centerRadius = 60;
export const centerSize = centerRadius * 2 - 3;
// How much the ring (and with it the picture, through `onBass`) swells at full bass.
export const bassSwell = 0.12;
// The ring of ticks' turn per second (radians) while it turns.
const turnPerSecond = 0.15;
// Out of view by visibility (a hidden kept view) no event says it shows again, so it looks this often.
const hiddenCheckMs = 500;

// A shared sound's spectrum drawn on a canvas in the element's text color. `bars`: a row of bars (thumbnails).
// `radial`: a ring that swells with the bass, bars around the middle mirrored left and right with a dot at each tip,
// and a ring of ticks turning slowly; drawn on a square canvas centred in its parent (the glow behind it is the
// parent's, voice.css .voice-sound-share-glow). `analyser` is read on each look, so it may come and go.
// Each frame drawn makes the window draw (a full-screen stage at 30 fps kept the GPU busy), so it draws
// only while seen and while there is sound (visualizerPace.ts), on a timer rather than every animation frame.
export default function SoundVisualizer(props: {
  analyser: () => AnalyserNode | undefined;
  variant?: "bars" | "radial";
  // The bass level (0 to 1, in 1/32 steps), called when it changes, so things over the canvas can move with it.
  onBass?: (bass: number) => void;
}) {
  let canvas!: HTMLCanvasElement;
  onMount(() => {
    const context = canvas.getContext("2d")!;
    const radial = props.variant === "radial";
    const box = radial ? canvas.parentElement! : canvas;
    const count = radial ? 48 : 24;
    const heights = new Float32Array(count);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let data = new Uint8Array(0);
    let bass = 0;
    let shownBass = -1;
    let color = "";
    let colorAt = -Infinity;
    let turn = 0;
    let last = performance.now();
    let boxWidth = 0;
    let boxHeight = 0;
    let scale = 1;
    // The still frame for the current silence is drawn.
    let still = false;
    let inView = true;
    let focused = document.hasFocus();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;

    const visible = () => inView && !document.hidden && (canvas.checkVisibility?.({ visibilityProperty: true }) ?? true);

    const fit = () => {
      const side = Math.min(boxWidth, boxHeight);
      const css = radial ? { width: side, height: side } : { width: boxWidth, height: boxHeight };
      if (radial) {
        canvas.style.width = `${css.width}px`;
        canvas.style.height = `${css.height}px`;
      }
      const size = backingSize(css.width, css.height, devicePixelRatio);
      scale = size.scale;
      if (canvas.width !== size.width || canvas.height !== size.height) {
        canvas.width = size.width;
        canvas.height = size.height;
      }
    };

    const draw = (time: number) => {
      frame = 0;
      const { width, height } = canvas;
      if (width === 0 || height === 0) return;
      // Themes can change while it runs; reading styles on every draw would be wasteful.
      if (time - colorAt > 1000) {
        color = getComputedStyle(canvas).color;
        colorAt = time;
      }
      context.clearRect(0, 0, width, height);
      context.fillStyle = color;
      context.strokeStyle = color;
      if (radial) drawRadial(context, width, height, scale, heights, Math.max(0, shownBass), turn);
      else drawBars(context, width, height, heights);
    };

    // Reads the sound, decides from it when to look next and whether to draw.
    const look = () => {
      timer = undefined;
      const now = performance.now();
      // Rises and falls go by time (steps of 33 ms), so looking less often doesn't slow them.
      const steps = Math.min(4, (now - last) / 33);
      last = now;
      const analyser = props.analyser();
      if (analyser && data.length !== analyser.frequencyBinCount) data = new Uint8Array(analyser.frequencyBinCount);
      if (analyser) analyser.getByteFrequencyData(data);
      else data.fill(0);
      // Bars spread over the bins logarithmically, as hearing is; they fall slower than they rise.
      const bins = Math.log2(data.length || 1);
      const fall = 0.85 ** steps;
      for (let i = 0; i < count; i++) {
        const from = Math.floor(2 ** ((i / count) * bins));
        const to = Math.max(from + 1, Math.floor(2 ** (((i + 1) / count) * bins)));
        let peak = 0;
        for (let b = from; b < to && b < data.length; b++) peak = Math.max(peak, data[b]);
        const target = peak / 255;
        heights[i] = target > heights[i] ? target : heights[i] * fall + target * (1 - fall);
      }
      let low = 0;
      for (let b = 1; b < Math.min(8, data.length); b++) low += data[b] / 255;
      const bassNow = data.length ? low / 7 : 0;
      const bassRise = 0.5 ** steps;
      const bassFall = 0.92 ** steps;
      bass = bassNow > bass ? bass * bassRise + bassNow * (1 - bassRise) : bass * bassFall + bassNow * (1 - bassFall);

      const sound = hasSound(data, heights, bass);
      if (!sound) {
        // Settled: show nothing left over.
        heights.fill(0);
        bass = 0;
      }
      const next = pace({ visible: visible(), sound, focused, saving: powerSaving(), reducedMotion: reduced.matches });
      if (next.turn) turn = (turn + steps * 0.033 * turnPerSecond) % (Math.PI * 2);
      if (next.waitMs !== null && (next.draw || !still)) {
        still = !sound;
        const stepped = stepTo(bass, 32);
        if (stepped !== shownBass) {
          shownBass = stepped;
          props.onBass?.(stepped);
        }
        if (!frame) frame = requestAnimationFrame(draw);
      }
      if (next.waitMs !== null) timer = setTimeout(look, next.waitMs);
      // Hidden by visibility, it looks again now and then; out of view or in a hidden page, the events wake it.
      else if (inView && !document.hidden) timer = setTimeout(look, hiddenCheckMs);
    };

    const wake = () => {
      if (timer !== undefined) clearTimeout(timer);
      look();
    };

    const measure = () => {
      boxWidth = box.clientWidth;
      boxHeight = box.clientHeight;
      fit();
    };
    const resize = new ResizeObserver(() => {
      measure();
      // Resizing a canvas clears it: drawn again on the next frame, not the next look (it blinked while resizing).
      if (!frame) frame = requestAnimationFrame(draw);
    });
    measure();
    resize.observe(box);
    const watch = new IntersectionObserver(([entry]) => {
      const was = inView;
      inView = entry.isIntersecting;
      if (inView && !was) wake();
    });
    watch.observe(canvas);
    const shown = () => {
      if (!document.hidden) wake();
    };
    const focus = () => {
      focused = true;
      wake();
    };
    const blur = () => (focused = false);
    document.addEventListener("visibilitychange", shown);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    look();
    onCleanup(() => {
      if (timer !== undefined) clearTimeout(timer);
      cancelAnimationFrame(frame);
      resize.disconnect();
      watch.disconnect();
      document.removeEventListener("visibilitychange", shown);
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
    });
  });
  return <canvas ref={canvas} class="voice-visualizer" aria-hidden="true" />;
}

function drawBars(context: CanvasRenderingContext2D, width: number, height: number, heights: Float32Array) {
  const gap = (width / heights.length) * 0.3;
  const barWidth = width / heights.length - gap;
  for (let i = 0; i < heights.length; i++) {
    const h = Math.max(barWidth / 2, heights[i] * height);
    context.fillRect(i * (barWidth + gap) + gap / 2, (height - h) / 2, barWidth, h);
  }
}

// Bars and dots are drawn a few brightness steps at a time, one path each, not one path per bar.
const brightnessSteps = 4;

function drawRadial(context: CanvasRenderingContext2D, width: number, height: number, scale: number, heights: Float32Array, bass: number, turn: number) {
  const cx = width / 2;
  const cy = height / 2;
  const inner = centerRadius * scale * (1 + bass * bassSwell);
  const reach = Math.max(24 * scale, Math.min(width, height) / 2 - inner - 48 * scale);

  // The ring around the picture, swelling with the bass.
  context.globalAlpha = 0.35 + bass * 0.5;
  context.lineWidth = 3 * scale;
  context.beginPath();
  context.arc(cx, cy, inner, 0, Math.PI * 2);
  context.stroke();

  // Bars from the top round to the bottom on the right, mirrored on the left; low notes at the top. A dot just past
  // each tip fades in as the bar grows.
  const step = Math.PI / heights.length;
  const barWidth = Math.max(2 * scale, inner * step * 0.55);
  const start = inner + 8 * scale;
  const dot = barWidth * 0.45;
  context.lineCap = "round";
  context.lineWidth = barWidth;
  const bars: (Path2D | undefined)[] = [];
  const dots: (Path2D | undefined)[] = [];
  for (let i = 0; i < heights.length; i++) {
    const level = Math.round(stepTo(heights[i], brightnessSteps) * brightnessSteps);
    const barPath = (bars[level] ??= new Path2D());
    const dotPath = (dots[level] ??= new Path2D());
    const length = 4 * scale + heights[i] * reach;
    const angle = (i + 0.5) * step;
    for (const side of [1, -1]) {
      const a = -Math.PI / 2 + side * angle;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      barPath.moveTo(cx + cos * start, cy + sin * start);
      barPath.lineTo(cx + cos * (start + length), cy + sin * (start + length));
      const tip = start + length + barWidth * 1.6;
      dotPath.moveTo(cx + cos * tip + dot, cy + sin * tip);
      dotPath.arc(cx + cos * tip, cy + sin * tip, dot, 0, Math.PI * 2);
    }
  }
  for (let level = 0; level <= brightnessSteps; level++) {
    const shade = level / brightnessSteps;
    const barPath = bars[level];
    if (!barPath) continue;
    context.globalAlpha = 0.45 + shade * 0.55;
    context.stroke(barPath);
    if (shade > 0) {
      context.globalAlpha = shade * 0.8;
      context.fill(dots[level]!);
    }
  }

  // Ticks on an outer ring all the way round, turned as one piece (every third one long).
  const ring = inner + 16 * scale + reach;
  const ticks = 72;
  const path = new Path2D();
  for (let i = 0; i < ticks; i++) {
    const a = (i / ticks) * Math.PI * 2 + turn;
    const tick = (i % 3 === 0 ? 10 : 5) * scale;
    path.moveTo(cx + Math.cos(a) * ring, cy + Math.sin(a) * ring);
    path.lineTo(cx + Math.cos(a) * (ring + tick), cy + Math.sin(a) * (ring + tick));
  }
  context.globalAlpha = 0.18 + bass * 0.25;
  context.lineWidth = 1.5 * scale;
  context.stroke(path);
  context.globalAlpha = 1;
}
