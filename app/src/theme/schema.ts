// A theme is plain data (JSON), so it is safe to share. Every value is validated in parseTheme.

export const colorKeys = [
  "accent", "accentText", "text", "textMuted", "textDisabled", "border",
  "link", "warning", "success", "danger", "light", "dark", "darker",
] as const;
export type ColorKey = (typeof colorKeys)[number];

// Colors a theme may leave out: each then takes the default for the theme's scheme.
export const severityKeys = ["severityLow", "severityMedium", "severityHigh", "severitySevere"] as const;
export type SeverityKey = (typeof severityKeys)[number];
// Issue severities as a heat scale (light yellow, deep yellow, orange, deep red) that reads the same in every theme:
// most themes' warning color sits close to their danger color. Light themes get stronger tones for a pale background.
export const defaultSeverityColors: Record<"dark" | "light", Record<SeverityKey, string>> = {
  dark: { severityLow: "#fff176", severityMedium: "#fbc02d", severityHigh: "#fb8c00", severitySevere: "#d32f2f" },
  light: { severityLow: "#e3c13b", severityMedium: "#d39e00", severityHigh: "#e65100", severitySevere: "#b71c1c" },
};

export type Corners = "rounded" | "square" | "cut";
export type BarMode = "docked" | "floating";

export const soundNames = [
  "mention", "notification", "join", "leave", "peer-join", "peer-leave", "mute", "unmute", "deafen", "undeafen",
  "stream-start", "stream-stop", "disconnect", "task-done", "upload-done", "error",
] as const;
export type SoundName = (typeof soundNames)[number];

export interface Bar {
  width: number;    // px
  mode: BarMode;
}

export interface Theme {
  id: string;
  name: string;
  author?: string;
  scheme: "dark" | "light";
  colors: Record<ColorKey, string> & Partial<Record<SeverityKey, string>>;
  border: { width: number; outlines?: boolean };    // width: px. outlines: grey lines around boxes and panels
  shadow: { panel: string; popup: string };
  fonts: { ui: string; heading?: string; code: string; size: number; files: { family: string; url: string }[] };
  shape: { corners: Corners; size: number };    // size: radius or cut length, px
  // margin: the gutter every view's content snaps to, px (inside boxes, half of it).
  layout: { serverBar: Bar; channelBar: Bar; gap: number; margin: number };
  icons: { set: string; overrides: Record<string, string> };    // overrides: icon name -> data:image/svg+xml URL
  sounds: Partial<Record<SoundName, string>>;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

// What a theme file contains: any subset of Theme, on top of the theme named in extends.
export type ThemeFile = DeepPartial<Theme> & { id: string; name: string; extends?: string };
