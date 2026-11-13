import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { access } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Room } from "trystero";
import { ApiClient } from "../../src/api/client";
import { createIdentity } from "../../src/core/identity";
import { MockTransport } from "../../src/mock/transport";
import { HostedServer } from "../../src/node/host";
import { fileContent } from "../../src/node/storage";
import { memoryCommits } from "../../src/p2p/commits";
import { Ledger, createLedgerBackend, newRowId } from "../../src/p2p/ledger";
import { signCommit, userNumberOf, type SnapshotRef } from "../../src/p2p/log";
import { NodeLink, nodeRows } from "../../src/p2p/nodes";
import { digestBytes, pieceCount, pieceKey, pieceSize, setMinStripeBytes } from "../../src/p2p/pieces";
import { localPlugins, plugins } from "../../src/p2p/plugins";
import { workspacePolicy } from "../../src/p2p/policy";
import { ContentStreams, type DownloadResult, type StreamStore } from "../../src/p2p/stream";
import { WorkspaceSync } from "../../src/p2p/sync";
import { Network } from "../p2p/fakeNetwork";

// Three nodes on the fake network keep a 9 MiB file in pieces (stripe_mb 1, the 20 GB minimum lowered for the test),
// with copies or with parity, take them from the owner as byte ranges, check them against the file's piece list, and
// serve the file to a member piece by piece; no node ever holds it whole.

beforeAll(() => setMinStripeBytes(1024 * 1024));
afterAll(() => setMinStripeBytes(null));

const dirs: string[] = [];
const closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "mw-host-"));
  dirs.push(dir);
  return dir;
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return true;
    await wait(100);
  }
  return check();
}
const nameOf = (roomId: string) => (roomId.endsWith(":members") ? "members" : roomId.includes(":call:") ? "call" : "hub");

// The owner ("a") of a new workspace on a fake network: its ledger, room, API and content store. `slowMs`: each chunk
// it sends is read that much later (a slow uplink).
async function owner(slowMs = 0) {
  const network = new Network();
  const identity = await createIdentity(false);
  const signer = { author: identity.id, key: { x: identity.publicKey.x!, y: identity.publicKey.y! }, privateKey: identity.privateKey, replica: crypto.randomUUID() };
  const { workspaceId, genesis } = await Ledger.createGenesis(signer);
  const ledger = new Ledger(workspaceId, signer, workspacePolicy, memoryCommits());
  const backend = createLedgerBackend(ledger, localPlugins);
  for (const plugin of plugins) backend.load(plugin);
  await ledger.load();
  await ledger.adopt(genesis);
  const sync = new WorkspaceSync(ledger, workspaceId, "secret", {
    self: "a", tabs: false, fallbackAfterMs: 60_000, joinRoom: (roomId, passive) => network.join("a", nameOf(roomId), passive) as unknown as Room,
  });
  sync.setNodes({ known: () => true, isNode: (p) => p.startsWith("n") });
  const api = new ApiClient(new MockTransport(backend));
  const ownerStore = fileContent(await scratch());
  const served: StreamStore = slowMs === 0 ? ownerStore : {
    size: (hash) => ownerStore.size(hash),
    openWriter: (hash) => ownerStore.openWriter(hash),
    readRange: async (hash, start, end) => {
      await wait(slowMs);
      return ownerStore.readRange(hash, start, end);
    },
  };
  const streams = new ContentStreams(sync.room!, served);
  closers.push(() => streams.close(), () => sync.close());
  const store = async (data: Uint8Array) => {
    const name = createHash("sha256").update(data).digest("hex");
    const writer = await ownerStore.openWriter(name);
    await writer.append(new Uint8Array(data) as Uint8Array<ArrayBuffer>);
    await writer.finish(name);
    return name;
  };
  return { network, workspaceId, ledger, api, sync, streams, store };
}

type Owner = Awaited<ReturnType<typeof owner>>;

