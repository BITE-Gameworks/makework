import { createSignal } from "solid-js";
import { readJson, writeJson } from "../../../core/storage";

const panels = {
  "design.layers": { key: "design.layersWidth", min: 180, max: 520 },
  "design.properties": { key: "design.propertiesWidth", min: 180, max: 520 },
  "diagram.library": { key: "diagram.libraryWidth", min: 180, max: 520 },
  "diagram.properties": { key: "diagram.propertiesWidth", min: 180, max: 520 },
} as const;

export type CanvasPanel = keyof typeof panels;

const widths = Object.fromEntries(
  Object.entries(panels).map(([id, panel]) => [id, createSignal<number | null>(readJson(panel.key, null))]),
) as Record<CanvasPanel, ReturnType<typeof createSignal<number | null>>>;

export const panelWidth = (panel: CanvasPanel) => widths[panel][0]();
export const setPanelWidth = (panel: CanvasPanel, width: number | null) => {
  const limits = panels[panel];
  widths[panel][1](width === null ? null : Math.round(Math.min(limits.max, Math.max(limits.min, width))));
};
export const savePanelWidth = (panel: CanvasPanel) => writeJson(panels[panel].key, panelWidth(panel));
