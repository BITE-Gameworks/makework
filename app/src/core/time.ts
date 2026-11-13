import { createRoot, createSignal } from "solid-js";
import { plural } from "./plural";

// Ticks every 30 s so relative times stay current.
export const now = createRoot(() => {
  const [time, setTime] = createSignal(Date.now());
  setInterval(() => setTime(Date.now()), 30_000);
  return time;
});

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const seconds = Math.max(0, (now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const units: [number, string][] = [[60, "minute"], [3600, "hour"], [86400, "day"], [604800, "week"]];
  for (let i = units.length - 1; i >= 0; i--) {
    const [size, name] = units[i];
    if (seconds >= size * 0.9) {
      const n = Math.max(1, Math.round(seconds / size));
      return `${plural(n, name)} ago`;
    }
  }
  return "just now";
}

// "in 7 days" for a time ahead, "just now" when it has passed.
export function timeUntil(iso: string | null | undefined): string {
  if (!iso) return "";
  const seconds = (new Date(iso).getTime() - now()) / 1000;
  if (seconds < 45) return "now";
  const units: [number, string][] = [[60, "minute"], [3600, "hour"], [86400, "day"], [604800, "week"]];
  for (let i = units.length - 1; i >= 0; i--) {
    const [size, name] = units[i];
    if (seconds >= size * 0.9) {
      const n = Math.max(1, Math.round(seconds / size));
      return `in ${plural(n, name)}`;
    }
  }
  return "now";
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  // The unit is chosen by the value as shown (rounded), so 1023.7 KB reads "1.0 MB", never "1024 KB".
  const shown = (value: number, unit: number) => (value < 9.95 && unit > 0 ? Number(value.toFixed(1)) : Math.round(value));
  let value = bytes;
  let unit = 0;
  while (shown(value, unit) >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 9.95 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
