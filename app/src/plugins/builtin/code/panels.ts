import { createSignal } from "solid-js";
import { readJson, writeJson } from "../../../core/storage";

const widthKey = "code.treeWidth";
const [treeWidth, setTreeWidthSignal] = createSignal<number | null>(readJson(widthKey, null));
export { treeWidth };
export const setTreeWidth = (value: number | null) => setTreeWidthSignal(value === null ? null : Math.max(180, Math.min(520, Math.round(value))));
export const saveTreeWidth = () => writeJson(widthKey, treeWidth());

const openKey = (place: string) => `code.open.${place}`;
export const rememberedOpen = (place: string) => readJson<number[]>(openKey(place), []);
export const rememberOpen = (place: string, ids: number[]) => writeJson(openKey(place), ids);

const heightKey = "code.terminalHeight";
const [terminalHeight, setTerminalHeightSignal] = createSignal<number | null>(readJson(heightKey, null));
export { terminalHeight };
export const setTerminalHeight = (value: number | null) => setTerminalHeightSignal(value === null ? null : Math.max(120, Math.min(800, Math.round(value))));
export const saveTerminalHeight = () => writeJson(heightKey, terminalHeight());
