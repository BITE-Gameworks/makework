// What each permission allows and what a member has, from the `roles` tables. Shared by the policy every member
// checks (policy.ts) and the UI (core/roles.ts), so both agree.
import type { ApiValue } from "../api/types";

export const permissionInfo = {
  administrator: { label: "Administrator", description: "Every permission. Roles above theirs still can't be changed." },
  manage_workspace: { label: "Manage workspace", description: "Change workspace settings." },
  manage_invites: { label: "Manage invites", description: "Create, revoke and permanently delete invitations to this workspace." },
  manage_history: { label: "Manage history", description: "Create snapshots and archive older workspace history." },
  manage_plugins: { label: "Manage plugins", description: "Add, update, disable or remove plugins in the workspace." },
  manage_emojis: { label: "Manage emoji", description: "Add and remove the workspace's custom emoji." },
  manage_bots: { label: "Manage bots", description: "Create, configure, run and remove bots in the workspace." },
  store_credentials: { label: "Store credentials", description: "Save secrets such as a model server's key. Only members with this permission (and nodes) can read them." },
  manage_roles: { label: "Manage roles", description: "Create, edit and hand out roles below their highest role." },
  manage_channels: { label: "Manage channels", description: "Add, rename and remove categories and channels." },
  kick_members: { label: "Kick members", description: "Remove members below their highest role; they can join again with an invite." },
  ban_members: { label: "Ban members", description: "Ban members below their highest role: their changes are refused." },
  mute_members: { label: "Mute members", description: "Mute members below their highest role in calls, or in chat (messages, reactions, votes, comments)." },
  manage_messages: { label: "Manage messages", description: "Delete other people's messages, reactions and comments." },
  mention_everyone: { label: "Mention @everyone", description: "@everyone, @here and every role notify people." },
  view_history: { label: "View history", description: "See the workspace's history of changes." },
  manage_nodes: { label: "Manage nodes", description: "Authorize or ignore nodes, which keep the workspace's files and serve them to members, and see where members who share their location connect." },
  send_messages: { label: "Send messages", description: "Write in chat channels, react, vote and comment." },
  edit_content: { label: "Edit content", description: "Change tasks, files and designs." },
} as const;

export type Permission = keyof typeof permissionInfo;
export const allPermissions = Object.keys(permissionInfo) as Permission[];
export const defaultPermissions: Permission[] = ["send_messages", "edit_content"];

// Before a workspace has an @everyone role it keeps the rules it started with: everything open but server settings,
// roles, kicks and bans. Otherwise adding roles would refuse changes members had already made.
const openPermissions = allPermissions.filter((p) => ![
  "administrator", "manage_workspace", "manage_invites", "manage_history", "manage_plugins", "manage_bots", "store_credentials", "manage_roles", "kick_members", "ban_members", "mute_members", "manage_nodes", "view_history",
].includes(p));

export function isPermission(name: string): name is Permission {
  return name in permissionInfo;
}

export type Row = { id: number } & Record<string, ApiValue>;

export interface RoleTables {
  roles: Row[];
  members: Row[];
  bans: Row[];
  // kind "voice" or "chat", until someone with Mute members removes the row.
  mutes?: Row[];
  // Guests and when they joined (ms), from `guestsFrom`.
  guests?: Map<number, number>;
}

type Rows = (plugin: string, table: string, where?: Record<string, ApiValue>) => Row[];

// Guests: members whose latest join used a guest invite and who weren't made full members since, with when they
// joined (ms). The join's time is checked against its commit's by the policy.
export function guestsFrom(rows: Rows): Map<number, number> {
  const guestInvites = new Set(rows("members", "members_invites").filter((i) => i.guest === true).map((i) => i.id));
  const guests = new Map<number, number>();
  if (guestInvites.size === 0) return guests;
  const latest = new Map<number, Row>();
  for (const join of rows("members", "members_invite_joins")) latest.set(Number(join.user_id), join);
  const promoted = new Map<number, number>();
  for (const p of rows("members", "members_promotions"))
    promoted.set(Number(p.user_id), Math.max(promoted.get(Number(p.user_id)) ?? -Infinity, Date.parse(String(p.created_at))));
  for (const [user, join] of latest) {
    const at = Date.parse(String(join.joined_at));
    if (guestInvites.has(Number(join.invite_id)) && Number.isFinite(at) && (promoted.get(user) ?? -Infinity) < at) guests.set(user, at);
  }
  return guests;
}

