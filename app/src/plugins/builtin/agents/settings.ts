// What the agents plugin shares across a workspace, in the bots plugin's bots_defaults (Workspace settings > Plugins).
import { localServerUrl } from "../../../core/llm";
import type { PluginClient } from "../../../api/client";

export const agentsPluginId = "makework.agents";
export const serverDefaultKey = "server";
export const stepsDefaultKey = "maxSteps";

export const workspaceDefault = async (bots: Pick<PluginClient, "read">, key: string): Promise<string> =>
  String((await bots.read("bots_defaults", { key }).catch(() => []))[0]?.value ?? "").trim();

// A bot's own address, else the workspace's, else this device's own server.
export const serverUrlOf = async (config: Record<string, unknown>, bots: Pick<PluginClient, "read">): Promise<string> =>
  String(config.server ?? "").trim() || (await workspaceDefault(bots, serverDefaultKey)) || localServerUrl;
