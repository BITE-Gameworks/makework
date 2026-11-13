// Forgetting a channel on this device: nothing of a forgotten channel is wanted (except the member's own
// uploads), freeing it deletes only content nothing else keeps, and the channel can be synced again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContentLink } from "../../src/p2p/content";
import type { WorkspaceSync } from "../../src/p2p/sync";
import { MockBackend } from "../../src/system/backend";
import { chat } from "../../src/system/chat";
import { emoji } from "../../src/system/emoji";
import { files } from "../../src/system/files";

const h = (n: number) => n.toString(16).padStart(64, "0");
const ref = (n: number) => `mwc:${h(n)}`;

// Content stores don't exist under the test runner: deleteContent is observed, hasContent says nothing is here
// (refresh also never fetches: the link is room-less).
const mocks = vi.hoisted(() => ({
  deleteContent: vi.fn(async () => {}),
  hasContent: vi.fn(async () => false),
}));

vi.mock("../../src/core/content", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/content")>();
  return { ...actual, deleteContent: mocks.deleteContent, hasContent: mocks.hasContent };
});

// Which nodes are reached (p2p/nodes.ts `nodePeers`): an upload's label depends on it. `nodes`: the peers that are
// nodes (`NodeLink.isNode`), for telling a node's pull from a member's. `holding`: the files the nodes hold whole, as
// they answer when asked; `known`: those this device already knows about without asking. Files over 100 bytes are
// kept in pieces.
const nodeState = vi.hoisted(() => ({
  peers: [] as { user: number; rtt: number | null; app: string | null }[],
  nodes: [] as string[],
  holding: [] as string[],
  known: [] as string[],
}));
vi.mock("../../src/p2p/nodes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/p2p/nodes")>();
  return {
    ...actual, nodePeers: () => nodeState.peers,
    nodeLinkOf: () => (nodeState.nodes.length ? {
      isNode: (peer: string) => nodeState.nodes.includes(peer), hasNodes: () => true,
      onlineNodes: () => new Map(nodeState.nodes.map((peer, i) => [i + 2, peer])),
      keptWhole: (size: number) => size <= 100,
      holdsWhole: (hash: string) => nodeState.known.includes(hash),
      askHoldings: async (hashes: string[]) => {
        const held = hashes.filter((hash) => nodeState.holding.includes(hash));
        nodeState.known.push(...held);
        return new Set(held);
      },
    } : undefined),
  };
});

// Stored content doesn't exist under the test runner either: every file asked for is 20 bytes.
vi.mock("../../src/core/stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/stream")>();
  return {
    ...actual, contentSize: async () => 20,
    readRange: async (_hash: string, start: number, end: number) => new Uint8Array(new ArrayBuffer(end - start)),
  };
});

function setup() {
  const backend = new MockBackend({ userId: 1 });
  backend.load(files);
  backend.load(chat);
  backend.load(emoji);
  const sync = { room: null, onPeers: () => () => {} } as unknown as WorkspaceSync;
  const link = new ContentLink("s", backend, sync, 1, "test-content-s-1");
  const at = (plugin: string) => backend.data(plugin);
  return { backend, link, at };
}

