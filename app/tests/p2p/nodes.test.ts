import { afterEach, describe, expect, it } from "vitest";
import type { Room } from "trystero";
import { ApiClient } from "../../src/api/client";
import { createIdentity, sign } from "../../src/core/identity";
import { MockTransport } from "../../src/mock/transport";
import { memoryCommits } from "../../src/p2p/commits";
import { Ledger, createLedgerBackend, type Signer } from "../../src/p2p/ledger";
import { NodeLink, helloText, nodeChannels, type NodeHello } from "../../src/p2p/nodes";
import { localPlugins, plugins } from "../../src/p2p/plugins";
import { workspacePolicy } from "../../src/p2p/policy";
import { WorkspaceSync } from "../../src/p2p/sync";
import { Network } from "./fakeNetwork";

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

async function signer(): Promise<Signer> {
  const identity = await createIdentity(false);
  return { author: identity.id, key: { x: identity.publicKey.x!, y: identity.publicKey.y! }, privateKey: identity.privateKey, replica: crypto.randomUUID() };
}

describe("NodeLink", () => {
  let closers: (() => void)[] = [];
  afterEach(() => {
    closers.forEach((close) => close());
    closers = [];
  });

  async function member(network: Network, id: string, workspaceId: string, who: Signer) {
    const ledger = new Ledger(workspaceId, who, workspacePolicy, memoryCommits());
    const backend = createLedgerBackend(ledger, localPlugins);
    for (const plugin of plugins) backend.load(plugin);
    await ledger.load();
    const sync = new WorkspaceSync(ledger, workspaceId, "secret", { room: network.room(id) as unknown as Room, self: id, tabs: false });
    closers.push(() => sync.close());
    return { ledger, sync, api: new ApiClient(new MockTransport(backend)) };
  }


  it("stops counting a node that doesn't answer pings, and counts it again when it does", async () => {
    const network = new Network();
    const owner = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(owner);
    const a = await member(network, "a", workspaceId, owner);
    await a.ledger.adopt(genesis);
    const nodeKey = await signer();
    const n = await member(network, "n", workspaceId, nodeKey);
    network.link("a", "n");
    await settle();
    await n.api.plugin("nodes").call("register", { key_x: nodeKey.key.x, key_y: nodeKey.key.y });
    await n.ledger.flush();
    await settle();
    await a.api.plugin("nodes").call("decide", { user_id: n.ledger.me, status: "authorized" });
    await a.ledger.flush();
    await settle();
    const nodeSide = new NodeLink(workspaceId, n.ledger, n.sync, { answerPings: true });
    const link = new NodeLink(workspaceId, a.ledger, a.sync, { pingEveryMs: 40, deadAfterMs: 150 });
    closers.push(() => nodeSide.close(), () => link.close());
    const time = Date.now();
    nodeSide.sendHello({ user: n.ledger.me, time, sig: await sign(nodeKey.privateKey, helloText(workspaceId, "n", time)) }, "a");
    await settle();
    expect(link.nodeUser("n")).toBe(n.ledger.me);

    // The node goes quiet (killed, or its connection dead without WebRTC noticing yet).
    const pings = network.rooms.get("n")!.actions.get(nodeChannels.ping)!;
    const send = pings.send;
    pings.send = async () => {};
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(link.nodeUser("n")).toBeNull();
    // It answers again: back without waiting for its next hello.
    pings.send = send;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(link.nodeUser("n")).toBe(n.ledger.me);

    // A busy node answering slower than the pings go out (each answer to an earlier ping) still counts.
    pings.send = (...args) => new Promise((resolve) => setTimeout(() => resolve(send(...args)), 100));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(link.nodeUser("n")).toBe(n.ledger.me);
  });
  it("knows a node whose hello came before its row (a member who just joined)", async () => {
    const network = new Network();
    const owner = await signer();
    const { workspaceId, genesis } = await Ledger.createGenesis(owner);
    const a = await member(network, "a", workspaceId, owner);
    await a.ledger.adopt(genesis);
    const nodeKey = await signer();
    const n = await member(network, "n", workspaceId, nodeKey);
    network.link("a", "n");
    await settle();
    await n.api.plugin("nodes").call("register", { key_x: nodeKey.key.x, key_y: nodeKey.key.y });
    await n.ledger.flush();
    await settle();
    await a.api.plugin("nodes").call("decide", { user_id: n.ledger.me, status: "authorized" });
    await a.ledger.flush();
    await settle();

    // B connects to the node only; the hello arrives at once, the data (with the node's row) after it.
    const b = await member(network, "b", workspaceId, await signer());
    const link = new NodeLink(workspaceId, b.ledger, b.sync);
    closers.push(() => link.close());
    const sendHello = n.sync.mesh!.channel<NodeHello>(nodeChannels.hello, () => {});
    network.link("b", "n");
    const time = Date.now();
    sendHello({ user: n.ledger.me, time, sig: await sign(nodeKey.privateKey, helloText(workspaceId, "n", time)) }, "b");
    expect(link.nodeUser("n")).toBeNull();
    await settle();
    expect(b.ledger.owner).not.toBeNull();
    expect(link.nodeUser("n")).toBe(n.ledger.me);
    expect(link.order(["a", "n"])[0]).toBe("n");
  });
});
