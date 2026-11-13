// Writes a theme to CSS variables and data attributes on <html>. Styles read only these.
import type { Theme } from "./schema";

const loadedFonts = new Set<string>();
let applied = false;
let switchTimer: ReturnType<typeof setTimeout> | undefined;

export function themeVariables(theme: Theme): Record<string, string> {
  const vars: Record<string, string> = {
    "--mw-border-width": `${theme.border.width}px`,
    "--mw-shadow-panel": theme.shadow.panel,
    "--mw-shadow-popup": theme.shadow.popup,
    "--mw-font-ui": theme.fonts.ui,
    "--mw-font-heading": theme.fonts.heading ?? theme.fonts.ui,
    "--mw-font-code": `"Fira Code Variable", ${theme.fonts.code}`,
    "--mw-font-size": `${theme.fonts.size}px`,
    "--mw-corner": `${theme.shape.size}px`,
    "--mw-workspace-bar-width": `${theme.layout.serverBar.width}px`,
    "--mw-channel-bar-width": `${theme.layout.channelBar.width}px`,
    "--mw-gap": `${theme.layout.gap}px`,
    "--mw-margin": `${theme.layout.margin}px`,
  };
  for (const [key, value] of Object.entries(theme.colors)) vars[`--mw-${kebab(key)}`] = value;
  return vars;
}

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  if (applied) fadeSwitch(root);
  applied = true;
  for (const [name, value] of Object.entries(themeVariables(theme))) root.style.setProperty(name, value);

  root.dataset.corners = theme.shape.corners;
  root.toggleAttribute("data-outlines", theme.border.outlines === true);
  root.dataset.workspaceBar = theme.layout.serverBar.mode;
  root.dataset.channelBar = theme.layout.channelBar.mode;
  root.style.colorScheme = theme.scheme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.colors.darker);

  for (const { family, url } of theme.fonts.files) loadFont(family, url);
}

function fadeSwitch(root: HTMLElement) {
  root.classList.add("theme-switching");
  clearTimeout(switchTimer);
  switchTimer = setTimeout(() => root.classList.remove("theme-switching"), 400);
}

function loadFont(family: string, url: string) {
  const key = `${family}\n${url}`;
  if (loadedFonts.has(key)) return;
  loadedFonts.add(key);
  const face = new FontFace(family, `url("${url}")`);
  document.fonts.add(face);
  face.load().catch((e) => console.warn(`Theme font '${family}' failed to load:`, e));
}

function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}
