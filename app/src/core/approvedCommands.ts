// Commands members share for others to run on their own computers (code run configurations, release build
// configurations); which of them this device agreed to run is kept here only. A command runs without asking when
// this member made its last change, or when this device saw exactly that text before and its user agreed: anyone
// changing it makes every other device ask again. `place` keeps channels (and kinds of command) apart.
import { readJson, writeJson } from "./storage";

export interface SharedCommand { id: number; command: string; updatedBy: number }

export function approve(place: string, id: number, command: string): void {
  writeJson(place, { ...readJson<Record<string, string>>(place, {}), [id]: command });
}

export const mayRun = (place: string, shared: SharedCommand, me: number | null): boolean =>
  (me !== null && shared.updatedBy === me) || readJson<Record<string, string>>(place, {})[shared.id] === shared.command;