describe("forgetting a channel", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    mocks.deleteContent.mockClear();
    t = setup();
  });
  afterEach(() => {
    t.link.close();
  });

  it("stops wanting a forgotten channel's rows but keeps own uploads and other channels", async () => {
    const { at, link } = t;
    at("files").insert("files_entries", { channel_id: 10, parent_id: null, kind: "file", name: "a.bin", mime: "application/octet-stream", size: 1, url: ref(1), author_id: 2 });
    at("files").insert("files_entries", { channel_id: 10, parent_id: null, kind: "file", name: "mine.bin", mime: "application/octet-stream", size: 1, url: ref(2), author_id: 1 });
    at("files").insert("files_entries", { channel_id: 11, parent_id: null, kind: "file", name: "b.bin", mime: "application/octet-stream", size: 1, url: ref(3), author_id: 2 });
    link.setMark({ kind: "channel", id: 10 }, true);
    link.setMark({ kind: "channel", id: 11 }, true);

    expect([...link.wanted()]).toEqual([h(1), h(2), h(3)]);
    link.forgetChannel(10);
    await Promise.resolve();

    expect([...link.wanted()]).toEqual([h(2), h(3)]);
    expect(link.isMarked({ kind: "forgotten", id: 10 })).toBe(true);
    expect(link.isMarked({ kind: "channel", id: 10 })).toBe(false);
    // Only the file only this channel needed is freed.
    expect(mocks.deleteContent).toHaveBeenCalledTimes(1);
    expect(mocks.deleteContent).toHaveBeenCalledWith(h(1));
  });

  it("frees nothing that another kept place still wants, even in the forgotten channel", async () => {
    const { at, link } = t;
    // The same content is also in channel 11, which stays synced.
    at("files").insert("files_entries", { channel_id: 10, parent_id: null, kind: "file", name: "shared.bin", mime: "application/octet-stream", size: 1, url: ref(4), author_id: 2 });
    at("files").insert("files_entries", { channel_id: 11, parent_id: null, kind: "file", name: "shared.bin", mime: "application/octet-stream", size: 1, url: ref(4), author_id: 2 });
    link.setMark({ kind: "channel", id: 10 }, true);
    link.setMark({ kind: "channel", id: 11 }, true);

    link.forgetChannel(10);
    await Promise.resolve();

    expect([...link.wanted()]).toEqual([h(4)]);
    expect(mocks.deleteContent).not.toHaveBeenCalled();
  });

  it("keeps nothing of a forgotten channel even when its folder is synced", async () => {
    const { at, link } = t;
    const folder = at("files").insert("files_entries", { channel_id: 10, parent_id: null, kind: "folder", name: "refs", author_id: 2 });
    at("files").insert("files_entries", { channel_id: 10, parent_id: folder, kind: "file", name: "deep.bin", mime: "application/octet-stream", size: 1, url: ref(5), author_id: 2 });
    link.setMark({ kind: "channel", id: 10 }, true);
    link.setMark({ kind: "folder", id: folder }, true);
    expect([...link.wanted()]).toEqual([h(5)]);

    link.forgetChannel(10);
    await Promise.resolve();

    expect([...link.wanted()]).toEqual([]);
    expect(mocks.deleteContent).toHaveBeenCalledWith(h(5));
  });

  it("skips chat attachments of a forgotten channel, except the member's own", async () => {
    const { at, link } = t;
    const mine = at("chat").insert("chat_messages", { channel_id: 10, author_id: 1, thread_id: null, kind: "message", body: "hi" });
    const other = at("chat").insert("chat_messages", { channel_id: 10, author_id: 2, thread_id: null, kind: "message", body: "hi" });
    at("chat").insert("chat_attachments", { message_id: mine, name: "a.png", mime: "image/png", size: 1, url: ref(6) });
    at("chat").insert("chat_attachments", { message_id: other, name: "b.png", mime: "image/png", size: 1, url: ref(7) });
    link.setMark({ kind: "channel", id: 10 }, true);
    expect([...link.wanted()]).toEqual([h(6), h(7)]);

    link.forgetChannel(10);
    await Promise.resolve();

    expect([...link.wanted()]).toEqual([h(6)]);
    expect(mocks.deleteContent).toHaveBeenCalledTimes(1);
    expect(mocks.deleteContent).toHaveBeenCalledWith(h(7));
  });

  it("restores the channel: the forgotten mark goes and syncing it again fetches its content", async () => {
    const { at, link } = t;
    at("files").insert("files_entries", { channel_id: 10, parent_id: null, kind: "file", name: "a.bin", mime: "application/octet-stream", size: 1, url: ref(1), author_id: 2 });
    link.setMark({ kind: "channel", id: 10 }, true);
    link.forgetChannel(10);
    await Promise.resolve();
    expect([...link.wanted()]).toEqual([]);
    mocks.deleteContent.mockClear();

    link.restoreChannel(10);
    link.setMark({ kind: "channel", id: 10 }, true);
    expect([...link.wanted()]).toEqual([h(1)]);
    expect(mocks.deleteContent).not.toHaveBeenCalled();
  });
});

