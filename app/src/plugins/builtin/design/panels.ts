import { panelWidth as width, savePanelWidth as save, setPanelWidth as set } from "../canvas/panels";

export type DesignPanel = "layers" | "properties";

const panelId = (panel: DesignPanel) => `design.${panel}` as const;
export const panelWidth = (panel: DesignPanel) => width(panelId(panel));
export const setPanelWidth = (panel: DesignPanel, value: number | null) => set(panelId(panel), value);
export const savePanelWidth = (panel: DesignPanel) => save(panelId(panel));
