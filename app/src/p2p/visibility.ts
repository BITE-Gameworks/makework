// Who sees a channel or category, and who may change things in it, from the `channels_visibility` rules. Shared by the policy every member checks
// (policy.ts: changes in a channel you can't see are refused) and the UI (core/workspaces.ts), so both agree.
// Rules only hide things in the app: every member still receives the channel's data.
import { standing, type RoleTables, type Row } from "./permissions";

export type VisibilityTarget = "channel" | "category";

// A member's rule wins over role rules; among their roles (not @everyone) one that shows wins over one that
// hides; then the @everyone rule. A channel's rules come before its category's. Without any, the roles' default
// (`channels` on the role: "show", "hide", or "" like @everyone) decides the same way, else it is visible.
// The owner and administrators see everything.
export function canSee(
  rules: Row[], roles: RoleTables, ownerId: number | null, userId: number, target: { channelId?: number; categoryId: number | null },
): boolean {
  if (rules.length === 0 && !hidesByDefault(roles)) return true;
  const me = standing(roles, userId, ownerId);
  if (me.owner || me.permissions.has("administrator")) return true;
  const everyone = roles.roles.find((r) => r.everyone)?.id;
  const mine = new Set(roles.members.filter((m) => m.user_id === userId).map((m) => m.role_id));
  const byDefault = () => {
    const set = roles.roles.filter((r) => r.id !== everyone && mine.has(r.id) && (r.channels === "show" || r.channels === "hide"));
    if (set.length) return set.some((r) => r.channels === "show");
    return roles.roles.find((r) => r.id === everyone)?.channels !== "hide";
  };
  return ruleFor("visible", rules, roles, userId, target) ?? byDefault();
}

// Whether a member may change things in a channel by its rules (the `edit` of channels_visibility rows, decided
// like visibility); undefined when no rule says, and the workspace's "Edit content" and "Send messages" decide.
export function canEditIn(
  rules: Row[], roles: RoleTables, ownerId: number | null, userId: number, target: { channelId?: number; categoryId: number | null },
): boolean | undefined {
  if (!rules.some((r) => typeof r.edit === "boolean")) return undefined;
  const me = standing(roles, userId, ownerId);
  if (me.owner || me.permissions.has("administrator")) return true;
  return ruleFor("edit", rules, roles, userId, target);
}

// What the rules on a channel, else its category, say about one setting for this member; rows that leave the
// setting unset (null) don't count.
function ruleFor(
  field: "visible" | "edit", rules: Row[], roles: RoleTables, userId: number, target: { channelId?: number; categoryId: number | null },
): boolean | undefined {
  return ruleSource(field, rules, roles, userId, target)?.value;
}

// The rule that decides a setting: whose it is (the member, one of their roles, @everyone) and where (the channel
// or its category). Undefined when no rule says.
export interface RuleSource {
  value: boolean;
  subject: "member" | "role" | "everyone";
  roleId?: number;
  at: VisibilityTarget;
}

export function ruleSource(
  field: "visible" | "edit", rules: Row[], roles: RoleTables, userId: number, target: { channelId?: number; categoryId: number | null },
): RuleSource | undefined {
  const everyone = roles.roles.find((r) => r.everyone)?.id;
  const mine = new Set(roles.members.filter((m) => m.user_id === userId).map((m) => m.role_id));
  const decide = (at: VisibilityTarget, id: number | null | undefined): RuleSource | undefined => {
    if (id == null) return undefined;
    const here = rules.filter((r) => r.target === at && r.target_id === id && typeof r[field] === "boolean");
    if (here.length === 0) return undefined;
    const member = here.find((r) => r.subject === "member" && r.subject_id === userId);
    if (member) return { value: member[field] as boolean, subject: "member", at };
    const byRole = here.filter((r) => r.subject === "role" && r.subject_id !== everyone && mine.has(r.subject_id));
    if (byRole.length) {
      const deciding = byRole.find((r) => r[field]) ?? byRole[0];
      return { value: !!deciding[field], subject: "role", roleId: Number(deciding.subject_id), at };
    }
    const all = here.find((r) => r.subject === "role" && r.subject_id === everyone);
    return all ? { value: all[field] as boolean, subject: "everyone", at } : undefined;
  };
  return decide("channel", target.channelId) ?? decide("category", target.categoryId);
}

// Whether any role hides channels without rules; until one does and while there are no rules, all is visible.
export function hidesByDefault(roles: RoleTables): boolean {
  return roles.roles.some((r) => r.channels === "hide");
}
