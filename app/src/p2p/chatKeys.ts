// Who may read which of a channel's keys, and what keeps them moving (ADR 0021). Shared by the policy every member
// checks and the keyring (p2p/chatKeyring.ts), so both agree.
import type { ApiValue } from "../api/types";
import type { RoleTables, Row } from "./permissions";
import { canSee } from "./visibility";

type Rows = (plugin: string, table: string, where?: Record<string, ApiValue>) => Row[];

export interface Epoch {
  channelId: number;
  epoch: number;
  check: string;
  createdBy: number;
  createdAt: number;
}

export function epochsOf(rows: Rows, channelId: number): Epoch[] {
  return rows("chat", "chat_keys", { channel_id: channelId })
    .map((r) => ({ channelId, epoch: Number(r.epoch), check: String(r.check), createdBy: Number(r.created_by), createdAt: Date.parse(String(r.created_at)) }))
    .sort((a, b) => a.epoch - b.epoch);
}

// Who reads chat: members with a profile (not bots, which use their host's device) and the owner.
export function readers(rows: Rows, owner: number | null): number[] {
  const people = new Set(rows("members", "members_profiles").filter((p) => p.bot !== true).map((p) => Number(p.user_id)));
  if (owner !== null) people.add(owner);
  return [...people];
}

// A current, unbanned member (or the owner) who can see the channel.
export function mayReadChannel(rows: Rows, roles: RoleTables, owner: number | null, userId: number, channelId: number): boolean {
  const channel = rows("channels", "channels_channels", { id: channelId })[0];
  if (!channel || roles.bans.some((b) => b.user_id === userId)) return false;
  if (userId !== owner && !rows("members", "members_profiles", { user_id: userId }).some((p) => p.bot !== true)) return false;
  const target = { channelId, categoryId: channel.category_id === null || channel.category_id === undefined ? null : Number(channel.category_id) };
  return canSee(rows("channels", "channels_visibility"), roles, owner, userId, target);
}

// A guest reads only epochs made after they joined.
export function mayRead(rows: Rows, roles: RoleTables, owner: number | null, userId: number, epoch: Epoch): boolean {
  if (!mayReadChannel(rows, roles, owner, userId, epoch.channelId)) return false;
  const since = roles.guests?.get(userId);
  return since === undefined || epoch.createdAt >= since;
}

export interface KeyPlan {
  // Why the channel needs a new epoch, or null.
  rotate: "none-yet" | "lost-access" | "guest" | null;
  // Epochs to give, of those this device holds.
  grants: { userId: number; epoch: number }[];
}

// What a device holding the epochs `held` should do for a channel. A channel without keys gets its first from the
// first member who posts in it.
export function keyPlan(rows: Rows, roles: RoleTables, owner: number | null, channelId: number, held: (epoch: number) => boolean): KeyPlan {
  const list = epochsOf(rows, channelId);
  const current = list.at(-1);
  if (!current) return { rotate: "none-yet", grants: [] };
  const given = rows("chat", "chat_key_grants", { channel_id: channelId });
  const has = new Set(given.map((g) => `${g.epoch}:${g.user_id}`));
  const reads = new Map<number, boolean>();
  const readsChannel = (user: number) => reads.get(user) ?? reads.set(user, mayReadChannel(rows, roles, owner, user, channelId)).get(user)!;
  if (given.some((g) => Number(g.epoch) === current.epoch && !readsChannel(Number(g.user_id)))) return { rotate: "lost-access", grants: [] };
  const people = readers(rows, owner).filter(readsChannel);
  if (people.some((u) => !has.has(`${current.epoch}:${u}`) && !mayRead(rows, roles, owner, u, current))) return { rotate: "guest", grants: [] };
  const grants: KeyPlan["grants"] = [];
  for (const e of list) {
    if (!held(e.epoch)) continue;
    for (const u of people) if (!has.has(`${e.epoch}:${u}`) && mayRead(rows, roles, owner, u, e)) grants.push({ userId: u, epoch: e.epoch });
  }
  return { rotate: null, grants };
}
