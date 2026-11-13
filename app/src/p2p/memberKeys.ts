// Members' public account keys, by user number: from the commits they signed, and for those whose commits this device
// doesn't have (a snapshot) or nodes that haven't signed anything yet, from their row (checked against its user id by
// the policy). What sealing to a member needs.
// Kept per ledger until a commit comes in: the scan decodes every commit's author (~60 ms for 17k commits), and the
// bot runner and encrypted chat ask often.
import { accountIdOf } from "../core/identity";
import type { Ledger } from "./ledger";
import { userNumberOf } from "./log";

export type PublicKeyOf = { id: string; publicKey: { x: string; y: string } };

const known = new WeakMap<Ledger, { count: number; keys: ReadonlyMap<number, PublicKeyOf> }>();

export function publicKeysOf(ledger: Ledger): ReadonlyMap<number, PublicKeyOf> {
  const cached = known.get(ledger);
  if (cached?.count === ledger.commitCount) return cached.keys;
  const keys = new Map<number, PublicKeyOf>();
  for (const { commit } of ledger.log()) {
    if (commit.key?.x && commit.key?.y) keys.set(userNumberOf(commit.author), { id: commit.author, publicKey: commit.key });
  }
  for (const row of [...ledger.select("nodes", "nodes_nodes", {}), ...ledger.select("members", "members_profiles", {})]) {
    const userId = Number(row.user_id);
    if (keys.has(userId) || typeof row.key_x !== "string" || typeof row.key_y !== "string") continue;
    const key = { x: row.key_x, y: row.key_y };
    const id = accountIdOf(key);
    if (userNumberOf(id) === userId) keys.set(userId, { id, publicKey: key });
  }
  known.set(ledger, { count: ledger.commitCount, keys });
  return keys;
}

// Who gets a new room secret: current members and authorized nodes, not bots or the banned. `unknown` are those with no
// signed key on this device (their commits came before a snapshot, or they never made one): they can't be sealed to.
export function secretRecipients(ledger: Ledger, self: PublicKeyOf): { recipients: Map<number, PublicKeyOf>; unknown: number[] } {
  const keys = publicKeysOf(ledger);
  const banned = new Set(ledger.select("roles", "roles_bans", {}).map((row) => Number(row.user_id)));
  const wanted = new Set<number>([
    ...ledger.select("members", "members_profiles", {}).filter((row) => row.bot !== true).map((row) => Number(row.user_id)),
    ...ledger.select("nodes", "nodes_nodes", {}).filter((row) => row.status === "authorized").map((row) => Number(row.user_id)),
  ]);
  if (ledger.owner !== null) wanted.add(ledger.owner);
  const recipients = new Map<number, PublicKeyOf>();
  const unknown: number[] = [];
  for (const userId of wanted) {
    if (banned.has(userId)) continue;
    const recipient = userId === userNumberOf(self.id) ? self : keys.get(userId);
    if (recipient) recipients.set(userId, recipient);
    else unknown.push(userId);
  }
  return { recipients, unknown };
}