// Guests are members of the Guest role without a `roles_members` row (so nobody needs Manage roles when they join).
export function withGuests(tables: RoleTables, guests: Map<number, number>): RoleTables {
  const role = tables.roles.find((r) => r.guest === true);
  const members = role ? [...tables.members, ...[...guests.keys()].map((user) => ({ id: -user, user_id: user, role_id: role.id }))] : tables.members;
  return { ...tables, members, guests };
}

export type MuteKind = "voice" | "chat";
export const isMuteKind = (kind: unknown): kind is MuteKind => kind === "voice" || kind === "chat";

// The `roles` tables gathered from any source of rows (a policy's `rows`, a ledger's `select`, the backend's `data`),
// so every caller that needs the whole set reads them the same way.
export function roleTablesFrom(rows: Rows): RoleTables {
  return withGuests({
    roles: rows("roles", "roles_roles"), members: rows("roles", "roles_members"),
    bans: rows("roles", "roles_bans"), mutes: rows("roles", "roles_mutes"),
  }, guestsFrom(rows));
}

// Kicked out of the workspace: a kick row and no profile (a profile sent again, joining with an invite, lifts it). The
// latest kick, for who did it; null for anyone not kicked out. The policy, the member's app and a node's calls all
// ask this one rule.
export function kickedBy(rows: (plugin: string, table: string, where?: Record<string, ApiValue>) => Row[], user: number): Row | null {
  const kicks = rows("members", "members_kicks", { user_id: user });
  if (kicks.length === 0 || rows("members", "members_profiles", { user_id: user }).length > 0) return null;
  return kicks.at(-1)!;
}

export interface Standing {
  owner: boolean;
  banned: boolean;
  permissions: Set<Permission>;
  // Muted by a moderator: others don't hear them in calls (voice); they lose Send messages (chat).
  muted: { voice: boolean; chat: boolean };
  // The position of their highest role; the owner is above everything.
  highest: number;
}

export function parsePermissions(text: ApiValue): Permission[] {
  return String(text ?? "").split(",").map((p) => p.trim()).filter(isPermission);
}

export function standing(tables: RoleTables, userId: number, ownerId: number | null): Standing {
  if (userId === ownerId) return { owner: true, banned: false, permissions: new Set(allPermissions), muted: { voice: false, chat: false }, highest: Infinity };
  const banned = tables.bans.some((b) => b.user_id === userId);
  const everyone = tables.roles.find((r) => r.everyone);
  const mine = tables.members.filter((m) => m.user_id === userId)
    .map((m) => tables.roles.find((r) => r.id === m.role_id)).filter((r): r is Row => !!r && !r.everyone);
  // Guests have the Guest role's permissions instead of @everyone's, once there is one.
  const guest = !!tables.guests?.has(userId) && tables.roles.some((r) => r.guest === true);
  const permissions = new Set<Permission>(guest ? [] : everyone ? parsePermissions(everyone.permissions) : openPermissions);
  for (const role of mine) parsePermissions(role.permissions).forEach((p) => permissions.add(p));
  if (permissions.has("administrator")) allPermissions.forEach((p) => permissions.add(p));
  const mutes = (tables.mutes ?? []).filter((m) => m.user_id === userId);
  const muted = { voice: mutes.some((m) => m.kind === "voice"), chat: mutes.some((m) => m.kind === "chat") };
  if (muted.chat) permissions.delete("send_messages");
  const highest = Math.max(0, ...mine.map((r) => Number(r.position)));
  return { owner: false, banned, permissions, muted, highest };
}

// The permissions a channel's edit rules (p2p/visibility.ts) give or take inside that channel.
export const channelPermissions: Permission[] = ["edit_content", "send_messages"];
