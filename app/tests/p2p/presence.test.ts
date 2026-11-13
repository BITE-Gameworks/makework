import { afterEach, describe, expect, it } from "vitest";
import type { Room } from "trystero";
import { createIdentity } from "../../src/core/identity";
import { memoryCommits } from "../../src/p2p/commits";
import { peerStatusOf, peerVersionOf } from "../../src/core/presence";
import { appVersion } from "../../src/core/version";
import { Ledger, type Signer } from "../../src/p2p/ledger";
import { workspacePolicy } from "../../src/p2p/policy";
import { PresenceChannel } from "../../src/p2p/presence";
import { WorkspaceSync } from "../../src/p2p/sync";
import { Network } from "./fakeNetwork";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function signer(): Promise<Signer> {
  const identity = await createIdentity(false);
  return { author: identity.id, key: { x: identity.publicKey.x!, y: identity.publicKey.y! }, privateKey: identity.privateKey, replica: crypto.randomUUID() };
}

describe("channel presence", () => {
  let closers: (() => void)[] = [];
  afterEach(() => {
    closers.forEach((close) => close());
    closers = [];
  });

  async function members(ids: string[]) {
    const network = new Network();
    const workspaceId = `presence-${crypto.randomUUID()}`;
    const out: Record<string, PresenceChannel> = {};
    const syncs: Record<string, WorkspaceSync> = {};
    for (const [i, id] of ids.entries()) {
      const ledger = new Ledger(workspaceId, await signer(), workspacePolicy, memoryCommits());
      const sync = new WorkspaceSync(ledger, workspaceId, "secret", { room: network.room(id) as unknown as Room, self: id, tabs: false });
      const presence = new PresenceChannel(workspaceId, sync, i + 1);
      closers.push(() => presence.close(), () => sync.close());
      out[id] = presence;
      syncs[id] = sync;
    }
    for (const [i, x] of ids.entries()) for (const y of ids.slice(i + 1)) network.link(x, y);
    return { network, workspaceId, syncs, ...out } as
      { network: Network; workspaceId: string; syncs: Record<string, WorkspaceSync> } & Record<string, PresenceChannel>;
  }

  // Its app closed or reloaded (mesh.ts `bye`): its online dot goes at once, not when its connection times out.
  it("drops a member's status at once when its app says bye", async () => {
    const { workspaceId, syncs, a } = await members(["a", "b"]);
    a.setStatus("online");
    await wait(100);
    expect(peerStatusOf(workspaceId, 1)).toBe("online");
    void syncs.a.mesh!.bye();
    await wait(10);
    expect(peerStatusOf(workspaceId, 1)).toBeNull();
  });

  it("shares status separately from cursor updates and clears it when hidden", async () => {
    const { network, workspaceId, a, b } = await members(["a", "b"]);
    a.set(1, { x: 0 });
    b.set(1, { x: 0 });
    await wait(120);

    a.setStatus("dnd");
    await wait(100);
    expect(peerStatusOf(workspaceId, 1)).toBe("dnd");
    const beforeCursor = network.count("a", "b", "presence");
    a.set(1, { x: 1 });
    await wait(100);
    expect(network.count("a", "b", "presence") - beforeCursor).toBe(1);
    expect(peerStatusOf(workspaceId, 1)).toBe("dnd");

    a.setStatus(null);
    await wait(100);
    expect(peerStatusOf(workspaceId, 1)).toBeNull();
  });

  it("shares the app version with a status, and not while hidden", async () => {
    const { workspaceId, a } = await members(["a", "b"]);
    await wait(100);
    expect(peerVersionOf(workspaceId, 1)).toBeNull();

    a.setStatus("online");
    await wait(100);
    expect(peerVersionOf(workspaceId, 1)).toBe(appVersion);

    a.setStatus(null);
    await wait(100);
    expect(peerVersionOf(workspaceId, 1)).toBeNull();
  });

  it("shows a hosted bot in the channels it is in, to the members viewing them", async () => {
    const { a, b, c } = await members(["a", "b", "c"]);
    a.set(2, { x: 0 });
    b.set(1, { x: 0 });
    c.set(2, { x: 0 });
    await wait(150);
    const sees = (p: PresenceChannel) => [...(p as unknown as { peers: Map<string, { userId: number; channelId: number; bot?: true }> }).peers.values()]
      .filter((entry) => entry.bot && entry.userId === 99).map((entry) => entry.channelId);
    a.setAs(99, 1, { typing: 0, cursor: { x: 5, y: 6 } });
    await wait(150);
    expect(sees(b)).toEqual([1]);
    expect(sees(c)).toEqual([]);
    a.setAs(99, 1, null);
    await wait(100);
    expect(sees(b)).toEqual([]);
  });

  it("sends cursor moves only to the members viewing the same channel", async () => {
    const { network, a, b, c } = await members(["a", "b", "c"]);
    a.set(1, { x: 0 });
    b.set(1, { x: 0 });
    c.set(2, { x: 0 });
    await wait(150);
    const before = { b: network.count("a", "b", "presence"), c: network.count("a", "c", "presence") };
    for (let i = 1; i <= 5; i++) {
      a.set(1, { x: i });
      await wait(70);
    }
    expect(network.count("a", "b", "presence") - before.b).toBe(5);
    expect(network.count("a", "c", "presence") - before.c).toBe(0);

    // C comes into channel 1: everyone hears it, and A sends C its state at once.
    const intoC = network.count("a", "c", "presence");
    c.set(1, { x: 9 });
    await wait(100);
    expect(network.count("a", "c", "presence") - intoC).toBe(1);
    a.set(1, { x: 6 });
    await wait(100);
    expect(network.count("a", "c", "presence") - intoC).toBe(2);
  });

  it("sends channel events only to the members viewing that channel", async () => {
    const { network, a, b, c } = await members(["a", "b", "c"]);
    b.set(1, { x: 0 });
    c.set(2, { x: 0 });
    await wait(150);
    a.send(1, { ping: true });
    expect(network.count("a", "b", "chan-event")).toBe(1);
    expect(network.count("a", "c", "chan-event")).toBe(0);
  });
});