// "Delete from network" removes a file's rows (system/files.ts `purge`); "Delete locally" only hides them.
describe("a file deleted for good", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    mocks.deleteContent.mockClear();
    t = setup();
  });
  afterEach(() => {
    t.link.close();
  });
  const file = (t: ReturnType<typeof setup>, n: number, name: string, parent: number | null = null) =>
    t.at("files").insert("files_entries", { channel_id: 10, parent_id: parent, kind: "file", name, mime: "application/octet-stream", size: 1, url: ref(n), author_id: 1, deleted: false });

  it("frees its content on this device, but not a hidden file's or content another entry points at", async () => {
    const { at, link } = t;
    const gone = file(t, 1, "gone.bin");
    const hidden = file(t, 2, "hidden.bin");
    const shared = file(t, 3, "shared.bin");
    file(t, 3, "copy.bin");
    expect([...link.wanted()]).toEqual([h(1), h(2), h(3)]);

    at("files").update("files_entries", { deleted: true }, { id: hidden });
    link.wanted();
    at("files").delete("files_entries", { id: gone });
    at("files").delete("files_entries", { id: shared });
    await Promise.resolve();

    expect(mocks.deleteContent).toHaveBeenCalledTimes(1);
    expect(mocks.deleteContent).toHaveBeenCalledWith(h(1));
    expect([...link.wanted()]).toEqual([h(3)]);
  });

  it("frees a folder's files, hidden ones too, and no longer counts them as on their way to a node", async () => {
    const { at, link } = t;
    nodeState.nodes = ["n1"];
    const folder = at("files").insert("files_entries", { channel_id: 10, parent_id: null, kind: "folder", name: "docs", size: 0, author_id: 1, deleted: false });
    const inside = file(t, 5, "inside.bin", folder);
    const hidden = file(t, 6, "hidden.bin", folder);
    at("files").update("files_entries", { deleted: true }, { id: hidden });
    link.expectDelivery(h(5), 20);
    expect(link.delivery(h(5))).toBeDefined();
    link.wanted();

    for (const id of [inside, hidden, folder]) at("files").delete("files_entries", { id });
    await Promise.resolve();

    expect(mocks.deleteContent).toHaveBeenCalledTimes(2);
    expect(mocks.deleteContent).toHaveBeenCalledWith(h(5));
    expect(mocks.deleteContent).toHaveBeenCalledWith(h(6));
    expect(link.delivery(h(5))).toBeUndefined();
    nodeState.nodes = [];
  });
});

describe("custom emoji content", () => {
  it("wants every emoji image, including removed ones, with no mark", () => {
    const backend = new MockBackend({ userId: 1 });
    backend.load(emoji);
    const sync = { room: null, onPeers: () => () => {} } as unknown as WorkspaceSync;
    const link = new ContentLink("s", backend, sync, 1, "test-content-s-emoji");
    try {
      const at = backend.data("emoji");
      at.insert("emoji_emojis", { name: "party_parrot", url: ref(1), thumb: "data:image/webp;base64,AAAA", mime: "image/png", size: 1, width: 1, height: 1, author_id: 2, created_at: new Date().toISOString(), deleted: false });
      at.insert("emoji_emojis", { name: "old_one", url: ref(2), thumb: "data:image/webp;base64,AAAA", mime: "image/png", size: 1, width: 1, height: 1, author_id: 2, created_at: new Date().toISOString(), deleted: true });
      expect([...link.wanted()]).toEqual([h(1), h(2)]);
    } finally {
      link.close();
    }
  });
});

