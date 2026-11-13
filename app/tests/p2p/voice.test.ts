// The screen-share quality through the call's media link (src/p2p/voice.ts, VoiceLink): what a member picks reaches
// the senders carrying their share on every connection, late joiners included, the upload budget follows how many
// copies go out, and the live line reads those senders. The mesh and room are fakes; the mesh adds a stream's
// senders a moment after it is asked, like Trystero (which sends the stream's metadata first).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ledger } from "../../src/p2p/ledger";
import type { WorkspaceSync } from "../../src/p2p/sync";
import { Mesh } from "../../src/p2p/mesh";
import { Network } from "./fakeNetwork";
import { VoiceLink } from "../../src/p2p/voice";
import { MockBackend } from "../../src/system/backend";
import { voice } from "../../src/system/voice";
import { recentCallEvents } from "../../src/voice/activity";
import { clearRemote, remoteStream, reportedCallSize, setRemoteStream } from "../../src/voice/media";
import { FakeMediaStream, FakeSender, fakeStream, fakeTrack, type FakeStream, type FakeTrack } from "../voice/fakeSender";

// The call's link to a node (p2p/sfu.ts) is the network's business; here only its word on the mode matters, which a
// test sets and announces like SfuLink does (`onMode`). Calls stay mesh calls unless a test says otherwise.
const node = vi.hoisted(() => ({
  mode: "mesh" as "mesh" | "sfu",
  announce: (_mode: "mesh" | "sfu") => {},
  // A member's stream arriving from the node (or going: null), as SfuLink hands it on.
  deliver: (_user: number, _kind: "mic" | "camera" | "screen", _stream: unknown) => {},
  // What the call was told to do with the node (call, own streams, hosted bots' streams, whether it listens).
  intents: [] as unknown[][],
}));
vi.mock("../../src/p2p/sfu", () => ({
  SfuLink: class {
    constructor(
      _server: string, _sync: unknown, _ledger: unknown, _user: number, _count: unknown, onMode: (mode: "mesh" | "sfu") => void,
      onRemote: (user: number, kind: "mic" | "camera" | "screen", stream: unknown) => void,
    ) {
      node.announce = (mode) => {
        node.mode = mode;
        onMode(mode);
      };
      node.deliver = onRemote;
    }
    modeOf() {
      return node.mode;
    }
    setIntent(...args: unknown[]) {
      node.intents.push(args);
    }
    setQuality() {}
    async close() {}
    async screenStats() {
      return null;
    }
    screenSoundRefused() {
      return false;
    }
  },
}));

type FakePeer = {
  connectionState: string; signalingState: string; senders: FakeSender[]; changes: (() => void)[];
  getSenders(): FakeSender[]; addEventListener(type: string, listener: () => void): void;
};
type Presence = {
  userId: number; row: Record<string, unknown> | null; refreshMs?: number; node?: boolean; resend?: string[]; revision?: number;
  watching?: string[]; seen?: number; replaces?: string;
};

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const call = 5;

describe("three members' replicated call membership", () => {
  it("keeps all participants through a short partition and reconciles after reconnecting", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const network = new Network();
    const links: VoiceLink[] = [];
    const meshes: Mesh[] = [];
    const backends: MockBackend[] = [];
    try {
      for (let user = 1; user <= 3; user++) {
        const room = network.room(`p${user}`);
        const mesh = new Mesh(room as never, `p${user}`, () => {}, { shareRoutes: () => true });
        meshes.push(mesh);
        const backend = new MockBackend({ userId: user });
        backend.load(voice);
        backends.push(backend);
        const sync = { mesh, room, joinCall() {}, onPeers: mesh.onPeers.bind(mesh) } as unknown as WorkspaceSync;
        const link = new VoiceLink("three-members", backend, sync, user, { select: () => [{ sfu_calls: false }] } as unknown as Ledger);
        links.push(link);
        backend.data("voice").insert("voice_participants", { user_id: user, channel_id: call, muted: false });
        link.setLocal(call, { mic: fakeStream(fakeTrack("audio")) as unknown as MediaStream, camera: null, screen: null });
      }
      network.link("p1", "p2");
      network.link("p1", "p3");
      network.link("p2", "p3");
      await settle();
      const users = (backend: MockBackend) => backend.data("voice").select("voice_participants").map((row) => row.user_id).sort();
      for (const backend of backends) expect(users(backend)).toEqual([1, 2, 3]);
      network.unlink("p1", "p2");
      network.unlink("p1", "p3");
      vi.advanceTimersByTime(5_000);
      for (const backend of backends) expect(users(backend)).toEqual([1, 2, 3]);
      network.link("p1", "p2");
      network.link("p1", "p3");
      await settle();
      vi.advanceTimersByTime(6_000);
      for (const backend of backends) expect(users(backend)).toEqual([1, 2, 3]);
      // A genuine hang-up still propagates immediately across all three replicas.
      backends[0].data("voice").delete("voice_participants", { user_id: 1 });
      await settle();
      expect(users(backends[1])).toEqual([2, 3]);
      expect(users(backends[2])).toEqual([2, 3]);
    } finally {
      links.forEach((link) => link.close());
      meshes.forEach((mesh) => mesh.close());
      vi.useRealTimers();
    }
  });
});

