import { For, Show, createMemo, onCleanup, onMount, type JSX } from "solid-js";
import { trackEyes } from "./botEyes";
import { botTypeFor } from "../plugins/registry";
import type { BotFrame, BotPalette } from "../plugins/types";

// Generated robot faces for bots, and only for bots: a head with a dark outline and a dark screen whose eyes glow
// and follow the pointer. People's avatars never look like this, so a bot can't be impersonated by a picture.
// The look (head, ears, antenna, eyes, mouth) comes from the seed (the bot's id), the body colors from the bot's
// type, so two Taskbots are siblings. Pure functions of their input; nothing is fetched.
const outline = "#1b2d4f";
const screen = "#0c1428";
// Closed eyes of a bot that is off.
const dim = "#5d6a82";

const palettes = [
  { body: "#4a98d6", shade: "#3b7fb8", accent: "#7cc4f2", glow: "#7ff0ff" },
  { body: "#f7eff4", shade: "#dddbe4", accent: "#ef8f7e", glow: "#9ff4ff" },
  { body: "#7fcf9c", shade: "#5fb37f", accent: "#f4d35e", glow: "#a6ffc4" },
  { body: "#f4d35e", shade: "#d9b73f", accent: "#ef8f7e", glow: "#ffe27a" },
  { body: "#b79af0", shade: "#9779d6", accent: "#7cc4f2", glow: "#e0b4ff" },
  { body: "#f2a65a", shade: "#d98a3c", accent: "#4a98d6", glow: "#ffc48a" },
  { body: "#8fb8c8", shade: "#6f9aab", accent: "#f4d35e", glow: "#b6f3ff" },
];

// A bot type names its palettes (BotLook); types without a look get one from their name.
const paletteIndex: Record<BotPalette, number> = { blue: 0, white: 1, green: 2, yellow: 3, purple: 4, orange: 5, steel: 6 };
// Squareish heads and rounder ones (indexes into `heads`).
const frames: Record<BotFrame, number[]> = { square: [0, 2], round: [1, 3] };

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

