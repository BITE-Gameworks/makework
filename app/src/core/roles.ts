// Roles, role members, bans and mutes per workspace, from the `roles` plugin, and what the signed-in user may do there.
// The UI only hides what would be refused anyway: every member's policy (p2p/policy.ts) decides.
import { createStore, reconcile } from "solid-js/store";
import type { ApiClient } from "../api/client";
import { guestsFrom, standing, withGuests, type MuteKind, type Permission, type RoleTables, type Row, type Standing } from "../p2p/permissions";
import { myId } from "./members";
import { trimChars } from "./text";

const [tables, setTables] = createStore<Record<string, RoleTables & { owner: number | null }>>({});
const empty: RoleTables = { roles: [], members: [], bans: [], mutes: [] };

export async function loadRoles(workspaceId: string, api: ApiClient, owner: () => number | null): Promise<void> {
  const ext = api.plugin("roles");
  const people = api.plugin("members");
  const load = async () => {
    try {
      const [roles, members, bans, mutes, invites, joins, promotions] = await Promise.all([
        ext.read("roles_roles"), ext.read("roles_members"), ext.read("roles_bans"), ext.read("roles_mutes"),
        people.read("members_invites"), people.read("members_invite_joins"), people.read("members_promotions"),
      ]);
      const found: Record<string, Row[]> = { members_invites: invites, members_invite_joins: joins, members_promotions: promotions };
      const guests = guestsFrom((_, table) => found[table] ?? []);
      const withThem = withGuests({ roles, members, bans, mutes }, guests);
      setTables(workspaceId, reconcile({ ...withThem, guests: undefined, owner: owner() }, { key: "id" }));
      guestTimes.set(workspaceId, guests);
    } catch (e) {
      console.warn(`Roles of '${workspaceId}' not loaded:`, e);
      // Channels wait for the roles (rolesLoaded); without any, rules for @everyone and roles can't apply.
      if (!tables[workspaceId]) setTables(workspaceId, { ...empty, owner: owner() });
    }
  };
  ext.onEvent(() => void load());
  people.onEvent((e) => ["members_invites", "members_invite_joins", "members_promotions"].includes(e.table) && void load());
  await load();
}

// Whether the roles were read; until then nobody's visibility can be worked out.
export function rolesLoaded(workspaceId: string): boolean {
  return tables[workspaceId] !== undefined;
}

export function forgetRoles(workspaceId: string): void {
  setTables(workspaceId, undefined!);
}

export function roleTablesOf(workspaceId: string): RoleTables {
  return { ...(tables[workspaceId] ?? empty), guests: guestTimes.get(workspaceId) };
}

export function workspaceOwner(workspaceId: string): number | null {
  return tables[workspaceId]?.owner ?? null;
}

// Kept outside the store: a Map doesn't reconcile.
const guestTimes = new Map<string, Map<number, number>>();

export function standingOf(workspaceId: string, userId: number): Standing {
  return standing({ ...(tables[workspaceId] ?? empty), guests: guestTimes.get(workspaceId) }, userId, workspaceOwner(workspaceId));
}

// When a guest joined (ms), or null for full members.
export function guestSince(workspaceId: string, userId: number): number | null {
  void tables[workspaceId]?.members;
  return guestTimes.get(workspaceId)?.get(userId) ?? null;
}

export function can(workspaceId: string, permission: Permission): boolean {
  const me = myId(workspaceId);
  return me !== null && standingOf(workspaceId, me).permissions.has(permission);
}

// Roles from the highest down, @everyone last.
export function roleList(workspaceId: string): Row[] {
  return [...(tables[workspaceId]?.roles ?? [])].sort((a, b) => Number(b.position) - Number(a.position));
}

export function rolesOf(workspaceId: string, userId: number): Row[] {
  const ids = new Set((tables[workspaceId]?.members ?? []).filter((m) => m.user_id === userId).map((m) => m.role_id));
  return roleList(workspaceId).filter((r) => ids.has(r.id));
}

export function bans(workspaceId: string): Row[] {
  return tables[workspaceId]?.bans ?? [];
}

export function isMuted(workspaceId: string, userId: number, kind: MuteKind): boolean {
  return (tables[workspaceId]?.mutes ?? []).some((m) => m.user_id === userId && m.kind === kind);
}

// Whether the signed-in member may mute, kick or ban this one: the permission, and the member below their highest role.
export function canModerate(workspaceId: string, userId: number, permission: Permission): boolean {
  const me = myId(workspaceId);
  if (me === null || me === userId) return false;
  const mine = standingOf(workspaceId, me);
  const theirs = standingOf(workspaceId, userId);
  return mine.permissions.has(permission) && !theirs.owner && theirs.highest < mine.highest;
}

export async function setMuted(api: ApiClient, userId: number, kind: MuteKind, on: boolean): Promise<void> {
  await api.plugin("roles").call(on ? "mute" : "unmute", { user_id: userId, kind });
}

export function isBanned(workspaceId: string, userId: number): boolean {
  return bans(workspaceId).some((b) => b.user_id === userId);
}

// How a role is mentioned: @ and its name in lowercase, spaces and other characters as "_" (so "Art Team" is
// @art_team). Members' usernames win over role names.
export function roleSlug(name: unknown): string {
  return trimChars(String(name ?? "").toLowerCase().replace(/[^a-z0-9._]+/g, "_"), "._");
}

export function roleBySlug(workspaceId: string, slug: string): Row | undefined {
  return roleList(workspaceId).find((r) => !r.everyone && roleSlug(r.name) === slug);
}

// Whether the author may notify people with this role: anyone if it is mentionable, else "Mention @everyone".
export function canMentionRole(workspaceId: string, authorId: number, role: Row): boolean {
  return !!role.mentionable || standingOf(workspaceId, authorId).permissions.has("mention_everyone");
}

// Whether @everyone, @here or a role of yours in a message notifies you. @here works like @everyone: only recent
// messages notify, so it reaches the people who are online.
export function groupMentionsMe(workspaceId: string, body: string, authorId: number): boolean {
  return groupMention(workspaceId, body, authorId) !== null;
}

// Which kind of group mention in a message reaches you: "everyone" (@everyone, @here), "role", or null.
export function groupMention(workspaceId: string, body: string, authorId: number): "everyone" | "role" | null {
  const me = myId(workspaceId);
  if (me === null) return null;
  const names = new Set([...body.matchAll(/(?<![\w@.])@([a-z0-9._]*[a-z0-9_])/gi)].map((m) => m[1].toLowerCase()));
  if ((names.has("everyone") || names.has("here")) && standingOf(workspaceId, authorId).permissions.has("mention_everyone")) return "everyone";
  return rolesOf(workspaceId, me).some((role) => names.has(roleSlug(role.name)) && canMentionRole(workspaceId, authorId, role)) ? "role" : null;
}
