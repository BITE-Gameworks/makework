import { describe, expect, it } from "vitest";
import type { Room } from "trystero";
import { RoomGroup } from "../../src/p2p/roomGroup";
import { Network, fakeStream } from "./fakeNetwork";

const room = (network: Network, id: string, name: string) => network.room(id, name) as unknown as Room;

describe("RoomGroup", () => {
  function setup() {
    const network = new Network();
    const group = new RoomGroup();
    const events: string[] = [];
    group.onPeerJoin = (peer) => events.push(`+${peer}`);
    group.onPeerLeave = (peer) => events.push(`-${peer}`);
    const got: { data: unknown; from: string }[] = [];
    const chat = group.makeAction<string>("chat", { onMessage: (data, { peerId }) => void got.push({ data, from: peerId }) });
    group.add("hub", room(network, "a", "hub"));
    group.add("members", room(network, "a", "members"));
    // B's side, one room each.
    const bHub = network.room("b", "hub");
    const bMembers = network.room("b", "members");
    const cMembers = network.room("c", "members");
    const heard: { room: string; from: string; data: unknown }[] = [];
    for (const r of [bHub, bMembers, cMembers]) r.makeAction("chat", { onMessage: (data, { peerId }) => void heard.push({ room: `${r.name}/${r.id}`, from: peerId, data }) });
    return { network, group, events, got, chat, heard };
  }

  it("reports a peer once while it is in any of the rooms", async () => {
    const { network, group, events } = setup();
    network.link("a", "b", "members");
    network.link("a", "b", "hub");
    expect(events).toEqual(["+b"]);
    network.unlink("a", "b", "members");
    expect(events).toEqual(["+b"]);
    await group.remove("hub");
    expect(events).toEqual(["+b", "-b"]);
  });

  // A peer's media goes through the first room it shares with this one. When that connection closes while the peer stays
  // in another room, nothing leaves, so the media must be told it moved (or a call through the member room went silent
  // once the member room was left; the other side logs "User-Initiated Abort, reason=Close called").
  it("says when the room carrying a peer goes while the peer stays in another", async () => {
    const { network, group } = setup();
    const moved: string[] = [];
    group.onPeerMoved = (peer) => moved.push(peer);
    network.link("a", "b", "members");
    network.link("a", "b", "hub");
    // Not the carrying room: nothing moves.
    network.unlink("a", "b", "hub");
    expect(moved).toEqual([]);
    network.link("a", "b", "hub");
    // The other side closed the carrying connection.
    network.unlink("a", "b", "members");
    expect(moved).toEqual(["b"]);
    network.link("a", "b", "members");
    // This side leaves the carrying room.
    await group.remove("hub");
    expect(moved).toEqual(["b", "b"]);
    // Its last room: a leave, not a move.
    await group.remove("members");
    expect(moved).toEqual(["b", "b"]);
  });

  it("says a peer moved when a new connection replaces its old one in the carrying room", () => {
    const { network, group } = setup();
    const moved: string[] = [];
    group.onPeerMoved = (peer) => moved.push(peer);
    network.link("a", "b", "members");
    network.link("a", "b", "hub");
    // Trystero joins the peer again without a leave for the old connection.
    network.rooms.get("a")!.onPeerJoin?.("b");
    expect(moved).toEqual([]);
    network.rooms.get("members/a")!.onPeerJoin?.("b");
    expect(moved).toEqual(["b"]);
  });

  it("sends through the first room the peer is in, and broadcasts once per peer", async () => {
    const { network, group, chat, heard } = setup();
    network.link("a", "b", "members");
    network.link("a", "b", "hub");
    network.link("a", "c", "members");
    await chat.send("to b", { target: "b" });
    expect(heard).toEqual([{ room: "members/b", from: "a", data: "to b" }]);
    heard.length = 0;
    await chat.send("everyone");
    expect(heard.map((h) => h.room).sort()).toEqual(["members/b", "members/c"]);
    // Once the member room is gone, B is still reached through the hub; C is gone.
    await group.remove("members");
    heard.length = 0;
    await chat.send("after");
    expect(heard).toEqual([{ room: "hub/b", from: "a", data: "after" }]);
    expect(Object.keys(group.getPeers())).toEqual(["b"]);
  });

  it("gives messages from any room to the group's handler, also one set after the rooms were added", () => {
    const { network, group, got } = setup();
    const late = group.makeAction<string>("late");
    const lateGot: string[] = [];
    late.onMessage = (data) => void lateGot.push(data);
    network.link("a", "b", "hub");
    network.link("a", "c", "members");
    void network.rooms.get("b")!.actions.get("chat")!.send("from b", { target: "a" });
    void network.rooms.get("members/c")!.actions.get("chat")!.send("from c", { target: "a" });
    expect(got).toEqual([{ data: "from b", from: "b" }, { data: "from c", from: "c" }]);
    network.rooms.get("b")!.makeAction("late");
    void network.rooms.get("b")!.actions.get("late")!.send("late one", { target: "a" });
    expect(lateGot).toEqual(["late one"]);
  });

  it("keeps unauthenticated and invited peers out of member-only actions", async () => {
    const network = new Network();
    const a = new RoomGroup();
    const b = new RoomGroup();
    a.requirePeerAuthentication("member");
    b.requirePeerAuthentication("member");
    const members: string[] = [];
    const syncReceived: string[] = [];
    const memberReceived: string[] = [];
    a.onPeerJoin = (peer) => members.push(peer);
    const syncA = a.makeAction<string>("sync", { mwAccess: "invite" } as never);
    const memberA = a.makeAction<string>("member");
    const syncB = b.makeAction<string>("sync", { mwAccess: "invite" } as never);
    const memberB = b.makeAction<string>("member");
    syncB.onMessage = (value) => void syncReceived.push(value);
    memberB.onMessage = (value) => void memberReceived.push(value);
    a.add("hub", room(network, "a", "hub"));
    b.add("hub", room(network, "b", "hub"));
    network.link("a", "b", "hub");

    await syncA.send("blocked before auth", { target: "b" });
    expect(syncReceived).toEqual([]);
    expect(members).toEqual([]);

    a.authorizePeer("b", "invite");
    b.authorizePeer("a", "member");
    await syncA.send("catch-up", { target: "b" });
    await memberA.send("not sent to invitee", { target: "b" });
    expect(syncReceived).toEqual(["catch-up"]);
    expect(memberReceived).toEqual([]);
    expect(members).toEqual(["b"]);

    b.setLocalAccess("invite");
    await memberA.send("not sent to a joining device", { target: "b" });
    expect(memberReceived).toEqual([]);
  });

  it("holds what a peer sends before it is authorized here, and hands it over once it is", async () => {
    const network = new Network();
    const a = new RoomGroup();
    const b = new RoomGroup();
    a.requirePeerAuthentication("member");
    b.requirePeerAuthentication("member");
    const received: string[] = [];
    const syncA = a.makeAction<string>("sync", { mwAccess: "invite" } as never);
    const syncB = b.makeAction<string>("sync", { mwAccess: "invite" } as never);
    syncB.onMessage = (value) => void received.push(value);
    a.add("hub", room(network, "a", "hub"));
    b.add("hub", room(network, "b", "hub"));
    network.link("a", "b", "hub");
    // A checked B's proof first and says hello; B is still checking A's.
    a.authorizePeer("b", "member");
    await syncA.send("hello", { target: "b" });
    expect(received).toEqual([]);
    b.authorizePeer("a", "member");
    expect(received).toEqual(["hello"]);

    // Refused: what it sent is dropped.
    const c = new RoomGroup();
    c.requirePeerAuthentication("member");
    const syncC = c.makeAction<string>("sync", { mwAccess: "invite" } as never);
    c.add("hub", room(network, "c", "hub"));
    network.link("a", "c", "hub");
    a.authorizePeer("c", "member");
    await syncA.send("hello", { target: "c" });
    let heard = false;
    syncC.onMessage = () => void (heard = true);
    c.authorizePeer("a", null);
    expect(heard).toBe(false);
  });

  // Each side of a new connection sends its streams as soon as it has checked the other's proof. A member back from a
  // dropped connection stayed "Connecting…" for good: the other side was faster, and its mic, there before this side
  // had checked the other's proof, was dropped and never sent again.
  describe("streams from a peer not authorized here yet", () => {
    function streams() {
      const network = new Network();
      const a = new RoomGroup();
      const b = new RoomGroup();
      a.requirePeerAuthentication("member");
      b.requirePeerAuthentication("member");
      const got: string[] = [];
      b.onPeerStream = (stream, peer) => void got.push(`${peer}:${stream.id}`);
      a.add("call", room(network, "a", "call"));
      b.add("call", room(network, "b", "call"));
      network.link("a", "b", "call");
      a.authorizePeer("b", "member");
      return { network, a, b, got };
    }

    it("are held and handed over once the peer is authorized", () => {
      const { a, b, got } = streams();
      a.addStream(fakeStream("mic", [{ readyState: "live" }]), { target: "b" });
      expect(got).toEqual([]);
      b.authorizePeer("a", "member");
      expect(got).toEqual(["a:mic"]);
    });

    it.each([
      ["is refused", (_network: Network, b: RoomGroup) => b.authorizePeer("a", null)],
      ["leaves", (network: Network) => network.unlink("a", "b", "call")],
    ])("are dropped when the peer %s first", (_label, end) => {
      const { network, a, b, got } = streams();
      a.addStream(fakeStream("mic", [{ readyState: "live" }]), { target: "b" });
      end(network, b);
      // Back on a new connection: only what it sends then comes through.
      network.unlink("a", "b", "call");
      network.link("a", "b", "call");
      b.authorizePeer("a", "member");
      expect(got).toEqual([]);
    });

    // Held because this device isn't a member yet (a joiner whose join is on its way), with no message held next to it.
    it("are handed over once this device becomes a member", () => {
      const network = new Network();
      const a = new RoomGroup();
      const b = new RoomGroup();
      a.requirePeerAuthentication("member");
      b.requirePeerAuthentication("invite");
      const got: string[] = [];
      b.onPeerStream = (stream, peer) => void got.push(`${peer}:${stream.id}`);
      a.add("call", room(network, "a", "call"));
      b.add("call", room(network, "b", "call"));
      network.link("a", "b", "call");
      a.authorizePeer("b", "member");
      b.authorizePeer("a", "member");
      a.addStream(fakeStream("mic", [{ readyState: "live" }]), { target: "b" });
      expect(got).toEqual([]);
      b.setLocalAccess("member");
      expect(got).toEqual(["a:mic"]);
    });

    // A go-between passing on the mics and cameras of ten members: none may be lost, or those stay unheard for good.
    it("are all held from a peer passing on many members' streams", () => {
      const { a, b, got } = streams();
      for (let i = 0; i < 20; i++) a.addStream(fakeStream(`s${i}`, [{ readyState: "live" }]), { target: "b" });
      b.authorizePeer("a", "member");
      expect(got).toHaveLength(20);
    });

    // One of the peer's connections closing (a move) keeps them: one that came over the other would be lost for good.
    it("are kept when one of the peer's connections closes and another stays", () => {
      const { network, a, b, got } = streams();
      a.add("hub", room(network, "a", "hub"));
      b.add("hub", room(network, "b", "hub"));
      network.link("a", "b", "hub");
      a.addStream(fakeStream("mic", [{ readyState: "live" }]), { target: "b" });
      network.unlink("a", "b", "call");
      b.authorizePeer("a", "member");
      expect(got).toEqual(["a:mic"]);
    });

    // A stream without a live track handed over would count as heard: the call would say it is connected, in silence.
    it("are handed over once each, without the ones whose tracks ended meanwhile", () => {
      const { a, b, got } = streams();
      const camera = { readyState: "live" as MediaStreamTrackState };
      const mic = fakeStream("mic", [{ readyState: "live" }]);
      a.addStream(mic, { target: "b" });
      a.addStream(mic, { target: "b" });
      a.addStream(fakeStream("camera", [camera]), { target: "b" });
      a.addStream(fakeStream("screen", []), { target: "b" });
      camera.readyState = "ended";
      b.authorizePeer("a", "member");
      expect(got).toEqual(["a:mic"]);
    });
  });
});
