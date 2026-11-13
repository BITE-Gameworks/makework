// Emoji this user picked lately, newest first, kept on this device.
import { createSignal } from "solid-js";
import { readJson, writeJson } from "../core/storage";

const key = "mw.emoji.recent";
const [recent, setRecent] = createSignal<string[]>(readJson(key, []));
export { recent };

export function rememberEmoji(name: string): void {
  setRecent((list) => [name, ...list.filter((n) => n !== name)].slice(0, 16));
  writeJson(key, recent());
}
