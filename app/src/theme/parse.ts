// Turns a theme file into a complete, validated Theme. Imported themes are untrusted, so every value is
// checked before it reaches a CSS variable: no url(), no rule breaking characters, numbers in range.
import { colorKeys, soundNames, type Theme, type ThemeFile } from "./schema";

export class ThemeError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid theme: ${problems.join("; ")}`);
  }
}

const hexColor = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const functionColor = /^(rgb|rgba|hsl|hsla)\([\d\s.,%/+-]+\)$/i;
const namedColor = /^[a-z]{3,20}$/i;
const unsafeCss = /url\(|[;{}\\<>@]|\/\*/i;

const ranges = {
  "border.width": [0, 8],
  "fonts.size": [10, 24],
  "shape.size": [0, 24],
  "layout.serverBar.width": [40, 120],
  "layout.channelBar.width": [160, 480],
  "layout.gap": [0, 32],
  "layout.margin": [0, 48],
} as const;

export function parseTheme(file: ThemeFile, base: Theme | undefined): Theme {
  const theme = merge(base ?? {}, withoutExtends(file)) as Theme;
  const problems = validate(theme);
  if (problems.length > 0) throw new ThemeError(problems);
  return theme;
}

function withoutExtends(file: ThemeFile): Partial<Theme> {
  const { extends: _, ...rest } = file;
  return rest as Partial<Theme>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function merge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? structuredClone(base) : override;
  const result: Record<string, unknown> = structuredClone(base);
  for (const [key, value] of Object.entries(override)) result[key] = merge(base[key], value);
  return result;
}

function validate(theme: Theme): string[] {
  const problems: string[] = [];
  const check = (ok: boolean, problem: string) => ok || problems.push(problem);
  const at = (path: string) => path.split(".").reduce<unknown>((v, k) => (isPlainObject(v) ? v[k] : undefined), theme);

  check(typeof theme.id === "string" && /^[a-z0-9-]{1,64}$/.test(theme.id), "id must be 1-64 of a-z, 0-9, '-'");
  check(typeof theme.name === "string" && theme.name.length > 0 && theme.name.length <= 64, "name must be 1-64 characters");
  check(theme.author === undefined || (typeof theme.author === "string" && theme.author.length <= 64), "author must be text");
  check(theme.scheme === "dark" || theme.scheme === "light", "scheme must be dark or light");

  for (const key of colorKeys) check(isColor(at(`colors.${key}`)), `colors.${key} must be a color`);
  const safeCss = (path: string) => String.raw`${path} must be plain CSS text without url() or ; { } \ < > @`;
  for (const path of ["shadow.panel", "shadow.popup", "fonts.ui", "fonts.code"]) check(isSafeCss(at(path)), safeCss(path));
  check(at("fonts.heading") === undefined || isSafeCss(at("fonts.heading")), safeCss("fonts.heading"));

  for (const [path, [min, max]] of Object.entries(ranges)) {
    const value = at(path);
    check(typeof value === "number" && value >= min && value <= max, `${path} must be a number from ${min} to ${max}`);
  }

  check(theme.border?.outlines === undefined || typeof theme.border.outlines === "boolean", "border.outlines must be true or false");
  check(["rounded", "square", "cut"].includes(theme.shape?.corners), "shape.corners must be rounded, square or cut");
  for (const bar of ["serverBar", "channelBar"])
    check(["docked", "floating"].includes(at(`layout.${bar}.mode`) as string), `layout.${bar}.mode must be docked or floating`);

  const files = theme.fonts?.files;
  check(Array.isArray(files) && files.every((f) =>
    isPlainObject(f) && isSafeCss(f.family) && isUrl(f.url, ["https:", "data:font/"])), "fonts.files must be { family, url } with https or data:font URLs");

  check(typeof theme.icons?.set === "string" && isPlainObject(theme.icons.overrides) &&
    Object.values(theme.icons.overrides).every((url) => isUrl(url, ["data:image/svg+xml"])), "icons.overrides must be data:image/svg+xml URLs");

  check(isPlainObject(theme.sounds) && Object.entries(theme.sounds).every(([name, url]) =>
    (soundNames as readonly string[]).includes(name) && isUrl(url, ["https:", "data:audio/"])), "sounds must map sound names to https or data:audio URLs");

  return problems;
}

function isColor(value: unknown): boolean {
  return typeof value === "string" && (hexColor.test(value) || functionColor.test(value) || namedColor.test(value));
}

function isSafeCss(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !unsafeCss.test(value);
}

function isUrl(value: unknown, prefixes: string[]): boolean {
  // Used inside url("..."), so a quote, backslash or line break could end it.
  return typeof value === "string" && value.length <= 2_000_000 && prefixes.some((p) => value.startsWith(p)) &&
    !/["\\\n\r]/.test(value);
}
