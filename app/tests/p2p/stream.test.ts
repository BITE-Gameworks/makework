import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Room } from "trystero";
import { describe, expect, it } from "vitest";
import type { ContentWriter } from "../../src/core/stream";
import { ContentStreams, type StreamStore } from "../../src/p2p/stream";

type Handler = (data: unknown, context: { peerId: string; metadata?: unknown }) => unknown;

type Progress = (progress: number, context: { peerId: string; metadata?: unknown }) => void;

// Peers in one room; every message is delivered on a later tick, like over the network. `delays`: how long messages
// of an action take to cross (a slow link: a whole chunk arrives only once all of it has crossed). Meanwhile both ends
// hear its progress every `frameMs`, as Trystero reports each 16 KB frame of a big message (`onProgress` to the sender,
// `onReceiveProgress` to the receiver). `stallAfterMs`: the link stops there; no more frames, and the message never
// arrives. A send aborted through its `signal` stops its frames and never arrives either, as in Trystero.
class Hub {
  readonly log: string[] = [];
  readonly delays: Record<string, number> = {};
  frameMs = 100;
  stallAfterMs: number | null = null;
  private readonly handlers = new Map<string, Handler>();
  private readonly progress = new Map<string, Progress>();

  room(self: string): Pick<Room, "makeAction"> {
    const makeAction = (namespace: string, config: { kind?: string; onRequest?: Handler; onMessage?: Handler; onReceiveProgress?: Progress } = {}) => {
      const handler = config.onRequest ?? config.onMessage;
      if (handler) this.handlers.set(`${self}/${namespace}`, handler);
      if (config.onReceiveProgress) this.progress.set(`${self}/${namespace}`, config.onReceiveProgress);
      const deliver = (data: unknown, target: string, metadata?: unknown, onProgress?: Progress, signal?: AbortSignal) => new Promise<unknown>((resolve, reject) => {
        const delay = this.delays[namespace] ?? 0;
        const stall = this.stallAfterMs;
        const started = Date.now();
        const frames = delay > 0 ? setInterval(() => {
          const elapsed = Date.now() - started;
          if ((stall !== null && elapsed >= stall) || signal?.aborted) return clearInterval(frames);
          const done = Math.min(1, elapsed / delay);
          onProgress?.(done, { peerId: target, metadata });
          this.progress.get(`${target}/${namespace}`)?.(done, { peerId: self, metadata });
        }, this.frameMs) : undefined;
        if (stall !== null && delay > stall) return;
        setTimeout(() => {
          clearInterval(frames);
          if (signal?.aborted) return;
          const to = this.handlers.get(`${target}/${namespace}`);
          if (!to) return reject(new Error("no handler"));
          this.log.push(`${namespace.replace("content-", "")} ${self}>${target} ${JSON.stringify(namespace === "content-part" ? metadata : data)}`);
          Promise.resolve(to(data, { peerId: self, metadata })).then(resolve, reject);
        }, delay);
      });
      return {
        request: (data: unknown, { target }: { target: string }) => deliver(data, target),
        send: async (data: unknown, { target, metadata, onProgress, signal }: { target: string; metadata?: unknown; onProgress?: Progress; signal?: AbortSignal }) => {
          void deliver(data, target, metadata, onProgress, signal).catch(() => {});
        },
      };
    };
    return { makeAction } as unknown as Pick<Room, "makeAction">;
  }
}

// Stored content and partial downloads in memory.
class MemoryStore implements StreamStore {
  readonly content = new Map<string, Uint8Array<ArrayBuffer>>();
  readonly partial = new Map<string, Uint8Array<ArrayBuffer>>();
  onAppend?: () => void;

  async readRange(hash: string, start: number, end: number) {
    return this.content.get(hash)?.slice(start, end) ?? null;
  }

  async size(hash: string) {
    return this.content.get(hash)?.byteLength ?? null;
  }

  async openWriter(hash: string): Promise<ContentWriter> {
    let bytes = this.partial.get(hash) ?? new Uint8Array(0);
    return {
      get size() {
        return bytes.byteLength;
      },
      append: async (chunk) => {
        const next = new Uint8Array(bytes.byteLength + chunk.byteLength);
        next.set(bytes);
        next.set(chunk, bytes.byteLength);
        bytes = next;
        this.partial.set(hash, bytes);
        this.onAppend?.();
      },
      finish: async (expected) => {
        this.partial.delete(hash);
        const actual = bytesToHex(sha256(bytes));
        if (expected && actual !== expected) throw new Error("Content does not match its hash.");
        const existed = this.content.has(actual);
        this.content.set(actual, bytes);
        return { hash: actual, existed };
      },
      close: async (discard) => {
        if (discard) this.partial.delete(hash);
      },
    };
  }
}

