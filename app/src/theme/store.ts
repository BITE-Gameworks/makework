// The built-in and user themes, which one is active, and saving user themes in this browser/app.
import { createEffect, createMemo, createRoot, createSignal } from "solid-js";
import { readJson, writeJson } from "../core/storage";
import { applyTheme } from "./apply";
import { parseTheme, ThemeError } from "./parse";
import type { Theme, ThemeFile } from "./schema";
import dark from "./themes/makework-dark.json";
import light from "./themes/makework-light.json";
import oled from "./themes/makework-oled.json";
import nier from "./themes/makework-nier.json";
import cyber from "./themes/makework-cyber.json";
import contra from "./themes/makework-contra.json";
import frostfall from "./themes/makework-frostfall.json";

export const defaultThemeId = "makework-dark";
const userThemesKey = "mw.themes.user";
const selectedKey = "mw.themes.selected";

export const builtInThemes = resolve([dark, light, oled, nier, cyber, frostfall, contra] as ThemeFile[]);

// Each file extends the theme it names, or the default; the default itself must be complete.
function resolve(files: ThemeFile[]): Theme[] {
  const themes: Theme[] = [];
  for (const file of files) {
    const baseId = file.extends ?? (file.id === defaultThemeId ? undefined : defaultThemeId);
    themes.push(parseTheme(file, themes.find((t) => t.id === baseId)));
  }
  return themes;
}

const [userThemes, setUserThemes] = createSignal<Theme[]>(loadUserThemes());
const [pluginThemes, setPluginThemesSignal] = createSignal<Theme[]>([]);
// Nirnroot (makework-sky) was replaced by Frostfall.
const renamed: Record<string, string> = { "makework-sky": "makework-frostfall" };
const savedTheme = readJson(selectedKey, defaultThemeId);
const [selectedId, setSelectedId] = createSignal(renamed[savedTheme] ?? savedTheme);
// The chosen theme and the user themes are synced across the account's devices (core/syncedPrefs.ts).
export { userThemes, selectedId as selectedThemeId };

export const { themes, theme } = createRoot(() => {
  const themes = createMemo(() => [...builtInThemes, ...pluginThemes(), ...userThemes()]);
  const theme = createMemo(() => themes().find((t) => t.id === selectedId()) ?? builtInThemes[0]);
  return { themes, theme };
});

// Call once inside the app's render root.
export function initTheme(): void {
  createEffect(() => applyTheme(theme()));
}

// Built-in and plugin themes can't be edited, only duplicated.
export function isBuiltIn(id: string): boolean {
  return builtInThemes.some((t) => t.id === id) || pluginThemes().some((t) => t.id === id);
}

// Themes contributed by enabled plugins; invalid ones are skipped with a warning.
export function setPluginThemes(files: ThemeFile[]): void {
  const parsed: Theme[] = [];
  for (const file of files) {
    try {
      const base = [...builtInThemes, ...parsed].find((t) => t.id === (file.extends ?? defaultThemeId));
      if (builtInThemes.some((t) => t.id === file.id)) throw new ThemeError([`id '${file.id}' is taken`]);
      parsed.push(parseTheme(file, base));
    } catch (e) {
      console.warn(`Plugin theme '${file.id}' skipped:`, e);
    }
  }
  setPluginThemesSignal(parsed);
}

export function selectTheme(id: string): void {
  setSelectedId(id);
  writeJson(selectedKey, id);
}

export function saveUserTheme(next: Theme): void {
  if (isBuiltIn(next.id)) throw new ThemeError([`'${next.id}' is a built-in theme; duplicate it to change it`]);
  const valid = parseTheme(next, undefined);
  setUserThemes((list) => [...list.filter((t) => t.id !== valid.id), valid]);
  persistUserThemes();
}

export function deleteUserTheme(id: string): void {
  setUserThemes((list) => list.filter((t) => t.id !== id));
  persistUserThemes();
  if (selectedId() === id) selectTheme(defaultThemeId);
}

// Replaces the user themes with ones kept elsewhere (core/syncedPrefs.ts); invalid ones are skipped.
export function replaceUserThemes(value: unknown): void {
  setUserThemes(parseUserThemes(value));
  persistUserThemes();
}

export function duplicateTheme(id: string): Theme {
  const source = themes().find((t) => t.id === id) ?? theme();
  const copy = { ...structuredClone(source), id: uniqueId(`${source.id}-copy`), name: `${source.name} (copy)` };
  delete copy.author;
  saveUserTheme(copy);
  return copy;
}

// Accepts a full theme or a partial one with extends. Throws ThemeError or SyntaxError.
export function importTheme(json: string): Theme {
  const file = JSON.parse(json) as ThemeFile;
  if (typeof file !== "object" || file === null) throw new ThemeError(["the file must contain a JSON object"]);
  const base = themes().find((t) => t.id === (file.extends ?? defaultThemeId));
  if (file.extends && !base) throw new ThemeError([`extends '${file.extends}', which is not installed`]);
  const parsed = parseTheme(file, base);
  const imported = isBuiltIn(parsed.id) || themes().some((t) => t.id === parsed.id)
    ? { ...parsed, id: uniqueId(parsed.id) }
    : parsed;
  saveUserTheme(imported);
  return imported;
}

export function exportTheme(theme: Theme): string {
  return JSON.stringify(theme, null, 2);
}

function uniqueId(base: string): string {
  const stem = base.slice(0, 56);
  for (let n = 1; ; n++) {
    const id = n === 1 ? stem : `${stem}-${n}`;
    if (!themes().some((t) => t.id === id)) return id;
  }
}

function loadUserThemes(): Theme[] {
  return parseUserThemes(readJson<unknown>(userThemesKey, []));
}

function parseUserThemes(stored: unknown): Theme[] {
  return (Array.isArray(stored) ? stored : []).flatMap((t) => {
    try {
      return [parseTheme(t, undefined)];
    } catch {
      return [];
    }
  });
}

function persistUserThemes() {
  writeJson(userThemesKey, userThemes());
}
