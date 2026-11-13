// Agents get their skills from the plugin registry; tests give them the built-in channel plugins' lists directly.
import { useAgentSource } from "../../src/agents/source";
import { browserSkills } from "../../src/plugins/builtin/browser/agentSkills";
import { chatIndex, chatSkills } from "../../src/plugins/builtin/chat/agentSkills";
import { codeIndex, codeSkills } from "../../src/plugins/builtin/code/agentSkills";
import { designBoardSkills, designChangeSkills, designDrawSkills, designGroupSkills, designSceneSkills, designIndex, designSkills } from "../../src/plugins/builtin/design/agentSkills";
import { diagramIndex, diagramSkills } from "../../src/plugins/builtin/diagram/agentSkills";
import { docsIndex, docsSkills } from "../../src/plugins/builtin/docs/agentSkills";
import { filesIndex, filesSkills } from "../../src/plugins/builtin/files/agentSkills";
import { gitSkills, localGitSkills } from "../../src/plugins/builtin/git/agentSkills";
import { sheetsIndex, sheetsSkills } from "../../src/plugins/builtin/sheets/agentSkills";
import { tasksIndex, tasksSkills } from "../../src/plugins/builtin/tasks/agentSkills";
import type { AgentIndexer, AgentSkill } from "../../src/plugins/types";

const byType: Record<string, AgentSkill[]> = {
  browser: browserSkills, chat: chatSkills, code: codeSkills, design: [...designSkills, ...designChangeSkills, ...designDrawSkills, ...designGroupSkills, ...designSceneSkills, ...designBoardSkills],
  diagram: diagramSkills, docs: docsSkills, files: filesSkills, git: [...gitSkills, ...localGitSkills], sheets: sheetsSkills, tasks: tasksSkills,
};
const indexers: Record<string, AgentIndexer> = {
  chat: chatIndex, code: codeIndex, design: designIndex, diagram: diagramIndex, docs: docsIndex,
  files: filesIndex, sheets: sheetsIndex, tasks: tasksIndex,
};

export function installAgentSource(): void {
  useAgentSource({
    skills: () => Object.entries(byType).flatMap(([type, list]) => list.map((skill) => ({ ...skill, channelType: skill.channelType ?? type }))),
    indexer: (type) => indexers[type],
  });
}