describe("screen-share quality through the media link", () => {
  let peers: Record<string, FakePeer>;
  let presence: (data: Presence, peerId: string) => void;
  let left: (peerId: string) => void;
  let rejoined: (peerId: string) => void;
  // A direct connection opening, and the presence this member sent (to whom; undefined for everyone).
  let direct: (peerId: string) => void;
  let sentPresence: { data: Presence; peer?: string }[];
  // Peers whose app said bye (the mesh's `hasQuit`), and the mesh telling the call (`onQuit`), as mesh.ts does.
  const quit = new Set<string>();
  let quitHandler: ((peerId: string) => void) | undefined;
  const sayBye = (peerId: string) => {
    quit.add(peerId);
    quitHandler?.(peerId);
  };
  let backend: MockBackend;
  let link: VoiceLink;
  const placed = new Set<(stream: FakeStream, target: string) => void>();
  // Whether new senders have their encodings at once (Chrome) or only once negotiated (some browsers).
  let encodingsAtOnce = true;

  beforeEach(() => {
    peers = {};
    sentPresence = [];
    quit.clear();
    placed.clear();
    // Only the presence refresh's interval is faked; settle() keeps real timeouts.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    encodingsAtOnce = true;
    const mesh = {
      channel: (_name: string, receive: (data: Presence, peerId: string) => void) => {
        presence = receive;
        return (data: Presence, peer?: string) => sentPresence.push({ data, peer });
      },
      onDirectPeers: (joined: (peerId: string) => void) => {
        direct = joined;
        return () => {};
      },
      onStream: () => () => {},
      onPlaced: (handler: (stream: FakeStream, target: string) => void) => {
        placed.add(handler);
        return () => placed.delete(handler);
      },
      addStream: (stream: FakeStream, target: string) => {
        void Promise.resolve().then(() => {
          peers[target]?.senders.push(...stream.getTracks().map((t) => new FakeSender(t, encodingsAtOnce ? undefined : [])));
          placed.forEach((handler) => handler(stream, target));
        });
      },
      removeStream: (stream: FakeStream, target: string) => {
        const peer = peers[target];
        if (peer) peer.senders = peer.senders.filter((s) => !stream.getTracks().includes(s.track!));
      },
      relayOf: () => null,
      hasQuit: (peerId: string) => quit.has(peerId),
      onQuit: (handler: (peerId: string) => void) => ((quitHandler = handler), () => {}),
      gone: (peerId: string) => sayBye(peerId),
      directPeers: () => Object.keys(peers),
    };
    const sync = {
      mesh,
      room: { getPeers: () => peers, makeAction: () => ({}) },
      onPeers: (joined: (peerId: string) => void, leave: (peerId: string) => void) => {
        rejoined = joined;
        left = leave;
        return () => {};
      },
      joinCall: () => {},
    } as unknown as WorkspaceSync;
    // Calls through nodes switched off, so the call stays a mesh call whatever its size.
    const ledger = { select: () => [{ sfu_calls: false }] } as unknown as Ledger;
    backend = new MockBackend({ userId: 1 });
    backend.load(voice);
    link = new VoiceLink("srv", backend, sync, 1, ledger);
    vi.stubGlobal("MediaStream", FakeMediaStream);
  });

  afterEach(() => {
    link.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // A member on their own connection, in our call. `watching`: the pictures it views (left out: an older app that
  // doesn't say, which gets every picture).
  const join = (peerId: string, userId: number, watching?: string[]) => {
    peers[peerId] = {
      connectionState: "connected", signalingState: "stable", senders: [], changes: [],
      getSenders() { return this.senders; },
      addEventListener(type, listener) { if (type === "signalingstatechange") this.changes.push(listener); },
    };
    presence({ userId, row: inCall(), ...(watching && { watching }) }, peerId);
  };
  const inCall = () => ({ channel_id: call, muted: false, deafened: false, sharing: null, camera: false, sound_only: false });
  // The member's row as the call shows it (the voice plugin's table, which the participant lists render by id).
  const rowOf = (userId: number) => backend.data("voice").select("voice_participants", { user_id: userId })[0];
  const leave = (peerId: string) => {
    delete peers[peerId];
    left(peerId);
  };
  const senderOf = (peerId: string, track: FakeTrack) => peers[peerId].senders.find((s) => s.track === track)!;

  const mic = fakeTrack("audio");
  const picture = fakeTrack("video");
  const sound = fakeTrack("audio");
  const share = () => ({ mic: fakeStream(mic), camera: null, screen: fakeStream(picture, sound) }) as never;

  it("tunes the share's picture and sound on every connection that carries it, and puts the mic first", async () => {
    join("p2", 2);
    join("p3", 3);
    link.setLocal(call, share());
    await settle();
    link.setQuality({ resolution: 1080, frameRate: 30, favour: "detail", bitrate: "auto" });
    await settle();
    for (const peerId of ["p2", "p3"]) {
      expect(senderOf(peerId, picture).current.encodings[0]).toMatchObject({ maxBitrate: 4_000_000, maxFramerate: 30, priority: "low" });
      expect(senderOf(peerId, picture).current.degradationPreference).toBe("maintain-resolution");
      expect(senderOf(peerId, sound).current.encodings[0]).toMatchObject({ maxBitrate: 128_000, priority: "medium" });
      expect(senderOf(peerId, mic).current.encodings[0]).toMatchObject({ priority: "high", networkPriority: "high" });
    }
  });

  it("tunes a member who joins after the quality was set, the chosen bitrate split between the copies", async () => {
    join("p2", 2);
    link.setLocal(call, share());
    link.setQuality({ resolution: 720, frameRate: 60, favour: "motion", bitrate: 8 });
    await settle();
    join("p3", 3);
    await settle();
    expect(senderOf("p3", picture).current.encodings[0]).toMatchObject({ maxBitrate: 4_000_000, maxFramerate: 60 });
    expect(senderOf("p3", picture).current.degradationPreference).toBe("maintain-framerate");
  });

  it("tunes a sender that only gets its encodings once the connection is negotiated", async () => {
    encodingsAtOnce = false;
    join("p2", 2);
    link.setLocal(call, share());
    link.setQuality({ resolution: 1080, frameRate: 30, favour: "detail", bitrate: "auto" });
    await settle();
    const sender = senderOf("p2", picture);
    expect(sender.sets).toBe(0);
    sender.negotiate();
    peers.p2.changes.forEach((changed) => changed());
    await settle();
    expect(sender.current.encodings[0]).toMatchObject({ maxBitrate: 4_000_000, maxFramerate: 30, priority: "low" });
  });

  it("keeps Auto's copies within the upload budget with three viewers, and lifts it when one leaves", async () => {
    for (const [peerId, userId] of [["p2", 2], ["p3", 3], ["p4", 4]] as const) join(peerId, userId);
    link.setLocal(call, share());
    link.setQuality({ resolution: 1440, frameRate: 30, favour: "balanced", bitrate: "auto" });
    await settle();
    for (const peerId of ["p2", "p3", "p4"]) expect(senderOf(peerId, picture).current.encodings[0].maxBitrate).toBe(2_700_000);
    leave("p4");
    await settle();
    for (const peerId of ["p2", "p3"]) expect(senderOf(peerId, picture).current.encodings[0].maxBitrate).toBe(4_000_000);
  });

  // A caller gets a picture only while it views it (its presence says so): a share or a camera goes out once per
  // viewer and no further, so it can't flood a call (ADR 0019). The mic and a share's sound go to every caller.
  const camera = fakeTrack("video");
  const everything = () => ({ mic: fakeStream(mic), camera: fakeStream(camera), screen: fakeStream(picture, sound) }) as never;
  const sending = (peerId: string) => peers[peerId].senders.map((s) => s.track);

  it("sends its screen and camera only to callers who view them, its mic and the share's sound to all", async () => {
    join("p2", 2, ["1:screen", "1:camera"]);
    join("p3", 3, []);
    link.setLocal(call, everything());
    await settle();
    expect(sending("p2")).toEqual(expect.arrayContaining([mic, camera, picture, sound]));
    expect(sending("p2")).toHaveLength(4);
    expect(sending("p3")).toEqual([mic, sound]);
  });

  it("sends every picture to an older app that doesn't say what it views", async () => {
    join("p2", 2);
    link.setLocal(call, everything());
    await settle();
    expect(sending("p2")).toEqual(expect.arrayContaining([mic, camera, picture, sound]));
  });

  it("sends a share of sound only to every caller (there is no picture to view)", async () => {
    join("p2", 2, []);
    link.setLocal(call, { mic: fakeStream(mic), camera: null, screen: fakeStream(sound) } as never);
    await settle();
    expect(sending("p2")).toEqual(expect.arrayContaining([mic, sound]));
  });

  // Each start or stop renegotiates the connection: a viewer flipping between channels keeps the picture a while.
  it("keeps sending a picture for 10 s after its viewer looks away, and again at once when it looks back", async () => {
    join("p2", 2, ["1:screen"]);
    link.setLocal(call, share());
    await settle();
    expect(sending("p2")).toContain(picture);
    presence({ userId: 2, row: inCall(), watching: [] }, "p2");
    vi.advanceTimersByTime(9_000);
    await settle();
    expect(sending("p2")).toContain(picture);
    vi.advanceTimersByTime(2_000);
    await settle();
    expect(sending("p2")).toEqual([mic, sound]);
    presence({ userId: 2, row: inCall(), watching: ["1:screen"] }, "p2");
    await settle();
    expect(sending("p2")).toEqual(expect.arrayContaining([mic, picture, sound]));
    expect(sending("p2")).toHaveLength(3);
  });

  // The stage turns every feed on or off at once: one presence goes out for them all.
  it("tells the others which pictures it views, once for a change of several", async () => {
    const before = sentPresence.length;
    link.watch(2, "screen", true);
    link.watch(3, "camera", true);
    await settle();
    expect(sentPresence.slice(before).map((p) => p.data.watching)).toEqual([["2:screen", "3:camera"]]);
    link.watch(2, "screen", false);
    await settle();
    expect(sentPresence.at(-1)?.data.watching).toEqual(["3:camera"]);
  });

  it("views nothing once it leaves the call", async () => {
    link.setLocal(call, share());
    link.watch(2, "screen", true);
    await settle();
    link.setLocal(null, { mic: null, camera: null, screen: null });
    await settle();
    expect(sentPresence.at(-1)?.data.watching).toEqual([]);
  });

  it("keeps its camera's copies within the camera budget", async () => {
    for (const [peerId, userId] of [["p2", 2], ["p3", 3], ["p4", 4]] as const) join(peerId, userId, ["1:camera"]);
    link.setLocal(call, { mic: fakeStream(mic), camera: fakeStream(camera), screen: null } as never);
    await settle();
    for (const peerId of ["p2", "p3", "p4"]) expect(senderOf(peerId, camera).current.encodings[0]).toMatchObject({ maxBitrate: 1_000_000, priority: "low" });
    leave("p4");
    await settle();
    for (const peerId of ["p2", "p3"]) expect(senderOf(peerId, camera).current.encodings[0].maxBitrate).toBe(1_500_000);
  });

  it("reads the share's numbers from its senders for the live line", async () => {
    join("p2", 2);
    link.setLocal(call, share());
    link.setQuality({ resolution: 1080, frameRate: 30, favour: "balanced", bitrate: "auto" });
    await settle();
    senderOf("p2", picture).report = new Map([["OT1", {
      id: "OT1", type: "outbound-rtp", kind: "video", timestamp: 1000, bytesSent: 0, frameWidth: 1920, frameHeight: 1080,
      framesPerSecond: 30, targetBitrate: 3_900_000, qualityLimitationReason: "none",
    }]]);
    expect(await link.shareStats()).toEqual({
      width: 1920, height: 1080, fps: 30, bitrate: 3_900_000, copies: 1, viaNode: false,
      cap: { bitrate: 4_000_000, capped: false }, soundRefused: false,
    });
  });

  it("has no numbers while no picture is shared", async () => {
    join("p2", 2);
    link.setLocal(call, { mic: fakeStream(mic), camera: null, screen: null } as never);
    link.setQuality({ resolution: 1080, frameRate: 30, favour: "balanced", bitrate: "auto" });
    expect(await link.shareStats()).toBeNull();
  });

  it("leaves the share's senders alone when a presence change moves no copy", async () => {
    join("p2", 2);
    join("p3", 3);
    link.setLocal(call, share());
    link.setQuality({ resolution: 1080, frameRate: 30, favour: "detail", bitrate: "auto" });
    await settle();
    const senders = ["p2", "p3"].flatMap((peerId) => peers[peerId].senders);
    for (const sender of senders) sender.gets = 0;
    // p2 mutes: nothing about who gets a copy changes.
    presence({ userId: 2, row: { channel_id: call, muted: true, deafened: false, sharing: null, camera: false, sound_only: false } }, "p2");
    await settle();
    expect(senders.reduce((n, sender) => n + sender.gets, 0)).toBe(0);
  });

  it("sends its presence again on a direct connection and while in a call, so one lost message heals", async () => {
    join("p2", 2);
    link.setLocal(call, share());
    await settle();
    // A member reached through a relay before (no new `onPeers`) now connects directly: it gets the presence again.
    sentPresence.length = 0;
    direct("p9");
    expect(sentPresence).toEqual([{ data: expect.objectContaining({ userId: 1 }), peer: "p9" }]);
    sentPresence.length = 0;
    vi.advanceTimersByTime(20_000);
    // To everyone (the own row is whatever the voice plugin holds; this fake never joined through it).
    expect(sentPresence).toEqual([{ data: expect.objectContaining({ userId: 1, refreshMs: 20_000 }), peer: undefined }]);
  });

  it("refreshes everyone in the server, also members it doesn't know are in the call (their presence was lost)", () => {
    join("p2", 2);
    // p3 is in the call too, but its presence never arrived here: this device counts it as not in the call.
    presence({ userId: 3, row: null }, "p3");
    link.setLocal(call, share());
    sentPresence.length = 0;
    vi.advanceTimersByTime(20_000);
    // Sent only to the members it knows are in the call, a lost presence on both sides never healed (mesh-test s10:
    // two members of a 3-member call never heard each other). The refresh reaches p3 too.
    expect(sentPresence).toEqual([{ data: expect.objectContaining({ userId: 1, refreshMs: 20_000 }), peer: undefined }]);
  });

  it("says it left the call again on the next three refreshes, then goes quiet", () => {
    join("p2", 2);
    link.setLocal(call, share());
    link.setLocal(null, { mic: null, camera: null, screen: null });
    sentPresence.length = 0;
    // One lost "left" used to leave a ghost participant on the others' screens until the connection dropped.
    vi.advanceTimersByTime(60_000);
    expect(sentPresence).toHaveLength(3);
    expect(sentPresence.every((s) => s.peer === undefined && s.data.userId === 1 && s.data.row === null)).toBe(true);
    sentPresence.length = 0;
    vi.advanceTimersByTime(120_000);
    expect(sentPresence).toEqual([]);
  });

  it("keeps a member's row as it is when the same presence comes again (the 20 s refresh)", () => {
    join("p2", 2);
    const before = rowOf(2);
    presence({ userId: 2, row: inCall() }, "p2");
    expect(rowOf(2)?.id).toBe(before.id);
    // A real change still goes in.
    presence({ userId: 2, row: { ...inCall(), muted: true } }, "p2");
    expect(rowOf(2)?.muted).toBe(true);
  });

  it("says how often it refreshes, so others can tell when it went silent", () => {
    join("p2", 2);
    link.setLocal(call, share());
    vi.advanceTimersByTime(20_000);
    expect(sentPresence.at(-1)?.data.refreshMs).toBe(20_000);
  });

  it("takes a member who refreshes out of the call once it missed a few refreshes, but not while it refreshes", () => {
    const refreshing = () => presence({ userId: 2, row: inCall(), refreshMs: 20_000 }, "p2");
    refreshing();
    vi.advanceTimersByTime(60_000);
    expect(rowOf(2)).toBeDefined();
    // Still refreshing: the clock starts again.
    refreshing();
    vi.advanceTimersByTime(60_000);
    expect(rowOf(2)).toBeDefined();
    // Gone silent (left, and every "left" was lost): out within a few missed refreshes.
    vi.advanceTimersByTime(40_000);
    expect(rowOf(2)).toBeUndefined();
  });

  it("takes out only the silent device of an account, not its other device still in the call", () => {
    // The same account on two devices; the first crashed (its "left" never went out), the second refreshes.
    presence({ userId: 2, row: inCall(), refreshMs: 20_000 }, "p2-crashed");
    presence({ userId: 2, row: inCall(), refreshMs: 20_000 }, "p2-alive");
    // Checked right after each tick, before the live device's next refresh could put a wrongly removed row back.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(20_000);
      expect(rowOf(2)).toBeDefined();
      presence({ userId: 2, row: inCall(), refreshMs: 20_000 }, "p2-alive");
    }
  });

  it("forgets the call size a silent device reported, though another device of its account stays in the call", () => {
    presence({ userId: 2, row: inCall(), refreshMs: 20_000, seen: 3 }, "p2-crashed");
    presence({ userId: 2, row: inCall(), refreshMs: 20_000, seen: 2 }, "p2-alive");
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(20_000);
      presence({ userId: 2, row: inCall(), refreshMs: 20_000, seen: 2 }, "p2-alive");
    }
    expect(reportedCallSize("srv", call)).toBe(2);
  });

  it("stops counting a call size its member hasn't said again for a few refreshes", () => {
    // An older app: never taken out (it doesn't refresh), but the larger count it said once stops counting.
    presence({ userId: 3, row: inCall(), seen: 4 }, "p3");
    expect(reportedCallSize("srv", call)).toBe(4);
    for (let i = 0; i < 4; i++) {
      presence({ userId: 2, row: inCall(), refreshMs: 20_000, seen: 2 }, "p2");
      vi.advanceTimersByTime(20_000);
    }
    expect(rowOf(3)).toBeDefined();
    expect(reportedCallSize("srv", call)).toBe(2);
  });

  it("doesn't take everyone out of the call when this device wakes from sleep", () => {
    presence({ userId: 2, row: inCall(), refreshMs: 20_000 }, "p2");
    // Asleep for two minutes: no timer ran, and no refresh could arrive.
    vi.setSystemTime(Date.now() + 120_000);
    vi.advanceTimersByTime(20_000);
    expect(rowOf(2)).toBeDefined();
    // Awake: the member is judged on the refreshes it could send since.
    vi.advanceTimersByTime(80_000);
    expect(rowOf(2)).toBeUndefined();
  });

  it("never takes out a member whose app doesn't say it refreshes (an older app)", () => {
    join("p3", 3);
    vi.advanceTimersByTime(600_000);
    expect(rowOf(3)).toBeDefined();
  });

  it("rejects delayed leave and channel updates from an older route", () => {
    presence({ userId: 2, row: null, revision: 1 }, "p2");
    presence({ userId: 2, row: inCall(), revision: 3 }, "p2");
    const id = rowOf(2).id;
    presence({ userId: 2, row: null, revision: 2 }, "p2");
    presence({ userId: 2, row: { ...inCall(), channel_id: 99 }, revision: 1 }, "p2");
    expect(rowOf(2)).toMatchObject({ id, channel_id: call });
    // Refreshing the current state still works, without remounting the member.
    presence({ userId: 2, row: inCall(), revision: 3 }, "p2");
    expect(rowOf(2).id).toBe(id);
    presence({ userId: 2, row: null, revision: 4 }, "p2");
    expect(rowOf(2)).toBeUndefined();
  });

  it("keeps membership across a brief route outage and attaches media again on return", async () => {
    join("p2", 2);
    link.setLocal(call, share());
    await settle();
    const id = rowOf(2).id;
    leave("p2");
    vi.advanceTimersByTime(5_000);
    expect(rowOf(2).id).toBe(id);
    join("p2", 2);
    rejoined("p2");
    await settle();
    vi.advanceTimersByTime(6_000);
    expect(rowOf(2).id).toBe(id);
    expect(senderOf("p2", mic)).toBeDefined();
    // Explicit leave is immediate, even during the grace period.
    leave("p2");
    presence({ userId: 2, row: null }, "p2");
    expect(rowOf(2)).toBeUndefined();
  });

  it("removes a member after a route outage that does not recover", () => {
    join("p2", 2);
    leave("p2");
    vi.advanceTimersByTime(9_000);
    expect(rowOf(2)).toBeDefined();
    vi.advanceTimersByTime(1_000);
    expect(rowOf(2)).toBeUndefined();
  });

  // Its app quit or reloaded (mesh.ts `bye`): the others saw it as reconnecting for 10 s and more, its name pulsing.
  it("takes a member whose app said bye out of the call at once, without waiting for it to reconnect", () => {
    join("p2", 2);
    sayBye("p2");
    expect(rowOf(2)).toBeUndefined();
    // Its link closing after, and a presence of it that comes late, bring nothing back.
    leave("p2");
    presence({ userId: 2, row: inCall() }, "p2");
    expect(rowOf(2)).toBeUndefined();
    vi.advanceTimersByTime(10_000);
    expect(rowOf(2)).toBeUndefined();
  });

  it("takes a member out at once when its bye comes after its link was already lost", () => {
    join("p2", 2);
    leave("p2");
    vi.advanceTimersByTime(2_000);
    expect(rowOf(2)).toBeDefined();
    sayBye("p2");
    expect(rowOf(2)).toBeUndefined();
  });

  // Its presence came through a go-between before the mesh counted it reachable, so no link of it was ever lost here.
  it("takes out a member that said bye before it ever counted as reachable", () => {
    presence({ userId: 2, row: inCall() }, "p2");
    expect(rowOf(2)).toBeDefined();
    sayBye("p2");
    expect(rowOf(2)).toBeUndefined();
  });

  it("names a member's leave on a bye as closed or reloaded, never as a lost connection", () => {
    link.setLocal(call, share());
    join("p2", 2);
    sayBye("p2");
    leave("p2");
    vi.advanceTimersByTime(10_000);
    // Newest first: nothing about the member after the leave.
    expect(recentCallEvents("srv", (peer) => peer)[0]).toContain("p2's app closed or reloaded: left the call");
  });

  // Its app crashed and came back (core/lastRun.ts): the old connection would stay until it timed out.
  it("drops a member's old connection when its restarted app replaces it, and keeps the member in the call", () => {
    join("p2", 2);
    const id = rowOf(2).id;
    leave("p2");
    join("p2b", 2);
    presence({ userId: 2, row: inCall(), replaces: "p2" }, "p2b");
    // Not taken out and put back (no leave and join sounds), and nothing left to time out.
    expect(rowOf(2).id).toBe(id);
    vi.advanceTimersByTime(30_000);
    expect(rowOf(2)?.id).toBe(id);
    // The mesh drops it too, for every other feature.
    expect(quit.has("p2")).toBe(true);
  });

  it("takes a member out at once when its restarted app replaces the old connection outside the call", () => {
    join("p2", 2);
    leave("p2");
    presence({ userId: 2, row: null, replaces: "p2" }, "p2b");
    expect(rowOf(2)).toBeUndefined();
  });

  it("never drops another member's connection a presence says it replaces", () => {
    join("p2", 2);
    join("p3", 3);
    presence({ userId: 3, row: inCall(), replaces: "p2" }, "p3");
    expect(rowOf(2)).toBeDefined();
    expect(quit.has("p2")).toBe(false);
  });

  it("names the connection its app replaces in its presence only while that is given", () => {
    // The link made for every test has none.
    expect(sentPresence.every(({ data }) => !("replaces" in data))).toBe(true);
    let replaces: string | null = "old-peer";
    const sent: Presence[] = [];
    const mesh = {
      channel: () => (data: Presence) => sent.push(data),
      onDirectPeers: () => () => {},
      onStream: () => () => {},
      onPlaced: () => () => {},
      directPeers: () => [],
      hasQuit: () => false,
      onQuit: () => () => {},
      gone: () => {},
    };
    const sync = {
      mesh, room: { getPeers: () => ({}), makeAction: () => ({}) }, joinCall: () => {}, onPeers: () => () => {},
    } as unknown as WorkspaceSync;
    const own = new MockBackend({ userId: 1 });
    own.load(voice);
    const restarted = new VoiceLink("srv-restarted", own, sync, 1, { select: () => [{ sfu_calls: false }] } as unknown as Ledger, {
      replaces: () => replaces,
    });
    try {
      restarted.setLocal(call, { mic: null, camera: null, screen: null });
      own.data("voice").insert("voice_participants", { user_id: 1, channel_id: call, muted: false });
      expect(sent.at(-1)?.replaces).toBe("old-peer");
      replaces = null;
      vi.advanceTimersByTime(20_000);
      expect(sent.at(-1)).toBeDefined();
      expect(sent.at(-1)?.replaces).toBeUndefined();
    } finally {
      restarted.close();
    }
  });

  it("really clears every old stream before a member rejoins", () => {
    const stream = fakeStream(mic) as unknown as MediaStream;
    setRemoteStream("srv", 2, "mic", stream);
    setRemoteStream("srv", 2, "camera", stream);
    clearRemote("srv", 2);
    expect(remoteStream("srv", 2, "mic")).toBeUndefined();
    expect(remoteStream("srv", 2, "camera")).toBeUndefined();
    setRemoteStream("srv", 2, "mic", stream);
    expect(remoteStream("srv", 2, "mic")?.id).toBe(stream.id);
  });
});

