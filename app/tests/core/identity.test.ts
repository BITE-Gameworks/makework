import { describe, expect, it } from "vitest";
import {
  accountId, base64url, createIdentity, exportPkcs8, importPrivateKey, isKeyPair, jwtClaims, lockKey, sign, unlockKey, unlockPkcs8, verify,
} from "../../src/core/identity";

describe("identity", () => {
  it("locks the private key with a password and unlocks it only with that password", async () => {
    const identity = await createIdentity(true);
    const locked = await lockKey(identity.privateKey, "correct horse", 1000);
    expect(await unlockKey(locked, "wrong horse")).toBeNull();
    const key = await unlockKey(locked, "correct horse");
    expect(key?.extractable).toBe(false);
    const signature = await sign(key!, "hello");
    expect(await verify(identity.publicKey, "hello", signature)).toBe(true);
    expect(await verify(identity.publicKey, "hellO", signature)).toBe(false);
  });

  it("moves a key as PKCS#8 and tells whether a key pair and id belong together", async () => {
    const identity = await createIdentity(true);
    const other = await createIdentity(false);
    const locked = await lockKey(identity.privateKey, "pw", 1000);
    expect(await unlockPkcs8(locked, "nope")).toBeNull();
    expect(await unlockPkcs8(locked, "pw")).toEqual(await exportPkcs8(identity.privateKey));
    const key = await importPrivateKey((await unlockPkcs8(locked, "pw"))!, false);
    expect(await isKeyPair(identity.id, key, identity.publicKey)).toBe(true);
    expect(await isKeyPair(identity.id, other.privateKey, identity.publicKey)).toBe(false);
    expect(await isKeyPair(other.id, key, identity.publicKey)).toBe(false);
  });

  it("derives a stable id from the public key", async () => {
    const identity = await createIdentity(false);
    expect(await accountId(identity.publicKey)).toBe(identity.id);
    expect(identity.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("reads JWT claims", () => {
    const json = new TextEncoder().encode(JSON.stringify({ sub: "42", name: "Ünïcode" }));
    const claims = jwtClaims(`x.${base64url(json)}.y`);
    expect(claims).toEqual({ sub: "42", name: "Ünïcode" });
  });
});
