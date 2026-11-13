import { afterEach, describe, expect, it, vi } from "vitest";
import type { Room } from "trystero";
import { Mesh, type StreamMeta } from "../../src/p2p/mesh";
import { RoomGroup } from "../../src/p2p/roomGroup";
import { Network, fakeStream, roomKey } from "./fakeNetwork";

// `hub`: relay at once (members of a hub never connect directly); `shareRoutes`: a node of a node group.
function node(network: Network, id: string, shareRoutes = false, hub = false) {
  const turnWanted = vi.fn();
  const mesh = new Mesh(network.room(id) as unknown as Room, id, turnWanted, { deltaAfterMs: 0, shareRoutes, ...(hub && { relayAfter: () => 0 }) });
  const got: { data: unknown; from: string }[] = [];
  const send = mesh.channel<{ text: string }>("chat", (data, from) => got.push({ data, from }));
  const streams: { stream: string; from: string; meta: StreamMeta }[] = [];
  mesh.onStream((stream, from, meta) => streams.push({ stream: stream.id, from, meta }));
  const joined: string[] = [];
  mesh.onPeers((peer) => joined.push(peer), () => {});
  return { mesh, send, got, streams, joined, turnWanted };
}

function setup() {
  const network = new Network();
  return { network, a: node(network, "a"), b: node(network, "b"), c: node(network, "c") };
}

