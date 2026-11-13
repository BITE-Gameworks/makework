import type { SoundName } from "./schema";
import { createSignal } from "solid-js";
import { readJson, writeJson } from "../core/storage";
import { theme } from "./store";
import { soundPack } from "./packs";
import { onlineStatus } from "../core/onlineStatus";

const volumeKey = "mw.sounds.volume";
const [soundVolume, setVolume] = createSignal<number>(readJson(volumeKey, 0.6));
export { soundVolume };

const bundled = import.meta.glob<string>("./sounds/*.mp3", { eager: true, query: "?url", import: "default" });
const builtIn = (file: string) => bundled[`./sounds/${file}.mp3`];

// Used when the theme has no sound of its own for the name.
const defaults: Partial<Record<SoundName, string>> = {
  mention: builtIn("crow-caw"),
  notification: builtIn("mention"),
  join: builtIn("join"),
  leave: builtIn("leave"),
  "peer-join": builtIn("join"),
  "peer-leave": builtIn("leave"),
  mute: builtIn("mute"),
  unmute: builtIn("unmute"),
  deafen: builtIn("deafen"),
  undeafen: builtIn("undeafen"),
  "stream-start": builtIn("stream-start"),
  "stream-stop": builtIn("stream-stop"),
  disconnect: builtIn("leave"),
  "task-done": builtIn("task-done"),
  "upload-done": builtIn("upload-done"),
  error: builtIn("error"),
};

export function setSoundVolume(value: number): void {
  setVolume(Math.min(1, Math.max(0, value)));
  writeJson(volumeKey, soundVolume());
}

// Sound packs chosen in Settings > Appearance (theme/packs.ts); "theme" plays the theme's sounds. Names a pack
// lacks fall back to MakeWork's own.
const soundPacks = new Map<string, { name: string; sounds: Partial<Record<SoundName, string>> }>([
  ["makework", { name: "MakeWork", sounds: defaults }],
]);

export function soundPackList(): { id: string; name: string }[] {
  return [...soundPacks].map(([id, pack]) => ({ id, name: pack.name }));
}

// Silent when neither the pack (or theme) nor the defaults have a sound for the name.
export function playSound(name: SoundName): void {
  if (onlineStatus() === "dnd") return;
  const pack = soundPack();
  const url = (pack === "theme" ? theme().sounds[name] : soundPacks.get(pack)?.sounds[name]) ?? defaults[name];
  if (!url || soundVolume() === 0) return;
  const audio = new Audio(url);
  audio.volume = soundVolume();
  audio.play().catch(() => {});
}
