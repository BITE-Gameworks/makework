// The docs view's per-device settings: tree/editor widths, edit mode, and the last page open per channel.
import { createSignal } from "solid-js";
import { readJson, writeJson } from "../../../core/storage";

export type DocsMode = "preview" | "edit" | "split";

const widthKey = "docs.treeWidth";
const editorWidthKey = "docs.editorWidth";
const modeKey = "docs.mode";
const [treeWidth, setTreeWidthSignal] = createSignal<number | null>(readJson(widthKey, null));
const [editorWidth, setEditorWidthSignal] = createSignal<number | null>(readJson(editorWidthKey, null));
const [mode, setModeSignal] = createSignal<DocsMode>(readJson(modeKey, "preview"));

export { treeWidth, editorWidth, mode };
export const setTreeWidth = (w: number | null) => setTreeWidthSignal(w === null ? null : Math.round(Math.min(520, Math.max(160, w))));
export const saveTreeWidth = () => writeJson(widthKey, treeWidth());
export const setEditorWidth = (w: number | null) => setEditorWidthSignal(w === null ? null : Math.round(Math.max(180, w)));
export const saveEditorWidth = () => writeJson(editorWidthKey, editorWidth());
export const setMode = (m: DocsMode) => {
  setModeSignal(m);
  writeJson(modeKey, m);
};

const openKey = (place: string) => `docs.open.${place}`;
export const lastOpen = (place: string) => readJson<number | null>(openKey(place), null);
export const rememberOpen = (place: string, id: number | null) => writeJson(openKey(place), id);