// A new upload from this device says "uploading" while a node is reached (it pulls the upload, so quitting would cut
// it off) and "waiting" while none is (core/content.ts transferLabel).
describe("an upload on its way to a node", () => {
  const key = "test-content-node";
  const pending = h(9);
  let link: ContentLink;
  let backend: MockBackend;
  const sync = () => ({ room, onPeers: () => () => {} }) as unknown as WorkspaceSync;
  beforeEach(() => {
    const stored = new Map([[`${key}.deliveries`, JSON.stringify({ [pending]: Date.now() })]]);
    vi.stubGlobal("localStorage", {
      getItem: (name: string) => stored.get(name) ?? null,
      setItem: (name: string, value: string) => void stored.set(name, value),
      removeItem: (name: string) => void stored.delete(name),
    });
    nodeState.peers = [];
    handlers.clear();
    sends.length = 0;
    backend = new MockBackend({ userId: 1 });
    backend.load(files);
    link = new ContentLink("w", backend, sync(), 1, key);
  });
  afterEach(() => {
    link.close();
    nodeState.peers = [];
    nodeState.nodes = [];
    nodeState.holding = [];
    nodeState.known = [];
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // A room in which peers ask this device for content (`content-want`) and stop (`content-stop`). Half of each chunk
  // sent goes out (one frame reported), and no ack ever comes. `sends`: what this device sent, by action and receiver.
  type Handler = (data: unknown, context: { peerId: string }) => unknown;
  const handlers = new Map<string, Handler>();
  const sends: { name: string; to: string; data: unknown }[] = [];
  const room = {
    getPeers: () => ({}),
    makeAction: (name: string, config: { onRequest?: Handler; onMessage?: Handler } = {}) => {
      const handler = config.onRequest ?? config.onMessage;
      if (handler) handlers.set(name, handler);
      return {
        request: async () => null,
        send: async (data: unknown, options: { target: string; onProgress?: (fraction: number, context: { peerId: string }) => void }) => {
          sends.push({ name, to: options.target, data });
          options.onProgress?.(0.5, { peerId: options.target });
        },
      };
    },
  };
  const stops = () => sends.filter((s) => s.name === "content-stop").map((s) => ({ to: s.to, data: s.data }));
  const mine = () => backend.data("files").insert("files_entries", {
    channel_id: 10, parent_id: null, kind: "file", name: "mine.bin", mime: "application/octet-stream", size: 20, url: `mwc:${pending}`, author_id: 1,
  });

  // Cancelling used to remove the item for everyone and delete its content. Now nothing is removed: the upload is held
  // back from the nodes (a node asks again for what it lacks about once a minute) until the user sends it on.
  it("holds an upload back from the nodes once the user cancels it, across restarts, until it is sent on", async () => {
    nodeState.nodes = ["node"];
    nodeState.peers = [{ user: 2, rtt: null, app: null }];
    mine();
    const want = handlers.get("content-want")!;
    expect(await want({ hash: pending, offset: 0 }, { peerId: "node" })).toEqual({ size: 20 });
    await tick();
    expect(link.sendingToNode(pending)).toBe(true);
    expect(link.undelivered()).toBe(1);

    link.cancelSend(pending);
    expect(link.sending(pending)).toBeUndefined();
    expect(link.delivery(pending)).toBe("held");
    // The node keeps what it got (no discard), and quitting doesn't ask about an upload the user stopped.
    expect(stops()).toEqual([{ to: "node", data: { hash: pending } }]);
    expect(link.undelivered()).toBe(0);
    expect([...link.wanted()]).toContain(pending);
    expect(mocks.deleteContent).not.toHaveBeenCalledWith(pending);
    expect(backend.data("files").select("files_entries")).toHaveLength(1);
    // The node asks again: refused. A member who asks still gets it.
    expect(await want({ hash: pending, offset: 0 }, { peerId: "node" })).toBeNull();
    expect(await want({ hash: pending, offset: 0 }, { peerId: "member" })).toEqual({ size: 20 });
    handlers.get("content-stop")!({ hash: pending }, { peerId: "member" });

    const restarted = new ContentLink("w", backend, sync(), 1, key);
    expect(restarted.delivery(pending)).toBe("held");
    restarted.close();

    link.uploadToNode(pending, 20);
    expect(link.delivery(pending)).toBe("uploading");
    expect(link.undelivered()).toBe(1);
    expect(await want({ hash: pending, offset: 0 }, { peerId: "node" })).toEqual({ size: 20 });
  });

  it("holds back an upload cancelled while it still waits for a node", () => {
    nodeState.nodes = ["node"];
    mine();
    expect(link.delivery(pending)).toBe("waiting");
    link.cancelSend(pending);
    expect(link.delivery(pending)).toBe("held");
    expect(stops()).toEqual([]);
  });

  it("only ends the send when the user cancels one to a member", async () => {
    nodeState.nodes = ["node"];
    mine();
    await handlers.get("content-want")!({ hash: pending, offset: 0 }, { peerId: "member" });
    await tick();
    link.cancelSend(pending);
    expect(link.sending(pending)).toBeUndefined();
    expect(stops()).toEqual([{ to: "member", data: { hash: pending, discard: true } }]);
    expect(link.delivery(pending)).toBe("waiting");
    expect(mocks.deleteContent).not.toHaveBeenCalledWith(pending);
  });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  it("remembers how far a node got with it while the pull pauses, and nothing of a member's", async () => {
    nodeState.nodes = ["node"];
    expect(link.deliveryProgress(pending)).toBeUndefined();
    await handlers.get("content-want")!({ hash: pending, offset: 0 }, { peerId: "member" });
    await tick();
    expect(link.sending(pending)).toBe(0.5);
    expect(link.deliveryProgress(pending)).toBeUndefined();
    // A member sends to one receiver at a time: the node's turn comes once the member's download is over.
    handlers.get("content-stop")!({ hash: pending }, { peerId: "member" });

    await handlers.get("content-want")!({ hash: pending, offset: 0 }, { peerId: "node" });
    await tick();
    expect(link.sendingToNode(pending)).toBe(true);
    expect(link.deliveryProgress(pending)).toBe(0.5);
    // The node gives way to another download (or drops out): the send is over, the place stays.
    handlers.get("content-stop")!({ hash: pending }, { peerId: "node" });
    expect(link.sending(pending)).toBeUndefined();
    expect(link.deliveryProgress(pending)).toBe(0.5);
    // Not for content that isn't a new upload from here.
    await handlers.get("content-want")!({ hash: h(8), offset: 0 }, { peerId: "node" });
    await tick();
    expect(link.deliveryProgress(h(8))).toBeUndefined();
  });

  // "Upload to the node" on any own file: one never on its way (the same bytes uploaded again, or an older file) is sent
  // on like a held back one.
  it("sends any own file on to the nodes when asked, and offers it only while no node is known to have it", () => {
    nodeState.nodes = ["node"];
    const other = h(8);
    expect(link.canUploadToNode(other, 20)).toBe(true);
    link.uploadToNode(other, 20);
    expect(link.delivery(other)).toBe("waiting");
    expect(link.canUploadToNode(other, 20)).toBe(false);
    // Not offered while one is on its way, nor for empty files or ones kept in pieces.
    expect(link.canUploadToNode(pending, 20)).toBe(false);
    expect(link.canUploadToNode(h(7), 0)).toBe(false);
    expect(link.canUploadToNode(h(7), 500)).toBe(false);
    // Nor where the workspace has no nodes.
    nodeState.nodes = [];
    expect(link.canUploadToNode(h(7), 20)).toBe(false);
  });

  it("asks the nodes at once when a file is sent on, so one a node has already says so", async () => {
    vi.useFakeTimers();
    nodeState.nodes = ["node"];
    nodeState.peers = [{ user: 2, rtt: null, app: null }];
    const other = h(8);
    nodeState.holding = [other];
    link.uploadToNode(other, 20);
    expect(link.delivery(other)).toBe("uploading");
    await vi.advanceTimersByTimeAsync(250);
    expect(link.delivery(other)).toBeUndefined();
    expect(link.undelivered()).toBe(0);
    expect(link.canUploadToNode(other, 20)).toBe(false);
  });

  // A file kept in pieces is never counted as on its way (nodes take it as ranges, never as a whole send): sending a held
  // back one on lifts the hold without counting it, or it would say "Uploading to the node" for ever.
  it("lifts the hold on a file kept in pieces without counting it as on its way", () => {
    nodeState.nodes = ["node"];
    const big = h(6);
    backend.data("files").insert("files_entries", {
      channel_id: 10, parent_id: null, kind: "file", name: "big.bin", mime: "application/octet-stream", size: 500, url: `mwc:${big}`, author_id: 1,
    });
    link.cancelSend(big);
    expect(link.delivery(big)).toBe("held");
    link.uploadToNode(big, 500);
    expect(link.delivery(big)).toBeUndefined();
    expect(link.undelivered()).toBe(0);
  });

  it("says uploading while a node is reached, waiting while none is", () => {
    expect(link.delivery(pending)).toBe("waiting");
    nodeState.peers = [{ user: 2, rtt: null, app: null }];
    expect(link.delivery(pending)).toBe("uploading");
    expect(link.delivery(h(8))).toBeUndefined();
  });
});
