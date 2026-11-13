import { describe, expect, it } from "vitest";
import {
  inviteCode, inviteOpen, invitePeerProofText, inviteProof, inviteRoom, inviteTokenKey, inviteUses, newInviteToken, parseInvite,
  verifyInviteProof,
} from "../../src/p2p/invite";
import { nodeCode, parseNodeCode } from "../../src/p2p/pair";

const entry = { id: "a".repeat(22), secret: "b".repeat(22) };

describe("workspace invites", () => {
  it("recognizes legacy mw2 codes so they can be refused", () => {
    expect(parseInvite(`mw2.${entry.id}.${entry.secret}`)).toEqual({ ...entry, v: 2 });
  });

  it("makes codes without the room secret, so they don't go stale when it changes", () => {
    const token = newInviteToken();
    const code = inviteCode(entry.id, token);
    expect(code).toBe(`mw4.${entry.id}.${token}`);
    expect(parseInvite(code)).toEqual({ id: entry.id, secret: "", v: 4, token });
  });

  it("still reads mw3 codes, with the room secret they carry", () => {
    const token = newInviteToken();
    expect(parseInvite(`mw3.${entry.id}.${entry.secret}.${token}`)).toEqual({ ...entry, v: 3, token });
    expect(parseInvite(`mw3.${entry.id}.${entry.secret}`)).toBeNull();
    expect(parseInvite(`mw4.${entry.id}.${token}.extra`)).toBeNull();
  });

  it("proves invite-token possession without transmitting the private token", () => {
    const token = newInviteToken();
    const tokenKey = inviteTokenKey(token)!;
    const text = invitePeerProofText(entry.id, "nonce", "peer-a", "peer-b", "author");
    const proof = inviteProof(token, text)!;
    expect(tokenKey).not.toBe(token);
    expect(verifyInviteProof(tokenKey, text, proof)).toBe(true);
    expect(verifyInviteProof(tokenKey, `${text}!`, proof)).toBe(false);
  });

  it("counts uses from the old counter and the join rows, and closes an invite when expired, revoked or used up", () => {
    const now = Date.now();
    const invite = { uses: 1, max_uses: 3, revoked: false, expires_at: null };
    expect(inviteUses(invite, 1)).toBe(2);
    expect(inviteOpen(invite, 1, now)).toBe(true);
    expect(inviteOpen(invite, 2, now)).toBe(false);
    expect(inviteOpen({ ...invite, revoked: true }, 0, now)).toBe(false);
    expect(inviteOpen({ ...invite, expires_at: new Date(now - 1).toISOString() }, 0, now)).toBe(false);
    expect(inviteOpen({ ...invite, max_uses: null, expires_at: new Date(now + 60_000).toISOString() }, 50, now)).toBe(true);
  });

  it("gives each invite its own room, from the token's public key", () => {
    const one = inviteTokenKey(newInviteToken())!;
    const two = inviteTokenKey(newInviteToken())!;
    expect(inviteRoom(one)).toEqual(inviteRoom(one));
    expect(inviteRoom(one).key).not.toBe(inviteRoom(two).key);
    expect(inviteRoom(one).password).not.toBe(inviteRoom(one).key);
  });
});

describe("node codes", () => {
  it("round-trips a node's code and refuses anything else", () => {
    const code = { id: "n".repeat(22), secret: "s".repeat(22) };
    expect(parseNodeCode(nodeCode(code))).toEqual(code);
    expect(parseNodeCode(` ${nodeCode(code)} `)).toEqual(code);
    expect(parseNodeCode(inviteCode(entry.id, newInviteToken()))).toBeNull();
    expect(parseNodeCode(`mwn1.${code.id}`)).toBeNull();
  });
});