describe("a call through a node, over the mesh", () => {
  let peers: Record<string, FakePeer>;
  let presence: (data: Presence, peerId: string) => void;
  let stream: (stream: FakeStream, peerId: string, meta: { kind: string }) => void;
  let sentPresence: Presence[];
  // A member's mesh connection going away (the server's room lost them; they may still be in the call on a node).
  let leaves: (peerId: string) => void;
  let backend: MockBackend;
  let link: VoiceLink;

  beforeEach(() => {
    node.mode = "mesh";
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    peers = {};
    sentPresence = [];
    const mesh = {
      channel: (_name: string, receive: (data: Presence, peerId: string) => void) => {
        presence = receive;
        return (data: Presence) => sentPresence.push(data);
      },
      onDirectPeers: () => () => {},
      onStream: (handler: typeof stream) => {
        stream = handler;
        return () => {};
      },
      onPlaced: () => () => {},
      addStream: (sent: FakeStream, target: string) => {
        peers[target]?.senders.push(...sent.getTracks().map((t) => new FakeSender(t)));
      },
      removeStream: (sent: FakeStream, target: string) => {
        const peer = peers[target];
        if (peer) peer.senders = peer.senders.filter((s) => !sent.getTracks().includes(s.track!));
      },
      relayOf: () => null,
      hasQuit: () => false,
      onQuit: () => () => {},
      gone: () => {},
      directPeers: () => Object.keys(peers),
    };
    const sync = {
      mesh, room: { getPeers: () => peers, makeAction: () => ({}) }, joinCall: () => {},
      onPeers: (_joined: unknown, left: (peerId: string) => void) => {
        leaves = left;
        return () => {};
      },
    } as unknown as WorkspaceSync;
    backend = new MockBackend({ userId: 1 });
    backend.load(voice);
    link = new VoiceLink("srv-node", backend, sync, 1, { select: () => [] } as unknown as Ledger);
  });
  afterEach(() => { link.close(); vi.useRealTimers(); });

  const inCall = (channel = call) => ({ channel_id: channel, muted: false, deafened: false, sharing: null, camera: false, sound_only: false });
  // A member on their own connection; `onNode`: their presence says their call goes through a node.
  const join = (peerId: string, userId: number, onNode: boolean, channel = call) => {
    peers[peerId] ??= {
      connectionState: "connected", signalingState: "stable", senders: [], changes: [],
      getSenders() { return this.senders; }, addEventListener() {},
    };
    presence({ userId, row: inCall(channel), node: onNode }, peerId);
  };
  const mic = fakeTrack("audio");
  const own = () => ({ mic: fakeStream(mic), camera: null, screen: null }) as never;
  const sendsTo = (peerId: string) => peers[peerId].senders.length > 0;

  it("takes its mesh copies back from members whose call goes through the node too", () => {
    join("p2", 2, false);
    link.setLocal(call, own());
    expect(sendsTo("p2")).toBe(true);
    node.announce("sfu");
    // Until p2 says it is on the node too, the mesh copy stays: neither side has a gap.
    expect(sendsTo("p2")).toBe(true);
    join("p2", 2, true);
    expect(sendsTo("p2")).toBe(false);
  });

  it("keeps sending to, and playing, a member still on the mesh while its own call goes through a node", () => {
    link.setLocal(call, own());
    node.announce("sfu");
    join("p3", 3, false);
    expect(sendsTo("p3")).toBe(true);
    // An incoming stream as Trystero hands it: the link listens for its tracks ending.
    const theirs = { ...fakeStream({ ...fakeTrack("audio"), addEventListener() {} } as never), addEventListener() {} } as unknown as FakeStream;
    stream(theirs, "p3", { kind: "mic" });
    // The store hands back a proxy of the stream: the same stream by id.
    expect(remoteStream("srv-node", 3, "mic")?.id).toBe(theirs.id);
  });

  it("stops sending to a member who left the channel while its call goes through a node", () => {
    link.setLocal(call, own());
    node.announce("sfu");
    join("p4", 4, false);
    expect(sendsTo("p4")).toBe(true);
    join("p4", 4, false, call + 1);
    expect(sendsTo("p4")).toBe(false);
  });

  it("says in its presence whether its call goes through a node", () => {
    link.setLocal(call, own());
    node.announce("sfu");
    expect(sentPresence.at(-1)?.node).toBe(true);
    node.announce("mesh");
    expect(sentPresence.at(-1)?.node).toBe(false);
  });

  // A member's other device not in a call (a view window, another computer) says so: the member is still in the call
  // on the first one, listed and heard. It came and went every time a view window met a member.
  it("keeps a member in the call when another device of the account says it isn't in one", () => {
    link.setLocal(call, own());
    join("p5", 5, false);
    const theirs = { ...fakeStream({ ...fakeTrack("audio"), addEventListener() {} } as never), addEventListener() {} } as unknown as FakeStream;
    stream(theirs, "p5", { kind: "mic" });
    presence({ userId: 5, row: null, refreshMs: 20_000 }, "p5-window");
    expect(backend.data("voice").select("voice_participants", { user_id: 5 })).toHaveLength(1);
    expect(remoteStream("srv-node", 5, "mic")?.id).toBe(theirs.id);
    expect(sendsTo("p5")).toBe(true);
  });

  it("puts a member's row back when its unchanged presence comes after another device of the account cleared it", () => {
    // The other device's word came first, while the one in the call wasn't known yet: the row went.
    backend.data("voice").insert("voice_participants", { user_id: 5, ...inCall() });
    presence({ userId: 5, row: null }, "p5-other");
    expect(backend.data("voice").select("voice_participants", { user_id: 5 })).toHaveLength(0);
    // The device in the call refreshes: its row comes back.
    join("p5", 5, false);
    expect(backend.data("voice").select("voice_participants", { user_id: 5 })).toHaveLength(1);
  });

  it("keeps the streams the node delivers for a member whose app doesn't say it is on a node", () => {
    link.setLocal(call, own());
    node.announce("sfu");
    // An older app: its presence has no `node`, but its call goes through the node like ours.
    peers.p6 = { connectionState: "connected", signalingState: "stable", senders: [], changes: [], getSenders() { return this.senders; }, addEventListener() {} };
    presence({ userId: 6, row: { ...inCall(), camera: true } }, "p6");
    const camera = { ...fakeStream({ ...fakeTrack("video"), addEventListener() {} } as never), addEventListener() {} };
    node.deliver(6, "camera", camera);
    // Anything that shows members again (its presence, our own change) must leave the node's stream alone.
    presence({ userId: 6, row: { ...inCall(), camera: true, muted: true } }, "p6");
    link.setLocal(call, own());
    expect(remoteStream("srv-node", 6, "camera")?.id).toBe(camera.id);
    // And no mesh copy goes to it: the node carries ours to it.
    expect(sendsTo("p6")).toBe(false);
  });

  it("keeps a member's streams from the node when its mesh connection drops (it is still in the call there)", () => {
    link.setLocal(call, own());
    node.announce("sfu");
    join("p8", 8, true);
    const mic = { ...fakeStream({ ...fakeTrack("audio"), addEventListener() {} } as never), addEventListener() {} };
    node.deliver(8, "mic", mic);
    // The direct connection to that member fails (mesh-test s11: "Could not connect to member ..."): its mic from the
    // node was cleared with the mesh's, and the node never delivers it again (its consumer is still alive).
    leaves("p8");
    vi.advanceTimersByTime(95_000);
    expect(remoteStream("srv-node", 8, "mic")?.id).toBe(mic.id);
    expect(backend.data("voice").select("voice_participants", { user_id: 8 })).toHaveLength(1);
    node.deliver(8, "mic", null);
    vi.advanceTimersByTime(1_000);
    expect(backend.data("voice").select("voice_participants", { user_id: 8 })).toHaveLength(0);
  });
});

