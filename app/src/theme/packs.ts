// Icon and sound packs, chosen apart from the theme (Settings > Appearance), per device. "theme" follows the
// theme's own icons and sounds.
import { createSignal } from "solid-js";
import { readJson, writeJson } from "../core/storage";

const iconKey = "mw.iconPack";
const soundKey = "mw.soundPack";

const [iconPack, setIconPackSignal] = createSignal<string>(readJson(iconKey, "theme"));
const [soundPack, setSoundPackSignal] = createSignal<string>(readJson(soundKey, "theme"));
export { iconPack, soundPack };

export function setIconPack(id: string): void {
  setIconPackSignal(id);
  writeJson(iconKey, id);
}

export function setSoundPack(id: string): void {
  setSoundPackSignal(id);
  writeJson(soundKey, id);
}
