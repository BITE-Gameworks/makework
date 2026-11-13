import { useAgentSource } from "../../../agents/source";
import { agentIndexerFor, agentSkills } from "../../registry";
import type { ClientPlugin } from "../../types";
import { agent } from "./agent";
import { leader } from "./leader";
import { isScratchpadName } from "../../../agents/scratchpad";
import { agentsPluginId } from "./settings";
import WorkspaceAgentSettings from "./WorkspaceAgentSettings";

// Agents ask the plugin registry for the skills and indexers channel plugins contribute.
useAgentSource({ skills: agentSkills, indexer: agentIndexerFor });

export const agentsPlugin: ClientPlugin = {
  manifest: {
    id: agentsPluginId,
    icon: "bot",
    name: "Agentic bots",
    version: "0.1.0",
    description: "Bots that think with a language model you run yourself (a llama.cpp server). Off by default. Set up in Workspace settings > Plugins.",
    author: "MakeWork",
  },
  bots: { agent, leader },
  workspaceSettings: WorkspaceAgentSettings,
  categoryNote: (name) => (isScratchpadName(name) ? "for bots" : undefined),
};