function setup(peers: string[], options: { sliceMs?: number; refuse?: (hash: string, peer: string) => boolean } = {}) {
  const hub = new Hub();
  const sent: string[] = [];
  // Every value a send's bar took (`onSending`), as "holder>receiver" and how far.
  const moved: { to: string; value: number }[] = [];
  const nodes = Object.fromEntries(peers.map((id) => {
    const store = new MemoryStore();
    const onSent = (hash: string, peer: string) => sent.push(`${id}>${peer}:${hash}`);
    const onSending = (_hash: string, peer: string, value: number) => moved.push({ to: `${id}>${peer}`, value });
    return [id, { store, streams: new ContentStreams(hub.room(id), store, { chunkSize: 10, idleMs: 500, onSent, onSending, ...options }) }];
  }));
  return { hub, nodes, sent, moved };
}

const file = (length: number) => {
  const bytes = Uint8Array.from({ length }, (_, i) => i % 251);
  return { bytes, hash: bytesToHex(sha256(bytes)) };
};

describe("content streams", () => {
  it("streams content in chunks, each one only after the last was acked", async () => {
    const { hub, nodes } = setup(["a", "b"]);
    const { bytes, hash } = file(35);
    nodes.a.store.content.set(hash, bytes);

    expect(await nodes.b.streams.download(hash, "a")).toBe("done");
    expect(nodes.b.store.content.get(hash)).toEqual(bytes);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const transfer = hub.log.filter((line) => line.startsWith("part") || line.startsWith("ack"));
    expect(transfer).toEqual([
      `part a>b {"hash":"${hash}","offset":0}`, `ack b>a {"hash":"${hash}","offset":10}`,
      `part a>b {"hash":"${hash}","offset":10}`, `ack b>a {"hash":"${hash}","offset":20}`,
      `part a>b {"hash":"${hash}","offset":20}`, `ack b>a {"hash":"${hash}","offset":30}`,
      `part a>b {"hash":"${hash}","offset":30}`, `ack b>a {"hash":"${hash}","offset":35}`,
    ]);
  });

  // With who received it: an upload counts as delivered once a node has all of it (p2p/deliveries.ts).
  it("reports a send as done once the last chunk is acked, and to whom", async () => {
    const { nodes, sent } = setup(["a", "b"]);
    const { bytes, hash } = file(25);
    nodes.a.store.content.set(hash, bytes);
    nodes.b.store.onAppend = () => expect(sent).toEqual([]);

    expect(await nodes.b.streams.download(hash, "a")).toBe("done");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toEqual([`a>b:${hash}`]);
  });

  it("fetches a byte range into memory: one piece of a big file for a node", async () => {
    const { hub, nodes, sent } = setup(["a", "b"]);
    const { bytes, hash } = file(35);
    nodes.a.store.content.set(hash, bytes);

    expect(await nodes.b.streams.fetchRange(hash, 10, 20, "a")).toEqual(bytes.slice(10, 20));
    expect(await nodes.b.streams.fetchRange(hash, 30, 35, "a")).toEqual(bytes.slice(30, 35));
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Stored nowhere, not counted as a whole send, and the holder stopped at the end by itself.
    expect(nodes.b.store.content.size + nodes.b.store.partial.size).toBe(0);
    expect(sent).toEqual([]);
    expect(hub.log.filter((line) => line.startsWith("part") || line.startsWith("stop"))).toEqual([
      `part a>b {"hash":"${hash}","offset":10}`, `part a>b {"hash":"${hash}","offset":30}`,
    ]);
    expect(await nodes.b.streams.fetchRange(hash, 30, 40, "a")).toBe("missing");
  });

  it("stops a holder from before ranges, which sends on past the end", async () => {
    const { hub, nodes } = setup(["a", "b"]);
    const { bytes, hash } = file(35);
    nodes.a.store.content.set(hash, bytes);
    // An older app: takes the want without its end.
    const handlers = (hub as unknown as { handlers: Map<string, Handler> }).handlers;
    const want = handlers.get("a/content-want")!;
    handlers.set("a/content-want", (data, context) => want({ ...(data as object), end: undefined }, context));

    expect(await nodes.b.streams.fetchRange(hash, 0, 10, "a")).toEqual(bytes.slice(0, 10));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hub.log).toContain(`stop b>a {"hash":"${hash}"}`);
    expect(hub.log.filter((line) => line.startsWith("part")).length).toBeLessThanOrEqual(2);
  });

  it("resumes from what arrived before", async () => {
    const { hub, nodes } = setup(["a", "b"]);
    const { bytes, hash } = file(35);
    nodes.a.store.content.set(hash, bytes);
    nodes.b.store.partial.set(hash, bytes.slice(0, 20));

    expect(await nodes.b.streams.download(hash, "a")).toBe("done");
    expect(nodes.b.store.content.get(hash)).toEqual(bytes);
    expect(hub.log.filter((line) => line.startsWith("part"))).toHaveLength(2);
  });

  it("sends to one member at a time", async () => {
    const { nodes } = setup(["a", "b", "c"]);
    const { bytes, hash } = file(50);
    nodes.a.store.content.set(hash, bytes);

    const results = await Promise.all([nodes.b.streams.download(hash, "a"), nodes.c.streams.download(hash, "a")]);
    expect(results).toEqual(["done", "busy"]);
    expect(await nodes.c.streams.download(hash, "a")).toBe("done");
  });

  // A node fetches a member's new images while members ask it for them (its keep pass and its on-demand fetches): asked
  // for two at once, the member's answer to the second ended the first transfer, and that download stalled until idleMs.
  it("fetches from one holder one file at a time, the next once the last is whole", async () => {
    const { hub, nodes } = setup(["a", "b"]);
    const one = file(60);
    const two = file(61);
    nodes.a.store.content.set(one.hash, one.bytes);
    nodes.a.store.content.set(two.hash, two.bytes);

    expect(await Promise.all([nodes.b.streams.download(one.hash, "a"), nodes.b.streams.download(two.hash, "a")])).toEqual(["done", "done"]);
    expect(nodes.b.store.content.get(one.hash)).toEqual(one.bytes);
    expect(nodes.b.store.content.get(two.hash)).toEqual(two.bytes);
    const lastOfOne = hub.log.reduce((last, line, i) => (line.startsWith("ack") && line.includes(one.hash) ? i : last), -1);
    const wantTwo = hub.log.findIndex((line) => line.startsWith("want") && line.includes(two.hash));
    expect(wantTwo).toBeGreaterThan(lastOfOne);
  });

  it("knows what is on its way: answered by its holder, or waiting its turn behind what is", async () => {
    const { nodes } = setup(["a", "b"]);
    const one = file(60);
    const two = file(61);
    nodes.a.store.content.set(one.hash, one.bytes);
    nodes.a.store.content.set(two.hash, two.bytes);
    const seen: boolean[][] = [];
    nodes.b.store.onAppend = () => seen.push([nodes.b.streams.coming(one.hash), nodes.b.streams.coming(two.hash)]);

    const both = Promise.all([nodes.b.streams.download(one.hash, "a"), nodes.b.streams.download(two.hash, "a")]);
    expect(nodes.b.streams.coming(one.hash)).toBe(false); // asked, not answered yet
    await both;
    expect(seen[0]).toEqual([true, true]);
    expect(nodes.b.streams.coming(one.hash)).toBe(false);
    expect(nodes.b.streams.coming(file(5).hash)).toBe(false);
  });

  // A node asks members something is coming from last (a request to them waits behind it and makes it give way).
  it("knows which holders something is coming from, running or waiting its turn", async () => {
    const { nodes } = setup(["a", "b", "c"]);
    const one = file(60);
    nodes.a.store.content.set(one.hash, one.bytes);

    expect(nodes.b.streams.receivingFrom("a")).toBe(false);
    const download = nodes.b.streams.download(one.hash, "a");
    expect(nodes.b.streams.receivingFrom("a")).toBe(true);
    expect(nodes.b.streams.receivingFrom("c")).toBe(false);
    expect(await download).toBe("done");
    expect(nodes.b.streams.receivingFrom("a")).toBe(false);
  });

  it("cancels a download that waits its turn", async () => {
    const { nodes } = setup(["a", "b"]);
    const one = file(60);
    const two = file(61);
    nodes.a.store.content.set(one.hash, one.bytes);
    nodes.a.store.content.set(two.hash, two.bytes);

    const both = Promise.all([nodes.b.streams.download(one.hash, "a"), nodes.b.streams.download(two.hash, "a")]);
    nodes.b.streams.cancel(two.hash);
    expect(await both).toEqual(["done", "cancelled"]);
  });

  // "busy" tells the asker the holder has it and to come back; content it hasn't is "missing", so the asker goes on to
  // the others (a node waiting on a busy member that hadn't got the file, a member backing off from such).
  it("answers missing, not busy, for content it doesn't have while it serves someone else", async () => {
    const { nodes } = setup(["a", "b", "c"]);
    const { bytes, hash } = file(50);
    nodes.a.store.content.set(hash, bytes);

    const serving = nodes.b.streams.download(hash, "a");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await nodes.c.streams.download(file(7).hash, "a")).toBe("missing");
    expect(await nodes.c.streams.download(hash, "a")).toBe("busy");
    expect(await serving).toBe("done");
  });

  it("is free for others once a receiver stops", async () => {
    const { nodes } = setup(["a", "b", "c"]);
    const { bytes, hash } = file(50);
    nodes.a.store.content.set(hash, bytes);
    nodes.b.store.onAppend = () => nodes.b.streams.cancel(hash);

    expect(await nodes.b.streams.download(hash, "a")).toBe("cancelled");
    expect(nodes.b.store.partial.has(hash)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await nodes.c.streams.download(hash, "a")).toBe("done");
  });

  it("lets the holder cancel a send; the receiver throws away what it got", async () => {
    const { nodes } = setup(["a", "b", "c"]);
    const { bytes, hash } = file(50);
    nodes.a.store.content.set(hash, bytes);
    const seen: (number | undefined)[] = [];
    const receivers: (string | undefined)[] = [];
    nodes.b.store.onAppend = () => {
      seen.push(nodes.a.streams.sendingProgress(hash));
      receivers.push(nodes.a.streams.sendingTo(hash));
      if (seen.length === 2) nodes.a.streams.stopSending(hash);
    };

    expect(await nodes.b.streams.download(hash, "a")).toBe("cancelled");
    expect(nodes.b.store.partial.has(hash)).toBe(false);
    expect(seen).toEqual([0, 0.2]);
    // Who it goes to while it is sent (a node or a member: the label differs, core/content.ts), nobody after.
    expect(receivers).toEqual(["b", "b"]);
    expect(nodes.a.streams.sendingTo(hash)).toBeUndefined();
    expect(nodes.a.streams.sendingProgress(hash)).toBeUndefined();
    expect(await nodes.c.streams.download(hash, "a")).toBe("done");
  });

  // An upload its member holds back from the nodes (p2p/content.ts): the receiver keeps what arrived, so sending it on
  // later goes on from there.
  it("lets the holder stop a send with the receiver keeping what it got", async () => {
    const { hub, nodes } = setup(["a", "b"]);
    const { bytes, hash } = file(50);
    nodes.a.store.content.set(hash, bytes);
    let appended = 0;
    nodes.b.store.onAppend = () => {
      if (++appended === 2) nodes.a.streams.stopSending(hash, false);
    };

    expect(await nodes.b.streams.download(hash, "a")).toBe("failed");
    expect(nodes.b.store.partial.get(hash)?.byteLength).toBe(20);
    expect(nodes.a.streams.sendingProgress(hash)).toBeUndefined();
    nodes.b.store.onAppend = undefined;
    expect(await nodes.b.streams.download(hash, "a")).toBe("done");
    expect(hub.log.filter((line) => line.startsWith("want"))).toEqual([
      `want b>a {"hash":"${hash}","offset":0}`, `want b>a {"hash":"${hash}","offset":20}`,
    ]);
  });

  it("answers missing to a peer it refuses, though the content is here", async () => {
    const { nodes } = setup(["a", "b", "c"], { refuse: (_hash, peer) => peer === "b" });
    const { bytes, hash } = file(25);
    nodes.a.store.content.set(hash, bytes);

    expect(await nodes.b.streams.download(hash, "a")).toBe("missing");
    expect(nodes.a.streams.sendingTo(hash)).toBeUndefined();
    expect(await nodes.c.streams.download(hash, "a")).toBe("done");
  });

  it("throws away content that doesn't match its hash", async () => {
    const { nodes } = setup(["a", "b"]);
    const { hash } = file(35);
    nodes.a.store.content.set(hash, file(36).bytes.slice(1));

    expect(await nodes.b.streams.download(hash, "a")).toBe("failed");
    expect(nodes.b.store.content.has(hash)).toBe(false);
    expect(nodes.b.store.partial.has(hash)).toBe(false);
  });

  it("fetches content it doesn't have when asked (onMissing), then sends it", async () => {
    // B is a node without the file; A (another node) keeps it; C asks B.
    const hub = new Hub();
    const make = (id: string, onMissing?: (hash: string) => Promise<boolean>) => {
      const store = new MemoryStore();
      return { store, streams: new ContentStreams(hub.room(id), store, { chunkSize: 10, idleMs: 500, onMissing }) };
    };
    const a = make("a");
    const b = make("b", async (hash) => (await b.streams.download(hash, "a")) === "done");
    const c = make("c");
    const { bytes, hash } = file(35);
    a.store.content.set(hash, bytes);
    expect(await c.streams.download(hash, "b")).toBe("done");
    expect(c.store.content.get(hash)).toEqual(bytes);
    expect(b.store.content.has(hash)).toBe(true);
    // Nothing to fetch it from: still "missing".
    expect(await c.streams.download(file(7).hash, "b")).toBe("missing");
  });

  // A node still loading a new upload from its uploader: the member comes back soon instead of showing "Nobody online
  // has it"; once it is here, the node sends it.
  it("answers busy while the content it fetches on demand is still on its way, then sends it", async () => {
    const hub = new Hub();
    const store = new MemoryStore();
    const { bytes, hash } = file(35);
    let asked = 0;
    new ContentStreams(hub.room("n"), store, { chunkSize: 10, idleMs: 500, senders: 8, onMissing: async (wanted) => {
      if (++asked === 1) return "busy";
      store.content.set(wanted, bytes);
      return true;
    } });
    const member = new ContentStreams(hub.room("m"), new MemoryStore(), { chunkSize: 10, idleMs: 500 });

    expect(await member.download(hash, "n")).toBe("busy");
    expect(await member.download(hash, "n")).toBe("done");
    expect(asked).toBe(2);
  });

  // A node fetching content first (up to 8 s) for one member mustn't turn others away: only sending takes a place.
  it("takes no place among the receivers served while it fetches the content first", async () => {
    const hub = new Hub();
    const store = new MemoryStore();
    const fresh = file(35);
    const kept = file(36);
    store.content.set(kept.hash, kept.bytes);
    let found!: (here: boolean) => void;
    new ContentStreams(hub.room("n"), store, { chunkSize: 10, idleMs: 500, onMissing: () => new Promise((resolve) => (found = resolve)) });
    const first = new ContentStreams(hub.room("m1"), new MemoryStore(), { chunkSize: 10, idleMs: 500 });
    const second = new ContentStreams(hub.room("m2"), new MemoryStore(), { chunkSize: 10, idleMs: 500 });

    const waiting = first.download(fresh.hash, "n");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await second.download(kept.hash, "n")).toBe("done");
    await new Promise((resolve) => setTimeout(resolve, 10)); // its last ack reached the node: that send is over
    store.content.set(fresh.hash, fresh.bytes);
    found(true);
    expect(await waiting).toBe("done");
  });

  it("serves more members at once while chunks are acked quickly (nodes)", async () => {
    const hub = new Hub();
    const store = new MemoryStore();
    const node = new ContentStreams(hub.room("n"), store, { chunkSize: 10, idleMs: 3_000, senders: 8 });
    const member = new ContentStreams(hub.room("m"), new MemoryStore(), { chunkSize: 10, idleMs: 3_000 });
    const { bytes, hash } = file(300);
    store.content.set(hash, bytes);
    expect(node.sendersNow).toBe(4);
    expect(await member.download(hash, "n")).toBe("done");
    expect(node.sendersNow).toBe(8);
  });

  it("reports content the member doesn't have", async () => {
    const { nodes } = setup(["a", "b"]);
    expect(await nodes.b.streams.download(file(5).hash, "a")).toBe("missing");
  });

  it("gives a peer that isn't a member yet only what invitees may fetch (a snapshot state)", async () => {
    const hub = new Hub();
    const holder = new MemoryStore();
    const joiner = new MemoryStore();
    const state = file(25);
    const other = file(15);
    holder.content.set(state.hash, state.bytes);
    holder.content.set(other.hash, other.bytes);
    const members = new Set<string>();
    void new ContentStreams(hub.room("a"), holder, {
      chunkSize: 10, idleMs: 500, invitees: { may: (hash) => hash === state.hash, isMember: (peer) => members.has(peer) },
    });
    const streams = new ContentStreams(hub.room("b"), joiner, { chunkSize: 10, idleMs: 500 });

    expect(await streams.download(other.hash, "a")).toBe("missing");
    expect(await streams.download(state.hash, "a")).toBe("done");
    expect(joiner.content.get(state.hash)).toEqual(state.bytes);
    members.add("b");
    expect(await streams.download(other.hash, "a")).toBe("done");
  });

  // Turns made a new image wait for a 2 GB file from the same holder to finish (a node loading both from an uploader,
  // a member asking the node for the image meanwhile). A long download now gives way after its slice and goes on later.
  it("lets a small file go first when a long download from the same holder ran past its slice", async () => {
    const hub = new Hub();
    const holder = new MemoryStore();
    const big = file(400);
    const small = file(15);
    holder.content.set(big.hash, big.bytes);
    holder.content.set(small.hash, small.bytes);
    void new ContentStreams(hub.room("a"), holder, { chunkSize: 10, idleMs: 500 });
    const store = new MemoryStore();
    const streams = new ContentStreams(hub.room("b"), store, { chunkSize: 10, idleMs: 500, sliceMs: 20 });
    const finished: string[] = [];

    const long = streams.download(big.hash, "a").then((result) => (finished.push("big"), result));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const short = streams.download(small.hash, "a").then((result) => (finished.push("small"), result));
    expect(await short).toBe("done");
    expect(await long).toBe("done");
    expect(finished).toEqual(["small", "big"]);
    expect(store.content.get(big.hash)).toEqual(big.bytes);
  });

  it("never starts a second download of a file while the first is still opening its part", async () => {
    const { nodes } = setup(["a", "b", "c"]);
    const { bytes, hash } = file(35);
    nodes.a.store.content.set(hash, bytes);
    nodes.c.store.content.set(hash, bytes);
    const open = nodes.b.store.openWriter.bind(nodes.b.store);
    nodes.b.store.openWriter = async (wanted) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return open(wanted);
    };

    const first = nodes.b.streams.download(hash, "a");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await nodes.b.streams.download(hash, "c")).toBe("busy");
    expect(await first).toBe("done");
  });

  it("keeps what arrived when the sender goes quiet", async () => {
    const { nodes } = setup(["a", "b"]);
    const { bytes, hash } = file(35);
    nodes.a.store.content.set(hash, bytes);
    let reads = 0;
    const read = nodes.a.store.readRange.bind(nodes.a.store);
    nodes.a.store.readRange = async (...args) => (++reads > 2 ? new Promise(() => {}) : read(...args));

    expect(await nodes.b.streams.download(hash, "a")).toBe("failed");
    expect(nodes.b.store.partial.get(hash)?.byteLength).toBe(20);
  });
});