describe("mesh", () => {
  let meshes: Mesh[] = [];
  afterEach(() => {
    meshes.forEach((m) => m.close());
    meshes = [];
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Two members in the member room join a call: their media goes over the member-room connection, the first they share.
  // When that room is left (a node became reachable) or its connection closes, they still reach each other through the
  // call room, and the media has to move there: it stayed on the closed connection and the call went silent.
  it.each([
    ["this member leaves the member room", (_network: Network, ga: RoomGroup) => ga.remove("members")],
    ["the other side closes the member-room connection", (n: Network) => n.unlink("a", "b", "members")],
  ])("moves its streams to the call room's connection when %s", async (_label, close) => {
    const network = new Network();
    const group = (id: string) => {
      const g = new RoomGroup();
      g.add("members", network.room(id, "members") as unknown as Room);
      g.add("call", network.room(id, "call") as unknown as Room);
      return g;
    };
    const ga = group("a");
    const gb = group("b");
    const a = new Mesh(ga as never, "a", () => {}, { deltaAfterMs: 0 });
    const b = new Mesh(gb as never, "b", () => {}, { deltaAfterMs: 0 });
    meshes = [a, b];
    const got: string[] = [];
    b.onStream((stream) => got.push(stream.id));
    network.link("a", "b", "members");
    network.link("a", "b", "call");
    a.addStream(fakeStream("mic"), "b", { kind: "mic" });
    expect(got).toEqual(["mic"]);
    expect(network.rooms.get(roomKey("members", "a"))!.streams.get("b")?.has("mic")).toBe(true);
    await close(network, ga);
    expect(network.rooms.get(roomKey("call", "a"))!.streams.get("b")?.has("mic")).toBe(true);
    expect(got).toEqual(["mic", "mic"]);
  });

  // A member back from a dropped connection: both sides already want to send to each other (each knew the other was in
  // the call through a go-between), so each places its mic the moment it has checked the other's proof. The faster
  // side's came before the other side had checked its proof, and the call stayed "Connecting…" for good.
  it("gets the mic of a member who checked this one's proof first", () => {
    const network = new Network();
    const group = (id: string) => {
      const g = new RoomGroup();
      g.requirePeerAuthentication("member");
      g.add("call", network.room(id, "call") as unknown as Room);
      return g;
    };
    const ga = group("a");
    const gb = group("b");
    const a = new Mesh(ga as never, "a", () => {}, { deltaAfterMs: 0 });
    const b = new Mesh(gb as never, "b", () => {}, { deltaAfterMs: 0 });
    meshes = [a, b];
    const got: string[] = [];
    b.onStream((stream, from) => got.push(`${from}:${stream.id}`));
    a.addStream(fakeStream("mic", [{ readyState: "live" }]), "b", { kind: "mic" });
    network.link("a", "b", "call");
    ga.authorizePeer("b", "member");
    expect(got).toEqual([]);
    gb.authorizePeer("a", "member");
    expect(got).toEqual(["a:mic"]);
  });

  it("lets only a few messages wait on a connection whose buffer is full, and sends all of them once it drains", async () => {
    const { network, a, b } = setup();
    meshes = [a.mesh, b.mesh];
    network.link("a", "b");
    // mesh-test s9: in werift (bots, nodes) each send waiting for a full buffer adds listeners to the data channel, and
    // a burst of small messages to one busy member passed 100 of them (MaxListenersExceededWarning).
    network.fill("a", "b");
    for (let i = 0; i < 300; i++) a.send({ text: `m${i}` }, "b");
    a.send({ text: "to everyone" });
    expect(network.waiting("a", "b")).toBeLessThanOrEqual(16);
    network.drain("a", "b");
    const texts = () => b.got.filter((g) => g.from === "a").map((g) => (g.data as { text: string }).text);
    await vi.waitFor(() => expect(texts()).toHaveLength(301));
    // Every one arrives. Not strictly in order, as with Trystero: a send starting just as the buffer drained can pass
    // ones still waking from the wait.
    expect(texts().sort()).toEqual([...Array.from({ length: 300 }, (_, i) => `m${i}`), "to everyone"].sort());
  });

  it("reaches a member through another one when a direct connection fails", () => {
    const { network, a, b, c } = setup();
    meshes = [a.mesh, b.mesh, c.mesh];
    network.link("a", "b");
    network.link("b", "c");
    expect(a.mesh.peers()).toEqual(["b"]);

    c.mesh.noteFailure("a");
    a.mesh.noteFailure("c");
    expect(a.mesh.relayOf("c")).toBe("b");
    expect(c.mesh.relayOf("a")).toBe("b");
    expect(a.joined).toContain("c");

    a.send({ text: "hi" }, "c");
    expect(c.got).toEqual([{ data: { text: "hi" }, from: "a" }]);
    a.send({ text: "all" });
    expect(c.got.at(-1)).toEqual({ data: { text: "all" }, from: "a" });
    expect(b.got.at(-1)).toEqual({ data: { text: "all" }, from: "a" });
  });

  // Media never goes through a member (ADR 0019): a go-between decodes and encodes again every copy it passes on, and
  // took over the load of every link that dropped, so one screen share froze or dropped members. A member reached only
  // through another gets nothing until their own link comes, and then exactly one copy, straight from the sender.
  it("never puts a stream on a go-between, and sends it once a direct link comes", () => {
    const { network, a, b, c } = setup();
    meshes = [a.mesh, b.mesh, c.mesh];
    network.link("a", "b");
    network.link("b", "c");
    c.mesh.noteFailure("a");
    a.mesh.noteFailure("c");
    expect(a.mesh.relayOf("c")).toBe("b");

    const screen = fakeStream("screen-a");
    a.mesh.addStream(screen, "c", { kind: "screen" });
    expect(c.streams).toEqual([]);
    expect(b.streams).toEqual([]);
    expect(network.rooms.get("a")!.streams.get("b")?.size ?? 0).toBe(0);
    expect(network.count("a", "b", "relay-media")).toBe(0);

    network.link("a", "c");
    expect(c.streams).toEqual([{ stream: "screen-a", from: "a", meta: { kind: "screen" } }]);
    expect([...network.rooms.get("a")!.streams.get("c")!]).toEqual(["screen-a"]);
    // Still one copy: nothing went on the connection to the go-between on the way.
    expect(network.rooms.get("a")!.streams.get("b")?.size ?? 0).toBe(0);
  });

  // An older app still asks its go-between to pass its media on: nothing is passed on.
  it("passes nothing on when an older app asks it to", () => {
    const { network, a, b, c } = setup();
    meshes = [a.mesh, b.mesh, c.mesh];
    network.link("a", "b");
    network.link("b", "c");
    a.mesh.addStream(fakeStream("mic-a"), "b", { kind: "mic" });
    network.rooms.get("a")!.makeAction("relay-media").send({ sid: "mic-a", to: "c", on: true }, { target: "b" });
    expect(c.streams).toEqual([]);
    expect(network.rooms.get("b")!.streams.get("c")?.size ?? 0).toBe(0);
  });

  // An older app's go-between may still pass a stream on: it already came, at the go-between's cost, so it is taken as
  // its sender's (dropped, the member would only hear nothing). This app never asks for that, nor does it.
  it("takes a stream an older app's go-between passed on as its sender's", () => {
    const { network, b, c } = setup();
    meshes = [b.mesh, c.mesh];
    network.link("b", "c");
    network.rooms.get("b")!.addStream(fakeStream("mic-a"), { target: "c", metadata: { kind: "mic", sid: "mic-a", from: "a" } });
    expect(c.streams).toEqual([{ stream: "mic-a", from: "a", meta: { kind: "mic" } }]);
  });

  // A receiver gets each stream over one connection, the one of the room it joined first, and still one after the
  // stream moved to another room's connection.
  it("puts each stream on one connection to its receiver, also after it moves", async () => {
    const network = new Network();
    const group = (id: string) => {
      const g = new RoomGroup();
      g.add("members", network.room(id, "members") as unknown as Room);
      g.add("call", network.room(id, "call") as unknown as Room);
      return g;
    };
    const ga = group("a");
    group("b");
    const a = new Mesh(ga as never, "a", () => {}, { deltaAfterMs: 0 });
    meshes = [a];
    network.link("a", "b", "members");
    network.link("a", "b", "call");
    // Connections still open that carry the stream (a closed one carries nothing).
    const carrying = () => ["members", "call"].filter((room) =>
      network.linked("a", "b", room) && network.rooms.get(roomKey(room, "a"))!.streams.get("b")?.has("screen"));
    a.addStream(fakeStream("screen"), "b", { kind: "screen" });
    expect(carrying()).toEqual(["members"]);
    await ga.remove("members");
    expect(carrying()).toEqual(["call"]);
  });

  it("puts a stream on its connection again when the peer asks", async () => {
    vi.useFakeTimers();
    const { network, a, b } = setup();
    meshes = [a.mesh, b.mesh];
    network.link("a", "b");
    const mic = fakeStream("mic-a");
    a.mesh.addStream(mic, "b", { kind: "mic" });
    const before = b.streams.length;
    a.mesh.resend(mic, "b");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(b.streams).toHaveLength(before + 1);
    expect([...network.rooms.get("a")!.streams.get("b")!]).toEqual(["mic-a"]);
  });

  it("coalesces repair requests while metadata and negotiation are pending, and cancels them on removal", async () => {
    vi.useFakeTimers();
    const { network, a, b } = setup();
    meshes = [a.mesh, b.mesh];
    network.link("a", "b");
    const room = network.rooms.get("a")!;
    const pc = room.getPeers().b;
    Object.assign(pc, { signalingState: "have-local-offer", connectionState: "connected" });
    const mic = fakeStream("mic");
    a.mesh.addStream(mic, "b", { kind: "mic" });
    const remove = vi.spyOn(room, "removeStream");
    a.mesh.resend(mic, "b");
    a.mesh.resend(mic, "b");
    await vi.advanceTimersByTimeAsync(12_000);
    expect(remove).not.toHaveBeenCalled();
    Object.assign(pc, { signalingState: "stable" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(remove).toHaveBeenCalledTimes(1);
    a.mesh.resend(mic, "b");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(remove).toHaveBeenCalledTimes(1);
    a.mesh.removeStream(mic, "b");
    a.mesh.addStream(mic, "b", { kind: "mic" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(remove).toHaveBeenCalledTimes(2); // only the explicit removal; the old repair cannot touch the new placement
    expect(room.streams.get("b")?.has("mic")).toBe(true);
  });

  it("retries a rejected attachment without announcing success or retrying a stream no longer wanted", async () => {
    vi.useFakeTimers();
    const { network, a, b } = setup();
    meshes = [a.mesh, b.mesh];
    network.link("a", "b");
    const room = network.rooms.get("a")!;
    const add = vi.spyOn(room, "addStream").mockImplementationOnce(() => [Promise.reject(new Error("metadata lost"))]);
    const placed = vi.fn();
    a.mesh.onPlaced(placed);
    const mic = fakeStream("mic");
    a.mesh.addStream(mic, "b", { kind: "mic" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(placed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(add).toHaveBeenCalledTimes(2);
    expect(placed).toHaveBeenCalledTimes(1);
    expect(b.streams).toHaveLength(1);
    add.mockImplementationOnce(() => [Promise.reject(new Error("metadata lost again"))]);
    const camera = fakeStream("camera");
    a.mesh.addStream(camera, "b", { kind: "camera" });
    await vi.advanceTimersByTimeAsync(1_000);
    a.mesh.removeStream(camera, "b");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(add).toHaveBeenCalledTimes(3);
  });

  it("cleans up an attachment that completes after the member leaves the call", async () => {
    vi.useFakeTimers();
    const { network, a, b } = setup();
    meshes = [a.mesh, b.mesh];
    network.link("a", "b");
    const room = network.rooms.get("a")!;
    const add = room.addStream.bind(room);
    let finish = () => {};
    vi.spyOn(room, "addStream").mockImplementationOnce((stream, options) => [new Promise<void>((resolve) => {
      finish = () => { add(stream, options); resolve(); };
    })]);
    const placed = vi.fn();
    a.mesh.onPlaced(placed);
    const mic = fakeStream("mic");
    a.mesh.addStream(mic, "b", { kind: "mic" });
    a.mesh.removeStream(mic, "b");
    finish();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(placed).not.toHaveBeenCalled();
    expect(room.streams.get("b")?.size).toBe(0);
  });

  it("can remove and re-add the same stream while its original attachment is still pending", async () => {
    vi.useFakeTimers();
    const { network, a, b } = setup();
    meshes = [a.mesh, b.mesh];
    network.link("a", "b");
    const room = network.rooms.get("a")!;
    const original = room.addStream.bind(room);
    let finish = () => {};
    const add = vi.spyOn(room, "addStream").mockImplementation((stream, options) => {
      // RTCPeerConnection.addTrack rejects duplicate attachments of the same track.
      if (room.streams.get(options.target)?.has(stream.id)) return [Promise.reject(new Error("track already attached"))];
      return original(stream, options);
    });
    add.mockImplementationOnce((stream, options) => [new Promise<void>((resolve) => {
      finish = () => { original(stream, options); resolve(); };
    })]);
    const placed = vi.fn();
    a.mesh.onPlaced(placed);
    const mic = fakeStream("mic");
    a.mesh.addStream(mic, "b", { kind: "mic" });
    a.mesh.removeStream(mic, "b");
    a.mesh.addStream(mic, "b", { kind: "mic" });
    finish();
    await vi.advanceTimersByTimeAsync(1);
    expect(placed).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(2);
    expect(room.streams.get("b")?.has("mic")).toBe(true);
  });

  // A node batches the news of a new member for a second (`deltaAfterMs`), and a message relayed from that member got
  // there first and was dropped: a new member's presence never showed until the next 20 s refresh (mesh-test s13). It
  // waits for the go-between to name its sender; one claiming a sender the go-between never names is still dropped.
  it("holds a relayed message until the go-between says it reaches the sender", () => {
    vi.useFakeTimers();
    const network = new Network();
    const peer = (id: string) => {
      const mesh = new Mesh(network.room(id) as unknown as Room, id, () => {}, { deltaAfterMs: 1_000, relayAfter: () => 0 });
      meshes.push(mesh);
      const got: { data: unknown; from: string }[] = [];
      const send = mesh.channel<{ text: string }>("chat", (data, from) => got.push({ data, from }));
      return { mesh, send, got };
    };
    const b = peer("b");
    peer("n");
    const c = peer("c");
    network.link("b", "n");
    vi.advanceTimersByTime(1_000);
    network.link("c", "n");
    // C got the node's whole list on connecting; B hears of C only with the node's next batch.
    expect(c.mesh.relayOf("b")).toBe("n");
    expect(b.mesh.relayOf("c")).toBeUndefined();
    c.send({ text: "hi" }, "b");
    expect(b.got).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(b.got).toEqual([{ data: { text: "hi" }, from: "c" }]);

    network.rooms.get("n")!.actions.get("relay-in")!.send({ from: "x", ch: "chat", data: { text: "not from x" } }, { target: "b" });
    vi.advanceTimersByTime(30_000);
    expect(b.got).toEqual([{ data: { text: "hi" }, from: "c" }]);
  });

  // A member leaving the member room for the hub (a node came) drops its direct connections, but a node still reaches
  // the others. They waited for a direct connection first (`relayAfter`, then the 5 s check) and counted it gone
  // meanwhile, so it vanished from their call's list for seconds (mesh-test s13).
  it("relays a member at once when its direct connection closes and another member still reaches it", () => {
    vi.useFakeTimers();
    const { network, a, b, c } = setup();
    meshes = [a.mesh, b.mesh, c.mesh];
    const left: string[] = [];
    a.mesh.onPeers(() => {}, (peer) => left.push(peer));
    network.link("a", "b");
    network.link("a", "c");
    network.link("b", "c");
    network.unlink("a", "b");
    expect(a.mesh.relayOf("b")).toBe("c");
    expect(left).toEqual([]);
    a.send({ text: "still there" }, "b");
    expect(b.got.at(-1)).toEqual({ data: { text: "still there" }, from: "a" });
  });

  // Its app quit or reloaded: relayed through the member that still named it, it looked like a connection lost for a
  // moment, and the call waited for it to come back.
  it("counts a member that said bye as gone at once, though another member still names it", () => {
    vi.useFakeTimers();
    const { network, a, b, c } = setup();
    meshes = [a.mesh, b.mesh, c.mesh];
    const left: string[] = [];
    a.mesh.onPeers(() => {}, (peer) => left.push(peer));
    network.link("a", "b");
    network.link("a", "c");
    network.link("b", "c");
    void b.mesh.bye();
    expect(left).toEqual(["b"]);
    expect(a.mesh.hasQuit("b")).toBe(true);
    expect(a.mesh.peers()).toEqual(["c"]);
    network.unlink("a", "b");
    expect(a.mesh.relayOf("b")).toBeUndefined();
    vi.advanceTimersByTime(10_000);
    expect(left).toEqual(["b"]);
  });

  // In the hub, members reach each other through the node only: the node names the leaver in its delta, so a member
  // whose relayed bye was lost (or an older app's node passing it on) still hears it.
  it("tells the members it relays that one of its direct peers said bye", () => {
    const network = new Network();
    const hub = (id: string) => {
      const mesh = new Mesh(network.room(id) as unknown as Room, id, () => {}, { deltaAfterMs: 0, relayAfter: () => 0 });
      meshes.push(mesh);
      return mesh;
    };
    hub("m1");
    hub("n");
    const m2 = hub("m2");
    const left: { peer: string; quit: boolean }[] = [];
    m2.onPeers(() => {}, (peer) => left.push({ peer, quit: m2.hasQuit(peer) }));
    network.link("m1", "n");
    network.link("m2", "n");
    expect(m2.relayOf("m1")).toBe("n");
    // Only the direct bye to the node.
    network.rooms.get("m1")!.actions.get("bye")!.send(true, { target: "n" });
    expect(left).toEqual([{ peer: "m1", quit: true }]);
  });

  // The node names the leaver in one delta to everyone; the relayed byes the leaver sends after (for older nodes) stop
  // there: passing them on cost the node two messages per member it relays on every reload.
  it("says bye to the go-between first and drops the relayed byes it already named in its delta", () => {
    const network = new Network();
    const hub = (id: string) => {
      const mesh = new Mesh(network.room(id) as unknown as Room, id, () => {}, { deltaAfterMs: 0, relayAfter: () => 0 });
      meshes.push(mesh);
      return mesh;
    };
    const m1 = hub("m1");
    hub("n");
    const m2 = hub("m2");
    network.link("m1", "n");
    network.link("m2", "n");
    const relayedBefore = network.count("n", "m2", "relay-in");
    void m1.bye();
    expect(m2.hasQuit("m1")).toBe(true);
    expect(network.count("m1", "n", "bye")).toBe(1);
    expect(network.count("m1", "n", "relay-out")).toBe(1);
    expect(network.count("n", "m2", "relay-in")).toBe(relayedBefore);
  });

  // An older node knows no bye and doesn't name the leaver: the relayed bye it passes on still tells the member.
  it("takes a relayed bye from a go-between that names the leaver", () => {
    const network = new Network();
    const hub = (id: string) => {
      const mesh = new Mesh(network.room(id) as unknown as Room, id, () => {}, { deltaAfterMs: 0, relayAfter: () => 0 });
      meshes.push(mesh);
      return mesh;
    };
    hub("m1");
    hub("n");
    const m2 = hub("m2");
    const quit: string[] = [];
    m2.onQuit((peer) => quit.push(peer));
    network.link("m1", "n");
    network.link("m2", "n");
    network.rooms.get("m1")!.actions.get("relay-out")!.send({ to: "m2", ch: "bye", data: true }, { target: "n" });
    expect(m2.hasQuit("m1")).toBe(true);
    expect(quit).toEqual(["m1"]);
  });

  // A go-between can't hide a member reached directly: only the member itself says bye over its own link.
  it("ignores a bye passed on, or named in a delta, for a member it reaches directly", () => {
    const { network, a, b, c } = setup();
    meshes = [a.mesh, b.mesh, c.mesh];
    network.link("a", "b");
    network.link("a", "c");
    network.link("b", "c");
    network.rooms.get("c")!.actions.get("relay-in")!.send({ from: "b", ch: "bye", data: true }, { target: "a" });
    network.rooms.get("c")!.actions.get("mesh-delta")!.send({ remove: ["b"], quit: ["b"] }, { target: "a" });
    expect(a.mesh.hasQuit("b")).toBe(false);
    expect(a.mesh.peers().sort()).toEqual(["b", "c"]);
  });

  // Only the leaver's own direct peer names it: one that said it reached it, and removes it in the same delta. Any
  // other member hid a member reached through a node for 10 minutes.
  it("ignores a delta naming as gone a member its sender doesn't reach or doesn't remove", () => {
    const network = new Network();
    const hub = (id: string) => {
      const mesh = new Mesh(network.room(id) as unknown as Room, id, () => {}, { deltaAfterMs: 0, relayAfter: () => 0 });
      meshes.push(mesh);
      return mesh;
    };
    const a = hub("a");
    hub("n");
    hub("x");
    hub("d");
    network.link("a", "n");
    network.link("x", "n");
    network.link("a", "d");
    expect(a.relayOf("x")).toBe("n");
    const delta = (from: string, change: unknown) => network.rooms.get(from)!.actions.get("mesh-delta")!.send(change, { target: "a" });
    delta("d", { remove: ["x"], quit: ["x"] });
    delta("n", { quit: ["x"] });
    expect(a.hasQuit("x")).toBe(false);
    expect(a.relayOf("x")).toBe("n");
    delta("n", { remove: ["x"], quit: ["x"] });
    expect(a.hasQuit("x")).toBe(true);
  });

  // A feature knows better (voice.ts: the member's restarted app named its old connection): every feature drops it.
  it("counts a peer a feature found gone as if it had said bye", () => {
    const { network, a, b } = setup();
    meshes = [a.mesh, b.mesh];
    const left: string[] = [];
    const quit: string[] = [];
    a.mesh.onPeers(() => {}, (peer) => left.push(peer));
    a.mesh.onQuit((peer) => quit.push(peer));
    network.link("a", "b");
    a.mesh.gone("b");
    a.mesh.gone("b");
    expect(left).toEqual(["b"]);
    expect(quit).toEqual(["b"]);
    expect(a.mesh.peers()).toEqual([]);
  });

  it("takes a member that said bye back when it connects again under the same id", () => {
    const { network, a, b } = setup();
    meshes = [a.mesh, b.mesh];
    network.link("a", "b");
    void b.mesh.bye();
    network.unlink("a", "b");
    expect(a.mesh.hasQuit("b")).toBe(true);
    network.link("a", "b");
    expect(a.mesh.hasQuit("b")).toBe(false);
    expect(a.mesh.peers()).toEqual(["b"]);
  });

  it("relays a member only heard of after a few seconds, without a failure", () => {
    vi.useFakeTimers();
    const { network, a, b, c } = setup();
    meshes = [a.mesh, b.mesh, c.mesh];
    network.link("a", "b");
    network.link("b", "c");
    expect(a.mesh.relayOf("c")).toBeUndefined();
    // The 5 s check picks it up once 3 s have passed; a direct connection usually forms sooner.
    vi.advanceTimersByTime(5_000);
    expect(a.mesh.relayOf("c")).toBe("b");
  });

  it("knows whom each direct peer reaches", () => {
    const { network, a, b, c } = setup();
    meshes = [a.mesh, b.mesh, c.mesh];
    network.link("a", "b");
    network.link("b", "c");
    expect([...a.mesh.neighborsOf("b")].sort()).toEqual(["a", "c"]);
    expect([...a.mesh.neighborsOf("c")]).toEqual([]);
    network.unlink("b", "c");
    expect([...a.mesh.neighborsOf("b")]).toEqual(["a"]);
  });

  // Media needs the direct link (nobody passes it on), so a failed attempt wants TURN for the next one even while a
  // go-between still passes the member's messages.
  it("wants TURN when a direct attempt failed, even with a go-between to the member", () => {
    const { network, a, b, c } = setup();
    meshes = [a.mesh, b.mesh, c.mesh];
    a.mesh.noteFailure("b");
    expect(a.mesh.needsTurn).toBe(true);
    expect(a.turnWanted).toHaveBeenCalledOnce();

    network.link("a", "b");
    expect(a.mesh.needsTurn).toBe(false);
    network.link("b", "c");
    a.mesh.noteFailure("c");
    expect(a.mesh.relayOf("c")).toBe("b");
    expect(a.mesh.needsTurn).toBe(true);
    expect(a.turnWanted).toHaveBeenCalledTimes(2);
    network.link("a", "c");
    expect(a.mesh.needsTurn).toBe(false);
  });

  it("reaches a member two hops away through two nodes (node groups)", () => {
    const network = new Network();
    const a = node(network, "a", false, true);
    const x = node(network, "x", true, true);
    const y = node(network, "y", true, true);
    const b = node(network, "b", false, true);
    meshes = [a.mesh, x.mesh, y.mesh, b.mesh];
    network.link("a", "x");
    network.link("x", "y");
    network.link("y", "b");
    expect(a.mesh.peers().sort()).toEqual(["b", "x", "y"]);
    expect(b.mesh.peers().sort()).toEqual(["a", "x", "y"]);
    expect(a.mesh.relayOf("b")).toBe("x");
    a.send({ text: "far" }, "b");
    expect(b.got).toEqual([{ data: { text: "far" }, from: "a" }]);
    b.send({ text: "back" }, "a");
    expect(a.got).toEqual([{ data: { text: "back" }, from: "b" }]);
    // Y only passes on what X sent for b when Y reaches b itself; never a third hop.
    network.unlink("y", "b");
    expect(a.mesh.peers().sort()).toEqual(["x", "y"]);
  });

  // Nodes that all reach a member through one of them told each other of it, and when it left they each kept it
  // through the other (far lists repeated what they had heard): a ghost that never went away.
  it("forgets a member who left when the nodes that relayed it are connected to each other", () => {
    const network = new Network();
    const x = node(network, "x", true, true);
    const y = node(network, "y", true, true);
    const z = node(network, "z", true, true);
    const a = node(network, "a", false, true);
    const b = node(network, "b", false, true);
    meshes = [x.mesh, y.mesh, z.mesh, a.mesh, b.mesh];
    network.link("x", "y");
    network.link("x", "z");
    network.link("y", "z");
    network.link("x", "b");
    network.link("y", "a");
    expect(y.mesh.relayOf("b")).toBe("x");
    expect(a.mesh.peers()).toContain("b");
    network.unlink("x", "b");
    for (const m of [x, y, z, a]) expect(m.mesh.peers()).not.toContain("b");
  });

  // A route has at most three go-betweens (two between node groups, one more for a failed link between nodes).
  it("reaches a member through three go-betweens, not four", () => {
    const chain = (ids: string[]) => {
      const network = new Network();
      const [first, ...rest] = ids;
      const ends = [first, rest.at(-1)!];
      const all = ids.map((id) => node(network, id, !ends.includes(id), true));
      meshes.push(...all.map((m) => m.mesh));
      for (let i = 1; i < ids.length; i++) network.link(ids[i - 1], ids[i]);
      return all;
    };
    const three = chain(["a", "x", "y", "z", "b"]);
    expect(three[0].mesh.relayOf("b")).toBe("x");
    three[0].send({ text: "far" }, "b");
    expect(three.at(-1)!.got).toEqual([{ data: { text: "far" }, from: "a" }]);
    three.at(-1)!.send({ text: "back" }, "a");
    expect(three[0].got).toEqual([{ data: { text: "back" }, from: "b" }]);

    const four = chain(["a", "w", "x", "y", "z", "b"]);
    expect(four[0].mesh.peers()).toContain("z");
    expect(four[0].mesh.peers()).not.toContain("b");
  });

  // Route lists that a direct peer sends, as its own Mesh would (they skip what the test doesn't set up).
  const tell = (network: Network, from: string, to: string, list: unknown) =>
    network.rooms.get(from)!.actions.get("routes")!.send(list, { target: to });

  it("drops a route that names this one or a peer twice", () => {
    const network = new Network();
    const x = node(network, "x", false, true);
    const y = node(network, "y", false, true);
    meshes = [x.mesh, y.mesh];
    network.link("x", "y");
    tell(network, "y", "x", { n: 1, routes: [["p", "x"], ["q", "z", "z"], ["r", "z"]] });
    expect(x.mesh.peers().sort()).toEqual(["r", "y"]);
    expect(x.mesh.relayOf("r")).toBe("y");
  });

  it("replaces each direct peer's routes with its last route list", () => {
    const network = new Network();
    const a = node(network, "a", false, true);
    const x = node(network, "x", false, true);
    const y = node(network, "y", false, true);
    meshes = [a.mesh, x.mesh, y.mesh];
    network.link("a", "x");
    network.link("a", "y");
    tell(network, "x", "a", { n: 1, routes: [["b", "m"]] });
    tell(network, "y", "a", { n: 1, routes: [["b", "k"]] });
    expect(a.mesh.relayOf("b")).toBe("x");
    // An empty list takes back what that peer said; the other's route stays.
    tell(network, "x", "a", { n: 2, routes: [] });
    expect(a.mesh.relayOf("b")).toBe("y");
    // "Nothing changed" since a list that never came here: nothing from that peer is kept, the whole list is asked for.
    tell(network, "y", "a", { n: 7 });
    expect(a.mesh.peers()).not.toContain("b");
    expect(network.count("a", "y", "routes")).toBe(1);
  });

  it("tells a direct peer only that nothing changed while its route list stays the same", () => {
    vi.useFakeTimers();
    const network = new Network();
    const [a, x, y, b] = [node(network, "a", false, true), node(network, "x", true, true), node(network, "y", true, true), node(network, "b", false, true)];
    meshes = [a.mesh, x.mesh, y.mesh, b.mesh];
    network.link("a", "x");
    network.link("x", "y");
    network.link("y", "b");
    expect(a.mesh.relayOf("b")).toBe("x");
    const lists: unknown[] = [];
    const action = network.rooms.get("a")!.actions.get("routes")!;
    const receive = action.onMessage!;
    action.onMessage = (data, context) => {
      if (context.peerId === "x") lists.push(data);
      return receive(data, context);
    };
    vi.advanceTimersByTime(15_000);
    expect(lists).toEqual([{ n: expect.any(Number) }]);
    // A change goes as what changed in the list A has.
    network.unlink("y", "b");
    expect(lists.at(-1)).toEqual({ n: 2, base: 1, remove: ["b"] });
    expect(a.mesh.peers()).not.toContain("b");
    // Plain members tell nobody their routes.
    expect(network.count("a", "x", "routes")).toBe(0);
  });

  // The change that emptied X's list never came (a send that failed). Its rounds said nothing to a peer while its
  // list was empty, so A kept routing to B, who had left: the ghost again.
  it("makes up for a lost change on the next round, an emptied list too", () => {
    vi.useFakeTimers();
    const network = new Network();
    const [a, x, y, b] = [node(network, "a", false, true), node(network, "x", true, true), node(network, "y", true, true), node(network, "b", false, true)];
    meshes = [a.mesh, x.mesh, y.mesh, b.mesh];
    network.link("a", "x");
    network.link("x", "y");
    network.link("y", "b");
    const action = network.rooms.get("a")!.actions.get("routes")!;
    const receive = action.onMessage!;
    let lose = true;
    action.onMessage = (data, context) => {
      if (lose && context.peerId === "x") return (lose = false);
      return receive(data, context);
    };
    network.unlink("y", "b");
    expect(a.mesh.peers()).toContain("b");
    vi.advanceTimersByTime(15_000);
    expect(a.mesh.peers()).not.toContain("b");
  });

  // Dropping a peer's routes when its list number didn't match made everyone reached through it leave and come back.
  it("keeps a peer's routes while it asks for the whole list", () => {
    const network = new Network();
    const [a, x, y, b] = [node(network, "a", false, true), node(network, "x", true, true), node(network, "y", true, true), node(network, "b", false, true)];
    meshes = [a.mesh, x.mesh, y.mesh, b.mesh];
    network.link("a", "x");
    network.link("x", "y");
    network.link("y", "b");
    const left: string[] = [];
    a.mesh.onPeers(() => {}, (peer) => left.push(peer));
    // A list number A never got: kept until X answers with its whole list.
    let asked = 0;
    const action = network.rooms.get("x")!.actions.get("routes")!;
    const receive = action.onMessage!;
    action.onMessage = (data, context) => {
      if ((data as { ask?: boolean }).ask) return asked++;
      return receive(data, context);
    };
    tell(network, "x", "a", { n: 99 });
    expect(asked).toBe(1);
    expect(a.mesh.peers()).toContain("b");
    expect(left).toEqual([]);
    tell(network, "x", "a", { n: 99 });
    expect(asked).toBe(1);
  });

  // Each member leaving sent the whole list to every direct peer at once: hundreds of full lists per burst of leaves.
  it("tells a burst of lost routes as one change", () => {
    vi.useFakeTimers();
    const network = new Network();
    const peer = (id: string, shareRoutes = false) => {
      const mesh = new Mesh(network.room(id) as unknown as Room, id, () => {}, { shareRoutes, relayAfter: () => 0 });
      meshes.push(mesh);
      return mesh;
    };
    const a = peer("a");
    peer("x", true);
    peer("y", true);
    const gone = ["b1", "b2", "b3"];
    gone.forEach((id) => peer(id));
    for (const id of gone) network.link("y", id);
    network.link("x", "y");
    network.link("a", "x");
    vi.advanceTimersByTime(2_000);
    expect(a.peers()).toEqual(expect.arrayContaining(gone));
    const before = network.count("x", "a", "routes");
    for (const id of gone) network.unlink("y", id);
    vi.advanceTimersByTime(10);
    expect(network.count("x", "a", "routes")).toBe(before + 1);
    for (const id of gone) expect(a.peers()).not.toContain(id);
  });

  it("takes the shortest route and keeps it while an equally short one comes", () => {
    const network = new Network();
    const [a, x, y, b] = ["a", "x", "y", "b"].map((id) => node(network, id, false, true));
    meshes = [a.mesh, x.mesh, y.mesh, b.mesh];
    network.link("a", "x");
    tell(network, "x", "a", { n: 1, routes: [["b", "k"]] });
    expect(a.mesh.relayOf("b")).toBe("x");
    network.link("a", "y");
    network.link("y", "b");
    expect(a.mesh.relayOf("b")).toBe("y");
    network.link("x", "b");
    expect(a.mesh.relayOf("b")).toBe("y");
  });

  it("ignores older apps' far lists", () => {
    const network = new Network();
    const a = node(network, "a", false, true);
    const x = node(network, "x", true, true);
    meshes = [a.mesh, x.mesh];
    network.link("a", "x");
    network.rooms.get("x")!.actions.get("mesh-far")!.send({ all: ["ghost"] }, { target: "a" });
    expect(a.mesh.peers()).toEqual(["x"]);
  });
});

// Member B `hops` go-betweens away from member A, through levels of two nodes each. The two nodes of a level are
// connected to each other and to both of the next level, so every hop has a loop: the shape in which nodes kept a
// member who had left alive by vouching for it to each other.
describe("routing loops", () => {
  let meshes: Mesh[] = [];
  afterEach(() => {
    meshes.forEach((m) => m.close());
    meshes = [];
    vi.useRealTimers();
  });

  function looped(hops: number) {
    const network = new Network();
    const a = node(network, "a", false, true);
    const b = node(network, "b", false, true);
    const levels = Array.from({ length: hops }, (_, i) => [`n${i + 1}x`, `n${i + 1}y`]);
    const nodes = levels.flat().map((id) => node(network, id, true, true));
    meshes.push(a.mesh, b.mesh, ...nodes.map((n) => n.mesh));
    for (const [x, y] of levels) network.link(x, y);
    for (let i = 1; i < hops; i++) for (const p of levels[i - 1]) for (const q of levels[i]) network.link(p, q);
    for (const p of levels[0]) network.link("a", p);
    for (const p of levels.at(-1)!) network.link(p, "b");
    return { network, a, b, levels, others: [a, ...nodes] };
  }

  // Every route list sent from now on.
  function watchRouteLists(network: Network): unknown[] {
    const lists: unknown[] = [];
    for (const room of network.rooms.values()) {
      const action = room.actions.get("routes");
      const receive = action?.onMessage;
      if (!action || !receive) continue;
      action.onMessage = (data, context) => {
        lists.push(data);
        return receive(data, context);
      };
    }
    return lists;
  }

  // A burst of route lists to one peer waits in its outbox (16 at a time) and goes out as earlier sends finish.
  const settle = () => vi.advanceTimersByTimeAsync(10);

  // Once B left, nobody keeps it through anyone else, and nothing but "nothing changed" goes round any more.
  async function expectForgotten(network: Network, others: { mesh: Mesh }[]) {
    await settle();
    for (const m of others) expect(m.mesh.peers()).not.toContain("b");
    const lists = watchRouteLists(network);
    await vi.advanceTimersByTimeAsync(60_000);
    for (const m of others) expect(m.mesh.peers()).not.toContain("b");
    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) expect(Object.keys(list as object)).toEqual(["n"]);
  }

  it.each([1, 2, 3])("reaches a member %i go-between(s) away, finds another way when a link goes, and forgets it when it leaves", async (hops) => {
    vi.useFakeTimers();
    const { network, a, b, levels, others } = looped(hops);
    await settle();
    const route = a.mesh.routeOf("b");
    expect(route).toHaveLength(hops);
    // Once each: no copy went round.
    a.send({ text: "there" }, "b");
    expect(b.got).toEqual([{ data: { text: "there" }, from: "a" }]);
    b.send({ text: "back" }, "a");
    expect(a.got).toEqual([{ data: { text: "back" }, from: "b" }]);

    // The link the route ends on goes: the other node of the last level still reaches B.
    const last = route!.at(-1)!;
    network.unlink(last, "b");
    await settle();
    expect(a.mesh.routeOf("b")).toHaveLength(hops);
    expect(a.mesh.routeOf("b")!.at(-1)).not.toBe(last);
    a.send({ text: "still there" }, "b");
    await settle();
    expect(b.got.at(-1)).toEqual({ data: { text: "still there" }, from: "a" });

    for (const p of levels.at(-1)!) network.unlink(p, "b");
    await expectForgotten(network, others);
  });

  it("never reaches a member four go-betweens away, and leaves no trace of it", async () => {
    vi.useFakeTimers();
    const { network, a, b, levels, others } = looped(4);
    await settle();
    // The last level is three go-betweens away; B one more.
    expect(a.mesh.peers()).toEqual(expect.arrayContaining(levels[3]));
    expect(a.mesh.peers()).not.toContain("b");
    a.send({ text: "too far" }, "b");
    expect(b.got).toEqual([]);

    for (const p of levels[3]) network.unlink(p, "b");
    await expectForgotten(network, others);
  });
});