// Another member of the owner's workspace on the same network, with its own ledger, content store and profile.
async function uploader(o: Owner, name: string) {
  const identity = await createIdentity(false);
  const signer = { author: identity.id, key: { x: identity.publicKey.x!, y: identity.publicKey.y! }, privateKey: identity.privateKey, replica: crypto.randomUUID() };
  const ledger = new Ledger(o.workspaceId, signer, workspacePolicy, memoryCommits());
  const backend = createLedgerBackend(ledger, localPlugins);
  for (const plugin of plugins) backend.load(plugin);
  await ledger.load();
  const ready = ledger.ready();
  const sync = new WorkspaceSync(ledger, o.workspaceId, "secret", {
    self: name, tabs: false, fallbackAfterMs: 60_000, joinRoom: (roomId, passive) => o.network.join(name, nameOf(roomId), passive) as unknown as Room,
  });
  sync.setNodes({ known: () => true, isNode: (p) => p.startsWith("n") });
  const api = new ApiClient(new MockTransport(backend));
  const content = fileContent(await scratch());
  const streams = new ContentStreams(sync.room!, content);
  closers.push(() => streams.close(), () => sync.close());
  await ready;
  await api.plugin("members").call("set-profile", { username: name, display_name: name, color: "" });
  await ledger.flush();
  const store = async (data: Uint8Array) => {
    const hash = createHash("sha256").update(data).digest("hex");
    const writer = await content.openWriter(hash);
    await writer.append(new Uint8Array(data) as Uint8Array<ArrayBuffer>);
    await writer.finish(hash);
    return hash;
  };
  return { ledger, api, store };
}

// Nodes hosting the owner's workspace, authorized once they asked. `cutOff`: nodes the owner never connects to (like
// the nodes of another group, which members don't reach). `streamIdleMs`: how long their transfers may stall.
async function hostNodes({ network, workspaceId, ledger, api }: Owner, names: string[], cutOff: string[] = [], streamIdleMs?: number) {
  const nodes: { name: string; server: HostedServer; dir: string }[] = [];
  for (const name of names) {
    const identity = await createIdentity(false);
    const dir = await scratch();
    const server = await HostedServer.open({ id: workspaceId, secret: "secret", replica: crypto.randomUUID() }, {
      identity: { id: identity.id, key: { x: identity.publicKey.x!, y: identity.publicKey.y! }, privateKey: identity.privateKey },
      commits: memoryCommits(), content: fileContent(dir), senders: 8, healAfterMs: 60_000, self: name, streamIdleMs,
      joinRoom: (roomId, passive) => network.join(name, nameOf(roomId), passive) as unknown as Room,
    }, () => ({ address: "", url: "", place: null }));
    nodes.push({ name, server, dir });
    closers.push(() => server.close().catch(() => {}));
  }
  await wait(50);
  for (const name of cutOff) network.unlink("a", name);
  expect(await until(() => nodeRows(ledger).length === names.length, 40_000)).toBe(true);
  for (const row of nodeRows(ledger)) await api.plugin("nodes").call("decide", { user_id: row.user_id, status: "authorized" });
  await ledger.flush();
  return nodes;
}

async function setup(storage: { stripe_mb: number; copies: number; parity: number }, cutOff: string[] = []) {
  const o = await owner();
  const { ledger, api, store } = o;

  // The owner uploads a 9 MiB file (three pieces) as a chat attachment, with its piece list.
  const bytes = randomBytes(9 * 1024 * 1024 + 123);
  const hash = createHash("sha256").update(bytes).digest("hex");
  await store(bytes);
  const list = new Uint8Array(pieceCount(bytes.byteLength) * digestBytes);
  for (let i = 0; i < pieceCount(bytes.byteLength); i++)
    list.set(createHash("sha256").update(bytes.subarray(i * pieceSize, (i + 1) * pieceSize)).digest(), i * digestBytes);
  const listHash = await store(list);
  await api.plugin("nodes").call("set-storage", storage);
  const { id } = await api.plugin("chat").call<{ id: number }>("post-message", { channel_id: 1, body: "big" });
  await api.plugin("chat").call("attach", { message_id: id, name: "big.bin", mime: "application/octet-stream", size: bytes.byteLength, url: `mwc:${hash}` });
  await api.plugin("nodes").call("add-pieces", { content: `mwc:${hash}`, manifest: `mwc:${listHash}` });
  await ledger.flush();

  const nodes = await hostNodes(o, ["n1", "n2", "n3"], cutOff);
  // Each node keeps its pieces (a node may have none: placement can give every piece to the other two).
  const kept = async () => {
    let any = false;
    for (const node of nodes) {
      const local = new Set((await fileContent(node.dir).pieces()).get(hash) ?? []);
      const duty = node.server.keptPieces();
      if (node.server.status() !== "authorized" || ![...duty].every((key) => local.has(key))) return false;
      any ||= duty.size > 0;
    }
    return any;
  };
  expect(await until(kept, 60_000)).toBe(true);
  return { network: o.network, nodes, hash, bytes, sync: o.sync, streams: o.streams };
}

