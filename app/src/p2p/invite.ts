import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64url, fromBase64url } from "../core/identity";

// `mw4.<workspace>.<token>`: the token alone opens the invite's own room (`inviteRoom`), where a member or node checks
// it and hands over the current room secret, so a code never goes stale when the secret changes (kick, ban, a deleted
// invite). `mw3` codes (`<workspace>.<room secret>.<token>`, before 2026-10-16) still admit: their room secret is tried
// too and may be out of date. `v: 2` codes (no token) come from before invites; they are recognized only to be refused
// with a clear message.
export interface ParsedInvite {
  id: string;
  // "" when the code doesn't carry one (mw4): the joiner learns it in the invite room.
  secret: string;
  v: 2 | 3 | 4;
  token?: string;
}

const part = /^[A-Za-z0-9_-]{16,}$/;

export function inviteCode(workspaceId: string, token: string): string {
  return `mw4.${workspaceId}.${token}`;
}

export function parseInvite(code: string): ParsedInvite | null {
  const [prefix, id, second, third, ...rest] = code.trim().split(".");
  if (!part.test(id ?? "") || !part.test(second ?? "") || rest.length > 0) return null;
  if (prefix === "mw4" && third === undefined) return { id, secret: "", v: 4, token: second };
  if (prefix === "mw2" && third === undefined) return { id, secret: second, v: 2 };
  if (prefix === "mw3" && part.test(third ?? "")) return { id, secret: second, v: 3, token: third };
  return null;
}

export function newInviteToken(): string {
  return base64url(p256.keygen().secretKey);
}

export function inviteTokenKey(token: string): string | null {
  try {
    const privateKey = fromBase64url(token);
    return privateKey.length === 32 ? base64url(p256.getPublicKey(privateKey)) : null;
  } catch {
    return null;
  }
}

export function validInviteTokenKey(tokenKey: string): boolean {
  try {
    p256.Point.fromHex(fromBase64url(tokenKey));
    return true;
  } catch {
    return false;
  }
}

export function inviteProof(token: string, text: string): string | null {
  try {
    const privateKey = fromBase64url(token);
    if (privateKey.length !== 32) return null;
    return base64url(p256.sign(sha256(new TextEncoder().encode(text)), privateKey).toBytes("compact"));
  } catch {
    return null;
  }
}

export function verifyInviteProof(tokenKey: string, text: string, proof: string): boolean {
  try {
    return p256.verify(fromBase64url(proof), sha256(new TextEncoder().encode(text)), fromBase64url(tokenKey));
  } catch {
    return false;
  }
}

export function invitePeerProofText(workspaceId: string, nonce: string, from: string, to: string, author: string): string {
  return `makework-invite-proof-v1|${workspaceId}|${nonce}|${from}|${to}|${author}`;
}

// v1 bound a use to the invite's use count, so two people joining with one invite at once signed the same count and
// every member refused the second. Kept for the commits that carry it.
export function inviteUseText(inviteId: number, userId: number, uses: number): string {
  return `makework-invite-use-v1|${inviteId}|${userId}|${uses}`;
}

// v2: the invite and the joiner only; joins are counted from `members_invite_joins` (system/members.ts).
export function inviteUseTextV2(inviteId: number, userId: number): string {
  return `makework-invite-use-v2|${inviteId}|${userId}`;
}

type InviteRow = Record<string, unknown>;

// Joins so far: the count kept on the row by v1 uses, plus one join row per v2 use.
export function inviteUses(invite: InviteRow, joins: number): number {
  return Number(invite.uses ?? 0) + joins;
}

// Whether an invite still admits someone: not revoked, not expired, not used up.
export function inviteOpen(invite: InviteRow, joins: number, now = Date.now()): boolean {
  if (invite.revoked === true) return false;
  if (inviteUses(invite, joins) >= Number(invite.max_uses ?? Infinity)) return false;
  if (invite.expires_at == null) return true;
  const expires = Date.parse(String(invite.expires_at));
  return Number.isFinite(expires) && expires > now;
}

// The room where an invite is checked: its id and password come from the token's public key, which every member has
// in the workspace's data and a joiner works out from the token. Nobody else can find it, and it doesn't change with
// the room secret.
export function inviteRoom(tokenKey: string): { key: string; password: string } {
  const hash = (text: string) => base64url(sha256(new TextEncoder().encode(text)));
  return { key: hash(`makework-invite-room|${tokenKey}`).slice(0, 22), password: hash(`makework-invite-password|${tokenKey}`) };
}
