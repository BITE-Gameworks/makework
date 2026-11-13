// Where agents get what plugins contribute (skills and indexers). The agents plugin connects this to the plugin
// registry when it starts; tests give it plain lists. Nothing in agents/ imports the registry or any channel plugin.
import type { AgentIndexer, AgentSkill } from "../plugins/types";

export interface AgentSource {
  skills(): AgentSkill[];
  indexer(type: string): AgentIndexer | undefined;
}

let source: AgentSource = { skills: () => [], indexer: () => undefined };

export const useAgentSource = (next: AgentSource): void => { source = next; };
export const agentSource = (): AgentSource => source;
