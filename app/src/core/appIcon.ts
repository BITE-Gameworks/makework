// The app's icon (a simple crow, resources/icon-simple.svg, readable at taskbar size; the detailed crow in
// resources/icon.svg is the Explore workspace's picture): the page's favicon and, on desktop, the window, taskbar and tray
// icon. It takes the active theme's colors unless "Icon matches theme colors" is off (Settings > Appearance), and
// shows the number of unread mentions and private messages in a badge at its top left.
import { createEffect, createSignal } from "solid-js";
import logo from "../../resources/icon.svg?raw";
import simpleSource from "../../resources/icon-simple.svg?raw";
import { unreadTotal } from "../dm/messages";
import { theme } from "../theme/store";
import type { Theme } from "../theme/schema";
import { desktop } from "./desktop";
import { totalMentions } from "./sidebar";
import { readJson, writeJson } from "./storage";

// Square, with a size of its own, so it draws onto a canvas at any size.
const simpleLogo = simpleSource.replace(/<svg\b/, `<svg width="128" height="128"`);

const themedKey = "mw.appIcon.themed";
const [themed, setThemedSignal] = createSignal(readJson(themedKey, true));
export const iconThemed = themed;

export function setIconThemed(on: boolean): void {
  setThemedSignal(on);
  writeJson(themedKey, on);
}

// The logo's colors that come from the theme; the eye's black and white and the beak's greys stay.
const themeColors: Record<string, keyof Theme["colors"]> = {
  "#09090b": "darker", "#101022": "dark", "#13162c": "light", "#3d52ae": "border", "#2f78e4": "accent", "#3276e2": "accent",
  "#141424": "light", "#4053a2": "border", "#00aeef": "accent",
};

const escapeText = (text: string) => text.replace(/[<>&]/g, (c) => `&#${c.codePointAt(0)};`);

// The count badge as SVG elements: a circle of radius `r` around (cx, cy) in the accent color, with the count.
function badgeShapes(colors: Theme["colors"] | null, count: number, cx: number, cy: number, r: number): string {
  const label = count > 99 ? "99+" : String(count);
  const fill = colors?.accent ?? "#2f78e4";
  const ink = colors?.accentText ?? "#000000";
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`
    + `<text x="${cx}" y="${cy}" fill="${ink}" font-family="sans-serif" font-weight="700" font-size="${r * (label.length > 2 ? 0.9 : label.length > 1 ? 1.15 : 1.4)}" text-anchor="middle" dominant-baseline="central">${escapeText(label)}</text>`;
}

// The logo as SVG text, in the theme's colors (null: its own) with a count badge when `count` is above 0. `simple`
// is the small crow for the favicon and taskbar; the default is the detailed one. Its glow takes the accent too.
export function logoSvg(colors: Theme["colors"] | null, count = 0, simple = false): string {
  const source = simple ? simpleLogo : logo;
  // As attributes (fill="#...") or in a style block (fill:#...).
  let svg = colors ? source.replace(/(fill|flood-color)(="|:)(#[0-9a-f]{6})/gi, (all, attribute: string, between: string, hex: string) => {
    const key = themeColors[hex.toLowerCase()];
    return key ? `${attribute}${between}${colors[key]}` : all;
  }) : source;
  if (count > 0) {
    // In the viewBox's top left corner, about two fifths of the icon wide so it reads at 16 px.
    const [x, y, size] = (/viewBox="([^"]+)"/.exec(svg)?.[1] ?? "0 0 124 124").split(/\s+/).map(Number);
    const r = size * 0.22;
    svg = svg.replace(/<\/svg>\s*$/, `${badgeShapes(colors, count, x + r, y + r, r)}</svg>`);
  }
  return svg;
}

// The badge alone (the same one the logo carries), for the overlay over the Windows taskbar button.
export function badgeSvg(colors: Theme["colors"] | null, count: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">${badgeShapes(colors, count, 16, 16, 16)}</svg>`;
}

const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

// The logo drawn at a size, as a canvas.
export async function logoCanvas(svg: string, size: number): Promise<HTMLCanvasElement> {
  const image = new Image();
  image.src = svgUrl(svg);
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  canvas.getContext("2d")!.drawImage(image, 0, 0, size, size);
  return canvas;
}

let drawing = 0;

// Call once inside the app's render root.
export function initAppIcon(): void {
  createEffect(() => {
    const count = totalMentions() + unreadTotal();
    const colors = themed() ? theme().colors : null;
    const svg = logoSvg(colors, count, true);
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    link ??= Object.assign(document.createElement("link"), { rel: "icon", type: "image/svg+xml" });
    link.href = svgUrl(svg);
    document.head.append(link);
    if (desktop?.setIcon) {
      const setIcon = desktop.setIcon;
      const drawn = ++drawing;
      // Windows shows the count over the taskbar button, on the icon without it (electron/main.js).
      const overlay = desktop.platform === "win32" && count > 0;
      void Promise.all([
        logoCanvas(svg, 256),
        overlay ? logoCanvas(logoSvg(colors, 0, true), 256) : null,
        overlay ? logoCanvas(badgeSvg(colors, count), 32) : null,
      ])
        .then(([badged, plain, badge]) => {
          if (drawn !== drawing) return;
          const png = (canvas: HTMLCanvasElement) => canvas.toDataURL("image/png");
          setIcon(png(badged), count, plain && badge ? { plain: png(plain), badge: png(badge) } : undefined);
        })
        .catch(() => {});
    }
  });
}
