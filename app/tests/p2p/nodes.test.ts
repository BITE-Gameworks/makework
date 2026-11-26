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
  // Owner "a" and node "n", authorized and linked; `hello` has the node say which peer it is, to "a".
  async function nodeAndMember(network: Network) {
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
    const hello = async () => {
      const time = Date.now();
      nodeSide.sendHello({ user: n.ledger.me, time, sig: await sign(nodeKey.privateKey, helloText(workspaceId, "n", time)) }, "a");
      await settle();
    };
    return { workspaceId, a, n, link, hello };
  }

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("keeps a node that relays a burst over a congested link: its answers go ahead of the burst", async () => {
    const network = new Network();
    const { n, link, hello } = await nodeAndMember(network);
    await hello();
    expect(link.nodeUser("n")).toBe(n.ledger.me);
    // Presence, call presence and mesh news for this member, over a link that takes one message every 3 ms: the burst
    // needs over a second, much longer than the member waits for an answer.
    const relay = n.sync.mesh!.channel<number>("burst", () => {});
    network.throttle("n", "a", 3);
    for (let i = 0; i < 400; i++) relay(i, "a");
    let lost = false;
    for (const end = Date.now() + 900; Date.now() < end;) {
      if (link.nodeUser("n") === null) lost = true;
      await wait(10);
    }
    expect(lost).toBe(false);
  });

  it("counts content moving to or from a node as an answer, and stops counting it when that stops too", async () => {
    const network = new Network();
    const { n, link, hello } = await nodeAndMember(network);
    await hello();
    // Its answers don't come (a slow uplink taken by an upload), but the upload's frames keep moving.
    network.rooms.get("n")!.actions.get(nodeChannels.ping)!.send = async () => {};
    const moving = setInterval(() => link.noteActive("n"), 30);
    await wait(400);
    expect(link.nodeUser("n")).toBe(n.ledger.me);
    clearInterval(moving);
    await wait(400);
    expect(link.nodeUser("n")).toBeNull();
    expect(link.isNode("n")).toBe(true);
    // Content moving again brings it back at once.
    link.noteActive("n");
    expect(link.nodeUser("n")).toBe(n.ledger.me);
  });

  it("tells its listeners when a node leaves, not when it only answers late", async () => {
    const network = new Network();
    const { n, link, hello } = await nodeAndMember(network);
    const told: (number | null)[] = [];
    link.onNodes((_peer, user) => told.push(user));
    await hello();
    expect(told).toEqual([n.ledger.me]);
    const pings = network.rooms.get("n")!.actions.get(nodeChannels.ping)!;
    const send = pings.send;
    pings.send = async () => {};
    await wait(400);
    expect(link.nodeUser("n")).toBeNull();
    pings.send = send;
    await wait(200);
    expect(link.nodeUser("n")).toBe(n.ledger.me);
    expect(told).toEqual([n.ledger.me]);
    // Late again, then gone: told once.
    pings.send = async () => {};
    await wait(400);
    network.unlink("a", "n");
    expect(told).toEqual([n.ledger.me, null]);
    expect(link.isNode("n")).toBe(false);
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