// Diagnosis 2026-11-10 (large files missing on a node, hypothesis H2): each chunk must cross within `idleMs` (30 s for
// 4 MiB in the app, about 1.1 Mbit/s). On a slower link every try fails on the same chunk, and resuming from the part
// never gets past it.
describe("a slow link", () => {
  // Tries spaced like the node's keep pass (60 s apart in the app): a chunk still crossing from the try before has
  // arrived, and been dropped, before the next try starts.
  async function tries(delayMs: number, count = 3) {
    const { hub, nodes } = setup(["a", "b"]);
    hub.delays["content-part"] = delayMs;
    const { bytes, hash } = file(35);
    nodes.a.store.content.set(hash, bytes);
    const results: string[] = [];
    const partial: number[] = [];
    for (let i = 0; i < count && results.at(-1) !== "done"; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, delayMs + 100));
      results.push(await nodes.b.streams.download(hash, "a"));
      partial.push(nodes.b.store.partial.get(hash)?.byteLength ?? 0);
    }
    return { results, partial, done: nodes.b.store.content.get(hash) };
  }

  it("finishes a download whose chunks cross in less than idleMs", async () => {
    const { results, done } = await tries(300);
    expect(results.at(-1)).toBe("done");
    expect(done?.byteLength).toBe(35);
  });

  // Moved only at each chunk's ack, a file under one chunk (4 MiB in the app) went from 0 to done, and on a slow link
  // the bar of a bigger one stood still for seconds.
  it("moves both ends' bars with the frames of a chunk, never backwards", async () => {
    const { hub, nodes, moved } = setup(["a", "b"]);
    hub.delays["content-part"] = 350;
    const { bytes, hash } = file(25);
    nodes.a.store.content.set(hash, bytes);
    const arriving: number[] = [];
    const watch = setInterval(() => {
      const value = nodes.b.streams.progress(hash);
      if (value !== undefined && value !== arriving.at(-1)) arriving.push(value);
    }, 10);
    try {
      expect(await nodes.b.streams.download(hash, "a")).toBe("done");
    } finally {
      clearInterval(watch);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    const sending = moved.map((m) => m.value);
    expect(moved.every((m) => m.to === "a>b")).toBe(true);
    // Within the first chunk (10 of 25 bytes), and the exact values at each ack.
    for (const values of [sending, arriving]) {
      expect(values.some((v) => v > 0 && v < 0.4)).toBe(true);
      expect(values).toEqual([...values].sort((x, y) => x - y));
    }
    expect(sending).toEqual(expect.arrayContaining([0, 0.4, 0.8, 1]));
    expect(nodes.a.streams.sendingProgress(hash)).toBeUndefined();
    expect(nodes.b.streams.progress(hash)).toBeUndefined();
  });

  it("still stops a transfer whose chunk stopped moving for idleMs", async () => {
    const { hub, nodes } = setup(["a", "b"]);
    hub.delays["content-part"] = 700;
    hub.stallAfterMs = 200;
    const { bytes, hash } = file(35);
    nodes.a.store.content.set(hash, bytes);
    const started = Date.now();
    expect(await nodes.b.streams.download(hash, "a")).toBe("failed");
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(nodes.b.store.partial.get(hash)?.byteLength ?? 0).toBe(0);
  });

  // A whole download gives way to one waiting for the same holder only once its chunk on the way landed: given way
  // mid-chunk, a link slower than `sliceMs` per chunk dropped that chunk every time, and two downloads gave way to each
  // other without either moving (progress came only from a stale chunk landing by luck).
  it("gives way to another download only between chunks", async () => {
    const { hub, nodes } = setup(["a", "b"], { sliceMs: 200 });
    hub.delays["content-part"] = 400;
    const big = file(35);
    const small = file(5);
    nodes.a.store.content.set(big.hash, big.bytes);
    nodes.a.store.content.set(small.hash, small.bytes);
    const first = nodes.b.streams.download(big.hash, "a");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await nodes.b.streams.download(small.hash, "a")).toBe("done");
    expect(await first).toBe("done");
    const at = (kind: string, hash: string) => hub.log.findIndex((line) => line.startsWith(`${kind} `) && line.includes(hash));
    // The big file's first stop (giving way) came after one of its chunks landed; the small one (a single chunk)
    // never gave way.
    expect(at("part", big.hash)).toBeGreaterThanOrEqual(0);
    expect(at("part", big.hash)).toBeLessThan(at("stop", big.hash));
    expect(at("stop", small.hash)).toBe(-1);
  });

  // Stopped, the holder takes back the chunk on its way: on a slow link the next transfer from it would wait behind it
  // (Trystero takes one big message per peer at a time) until its own deadline.
  it("takes back the chunk on its way when the receiver stops", async () => {
    const { hub, nodes } = setup(["a", "b"]);
    hub.delays["content-part"] = 400;
    const { bytes, hash } = file(35);
    nodes.a.store.content.set(hash, bytes);
    const download = nodes.b.streams.download(hash, "a");
    await new Promise((resolve) => setTimeout(resolve, 100));
    nodes.b.streams.cancel(hash);
    expect(await download).toBe("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(hub.log.filter((line) => line.startsWith("part a>b"))).toEqual([]);
  });

  it("reports an empty file as sent, though it has no chunk", async () => {
    const { nodes, sent } = setup(["a", "b"]);
    const { bytes, hash } = file(0);
    nodes.a.store.content.set(hash, bytes);
    expect(await nodes.b.streams.download(hash, "a")).toBe("done");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toEqual([`a>b:${hash}`]);
  });

  it("finishes a download on a link slower than one chunk per idleMs, from what arrived", async () => {
    const { results, partial, done } = await tries(700);
    expect({ results, partial }).toEqual({ results: expect.arrayContaining(["done"]), partial: expect.any(Array) });
    expect(done?.byteLength).toBe(35);
  });
});