// Whether a node's store has the whole file (it never should for a file kept in pieces).
const whole = (dir: string, hash: string) => access(join(dir, "content", hash)).then(() => true, () => false);

// A member ("d") in the hub room, reaching `node`.
async function member(network: Network, node: string) {
  const dir = await scratch();
  const room = network.join("d", "hub", false);
  const streams = new ContentStreams(room as unknown as Room, fileContent(dir), { idleMs: 20_000 });
  closers.push(() => streams.close(), () => room.leave());
  await until(() => network.linked("d", node), 5_000);
  return { streams, read: (hash: string) => readFile(join(dir, "content", hash)) };
}

// A member asks `node` for the whole file.
async function download(network: Network, node: string, hash: string) {
  const { streams, read } = await member(network, node);
  for (let i = 0; i < 10; i++) {
    if ((await streams.download(hash, node)) === "done") return read(hash);
    await wait(1_000);
  }
  return null;
}

describe("nodes keeping big files in pieces", () => {
  it("keeps each piece on `copies` nodes, taken as byte ranges, and serves the file piece by piece", async () => {
    const { network, nodes, hash, bytes } = await setup({ stripe_mb: 1, copies: 2, parity: 0 });
    for (const node of nodes) expect(await whole(node.dir, hash)).toBe(false);
    let pieces = 0;
    for (const node of nodes) pieces += ((await fileContent(node.dir).pieces()).get(hash) ?? []).length;
    expect(pieces).toBeGreaterThanOrEqual(pieceCount(bytes.byteLength) * 2);
    const got = await download(network, "n1", hash);
    expect(got && Buffer.from(got).equals(bytes)).toBe(true);
    for (const node of nodes) expect(await whole(node.dir, hash)).toBe(false);
  }, 120_000);

  it("knows what the other nodes keep, so no piece counts as short of its copies", async () => {
    const { nodes } = await setup({ stripe_mb: 1, copies: 2, parity: 0 });
    // Each node learns the others' pieces over `node-have`; NodeLink listened there first and the node's own handler
    // was never called (Trystero keeps the first action of a name), so every piece looked short (mesh-test s8/s9).
    expect(await until(async () => {
      for (const node of nodes) if ((await node.server.counts()).below > 0) return false;
      return true;
    }, 30_000)).toBe(true);
  }, 120_000);

  it("refuses damaged pieces from other nodes and still serves the right file", async () => {
    const { network, nodes, hash, bytes } = await setup({ stripe_mb: 1, copies: 2, parity: 0 });
    // Piece 0 damaged on both its holders: the node a member asks refuses both and takes it from the owner instead.
    const key = pieceKey(hash, 0);
    const holdersOf = nodes.filter((n) => n.server.keptPieces().has(key));
    expect(holdersOf).toHaveLength(2);
    for (const holder of holdersOf) await fileContent(holder.dir).writePiece(key, randomBytes(pieceSize));
    const server = nodes.find((n) => !holdersOf.includes(n))!;
    const got = await download(network, server.name, hash);
    expect(got && Buffer.from(got).equals(bytes)).toBe(true);
  }, 120_000);

  it("takes pieces through another node when it can't reach the uploader (another group's nodes)", async () => {
    const { network, nodes, hash, bytes } = await setup({ stripe_mb: 1, copies: 1, parity: 2 }, ["n2", "n3"]);
    expect(network.linked("a", "n2") || network.linked("a", "n3")).toBe(false);
    const got = await download(network, "n3", hash);
    expect(got && Buffer.from(got).equals(bytes)).toBe(true);
    for (const node of nodes) expect(await whole(node.dir, hash)).toBe(false);
  }, 120_000);

  it("with parity, rebuilds a piece whose node is gone", async () => {
    const { network, nodes, hash, bytes, sync, streams } = await setup({ stripe_mb: 1, copies: 1, parity: 2 });
    // The owner leaves (no whole copy anywhere), and so does the node keeping piece 0.
    streams.close();
    sync.close();
    const keeper = nodes.find((n) => n.server.keptPieces().has(`${hash}:0`))!;
    await keeper.server.close();
    const other = nodes.find((n) => n !== keeper && !n.server.keptPieces().has(`${hash}:0`))!;
    // No whole copy anywhere: only pieces, and piece 0 only by parity.
    for (const node of nodes) expect(await whole(node.dir, hash)).toBe(false);
    const got = await download(network, other.name, hash);
    expect(got && Buffer.from(got).equals(bytes)).toBe(true);
  }, 120_000);
});

