// A call split across nodes (ADR 0007). A node serves up to `sfu_capacity` members of a call; the next members join
// the next node in the call's order, and the nodes serving one call bridge to each other so it stays one call: each
// node pipes its own members' producers (never ones piped in, so nothing loops) into every other serving node's
// router over a mediasoup pipe transport, under the same id and with the same `SfuProducerInfo`. There they are
// listed, announced and consumed like that node's own members' producers; members see no difference.
//
// Nodes talk over the `sfu-bridge` request action of the server's room, which only authorized nodes may use. Of each
// pair, the node with the smaller user number links, so two nodes opening a call at once make one bridge.
import type { SfuNotify, SfuProducerInfo } from "../p2p/sfuProtocol";
import type { SfuCalls, SfuPipeConsumerLike, SfuPipeTransportLike } from "./sfu";

export const sfuBridgeChannel = "sfu-bridge";

// Where a node's pipe transport receives, and the keys it encrypts with. `lan`: the node's LAN address when it is behind
// a router (absent from nodes before 2026-10-17): a node behind the same router (the same public address) links there.
export type PipeTuple = { ip: string; port: number; srtp: unknown; lan?: string };

export type BridgeRequest =
  // `linked`: whether the asker has a bridge to this node for the call (a node holding one the asker doesn't drops it).
  | { serving: { call: number; linked?: boolean } }
  // `id` grows with every link a node makes (time based, so across restarts too): an older link arriving late never
  // replaces a newer one.
  | { link: { call: number; tuple: PipeTuple; id: number } }
  | { pipe: { call: number; info: SfuProducerInfo; kind: "audio" | "video"; rtpParameters: unknown; paused: boolean } }
  | { unpipe: { call: number; id: string } }
  | { unlink: { call: number } };

export type BridgeReply = { serves: boolean } | { ok: true; tuple?: PipeTuple } | { ok: false; error: string };

// What the bridges need from the node hosting them (node/host.ts); tests wire several nodes to each other.
export interface BridgeContext {
  calls(): SfuCalls | null;
  // This node's public address, the one its call transports announce; empty when it has none (no bridging then).
  address(): string;
  // Its LAN address when it is behind a router (main.ts `lanAddress`), else null.
  lanAddress?(): string | null;
  self(): number;
  // The user number of an authorized node of this server, by peer id; null for anyone else.
  nodeUser(peer: string): number | null;
  onlineNodes(): Map<number, string>;
  ask(peer: string, request: BridgeRequest): Promise<BridgeReply | null>;
  // Tells this node's members of the call (newProducer for a piped-in producer, producerClosed when it goes).
  notify(call: number, notice: SfuNotify): void;
  // How long before a link or a pipe that got no answer is tried again (tests make it short).
  retryMs?: number;
}

const defaultRetryMs = 10_000;

// One call's link to one other node: the pipe transport, this node's producers sent there (by producer id, their pipe
// consumers), and the producers that came in from there. Steps run one at a time, in order.
type Bridge = {
  id: number;
  transport: SfuPipeTransportLike | null;
  out: Map<string, SfuPipeConsumerLike>;
  in: Set<string>;
  // Pipes being made here, and those the other node took back meanwhile (its answer came too late there).
  making: Set<string>;
  cancelled: Set<string>;
  queue: Promise<void>;
  closed: boolean;
};

// One line per step of a bridge's life, `[bridge] call <id> <node>: ...`, in the node's log: a split call that didn't
// link (mesh-test s11) was otherwise invisible.
function log(call: number, who: string, what: string): void {
  console.info(`[bridge] call ${call} ${who}: ${what}`);
}

