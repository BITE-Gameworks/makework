// Whether editors show formatted text or the markdown itself. One choice for every editor, kept on this device.
import { createSignal } from "solid-js";
import { readJson, writeJson } from "../core/storage";

const key = "mw.editor.markdown";
const [markdownMode, setMode] = createSignal<boolean>(readJson(key, false));
export { markdownMode };

export function setMarkdownMode(on: boolean): void {
  setMode(on);
  writeJson(key, on);
}