// Members check that everyone's mic arrives and ask for a missing one again (VoiceLink.heal), and a member's stream
// whose track is replaced under the same object keeps playing.
describe("a call that heals itself", () => {
  let presence: (data: Presence, peerId: string) => void;
  let stream: (stream: FakeStream, peerId: string, meta: { kind: string }) => void;
  let sentPresence: { data: Presence; peer?: string }[];
  let resends: string[];
  let backend: MockBackend;
  let link: VoiceLink;
  let connections: Record<string, RTCPeerConnection>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    sentPresence = [];
    resends = [];
    connections = {};
    const mesh = {
      channel: (_name: string, receive: (data: Presence, peerId: string) => void) => {
        presence = receive;
        return (data: Presence, peer?: string) => sentPresence.push({ data, peer });
      },
      onDirectPeers: () => () => {},
      onStream: (handler: typeof stream) => {
        stream = handler;
        return () => {};
      },
      onPlaced: () => () => {},
      addStream: () => {},
      removeStream: () => {},
      resend: (_sent: FakeStream, target: string) => resends.push(target),
      relayOf: () => null,
      hasQuit: () => false,
      onQuit: () => () => {},
      gone: () => {},
      // p5 has no direct link here (media goes only over one).
      directPeers: () => ["p2", "p3", "p4"],
    };
    const sync = {
      mesh, room: { getPeers: () => connections, makeAction: () => ({}) }, joinCall: () => {}, onPeers: () => () => {},
    } as unknown as WorkspaceSync;
    backend = new MockBackend({ userId: 1 });
    backend.load(voice);
    link = new VoiceLink("srv-heal", backend, sync, 1, { select: () => [] } as unknown as Ledger);
    backend.data("voice").insert("voice_participants", { user_id: 1, ...inCall() });
    link.setLocal(call, { mic: fakeStream(fakeTrack("audio")), camera: null, screen: null } as never);
  });
  afterEach(() => {
    link.close();
    vi.useRealTimers();
  });

  const inCall = (muted = false) => ({ channel_id: call, muted, deafened: false, sharing: null, camera: false, sound_only: false });
  const asks = () => sentPresence.filter((p) => p.data.resend?.includes("mic")).map((p) => p.peer);

  it("asks a member whose mic doesn't arrive to send it again, less often each time, until it arrives", () => {
    presence({ userId: 2, row: inCall() }, "p2");
    vi.advanceTimersByTime(4_000);
    expect(asks()).toEqual(["p2"]);
    vi.advanceTimersByTime(6_000);
    expect(asks()).toEqual(["p2", "p2"]);
    vi.advanceTimersByTime(11_000);
    expect(asks()).toEqual(["p2", "p2"]);
    stream(fakeStream(fakeTrack("audio")), "p2", { kind: "mic" });
    const asked = asks().length;
    vi.advanceTimersByTime(60_000);
    expect(asks()).toHaveLength(asked);
  });

  // Its mic can only come over a direct link: until there is one, asking is no use.
  it("doesn't ask a member it has no direct link to", () => {
    presence({ userId: 5, row: inCall() }, "p5");
    vi.advanceTimersByTime(60_000);
    expect(asks()).toEqual([]);
  });

  it("doesn't ask a muted member (it may have no mic at all)", () => {
    presence({ userId: 3, row: inCall(true) }, "p3");
    vi.advanceTimersByTime(60_000);
    expect(asks()).toEqual([]);
  });

  it("sends its mic again to a member that asks, at most once in a short while", () => {
    presence({ userId: 2, row: inCall() }, "p2");
    presence({ userId: 2, row: inCall(), resend: ["mic"] }, "p2");
    presence({ userId: 2, row: inCall(), resend: ["mic"] }, "p2");
    expect(resends).toEqual(["p2"]);
    vi.advanceTimersByTime(2_000);
    presence({ userId: 2, row: inCall(), resend: ["mic"] }, "p2");
    expect(resends).toEqual(["p2", "p2"]);
  });

  it("answers a member it had no presence from with its own (theirs of ours may be lost too)", () => {
    const toP4 = () => sentPresence.filter((p) => p.peer === "p4");
    presence({ userId: 4, row: inCall() }, "p4");
    expect(toP4()).toEqual([{ data: expect.objectContaining({ userId: 1 }), peer: "p4" }]);
    presence({ userId: 4, row: inCall() }, "p4");
    expect(toP4()).toHaveLength(1);
  });

  it("keeps a member whose track was replaced under the same stream object", () => {
    presence({ userId: 2, row: inCall() }, "p2");
    let tracks = [fakeTrack("audio")];
    const listeners: Record<string, (event?: unknown) => void> = {};
    const theirs = {
      id: "theirs", getTracks: () => tracks, getAudioTracks: () => tracks, getVideoTracks: () => [],
      addEventListener: (type: string, listener: (event?: unknown) => void) => (listeners[type] = listener),
    } as unknown as FakeStream;
    stream(theirs, "p2", { kind: "mic" });
    expect(remoteStream("srv-heal", 2, "mic")?.id).toBe("theirs");
    // Trystero: the old track removed first, the new one added a moment later, on the same stream.
    tracks = [];
    listeners.removetrack();
    expect(remoteStream("srv-heal", 2, "mic")).toBeUndefined();
    tracks = [fakeTrack("audio")];
    listeners.addtrack({ track: tracks[0] });
    expect(remoteStream("srv-heal", 2, "mic")?.id).toBe("theirs");
  });

  // A silent member sends next to nothing (noise gate, Opus DTX), and the connection then flags its live track muted.
  // Asking it to send again renegotiated connections that also carry a share and the workspace's sync, in a loop.
  it("doesn't ask a member whose live mic the connection flagged muted", () => {
    presence({ userId: 2, row: inCall() }, "p2");
    const track = Object.assign(fakeTrack("audio"), { readyState: "live", muted: true });
    stream(fakeStream(track), "p2", { kind: "mic" });
    vi.advanceTimersByTime(120_000);
    expect(asks()).toEqual([]);
  });

  it("refreshes lost join presence promptly even before it knows any other call members", () => {
    sentPresence.length = 0;
    vi.advanceTimersByTime(7_000);
    expect(sentPresence.filter((message) => !message.peer)).toHaveLength(3);
    vi.advanceTimersByTime(5_000);
    expect(sentPresence.filter((message) => !message.peer)).toHaveLength(3);
    link.setLocal(null, { mic: null, camera: null, screen: null });
    sentPresence.length = 0;
    vi.advanceTimersByTime(7_000);
    expect(sentPresence).toEqual([]);
  });

  it("leaves quiet live tracks and short negotiation mutes alone", () => {
    presence({ userId: 2, row: inCall() }, "p2");
    const track = Object.assign(fakeTrack("audio"), { readyState: "live", muted: true });
    stream(fakeStream(track), "p2", { kind: "mic" });
    vi.advanceTimersByTime(7_000);
    track.muted = false;
    vi.advanceTimersByTime(60_000);
    expect(asks()).toEqual([]);
  });

  // The connection carries the workspace's sync and every other stream too: restarting it for one mic cut them all.
  it("never restarts a connection's ICE for a missing mic", () => {
    const restartIce = vi.fn();
    connections.p2 = { signalingState: "stable", connectionState: "connected", restartIce } as unknown as RTCPeerConnection;
    presence({ userId: 2, row: inCall() }, "p2");
    vi.advanceTimersByTime(180_000);
    expect(asks().length).toBeGreaterThan(0);
    expect(restartIce).not.toHaveBeenCalled();
  });

  it("says a member it has no direct link to yet is being connected directly", async () => {
    presence({ userId: 2, row: inCall() }, "p2");
    expect((await link.diagnose(2))[0]).toMatchObject({ "Connection": "connecting directly" });
  });

  // Only callers of this call are linked through its room: nothing is being connected to anyone else.
  it("says nothing of a link to a member in another call", async () => {
    presence({ userId: 3, row: { ...inCall(), channel_id: 99 } }, "p3");
    expect(await link.diagnose(3)).toEqual([]);
  });

  it("diagnoses the playing mic receiver rather than the last audio report on a shared connection", async () => {
    presence({ userId: 2, row: inCall() }, "p2");
    const track = Object.assign(fakeTrack("audio"), { readyState: "live", muted: false });
    stream(fakeStream(track), "p2", { kind: "mic" });
    const row = { type: "inbound-rtp", kind: "audio", bytesReceived: 100, packetsReceived: 2, packetsLost: 0 };
    connections.p2 = {
      connectionState: "connected", signalingState: "stable", getSenders: () => [],
      getReceivers: () => [{ track, getStats: async () => new Map([["mic", row]]) }],
      getStats: async () => new Map([["unrelated", { ...row, bytesReceived: 900_000 }]]),
    } as unknown as RTCPeerConnection;
    expect((await link.diagnose(2))[0]).toMatchObject({ "Mic track": track.id, "Audio in: bytes": 100 });
    vi.advanceTimersByTime(1_000);
    row.bytesReceived = 1100;
    row.packetsReceived = 12;
    expect((await link.diagnose(2))[0]).toMatchObject({
      "Audio in: kbit/s since last sample": 8, "Audio in: ms without packet progress": 0,
    });
  });
});

