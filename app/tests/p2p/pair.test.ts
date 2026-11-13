import { describe, expect, it } from "vitest";
import type { Room } from "trystero";
import { createIdentity, exportPkcs8, importAgreementKey } from "../../src/core/identity";
import { listenForPairing, pairWithNode, type HostOffer } from "../../src/p2p/pair";
import { Network } from "./fakeNetwork";

// An account with both of its keys: signing (ECDSA) and sealing (ECDH, from the same private key).
async function keys() {
  const identity = await createIdentity(true);
  const agreementKey = await importAgreementKey(await exportPkcs8(identity.privateKey));
  return { id: identity.id, key: { x: identity.publicKey.x!, y: identity.publicKey.y! }, privateKey: identity.privateKey, agreementKey };
}

describe("pairing a node", () => {
  const workspace = { workspace: "w".repeat(22), name: "Bite", secret: "s".repeat(22), generation: 3, recoverySecrets: ["o".repeat(22)] };

  async function setup() {
    const network = new Network();
    const node = await keys();
    const admin = await keys();
    const offers: HostOffer[] = [];
    listenForPairing(network.room("node", "pair") as unknown as Room, node, async (offer) => {
      if (offer.workspace === "x".repeat(22)) throw new Error("This node can't host that.");
      offers.push(offer);
    });
    const adminRoom = network.room("admin", "pair") as unknown as Room;
    network.link("admin", "node", "pair");
    return { network, node, admin, offers, adminRoom };
  }

  it("checks the node's key, authorizes it, then hands it the workspace sealed to that key", async () => {
    const { node, admin, offers, adminRoom } = await setup();
    const steps: string[] = [];
    const key = await pairWithNode(adminRoom, { id: node.id, secret: "p".repeat(22) }, { ...admin, publicKey: admin.key }, {
      authorize: async (k) => void steps.push(`authorize ${k.x === node.key.x}`),
      workspace: () => {
        steps.push("workspace");
        return workspace;
      },
    });
    expect(key).toEqual(node.key);
    expect(steps).toEqual(["authorize true", "workspace"]);
    expect(offers).toEqual([{ ...workspace, addedBy: admin.id }]);
  });

  it("refuses a node that isn't the code's, before anything is authorized", async () => {
    const { admin, adminRoom } = await setup();
    const other = await keys();
    let authorized = false;
    await expect(pairWithNode(adminRoom, { id: other.id, secret: "p".repeat(22) }, { ...admin, publicKey: admin.key }, {
      authorize: async () => void (authorized = true),
      workspace: () => workspace,
    })).rejects.toThrow(/isn't the one this code is for/);
    expect(authorized).toBe(false);
  });

  it("passes on why the node couldn't host it", async () => {
    const { node, admin, adminRoom } = await setup();
    await expect(pairWithNode(adminRoom, { id: node.id, secret: "p".repeat(22) }, { ...admin, publicKey: admin.key }, {
      authorize: async () => {},
      workspace: () => ({ ...workspace, workspace: "x".repeat(22) }),
    })).rejects.toThrow(/can't host that/);
  });

  it("says when no node answers in its room", async () => {
    const network = new Network();
    const admin = await keys();
    await expect(pairWithNode(network.room("admin", "pair") as unknown as Room, { id: admin.id, secret: "p".repeat(22) },
      { ...admin, publicKey: admin.key }, { authorize: async () => {}, workspace: () => workspace }, 100)).rejects.toThrow(/No node answered/);
  });
});