// With nodes online members reach each other only through them, so a new upload goes uploader -> node -> members.
describe("nodes passing new uploads on to members", () => {
  // Posts a message with `count` images of `bytes` each (stored by the owner, or nowhere: `stored` false).
  async function post(o: Owner, count: number, size = 300_000, stored = true) {
    const { id } = await o.api.plugin("chat").call<{ id: number }>("post-message", { channel_id: 1, body: "pictures" });
    const hashes: string[] = [];
    for (let i = 0; i < count; i++) {
      const bytes = randomBytes(size);
      const hash = stored ? await o.store(bytes) : createHash("sha256").update(bytes).digest("hex");
      await o.api.plugin("chat").call("attach", { message_id: id, name: `${i}.png`, mime: "image/png", size, url: `mwc:${hash}` });
      hashes.push(hash);
    }
    await o.ledger.flush();
    return hashes;
  }

  // What a member asking `node` for `hash` hears, again after "busy" (1 s apart), until something else.
  async function answers(streams: ContentStreams, node: string, hash: string, tries = 20) {
    const heard: DownloadResult[] = [];
    for (let i = 0; i < tries; i++) {
      const result = await streams.download(hash, node);
      heard.push(result);
      if (result !== "busy") break;
      await wait(1_000);
    }
    return heard;
  }

  // The node loads both images from the owner (its keep pass and on demand) while the member asks for them: asked for
  // two at once, the owner's answer to the second ended the first transfer, which stalled 30 s, and the member heard
  // "missing" ("Nobody online has it") meanwhile.
  it("passes several new images on, none answered missing", async () => {
    const o = await owner();
    const [node] = await hostNodes(o, ["n1"]);
    const hashes = await post(o, 3);
    const { streams } = await member(o.network, node.name);
    const heard = await Promise.all(hashes.map((hash) => answers(streams, node.name, hash)));
    for (const results of heard) expect(results.at(-1)).toBe("done");
    expect(heard.flat()).not.toContain("missing");
  }, 120_000);

  it("answers busy, not missing, while it is still loading the file from its uploader", async () => {
    const o = await owner(9_000);
    const [node] = await hostNodes(o, ["n1"]);
    const [hash] = await post(o, 1);
    const { streams } = await member(o.network, node.name);
    const heard = await answers(streams, node.name, hash);
    expect(heard[0]).toBe("busy");
    expect(heard.at(-1)).toBe("done");
  }, 120_000);

  // Nodes ask each other for a file they don't have, each waiting on the other: that is no file on its way.
  it("answers missing for a file nobody online has, though its nodes ask each other", async () => {
    const o = await owner();
    const nodes = await hostNodes(o, ["n1", "n2"]);
    await until(() => o.network.linked("n1", "n2"), 10_000);
    const [hash] = await post(o, 1, 1_000, false);
    const { streams } = await member(o.network, nodes[0].name);
    const started = Date.now();
    expect(await answers(streams, nodes[0].name, hash, 3)).toEqual(["missing"]);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 120_000);
});

// Diagnosis 2026-11-10 (large files missing or incomplete on a node after the uploader closed the app soon, H4): a node
// pulls a new upload from its uploader after the post, one chunk at a time. "Uploaded" on the uploader only means its
// own copy is stored.
describe("a new upload whose uploader leaves", () => {
  const chunk = 4 * 1024 * 1024;
  const partOf = (dir: string, hash: string) => stat(join(dir, "parts", `${hash}.part`)).then((s) => s.size, () => 0);

  // The owner posts a file of 3 chunks and a bit as a chat attachment, sending each chunk 1.5 s after the last (a slow
  // uplink), and leaves once the node has some of it.
  async function cutMidFile() {
    const o = await owner(1_500);
    // Kept whole, as every file under 20 GB is in real use (this file lowers the split size to 1 MiB).
    await o.api.plugin("nodes").call("set-storage", { stripe_mb: 0, copies: 1, parity: 0 });
    const [node] = await hostNodes(o, ["n1"], [], 3_000);
    const bytes = randomBytes(3 * chunk + 123);
    const hash = await o.store(bytes);
    const { id } = await o.api.plugin("chat").call<{ id: number }>("post-message", { channel_id: 1, body: "big" });
    await o.api.plugin("chat").call("attach", { message_id: id, name: "big.bin", mime: "application/octet-stream", size: bytes.byteLength, url: `mwc:${hash}` });
    await o.ledger.flush();
    expect(await until(async () => (await partOf(node.dir, hash)) >= chunk, 60_000)).toBe(true);
    o.network.unlink("a", node.name);
    const sentBefore = o.network.count("a", node.name, "content-part");
    // The node's transfer stops once it stalled (3 s here) and keeps what arrived.
    await wait(5_000);
    return { o, node, hash, sentBefore, part: await partOf(node.dir, hash) };
  }

  it("leaves an incomplete part and no file on the node when the uploader goes mid-file", async () => {
    const { node, hash, part } = await cutMidFile();
    expect(await whole(node.dir, hash)).toBe(false);
    expect(part).toBeGreaterThan(0);
    expect(part % chunk).toBe(0);
  }, 120_000);

  it("finishes from that part once the uploader is back", async () => {
    const { o, node, hash, sentBefore, part } = await cutMidFile();
    o.network.link("a", node.name);
    expect(await until(() => whole(node.dir, hash), 60_000)).toBe(true);
    const bytes = await readFile(join(node.dir, "content", hash));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
    // Resumed: only the chunks after the part were sent again, not the whole file.
    const resent = o.network.count("a", node.name, "content-part") - sentBefore;
    expect(resent).toBe(Math.ceil((bytes.byteLength - part) / chunk));
  }, 120_000);

  // H5: every new commit put the node's keep pass off by 2 s, so while a batch was still being posted (a folder of
  // files, one commit each) the node fetched nothing, and less was on it when the uploader left (the first file came
  // 11.1 s after its post, 2 s after the last of ten posts 1 s apart, 2026-11-10).
  it("starts pulling the first file of a batch while the rest is still being posted", async () => {
    const o = await owner();
    await o.api.plugin("nodes").call("set-storage", { stripe_mb: 0, copies: 1, parity: 0 });
    const [node] = await hostNodes(o, ["n1"]);
    const hashes: string[] = [];
    let first = 0;
    let arrived = 0;
    const watch = setInterval(() => void (hashes[0] && !arrived && whole(node.dir, hashes[0]).then((has) => {
      if (has && !arrived) arrived = Date.now();
    })), 100);
    closers.push(() => clearInterval(watch));
    for (let i = 0; i < 10; i++) {
      const bytes = randomBytes(1_000);
      const hash = await o.store(bytes);
      const { id } = await o.api.plugin("chat").call<{ id: number }>("post-message", { channel_id: 1, body: `file ${i}` });
      await o.api.plugin("chat").call("attach", { message_id: id, name: `${i}.bin`, mime: "application/octet-stream", size: bytes.byteLength, url: `mwc:${hash}` });
      await o.ledger.flush();
      hashes.push(hash);
      first ||= Date.now();
      await wait(1_000);
    }
    expect(await until(() => arrived > 0, 30_000)).toBe(true);
    const afterFirstPost = arrived - first;
    console.log(`[diagnosis H5] first file on the node ${afterFirstPost} ms after it was posted (posts 1 s apart, 10 in all)`);
    expect(afterFirstPost).toBeLessThan(5_000);
  }, 120_000);
});

// The keep pass took whole files one at a time for all members together: while a node pulled one member's big file,
// another member's upload wasn't asked for until that one was complete (small images still came, through members
// asking the node for them; a big file nobody asks for waited). Now one lane per uploader.
describe("two members uploading at once", () => {
  const chunk = 4 * 1024 * 1024;
  const partOf = (dir: string, hash: string) => stat(join(dir, "parts", `${hash}.part`)).then((s) => s.size, () => 0);

  async function attach(who: { api: ApiClient; ledger: Ledger; store(data: Uint8Array): Promise<string> }, bytes: Uint8Array) {
    const hash = await who.store(bytes);
    const { id } = await who.api.plugin("chat").call<{ id: number }>("post-message", { channel_id: 1, body: "file" });
    await who.api.plugin("chat").call("attach", { message_id: id, name: "file.bin", mime: "application/octet-stream", size: bytes.byteLength, url: `mwc:${hash}` });
    await who.ledger.flush();
    return hash;
  }

  it("takes the second member's file while the first one's is still on its way", async () => {
    // The owner sends a chunk every 1.5 s: its file of 8 chunks takes about 12 s.
    const o = await owner(1_500);
    await o.api.plugin("nodes").call("set-storage", { stripe_mb: 0, copies: 1, parity: 0 });
    const [node] = await hostNodes(o, ["n1"]);
    const b = await uploader(o, "b");
    const big = await attach(o, randomBytes(8 * chunk + 123));
    expect(await until(async () => (await partOf(node.dir, big)) >= chunk, 60_000)).toBe(true);
    const other = await attach(b, randomBytes(300_000));
    expect(await until(() => whole(node.dir, other), 8_000)).toBe(true);
    expect(await whole(node.dir, big)).toBe(false);
    // And the first one still arrives whole.
    expect(await until(() => whole(node.dir, big), 60_000)).toBe(true);
    const bytes = await readFile(join(node.dir, "content", big));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(big);
  }, 120_000);

  // One member's files stay one after the other: asked for together they would take turns every 5 s (`sliceMs`), each
  // turn a stop and a new request.
  it("takes one member's files one after the other", async () => {
    const o = await owner(1_500);
    await o.api.plugin("nodes").call("set-storage", { stripe_mb: 0, copies: 1, parity: 0 });
    const [node] = await hostNodes(o, ["n1"]);
    const wantsBefore = o.network.count(node.name, "a", "content-want");
    const first = await attach(o, randomBytes(4 * chunk + 1));
    const second = await attach(o, randomBytes(4 * chunk + 2));
    expect(await until(async () => (await whole(node.dir, first)) && (await whole(node.dir, second)), 60_000)).toBe(true);
    expect(o.network.count(node.name, "a", "content-want") - wantsBefore).toBe(2);
  }, 120_000);
});

// "Delete locally" in a files channel only hides an entry (undo restores it): the node keeps the bytes until its hourly cleanup,
// and kept the files of a deleted folder for good, since only the folder's row is marked. "Delete from network"
// (`purge`) removes the rows, and the node lets the bytes go at its next pass.
describe("files deleted for good", () => {
  async function filesNode() {
    const o = await owner();
    await o.api.plugin("nodes").call("set-storage", { stripe_mb: 0, copies: 1, parity: 0 });
    const [node] = await hostNodes(o, ["n1"]);
    const files = o.api.plugin("files");
    const add = async (name: string, bytes: Uint8Array, parent: number | null = null) => {
      const hash = await o.store(bytes);
      const { id } = await files.call<{ id: number }>("add-file", { channel_id: 1, parent_id: parent, name, mime: "application/octet-stream", size: bytes.byteLength, url: `mwc:${hash}` });
      await o.ledger.flush();
      return { id, hash };
    };
    const call = async (action: string, id: number) => {
      await files.call(action, { entry_id: id });
      await o.ledger.flush();
    };
    return { o, node, files, add, call, has: (hash: string) => whole(node.dir, hash) };
  }

  it("lets a file's bytes go within seconds, but not a hidden file's, nor bytes another entry points at", async () => {
    const { node, add, call, has } = await filesNode();
    const goneBytes = randomBytes(50_000);
    const gone = await add("gone.bin", goneBytes);
    const hidden = await add("hidden.bin", randomBytes(50_000));
    const sharedBytes = randomBytes(50_000);
    const shared = await add("shared.bin", sharedBytes);
    const copy = await add("copy.bin", sharedBytes);
    expect(await until(async () => (await has(gone.hash)) && (await has(hidden.hash)) && (await has(shared.hash)), 30_000)).toBe(true);

    await call("purge", gone.id);
    await call("remove", hidden.id);
    await call("purge", shared.id);
    expect(await until(async () => !(await has(gone.hash)), 15_000)).toBe(true);
    expect(node.server.wanted().has(hidden.hash)).toBe(false);
    expect(await has(hidden.hash)).toBe(true);
    expect(copy.hash).toBe(shared.hash);
    expect(await has(shared.hash)).toBe(true);

    // The same bytes uploaded again are taken again.
    const again = await add("gone again.bin", goneBytes);
    expect(again.hash).toBe(gone.hash);
    expect(await until(() => has(gone.hash), 30_000)).toBe(true);
  }, 120_000);

  it("stops keeping the files of a hidden folder, and lets a folder deleted for good go with everything in it", async () => {
    const { o, node, files, add, call, has } = await filesNode();
    const folder = async (name: string, parent: number | null = null) => {
      const { id } = await files.call<{ id: number }>("add-folder", { channel_id: 1, parent_id: parent, name });
      await o.ledger.flush();
      return id;
    };
    const hiddenFolder = await folder("hidden");
    const inHidden = await add("a.bin", randomBytes(50_000), await folder("sub", hiddenFolder));
    const goneFolder = await folder("gone");
    const inGone = await add("b.bin", randomBytes(50_000), await folder("sub", goneFolder));
    const kept = await add("kept.bin", randomBytes(50_000));
    expect(await until(async () => (await has(inHidden.hash)) && (await has(inGone.hash)) && (await has(kept.hash)), 30_000)).toBe(true);

    await call("remove", hiddenFolder);
    await call("purge", goneFolder);
    expect(await until(async () => !(await has(inGone.hash)), 15_000)).toBe(true);
    // Hidden: no longer the node's to keep (its cleanup takes it), and back once the folder is restored.
    expect(await until(() => !node.server.wanted().has(inHidden.hash), 5_000)).toBe(true);
    expect(node.server.wanted().has(kept.hash)).toBe(true);
    expect(await has(kept.hash)).toBe(true);
    await call("restore", hiddenFolder);
    expect(await until(() => node.server.wanted().has(inHidden.hash), 5_000)).toBe(true);
  }, 120_000);
});

// Nodes tell each other what they hold (`node-have`), never members; a member asks about the files it shows or its own
// uploads on their way (`node-holds`, p2p/nodes.ts). Before, a member's "Show hosting" marked every node "missing".
describe("members asking a node what it holds", () => {
  it("answers which of the files asked about it holds, and the member's hosting view follows", async () => {
    const o = await owner();
    await o.api.plugin("nodes").call("set-storage", { stripe_mb: 0, copies: 1, parity: 0 });
    const link = new NodeLink(o.workspaceId, o.ledger, o.sync);
    closers.push(() => link.close());
    const [node] = await hostNodes(o, ["n1"]);
    const held = await o.store(randomBytes(1_000));
    const nowhere = createHash("sha256").update(randomBytes(1_000)).digest("hex");
    const { id } = await o.api.plugin("chat").call<{ id: number }>("post-message", { channel_id: 1, body: "two" });
    for (const [i, hash] of [held, nowhere].entries())
      await o.api.plugin("chat").call("attach", { message_id: id, name: `${i}.bin`, mime: "application/octet-stream", size: 1_000, url: `mwc:${hash}` });
    await o.ledger.flush();
    expect(await until(() => whole(node.dir, held), 30_000)).toBe(true);
    expect(await until(() => link.onlineNodes().size > 0, 30_000)).toBe(true);

    const status = (hash: string) => link.contentHosting(hash, 1_000)?.nodes[0]?.status;
    // Nothing said yet: unknown, not missing.
    expect(status(nowhere)).toBe("unknown");
    expect([...(await link.askHoldings([held, nowhere]))]).toEqual([held]);
    expect(status(held)).toBe("holds");
    expect(status(nowhere)).toBe("missing");
  }, 120_000);
});

describe("nodes and signed history snapshots", () => {
  // The snapshot's state was read through the app's content store, IndexedDB on a node: every batch with the snapshot
  // commit failed ("Commits not applied: indexedDB is not defined"), and the node never caught up.
  it("bootstrap from a snapshot fetched into their own store, and read it again after a restart", async () => {
    const network = new Network();
    const owner = await createIdentity(false);
    const signer = { author: owner.id, key: { x: owner.publicKey.x!, y: owner.publicKey.y! }, privateKey: owner.privateKey, replica: crypto.randomUUID() };
    const { workspaceId, genesis } = await Ledger.createGenesis(signer);
    const ledger = new Ledger(workspaceId, signer, workspacePolicy, memoryCommits());
    const backend = createLedgerBackend(ledger, localPlugins);
    for (const plugin of plugins) backend.load(plugin);
    await ledger.load();
    await ledger.adopt(genesis);
    const api = new ApiClient(new MockTransport(backend));
    await api.plugin("chat").call("post-message", { channel_id: 1, body: "before the snapshot" });
    await ledger.flush();

    // The owner's snapshot: the state as a file in the owner's store and a signed commit pointing at it. The history
    // before the cutoff is compacted away, so the node can only start from the snapshot.
    const state = await ledger.snapshotState();
    const ownerStore = fileContent(await scratch());
    const json = new TextEncoder().encode(JSON.stringify(state));
    const hash = createHash("sha256").update(json).digest("hex");
    const writer = await ownerStore.openWriter(hash);
    await writer.append(json as Uint8Array<ArrayBuffer>);
    await writer.finish(hash);
    const anchor = ledger.log().at(-1)!.commit;
    const ref: SnapshotRef = {
      version: 1, index: state.index, hash: state.hash, genesisHash: state.genesisHash,
      order: { clock: anchor.clock, author: anchor.author, replica: anchor.replica, seq: anchor.seq },
      vector: ledger.vector(), content: `mwc:${hash}`, archiveContent: `mwc:${"b".repeat(64)}`,
    };
    const snapshot = await signCommit({
      server: workspaceId, author: signer.author, key: signer.key, replica: crypto.randomUUID(), seq: 0,
      clock: anchor.clock + 1, time: Date.now(), action: "workspace.snapshot",
      ops: [{
        ext: "members", table: "members_snapshots", kind: "insert", id: newRowId(),
        values: {
          cutoff_index: ref.index, cutoff_hash: ref.hash, genesis_hash: ref.genesisHash, vector: JSON.stringify(ref.vector),
          content: ref.content, archive_content: ref.archiveContent ?? null,
          created_by: userNumberOf(signer.author), created_at: new Date().toISOString(),
        },
      }],
      snapshot: ref,
    }, signer.privateKey);
    await ledger.accept([snapshot], async () => state);
    expect(await ledger.compactSnapshot()).toBeGreaterThan(0);

    const sync = new WorkspaceSync(ledger, workspaceId, "secret", {
      self: "a", tabs: false, fallbackAfterMs: 60_000, joinRoom: (roomId, passive) => network.join("a", nameOf(roomId), passive) as unknown as Room,
    });
    sync.setNodes({ known: () => true, isNode: (p) => p.startsWith("n") });
    const streams = new ContentStreams(sync.room!, ownerStore);
    closers.push(() => streams.close(), () => sync.close());

    const identity = await createIdentity(false);
    const dir = await scratch();
    const commits = memoryCommits();
    const entry = { id: workspaceId, secret: "secret", replica: crypto.randomUUID() };
    const open = async (name: string) => {
      const server = await HostedServer.open(entry, {
        identity: { id: identity.id, key: { x: identity.publicKey.x!, y: identity.publicKey.y! }, privateKey: identity.privateKey },
        commits, content: fileContent(dir), senders: 8, healAfterMs: 60_000, self: name,
        joinRoom: (roomId, passive) => network.join(name, nameOf(roomId), passive) as unknown as Room,
      }, () => ({ address: "", url: "", place: null }));
      closers.push(() => server.close().catch(() => {}));
      return server;
    };
    const bodies = (server: HostedServer) => server.ledger.select("chat", "chat_messages", {}).map((row) => row.body);

    const node = await open("n1");
    expect(await until(() => bodies(node).includes("before the snapshot"), 30_000)).toBe(true);
    expect(await whole(dir, hash)).toBe(true);
    // Kept through cache pruning: the node's log starts at the snapshot.
    expect(node.held().has(hash)).toBe(true);
    await api.plugin("chat").call("post-message", { channel_id: 1, body: "after the snapshot" });
    expect(await until(() => bodies(node).includes("after the snapshot"), 30_000)).toBe(true);

    await node.close();
    const again = await open("n2");
    expect(bodies(again).sort()).toEqual(["after the snapshot", "before the snapshot"]);
  }, 120_000);
});
