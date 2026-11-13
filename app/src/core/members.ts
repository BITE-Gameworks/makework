// User profiles per workspace and who the signed-in user is there, from the `members` plugin.
import { createEffect, createMemo, createRoot, on, untrack } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { ApiClient } from "../api/client";
import { account } from "./account";
import { cleanBotUsername } from "./botName";
import { isAssignableBot } from "./botStatus";
import { isNode } from "./nodes";

export interface Member {
  id: number;
  username: string;
  // Tells apart members who share the username (ada·4f2a).
  tag: string;
  // The workspace nickname if set, else the account's display name.
  displayName: string;
  accountName: string;
  nickname: string;
  bio: string;
  color: string;
  avatar: string;
  bot: boolean;
  botType: string;
}

const apis = new Map<string, ApiClient>();
// moved: old user id -> new one, for members the owner moved to another account (core/memberMove.ts).
const [members, setMembers] = createStore<Record<string, { me: number | null; byId: Record<number, Member>; moved: Record<number, number> }>>({});

export async function loadMembers(workspaceId: string, api: ApiClient): Promise<void> {
  apis.set(workspaceId, api);
  const ext = api.plugin("members");
  const load = async () => {
    try {
      const [rows, moves, { user_id }] = await Promise.all([
        ext.read("members_profiles"), ext.read("members_moves"), ext.call<{ user_id: number }>("whoami"),
      ]);
      const moved = Object.fromEntries(moves.map((m) => [Number(m.from_id), Number(m.to_id)]));
      const byId: Record<number, Member> = {};
      for (const row of rows) {
        const id = Number(row.user_id);
        const accountName = String(row.display_name || row.username);
        byId[id] = {
          id, username: row.bot === true ? cleanBotUsername(String(row.username)) : String(row.username), tag: row.bot === true ? String(row.bot_number ?? "1") : memberTag(id), displayName: String(row.nickname || accountName), accountName,
          nickname: String(row.nickname ?? ""), bio: String(row.bio ?? ""),
          color: String(row.color || ""), avatar: String(row.avatar || ""), bot: row.bot === true, botType: String(row.bot_type ?? ""),
        };
      }
      setMembers(workspaceId, reconcile({ me: user_id, byId, moved }));
    } catch (e) {
      console.warn(`Members of '${workspaceId}' not loaded:`, e);
    }
  };
  ext.onEvent(() => void load());
  await load();
}

// A member's user id is the first 6 bytes of the account id, so its first two bytes, the tag, are the top 16 bits.
function memberTag(userId: number): string {
  return Math.floor(userId / 2 ** 32).toString(16).padStart(4, "0");
}

// Members whose display name or username contains the query, the ones starting with it first, then by name. Used by
// every member picker (@mentions, ui/MemberSearch).
export function matchMembers<T extends { displayName: string; username: string }>(list: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  const starts = (m: T) => m.displayName.toLowerCase().startsWith(q) || m.username.toLowerCase().startsWith(q);
  return list
    .filter((m) => m.displayName.toLowerCase().includes(q) || m.username.toLowerCase().includes(q))
    .sort((a, b) => Number(starts(b)) - Number(starts(a)) || a.displayName.localeCompare(b.displayName));
}

// The member's id now: after a move to another account (several moves are followed), the new account's.
export function currentId(workspaceId: string, userId: number): number {
  const moved = members[workspaceId]?.moved ?? {};
  for (let i = 0; i < 16 && moved[userId] !== undefined; i++) userId = moved[userId];
  return userId;
}

export function member(workspaceId: string, userId: number): Member {
  userId = currentId(workspaceId, userId);
  return members[workspaceId]?.byId[userId] ?? {
    id: userId, username: `user${userId}`, tag: memberTag(userId), displayName: `User ${userId}`, accountName: `User ${userId}`, nickname: "", bio: "", color: "", avatar: "", bot: false, botType: "",
  };
}

// Whether the member's profile is here yet (member() makes one up until it is).
export function memberLoaded(workspaceId: string, userId: number): boolean {
  return !!members[workspaceId]?.byId[currentId(workspaceId, userId)];
}

export function botDisplayName(value: Pick<Member, "displayName" | "bot" | "botType">): string {
  return value.displayName;
}

export function myId(workspaceId: string): number | null {
  return members[workspaceId]?.me ?? null;
}

export function memberList(workspaceId: string): Member[] {
  return Object.values(members[workspaceId]?.byId ?? {});
}

export function memberListVisible(workspaceId: string): Member[] {
  return memberList(workspaceId).filter((m) => !isNode(workspaceId, m.id));
}

// Who tasks and issues can be given to: people, and the bots set to be assignable.
export function assignableMembers(workspaceId: string): Member[] {
  return memberListVisible(workspaceId).filter((m) => !m.bot || isAssignableBot(m.id));
}

type Profile = { username: string; displayName: string; color: string; avatar: string };

// Sends the signed-in user's profile to every workspace they are a member of whose copy differs. Others (still
// joining, kicked) get it with their join (p2p/workspaces.ts), never from here.
export async function publishProfile(profile: Profile): Promise<void> {
  const stale = untrack(() => [...apis].filter(([id]) => {
    const me = members[id]?.me;
    const mine = me === null || me === undefined ? undefined : members[id].byId[me];
    return mine && (mine.username !== profile.username || mine.accountName !== (profile.displayName || profile.username)
      || mine.color !== profile.color || mine.avatar !== profile.avatar);
  }));
  await Promise.all(stale.map(([, api]) =>
    api.plugin("members").call("set-profile", {
      username: profile.username, display_name: profile.displayName, color: profile.color, avatar: profile.avatar,
    })
      .catch((e) => console.warn("Profile not sent:", e))));
}

let watchingOwn = false;
// Sends the account's profile to the workspaces whenever it changes here: edited in Settings > Profile, or another
// device's newer one taken from the user server (core/account.ts syncAccount, pullProfile). Only the account is
// watched, never the workspace rows, so two devices with different copies can't keep overwriting each other.
export function watchOwnProfile(): void {
  if (watchingOwn) return;
  watchingOwn = true;
  createRoot(() => {
    const profile = createMemo(() => {
      const me = account();
      return me && { username: me.username, displayName: me.displayName, color: me.color, avatar: me.avatar };
    }, null, { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
    // Deferred: at start this device's copy may be older than the workspaces'; a connecting workspace sends the
    // newest itself (p2p/workspaces.ts, freshProfile).
    createEffect(on(profile, (value) => {
      if (value) void publishProfile(value);
    }, { defer: true }));
  });
}
