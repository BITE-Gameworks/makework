import { describe, expect, it } from "vitest";
import { createIdentity, exportPkcs8, importAgreementKey } from "../../src/core/identity";
import { pairKeys, seal, unseal } from "../../src/dm/crypto";

async function person() {
  const identity = await createIdentity(true);
  const agreement = await importAgreementKey(await exportPkcs8(identity.privateKey));
  return { id: identity.id, publicKey: { x: identity.publicKey.x!, y: identity.publicKey.y! }, agreement };
}

describe("private message sealing", () => {
  it("gives both sides the same keys and only them", async () => {
    const [ada, bob, eve] = await Promise.all([person(), person(), person()]);
    const adaSide = await pairKeys(ada.agreement, ada.id, bob);
    const bobSide = await pairKeys(bob.agreement, bob.id, ada);
    const eveSide = await pairKeys(eve.agreement, eve.id, bob);
    expect(bobSide.roomId).toBe(adaSide.roomId);
    expect(bobSide.roomPassword).toBe(adaSide.roomPassword);
    expect(eveSide.roomId).not.toBe(adaSide.roomId);

    const sealed = await seal(adaSide, { id: "m1", from: ada.id, to: bob.id, at: 1 }, { text: "hi", attachments: [] });
    expect(await unseal(bobSide, sealed)).toEqual({ text: "hi", attachments: [] });
    expect(await unseal(eveSide, sealed)).toBeNull();
    // The header can't be changed on the way.
    expect(await unseal(bobSide, { ...sealed, at: 2 })).toBeNull();
    expect(await unseal(bobSide, { ...sealed, from: eve.id })).toBeNull();
  });
});