describe("a hosted bot in a call (guests)", () => {
  type Sent = { stream: FakeStream; target: string; meta: Record<string, unknown> };
  let presence: (data: Presence & { guests?: { userId: number; row: Record<string, unknown> }[] }, peerId: string) => void;
  let sentPresence: { data: Presence & { guests?: { userId: number }[] }; peer?: string }[];
  let added: Sent[];
  let removed: { stream: FakeStream; target: string }[];
  let backend: MockBackend;
  let link: VoiceLink;
  let hostOf: Record<number, number>;
  const botRow = { channel_id: call, muted: false, deafened: false, sharing: null, camera: false, sound_only: false };

  beforeEach(() => {
    node.mode = "mesh";
    node.intents = [];
    sentPresence = [];
    added = [];
    removed = [];
    hostOf = { 50: 2, 60: 1 };
    const mesh = {
      channel: (_name: string, receive: typeof presence) => {
        presence = receive;
        return (data: never, peer?: string) => sentPresence.push({ data, peer });
      },
      onDirectPeers: () => () => {},
      onStream: () => () => {},
      onPlaced: () => () => {},
      addStream: (stream: FakeStream, target: string, meta: Record<string, unknown>) => added.push({ stream, target, meta }),
      removeStream: (stream: FakeStream, target: string) => removed.push({ stream, target }),
      relayOf: () => null,
      hasQuit: () => false,
      onQuit: () => () => {},
      gone: () => {},
      directPeers: () => [],
    };
    const sync = {
      mesh, room: { getPeers: () => ({}), makeAction: () => ({}) },
      onPeers: () => () => {},
      joinCall: () => {},
    } as unknown as WorkspaceSync;
    const ledger = {
      select: (_plugin: string, table: string, where: { user_id?: number }) =>
        table === "bots_bots" ? (where.user_id !== undefined && hostOf[where.user_id] !== undefined ? [{ host: hostOf[where.user_id] }] : []) : [{ sfu_calls: false }],
    } as unknown as Ledger;
    backend = new MockBackend({ userId: 1 });
    backend.load(voice);
    link = new VoiceLink("srv", backend, sync, 1, ledger);
  });

  afterEach(() => link.close());

  const users = () => backend.data("voice").select("voice_participants").map((row) => Number(row.user_id)).sort();

  it("sends its streams, tagged with the bot, to the members in its channel only", () => {
    presence({ userId: 2, row: { ...botRow } }, "p2");
    presence({ userId: 3, row: { ...botRow, channel_id: 99 } }, "p3");
    const sound = fakeStream(fakeTrack("audio"));
    link.setGuest(60, { channelId: call, streams: { mic: sound as never, camera: null, screen: null }, row: botRow });
    expect(added.map((a) => [a.target, a.meta])).toEqual([["p2", { kind: "mic", guest: 60 }]]);
    expect(users()).toContain(60);
    expect(sentPresence.at(-1)!.data.guests).toEqual([{ userId: 60, row: botRow, node: false }]);
    link.setGuest(60, null);
    expect(removed.map((r) => r.target)).toEqual(["p2"]);
    expect(users()).not.toContain(60);
  });

  // The media bot's sound rides in its share's stream (no mic while it shows a picture): a member who doesn't view the
  // call still hears it, and only viewers get the picture.
  it("sends a bot's picture only to the members who view it, its sound to all", () => {
    vi.stubGlobal("MediaStream", FakeMediaStream);
    try {
      presence({ userId: 2, row: { ...botRow }, watching: ["60:screen"] }, "p2");
      presence({ userId: 3, row: { ...botRow }, watching: [] }, "p3");
      const picture = fakeTrack("video");
      const sound = fakeTrack("audio");
      link.setGuest(60, { channelId: call, streams: { mic: null, camera: null, screen: fakeStream(picture, sound) as never }, row: botRow });
      expect(added.map((a) => [a.target, a.meta, a.stream.getTracks()])).toEqual([
        ["p2", { kind: "screen", guest: 60 }, [picture, sound]],
        ["p3", { kind: "screen", guest: 60 }, [sound]],
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows a bot a member hosts as a participant, and takes it out when the member stops listing it", () => {
    presence({ userId: 2, row: null, guests: [{ userId: 50, row: botRow }] }, "p2");
    expect(users()).toEqual([50]);
    presence({ userId: 2, row: null, guests: [] }, "p2");
    expect(users()).toEqual([]);
  });

  it("ignores a bot the sender does not host", () => {
    presence({ userId: 3, row: null, guests: [{ userId: 50, row: botRow }] }, "p3");
    expect(users()).toEqual([]);
  });

  it("sends a bot through the node when the call goes that way, and keeps the mesh for members not on it", () => {
    presence({ userId: 2, row: { ...botRow }, node: true }, "p2");
    presence({ userId: 3, row: { ...botRow } }, "p3");
    node.mode = "sfu";
    const sound = fakeStream(fakeTrack("audio"));
    link.setGuest(60, { channelId: call, streams: { mic: sound as never, camera: null, screen: null }, row: botRow });
    expect(added.map((a) => a.target)).toEqual(["p3"]);
    expect(sentPresence.at(-1)!.data.guests).toEqual([{ userId: 60, row: botRow, node: true }]);
    const [intent] = node.intents.slice(-1);
    expect(intent[0]).toBe(call);
    expect([...(intent[2] as Map<number, unknown>).keys()]).toEqual([60]);
    expect(intent[3]).toBe(false);
  });

  it("plays its own bot on this device", () => {
    const sound = fakeStream(fakeTrack("audio"));
    link.setGuest(60, { channelId: call, streams: { mic: sound as never, camera: null, screen: null }, row: botRow });
    expect(remoteStream("srv", 60, "mic")).toBeTruthy();
    link.setGuest(60, null);
    expect(remoteStream("srv", 60, "mic")).toBeUndefined();
  });
});

// A view window (core/popout.ts) is another peer of the same account that is never in a call: a word from it about
// calls made every member drop the main window's call (ADR 0009). It takes no part in call presence.
describe("a view window's media link", () => {
  it("says nothing about calls: not on connecting, on a direct link, or in answer to a member", () => {
    const sent: unknown[] = [];
    const joined: ((peer: string) => void)[] = [];
    let receive: ((data: Presence, peer: string) => void) | undefined;
    const mesh = {
      channel: (_name: string, handler: typeof receive) => {
        receive = handler;
        return (data: unknown) => sent.push(data);
      },
      onDirectPeers: (handler: (peer: string) => void) => (joined.push(handler), () => {}),
      onStream: () => () => {},
      onPlaced: () => () => {},
      directPeers: () => ["p2"],
    };
    const sync = {
      mesh, room: { getPeers: () => ({}), makeAction: () => ({}) }, joinCall: () => {},
      onPeers: (handler: (peer: string) => void) => (joined.push(handler), () => {}),
    } as unknown as WorkspaceSync;
    const backend = new MockBackend({ userId: 1 });
    backend.load(voice);
    const link = new VoiceLink("srv-window", backend, sync, 1, { select: () => [] } as unknown as Ledger, { presence: false });
    for (const handler of joined) handler("p2");
    receive?.({ userId: 2, row: { channel_id: call, muted: false, deafened: false, sharing: null, camera: false, sound_only: false } }, "p2");
    expect(sent).toEqual([]);
    link.close();
  });
});
