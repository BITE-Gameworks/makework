// Whether others see "... is typing" while you write in chat. Kept on this device.
import { createSignal } from "solid-js";
import { readJson, writeJson } from "./storage";

const key = "mw.sendTyping";
const [on, setOn] = createSignal(readJson(key, true));
export const sendTyping = on;

export function setSendTyping(value: boolean): void {
  setOn(value);
  writeJson(key, value);
}