export class SfuBridges {
  private readonly bridges = new Map<number, Map<string, Bridge>>();
  private warned = false;
  private lastLinkId = 0;
  private readonly retries = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly ctx: BridgeContext) {}

  // A request from another node.
  async handle(peer: string, request: BridgeRequest): Promise<BridgeReply> {
    if (this.ctx.nodeUser(peer) === null) {
      console.info(`[bridge] refused ${Object.keys(request)[0]} from ${peer.slice(0, 6)}: not a node of this server`);
      return { ok: false, error: "not a node of this server" };
    }
    try {
      if ("serving" in request) {
        const call = request.serving.call;
        // The asker has no bridge here, this node still has one (an "unlink" lost on the way): it is stale. Kept, it
        // made `consider` skip the pair and the call stayed split.
        if (request.serving.linked === false && this.bridges.get(call)?.has(peer)) {
          log(call, this.who(peer), "asks unlinked while a bridge is here: stale, dropped");
          this.close(call, peer);
        }
        const serves = this.serves(call);
        log(call, this.who(peer), `asks whether this node serves the call: ${serves ? "yes" : "no"}`);
        // It serves the call too: the pair links (if this node is the one that links, it does so now).
        if (serves) queueMicrotask(() => void this.consider(request.serving.call, peer));
        return { serves };
      }
      if ("link" in request) {
        const reply = await this.accept(request.link.call, peer, request.link.tuple, Number(request.link.id) || 0);
        if (reply.ok) queueMicrotask(() => this.pipeAll(request.link.call, peer));
        return reply;
      }
      if ("pipe" in request) {
        await this.pipeIn(peer, request.pipe);
        return { ok: true };
      }
      if ("unpipe" in request) {
        this.unpipeIn(peer, request.unpipe.call, request.unpipe.id);
        return { ok: true };
      }
      if ("unlink" in request) {
        this.close(request.unlink.call, peer);
        return { ok: true };
      }
      return { ok: false, error: "unknown request" };
    } catch (e) {
      console.info(`[bridge] ${Object.keys(request)[0]} from ${this.who(peer)} failed: ${(e as Error).message}`);
      return { ok: false, error: (e as Error).message };
    }
  }

  // What the bridges of a call are now (status.json, for mesh-test): per other node, its link id, whether its pipe
  // transport is up, and the producers sent there and taken from there.
  describe(call: number): { node: string; id: number; transport: boolean; out: number; in: number }[] {
    return [...(this.bridges.get(call) ?? [])].map(([peer, bridge]) => ({
      node: this.who(peer), id: bridge.id, transport: bridge.transport !== null, out: bridge.out.size, in: bridge.in.size,
    }));
  }

  // A node as the log names it: its user number, or its peer id when it isn't a known node.
  private who(peer: string): string {
    const user = this.ctx.nodeUser(peer);
    return user === null ? `peer ${peer.slice(0, 6)}` : `node ${user}`;
  }

  // This node took the first member of a call: whoever else serves it gets linked.
  async opened(call: number): Promise<void> {
    const peers = [...this.ctx.onlineNodes().values()];
    log(call, `node ${this.ctx.self()}`, `opened here, asking ${peers.length} online node(s): ${peers.map((p) => this.who(p)).join(", ") || "none"}`);
    await Promise.all(peers.map((peer) => this.ask(call, peer)));
  }

  // A node came online: the calls both serve get linked.
  async nodeOnline(peer: string): Promise<void> {
    await Promise.all([...this.bridgeable()].map((call) => this.ask(call, peer)));
  }

  // Now and then (host.ts): every call served here is asked about again on each online node it has no bridge with, so
  // a lost "serving" (or "unlink") doesn't leave a call split for good.
  async recheck(): Promise<void> {
    const asks: Promise<void>[] = [];
    for (const call of this.bridgeable()) {
      for (const peer of this.ctx.onlineNodes().values()) {
        if (this.bridges.get(call)?.has(peer)) continue;
        log(call, this.who(peer), "recheck: no bridge, asking again");
        asks.push(this.ask(call, peer));
      }
    }
    await Promise.all(asks);
  }

  // A member of this node started sending: every node serving the call gets it.
  produced(call: number, info: SfuProducerInfo): void {
    for (const peer of this.bridges.get(call)?.keys() ?? []) this.pipeOut(call, peer, info);
  }

  // Producers of this node's members stopped: the other nodes drop them.
  ended(call: number, ids: string[]): void {
    for (const [peer, bridge] of this.bridges.get(call) ?? []) {
      for (const id of ids) {
        const consumer = bridge.out.get(id);
        if (!consumer) continue;
        bridge.out.delete(id);
        consumer.close();
        this.step(bridge, async () => {
          await this.ctx.ask(peer, { unpipe: { call, id } });
        });
      }
    }
  }

  // This node's last member of the call left: the other nodes drop the bridge (and what came from here).
  emptied(call: number): void {
    for (const peer of [...(this.bridges.get(call)?.keys() ?? [])]) {
      void this.ctx.ask(peer, { unlink: { call } });
      this.close(call, peer);
    }
  }

  // Another node went away: what came from it goes.
  nodeLeft(peer: string): void {
    for (const call of [...this.bridges.keys()]) this.close(call, peer);
  }

  // This node's worker died and took its calls (their routers, pipe transports and producers) with it. Every bridge
  // is forgotten and the other nodes drop theirs; the next member here links the call again. Kept, the old bridges
  // made `consider` skip those pairs, so a call stayed split.
  reset(): void {
    if (this.bridges.size) console.info(`[bridge] reset: ${this.bridges.size} call(s) forgotten, the other nodes told to unlink`);
    for (const timer of this.retries) clearTimeout(timer);
    this.retries.clear();
    for (const [call, forCall] of this.bridges) {
      for (const [peer, bridge] of forCall) {
        bridge.closed = true;
        void this.ctx.ask(peer, { unlink: { call } });
      }
    }
    this.bridges.clear();
  }

  private later(run: () => void): void {
    const timer = setTimeout(() => {
      this.retries.delete(timer);
      run();
    }, this.ctx.retryMs ?? defaultRetryMs);
    this.retries.add(timer);
  }

  private serves(call: number): boolean {
    if (!this.ctx.address()) {
      if (!this.warned) console.warn("Calls through this node: no public address, so a call split across nodes isn't bridged here.");
      this.warned = true;
      return false;
    }
    const sfuCall = this.ctx.calls()?.get(call);
    return !!sfuCall && !sfuCall.isEmpty;
  }

  private *bridgeable(): Iterable<number> {
    for (const call of this.ctx.calls()?.channels() ?? []) if (this.serves(call)) yield call;
  }

  private async ask(call: number, peer: string): Promise<void> {
    if (!this.serves(call)) return;
    const reply = await this.ctx.ask(peer, { serving: { call, linked: !!this.bridges.get(call)?.has(peer) } });
    log(call, this.who(peer), `serves the call: ${reply === null ? "no answer" : "serves" in reply ? (reply.serves ? "yes" : "no") : `error ${(reply as { error?: string }).error}`}`);
    if (reply && "serves" in reply && reply.serves) await this.consider(call, peer);
  }

  // Both serve the call: the node with the smaller user number links (the other waits for it).
  private async consider(call: number, peer: string): Promise<void> {
    const other = this.ctx.nodeUser(peer);
    if (other === null || this.bridges.get(call)?.has(peer) || !this.serves(call)) return;
    if (this.ctx.self() >= other) return log(call, this.who(peer), "both serve it: waiting for that node to link (smaller user number)");
    this.lastLinkId = Math.max(Date.now() * 1000, this.lastLinkId + 1);
    const bridge = this.add(call, peer, this.lastLinkId);
    log(call, this.who(peer), `linking (link ${bridge.id})`);
    this.step(bridge, async () => {
      const sfuCall = this.ctx.calls()?.get(call);
      if (!sfuCall) throw new Error("the call closed");
      const transport = await sfuCall.router.createPipeTransport(this.listen());
      // Closed while the transport was being made: it goes too, or its port stayed taken.
      if (bridge.closed) return transport.close();
      bridge.transport = transport;
      const reply = await this.ctx.ask(peer, { link: { call, tuple: this.tupleOf(transport), id: bridge.id } });
      if (bridge.closed) return;
      if (!reply || !("ok" in reply) || !reply.ok || !reply.tuple) throw new Error((reply as { error?: string } | null)?.error ?? "no answer");
      const ip = this.target(reply.tuple);
      await transport.connect({ ip, port: reply.tuple.port, srtpParameters: reply.tuple.srtp });
      log(call, this.who(peer), `linked (link ${bridge.id}, this end ${transport.tuple.localAddress}:${transport.tuple.localPort}, theirs ${ip}:${reply.tuple.port})`);
    }, () => {
      log(call, this.who(peer), `link ${bridge.id} failed: trying again later`);
      // No answer, or it failed on the way: linked again after a while, while both still serve the call (nothing
      // else would link them: the two halves of the call stayed apart).
      this.close(call, peer, bridge);
      this.later(() => void this.consider(call, peer));
    });
    this.pipeAll(call, peer);
  }

  // The other node links: a pipe transport here, connected to its own.
  private async accept(call: number, peer: string, tuple: PipeTuple, id: number): Promise<Exclude<BridgeReply, { serves: boolean }>> {
    const sfuCall = this.ctx.calls()?.get(call);
    if (!sfuCall || !this.serves(call)) return { ok: false, error: "not serving this call" };
    // A link again (the other node came back): the old one goes first. One that is older than the link already up
    // arrived late and is refused, or it replaced the working bridge with one to a transport long closed.
    const current = this.bridges.get(call)?.get(peer);
    if (current && current.id > id) {
      log(call, this.who(peer), `refused link ${id}: link ${current.id} is newer`);
      return { ok: false, error: "a newer link is up" };
    }
    this.close(call, peer);
    const bridge = this.add(call, peer, id);
    const transport = await sfuCall.router.createPipeTransport(this.listen());
    if (bridge.closed) {
      transport.close();
      return { ok: false, error: "the bridge closed" };
    }
    try {
      await transport.connect({ ip: this.target(tuple), port: tuple.port, srtpParameters: tuple.srtp });
    } catch (e) {
      transport.close();
      this.close(call, peer, bridge);
      throw e;
    }
    bridge.transport = transport;
    log(call, this.who(peer), `accepted link ${id} (this end ${transport.tuple.localAddress}:${transport.tuple.localPort}, theirs ${this.target(tuple)}:${tuple.port})`);
    return { ok: true, tuple: this.tupleOf(transport) };
  }

  private pipeAll(call: number, peer: string): void {
    for (const info of this.ctx.calls()?.get(call)?.local() ?? []) this.pipeOut(call, peer, info);
  }

  private pipeOut(call: number, peer: string, info: SfuProducerInfo): void {
    const bridge = this.bridges.get(call)?.get(peer);
    if (!bridge) return;
    this.step(bridge, async () => {
      if (!bridge.transport || bridge.out.has(info.id)) return;
      const consumer = await bridge.transport.consume({ producerId: info.id });
      // It ended while the consumer was being made (`ended` found nothing to take back yet): nothing is sent, or the
      // other node kept a producer nothing feeds.
      if (bridge.closed || !this.ctx.calls()?.get(call)?.local().some((p) => p.id === info.id)) return consumer.close();
      bridge.out.set(info.id, consumer);
      const reply = await this.ctx.ask(peer, { pipe: { call, info, kind: consumer.kind, rtpParameters: consumer.rtpParameters, paused: consumer.producerPaused } });
      if (reply && "ok" in reply && reply.ok) return log(call, this.who(peer), `sent ${info.kind} of user ${info.user} (${info.id.slice(0, 8)})`);
      bridge.out.delete(info.id);
      consumer.close();
      log(call, this.who(peer), `sending ${info.kind} of user ${info.user} (${info.id.slice(0, 8)}): ${reply ? `refused, ${(reply as { error?: string }).error}` : "no answer, taking it back"}`);
      if (reply) return;
      // No answer: the other node may have taken it anyway (a slow answer). It is told to drop it, or it kept offering
      // a producer nothing feeds, and it is sent again while the member still sends it.
      await this.ctx.ask(peer, { unpipe: { call, id: info.id } });
      this.later(() => {
        if (this.ctx.calls()?.get(call)?.local().some((p) => p.id === info.id)) this.pipeOut(call, peer, info);
      });
    });
  }

  private async pipeIn(peer: string, pipe: Extract<BridgeRequest, { pipe: unknown }>["pipe"]): Promise<void> {
    const bridge = this.bridges.get(pipe.call)?.get(peer);
    const sfuCall = this.ctx.calls()?.get(pipe.call);
    if (!bridge?.transport || !sfuCall) throw new Error("no bridge for this call");
    // The member's own description (user, call kind), checked for shape: it comes from another node.
    const info: SfuProducerInfo = { id: String(pipe.info.id), kind: pipe.info.kind, user: Number(pipe.info.user) };
    bridge.making.add(info.id);
    const producer = await bridge.transport.produce({ id: info.id, kind: pipe.kind, rtpParameters: pipe.rtpParameters, paused: pipe.paused, appData: { kind: info.kind } })
      .finally(() => bridge.making.delete(info.id));
    // Closed meanwhile, or taken back by the other node while this was being made.
    if (bridge.closed || bridge.cancelled.delete(info.id)) {
      producer.close();
      return;
    }
    sfuCall.addRemote(info, producer);
    bridge.in.add(info.id);
    log(pipe.call, this.who(peer), `took ${info.kind} of user ${info.user} (${info.id.slice(0, 8)})`);
    this.ctx.notify(pipe.call, { newProducer: info });
  }

  private unpipeIn(peer: string, call: number, id: string): void {
    const bridge = this.bridges.get(call)?.get(peer);
    if (!bridge) return;
    if (!bridge.in.delete(id)) {
      // Taken back while its pipe is being made here: that pipe drops it when it does. A pipe never seen here (lost on
      // the way) leaves no mark, or the one sent again would be dropped while answered ok.
      if (bridge.making.has(id)) bridge.cancelled.add(id);
      return;
    }
    if (this.ctx.calls()?.get(call)?.removeRemote(id)) this.ctx.notify(call, { producerClosed: { id } });
  }

  private add(call: number, peer: string, id: number): Bridge {
    const bridge: Bridge = { id, transport: null, out: new Map(), in: new Set(), making: new Set(), cancelled: new Set(), queue: Promise.resolve(), closed: false };
    const forCall = this.bridges.get(call) ?? new Map<string, Bridge>();
    forCall.set(peer, bridge);
    this.bridges.set(call, forCall);
    return bridge;
  }

  // Drops the bridge: what came from the other node leaves this node's members, the pipe transport closes. `only`: drop
  // that bridge alone (a failure of an older link must not close a newer one to the same node).
  private close(call: number, peer: string, only?: Bridge): void {
    const forCall = this.bridges.get(call);
    const bridge = forCall?.get(peer);
    if (bridge || only) log(call, this.who(peer), `bridge ${(only ?? bridge)!.id} closed${only && only !== bridge ? " (an older one)" : ""}`);
    if (only && only !== bridge) {
      only.closed = true;
      for (const consumer of only.out.values()) consumer.close();
      only.transport?.close();
      return;
    }
    if (!forCall || !bridge) return;
    bridge.closed = true;
    forCall.delete(peer);
    if (forCall.size === 0) this.bridges.delete(call);
    const sfuCall = this.ctx.calls()?.get(call);
    for (const id of bridge.in) if (sfuCall?.removeRemote(id)) this.ctx.notify(call, { producerClosed: { id } });
    for (const consumer of bridge.out.values()) consumer.close();
    bridge.transport?.close();
  }

  // One step on a bridge after the ones before it; a failure is logged (and `failed` runs), the next step still runs.
  private step(bridge: Bridge, run: () => Promise<void>, failed?: () => void): void {
    bridge.queue = bridge.queue.then(async () => {
      if (bridge.closed) return;
      await run();
    }).catch((e) => {
      console.warn(`Calls across nodes: ${(e as Error).message}`);
      failed?.();
    });
  }

  private listen() {
    return { listenInfo: { protocol: "udp" as const, ip: "0.0.0.0", announcedAddress: this.ctx.address() }, enableRtx: true, enableSrtp: true };
  }

  private tupleOf(transport: SfuPipeTransportLike): PipeTuple {
    const lan = this.ctx.lanAddress?.();
    return { ip: transport.tuple.localAddress, port: transport.tuple.localPort, srtp: transport.srtpParameters, ...(lan ? { lan } : {}) };
  }

  // Where to send to the other node: its LAN address when it is behind the same router (the same public address),
  // else the address it announces. Through the shared public address, the packets had to come back in through the
  // router to the right machine, with both nodes' ports forwarded on one address: the links of two home nodes closed
  // soon after (node test).
  private target(tuple: PipeTuple): string {
    return tuple.lan && tuple.ip === this.ctx.address() ? tuple.lan : tuple.ip;
  }
}
