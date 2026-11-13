// Friends, friend requests and blocked people, kept on the user server. They decide who may send private messages:
// friends only, unless the account allows strangers. The user server enforces it for messages left there; the app
// drops live messages that break it (dm/messages.ts).
import { userNumberOf } from "../p2p/log";
import { createSignal } from "solid-js";
import { account, accountKey } from "../core/account";
import { openFriends } from "../core/navigation";
import { notify } from "../core/notifier";
import {
  changeRelation, changeSettings, findPerson, reportAccount, type PublicAccount, type RelationChange, type Relations,
} from "../core/userServer";
import { playSound } from "../theme/sounds";

const [relations, setRelations] = createSignal<Relations | null>(null);
export { relations };

export const isFriend = (id: string) => !!relations()?.friends.some((p) => p.id === id);
export const isBlocked = (id: string) => !!relations()?.blocked.some((p) => p.id === id);
// A workspace member someone blocked (a member's user id is the start of their account id).
export const isBlockedMember = (userId: number) => !!relations()?.blocked.some((p) => userNumberOf(p.id) === userId);
export const askedBy = (id: string) => !!relations()?.incoming.some((p) => p.id === id);
export const askedThem = (id: string) => !!relations()?.outgoing.some((p) => p.id === id);
export const allowsStrangers = () => relations()?.allowStrangers ?? false;
export const requestCount = () => relations()?.incoming.length ?? 0;

// Whether a message from this person may come in; unknown until the relations first load.
export function mayMessage(id: string): boolean {
  const known = relations();
  return !known || (!isBlocked(id) && (known.allowStrangers || isFriend(id)));
}

// Takes the relations as the user server has them now, telling about new friend requests.
export function applyRelations(next: Relations): void {
  const before = relations();
  setRelations(next);
  if (!before) return;
  for (const person of next.incoming.filter((p) => !before.incoming.some((b) => b.id === p.id))) {
    playSound("notification");
    notify({ tag: `friend:${person.id}`, title: "Friend request", body: `${person.profile.displayName} (@${person.username}) wants to be friends.`, onClick: openFriends });
  }
}

export async function changeFriend(action: RelationChange, id: string): Promise<void> {
  applyRelations(await changeRelation(signer(), action, id));
}

// By email or name·tag.
export async function requestFriend(query: string): Promise<PublicAccount> {
  const found = await findPerson(query, signer());
  await changeFriend("request", found.id);
  return found;
}

export function reportPerson(id: string, reason: string): Promise<void> {
  return reportAccount(signer(), id, reason);
}

export async function setAllowStrangers(allow: boolean): Promise<void> {
  applyRelations(await changeSettings(signer(), { allowStrangers: allow }));
}

function signer() {
  const me = account();
  if (!me) throw new Error("Not signed in.");
  return { id: me.id, key: accountKey() };
}
