// Every skill an agent can have, and which of them a task is offered. The general ones live here (search, memory, web);
// the skills for a kind of channel come from the plugin that owns it (`ClientPlugin.agentSkills`, via agents/source.ts).
import type { BotContext } from "../plugins/types";
import { channelSkills } from "./skillsChannels";
import { memorySkills } from "./skillsMemory";
import { searchSkills } from "./skillsSearch";
import { webSkills } from "./skillsWeb";
import { agentSource } from "./source";
import { channelTypeHints, scratchpadFor, type AgentSkill } from "./skillKit";

export type { AgentSkill, SkillEnv, SkillResult } from "./skillKit";
export { findChannel } from "./skillKit";

export const generalSkills: AgentSkill[] = [...searchSkills, ...memorySkills, ...webSkills, ...channelSkills];

export const allSkills = (): AgentSkill[] => [...generalSkills, ...agentSource().skills()];

// The skills whose permissions the bot holds and whose channel type the workspace has, so the model chooses among
// tools it can use.
export async function skillsFor(context: BotContext, sees: boolean): Promise<AgentSkill[]> {
  const types = new Set((await context.channels()).map((c) => c.type));
  if (await scratchpadFor(context)) for (const type of Object.keys(channelTypeHints)) types.add(type);
  return allSkills().filter((skill) =>
    skill.permissions.every(context.granted) && (!skill.channelType || types.has(skill.channelType)) && (sees || !skill.name.startsWith("design_look")));
}

const abilityOf = (permission: string): string =>
  permission === "web" ? "search the web or read web pages"
    : permission === "memory" ? "use the workspace index and notes"
      : permission === "write:channels" ? "create and rename channels and categories"
        : permission.startsWith("write:") ? `change ${permission.slice(6)} channels`
        : `look into ${permission.slice(5)} channels`;

// What this bot could do if a member who manages bots gave it more permissions (only for channel types the workspace has),
// so it can say so instead of claiming it is impossible.
export async function lockedAbilities(context: BotContext): Promise<string[]> {
  const types = new Set((await context.channels()).map((c) => c.type));
  const missing = new Set<string>();
  for (const skill of allSkills()) {
    if (skill.channelType && !types.has(skill.channelType)) continue;
    for (const permission of skill.permissions) if (!context.granted(permission)) missing.add(permission);
  }
  // Reading a channel type is implied by changing it; list one ability per type.
  return [...missing].filter((p) => !(p.startsWith("read:") && missing.has(`write:${p.slice(5)}`))).map(abilityOf);
}