// A small deterministic generator from a seed.
function random(seed: string): () => number {
  let a = hash(seed) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// `screen` is the dark panel on the face (x, y of its middle, size), `eye` the height of the eyes.
const heads = [
  { path: "M18 30 H82 Q86 30 86 34 V74 Q86 80 80 80 H20 Q14 80 14 74 V34 Q14 30 18 30 Z", top: 30, eye: 53, w: 62, h: 36 },
  { path: "M10 36 Q10 28 22 28 H78 Q90 28 90 36 V70 Q90 80 78 80 H22 Q10 80 10 70 Z", top: 28, eye: 54, w: 72, h: 34 },
  { path: "M24 22 H76 Q82 22 82 28 V76 Q82 84 74 84 H26 Q18 84 18 76 V28 Q18 22 24 22 Z", top: 22, eye: 52, w: 50, h: 40 },
  { path: "M16 80 V54 C16 36 31 22 50 22 C69 22 84 36 84 54 V80 Z", top: 22, eye: 56, w: 56, h: 34 },
];

const pick = <T,>(list: T[], r: () => number): T => list[Math.floor(r() * list.length)];

export function botIconParts(seed: string, type: string, state: "on" | "off" | "waiting" = "on"): JSX.Element {
  const r = random(`${seed}:look`);
  const look = botTypeFor(type)?.type.look;
  const base = look
    ? palettes[paletteIndex[pick(look.palettes, r)]]
    : palettes[(hash(type || seed) >>> 13) % palettes.length];
  const palette = look?.eyes ? { ...base, glow: look.eyes } : base;
  const head = look ? heads[pick(frames[look.frame], r)] : pick(heads, r);
  const ears = pick(["round", "phones", "none", "round"] as const, r);
  const antenna = pick(["ball", "twin", "fin", "none", "ball"] as const, r);
  const eyes = pick(["round", "pill", "block", "round"] as const, r);
  const mouth = pick(["line", "smile", "open", "none", "line"] as const, r);
  const id = hash(seed + type).toString(36);
  const eyeY = head.eye;
  const stroke = { stroke: outline, "stroke-width": 5, "stroke-linejoin": "round" as const, "stroke-linecap": "round" as const };
  const glow = { fill: palette.glow, filter: `url(#bot-glow-${id})` };
  const lit = { stroke: palette.glow, "stroke-width": 3.5, "stroke-linecap": "round" as const, fill: "none", filter: `url(#bot-glow-${id})` };
  const spread = Math.min(18, head.w / 2 - 12);

  return (
    <>
      <defs>
        <clipPath id={`bot-clip-${id}`}><path d={head.path} /></clipPath>
        <clipPath id={`bot-screen-${id}`}><rect x={50 - head.w / 2 + 1} y={eyeY - head.h / 2 - 1} width={head.w - 2} height={head.h + 6} rx="11" /></clipPath>
        <filter id={`bot-glow-${id}`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="1.8" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <Show when={ears === "round"}>
        <ellipse cx="9" cy={eyeY + 2} rx="7" ry="13" fill={palette.accent} {...stroke} />
        <ellipse cx="91" cy={eyeY + 2} rx="7" ry="13" fill={palette.accent} {...stroke} />
      </Show>
      <Show when={ears === "phones"}>
        <ellipse cx="10" cy={eyeY + 2} rx="9" ry="16" fill={outline} />
        <ellipse cx="90" cy={eyeY + 2} rx="9" ry="16" fill={outline} />
      </Show>
      <Show when={antenna === "ball"}>
        <path d={`M50 ${head.top} V12`} {...stroke} fill="none" />
        <circle cx="50" cy="10" r="7" fill={palette.accent} {...stroke} />
      </Show>
      <Show when={antenna === "twin"}>
        <For each={[30, 70]}>{(x) => (
          <>
            <path d={`M${x} ${head.top} V14`} {...stroke} fill="none" />
            <circle cx={x} cy="11" r="6" fill={palette.accent} {...stroke} />
          </>
        )}</For>
      </Show>
      <path d={head.path} fill={palette.body} />
      <g clip-path={`url(#bot-clip-${id})`}>
        <path d="M70 0 H100 V100 H0 V88 H70 Z" fill={palette.shade} opacity="0.55" />
      </g>
      <Show when={antenna === "fin"}>
        <rect x="42" y={head.top} width="16" height="12" rx="3" fill={outline} />
      </Show>
      <path d={head.path} fill="none" {...stroke} />
      <rect x={50 - head.w / 2} y={eyeY - head.h / 2 - 2} width={head.w} height={head.h + 8} rx="12" fill={screen} stroke={outline} stroke-width="2" />
      <Show when={state === "off"}>
        <For each={[50 - spread, 50 + spread]}>{(x) => <path d={`M${x - 6} ${eyeY} H${x + 6}`} stroke={dim} stroke-width="3" stroke-linecap="round" fill="none" />}</For>
      </Show>
      <Show when={state !== "off"}>
      <g clip-path={`url(#bot-screen-${id})`}>
      <g class="bot-eyes">
        <g class="bot-blink" classList={{ waiting: state === "waiting" }}>
        <Show when={eyes === "round"}>
          <For each={[50 - spread, 50 + spread]}>{(x) => <circle cx={x} cy={eyeY} r="6.5" {...glow} />}</For>
        </Show>
        <Show when={eyes === "pill"}>
          <For each={[50 - spread, 50 + spread]}>{(x) => <rect x={x - 4.5} y={eyeY - 9} width="9" height="18" rx="4.5" {...glow} />}</For>
        </Show>
        <Show when={eyes === "block"}>
          <For each={[50 - spread, 50 + spread]}>{(x) => <rect x={x - 7} y={eyeY - 5.5} width="14" height="11" rx="3.5" {...glow} />}</For>
        </Show>
        </g>
      </g>
      <g class="bot-mouth">
        <Show when={mouth === "line"}><path d={`M43 ${eyeY + 15} H57`} {...lit} /></Show>
        <Show when={mouth === "smile"}><path d={`M41 ${eyeY + 12} Q50 ${eyeY + 21} 59 ${eyeY + 12}`} {...lit} /></Show>
        <Show when={mouth === "open"}><path d={`M43 ${eyeY + 13} H57 Q57 ${eyeY + 21} 50 ${eyeY + 21} Q43 ${eyeY + 21} 43 ${eyeY + 13} Z`} {...glow} /></Show>
      </g>
      </g>
      </Show>
    </>
  );
}

export default function BotIcon(props: { seed: string; type?: string; state?: "on" | "off" | "waiting" }) {
  let svg!: SVGSVGElement;
  const parts = createMemo(() => botIconParts(props.seed, props.type ?? "", props.state ?? "on"));
  // Every bot blinks on its own rhythm (5 to 9 s, at its own offset), so a row of bots never blinks together.
  onMount(() => {
    const r = random(`${props.seed}:blink`);
    const everyMs = (5 + r() * 4) * 1000;
    onCleanup(trackEyes(svg, everyMs, r() * everyMs));
  });
  return <svg ref={svg} class="bot-icon" classList={{ off: props.state === "off" }} viewBox="-6 -2 112 104" aria-hidden="true">{parts()}</svg>;
}
