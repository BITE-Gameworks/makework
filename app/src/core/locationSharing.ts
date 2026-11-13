// Whether people who manage a workspace's nodes may see roughly where you are (your time zone's place), which node you
// use and whom you are connected to, on the globe in Server settings > Nodes (p2p/memberMap.ts). Off unless turned on;
// kept on this device.
import { createSignal } from "solid-js";
import { readJson, writeJson } from "./storage";


const key = "mw.shareLocation";
const [on, setOn] = createSignal(readJson(key, false));
export const shareLocation = on;

export function setShareLocation(value: boolean): void {
  setOn(value);
  writeJson(key, value);
}
