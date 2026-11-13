// Build configurations for releases (git_builds) are shared in the channel; which of them this device agreed to
// run is not (core/approvedCommands.ts). Agreeing covers the whole configuration: its folders say where the
// commands run, so changing them asks again too.
import type { PluginClient } from "../../../api/client";
import type { ApiValue } from "../../../api/types";
import { approve, mayRun } from "../../../core/approvedCommands";
import { desktop, type BuildCollect, type BuildPlan } from "../../../core/desktop";
import { createLive } from "../../live";

export interface BuildConfig { id: number; name: string; plan: BuildPlan; system: string; updatedBy: number }

const parsed = <T>(text: ApiValue, fallback: T): T => {
  try {
    return JSON.parse(String(text)) as T;
  } catch {
    return fallback;
  }
};

// Rows come from any member's commits, and the policy checks only who wrote them: JSON of the wrong shape reads as
// no commands (the build then refuses to run) rather than breaking the page.
function asCollect(value: unknown): BuildCollect {
  const c = value as { kind?: unknown; pattern?: unknown } | null;
  if (c?.kind === "pattern" && typeof c.pattern === "string") return { kind: "pattern", pattern: c.pattern };
  if (c?.kind === "binaries" || c?.kind === "installers" || c?.kind === "zip") return { kind: c.kind };
  return { kind: "binaries" };
}

const row = (value: Record<string, ApiValue>): BuildConfig => {
  const steps = parsed<unknown>(value.steps, []);
  return {
    id: Number(value.id), name: String(value.name ?? ""), system: String(value.system ?? ""), updatedBy: Number(value.updated_by ?? value.author_id),
    plan: {
      project: String(value.project ?? "."), output: String(value.output ?? "."),
      steps: Array.isArray(steps) ? steps.filter((s): s is string => typeof s === "string") : [], collect: asCollect(parsed<unknown>(value.collect, null)),
    },
  };
};

export const createBuilds = (api: PluginClient, channelId: number) => createLive<BuildConfig[]>(api, [], () => channelId,
  async () => (await api.call<{ rows: Record<string, ApiValue>[] }>("list-builds", { channel_id: channelId })).rows.map(row));

// A plain copy, apart from the live list: it can go through IPC (store proxies can't be cloned), and what a member
// agreed to run stays what runs if someone changes the configuration meanwhile.
export const copyBuild = (config: BuildConfig): BuildConfig => JSON.parse(JSON.stringify(config)) as BuildConfig;

const approvedKey = (place: string) => `git.approved.${place}`;
const asCommand = (config: BuildConfig) => ({ id: config.id, command: JSON.stringify(config.plan), updatedBy: config.updatedBy });
export const mayBuild = (place: string, config: BuildConfig, me: number | null) => mayRun(approvedKey(place), asCommand(config), me);
export const approveBuild = (place: string, config: BuildConfig) => approve(approvedKey(place), config.id, JSON.stringify(config.plan));

// Saves a new build configuration (no `id`) or changes one, written for this computer's system. Returns its id.
export async function saveBuild(api: PluginClient, channelId: number, id: number | null, name: string, plan: BuildPlan): Promise<number> {
  const fields = {
    name, project: plan.project, output: plan.output, steps: JSON.stringify(plan.steps), collect: JSON.stringify(plan.collect),
    system: desktop?.platform ?? "",
  };
  if (id !== null) {
    await api.call("update-build", { build_id: id, ...fields });
    return id;
  }
  return (await api.call<{ id: number }>("add-build", { channel_id: channelId, ...fields })).id;
}

export const systemName = (platform: string) => ({ linux: "Linux", win32: "Windows", darwin: "macOS" })[platform] ?? platform;

// Which files a build takes, in words.
export function collectText(collect: BuildCollect): string {
  switch (collect.kind) {
    case "binaries": return "Installers, packages and programs";
    case "installers": return "Installers and packages, also in subfolders";
    case "zip": return "The whole folder as one zip";
    case "pattern": return `Files matching ${collect.pattern}`;
  }
}
