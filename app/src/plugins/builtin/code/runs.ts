// Run configurations (code_runs) are shared in the channel; which commands this device agreed to run is not
// (core/approvedCommands.ts).
import type { PluginClient } from "../../../api/client";
import type { ApiValue } from "../../../api/types";
import { approve as approveCommand, mayRun } from "../../../core/approvedCommands";
import { desktop } from "../../../core/desktop";
import { readJson, writeJson } from "../../../core/storage";
import { createLive } from "../../live";

export interface RunConfig { id: number; name: string; command: string; updatedBy: number }

const row = (value: Record<string, ApiValue>): RunConfig => ({
  id: Number(value.id), name: String(value.name ?? ""), command: String(value.command ?? ""), updatedBy: Number(value.updated_by ?? value.author_id),
});

export const createRuns = (api: PluginClient, channelId: number) => createLive<RunConfig[]>(api, [], () => channelId,
  async () => (await api.call<{ rows: Record<string, ApiValue>[] }>("list-runs", { channel_id: channelId })).rows.map(row));

const approvedKey = (place: string) => `code.approved.${place}`;
export const isApproved = (place: string, run: RunConfig, me: number | null) => mayRun(approvedKey(place), run, me);
export const approve = (place: string, id: number, command: string) => approveCommand(approvedKey(place), id, command);

const lastKey = (place: string) => `code.lastRun.${place}`;
// "file" or a run configuration's id: what the Run button does without opening its menu.
export const lastRun = (place: string) => readJson<string | number>(lastKey(place), "file");
export const rememberRun = (place: string, which: string | number) => writeJson(lastKey(place), which);

const windows = () => desktop?.platform === "win32";
// Quoted for the shell the terminal uses: POSIX shells, or PowerShell on Windows.
const quote = (value: string) => (windows() ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", String.raw`'\''`)}'`);
const then = (first: string, next: string) => (windows() ? `${first}; if ($?) { ${next} }` : `${first} && ${next}`);

// The command "Run this file" uses, by language; null when there is none. `path` is relative to the run folder
// with "/" between folders; `hasFile` tells whether the project has a file at a root path (Cargo.toml).
export function fileCommand(language: string, path: string, hasFile: (name: string) => boolean): string | null {
  const file = quote(path);
  const stem = path.replace(/\.[^./]+$/, "");
  const binary = windows() ? `.\\${stem.replaceAll("/", "\\")}.exe` : `./${stem}`;
  const compiled = (compiler: string) => then(`${compiler} ${file} -o ${quote(windows() ? `${stem}.exe` : stem)}`, windows() ? `& ${quote(binary)}` : quote(binary));
  switch (language) {
    case "python": return `${windows() ? "python" : "python3"} ${file}`;
    case "javascript": return `node ${file}`;
    case "typescript": return `npx --yes tsx ${file}`;
    case "go": return `go run ${file}`;
    case "rust": return hasFile("Cargo.toml") ? "cargo run" : compiled("rustc");
    case "c": return compiled("cc");
    case "cpp": return compiled("c++");
    case "java": return `java ${file}`;
    case "csharp": return "dotnet run";
    case "shell": return `bash ${file}`;
    default: return null;
  }
}
