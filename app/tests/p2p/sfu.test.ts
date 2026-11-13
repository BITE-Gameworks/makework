// Calls through a node. The shared parts (src/p2p/sfuProtocol.ts): how the settings read, the mode they decide, the
// join's signed text, and the order members ask the call's nodes in; the node and the client both use these, so both
// agree on which node serves and when a call is an SFU call. Then the member's side (src/p2p/sfu.ts, SfuLink) with
// its screen share: the member's requests go through the app's RoomGroup over the fake network to a fake node that
// answers on its own request action (as node/host.ts does), and a fake mediasoup-client hands the track's media kind
// on, connects a transport on first use and gives each producer a sender that refuses what Chrome's refuses.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "trystero";
import type { Ledger } from "../../src/p2p/ledger";
import { Mesh } from "../../src/p2p/mesh";
import { RoomGroup } from "../../src/p2p/roomGroup";
import { SfuLink } from "../../src/p2p/sfu";
import {
  callNodeOrder, mediaKind, sfuDriven, sfuJoinText, sfuKinds, sfuMutedError, sfuNotifyChannel, sfuRequestChannel, sfuSettings,
  type SfuNotify, type SfuReply, type SfuRequest, type SfuSettings,
} from "../../src/p2p/sfuProtocol";
import type { WorkspaceSync } from "../../src/p2p/sync";
import type { MediaKind } from "../../src/voice/media";
import { fakeStream, fakeTrack, type FakeSender } from "../voice/fakeSender";
import { Network } from "./fakeNetwork";

// What the fake mediasoup-client made, and the nodes the mocked NodeLink reports online (user -> peer).
const media = vi.hoisted(() => ({
  produced: [] as { kind: string; encodings?: RTCRtpEncodingParameters[]; codecOptions?: { opusDtx?: boolean }; stopTracks?: boolean; sender: FakeSender; producer?: { track: unknown; [field: string]: unknown } }[],
  transports: [] as { emit(event: string, ...args: unknown[]): void }[],
  online: new Map<number, string>(),
  authorized: [11] as number[],
  // Whether a transport's connection comes up once connected (false: the node's media port is unreachable, ICE
  // never gets through and the test says when it fails).
  autoConnect: true,
}));

vi.mock("mediasoup-client", async () => {
  const { FakeSender } = await import("../voice/fakeSender");
  type Handler = (data: Record<string, unknown>, callback: (result?: never) => void, errback: (e: Error) => void) => void;
  class Transport {
    private readonly handlers = new Map<string, Handler>();
    private connected = false;
    constructor() {
      media.transports.push(this);
    }
    on(event: string, handler: Handler) {
      this.handlers.set(event, handler);
    }
    emit(event: string, ...args: unknown[]) {
      (this.handlers.get(event) as ((...a: unknown[]) => void) | undefined)?.(...args);
    }
    async produce(options: { track: { kind: "audio" | "video"; id: string }; appData: { kind: string }; encodings?: RTCRtpEncodingParameters[]; codecOptions?: { opusDtx?: boolean }; stopTracks?: boolean }) {
      await this.connect();
      const { id } = await new Promise<{ id: string }>((resolve, reject) =>
        this.handlers.get("produce")!({ kind: options.track.kind, rtpParameters: {}, appData: options.appData }, resolve as never, reject));
      const sender = new FakeSender(options.track, (options.encodings ?? [{}]).map((e) => ({ active: true, ...e })));
      const entry: (typeof media.produced)[number] = { kind: options.appData.kind, encodings: options.encodings, codecOptions: options.codecOptions, stopTracks: options.stopTracks, sender };
      media.produced.push(entry);
      return entry.producer = {
        id, rtpSender: sender, track: options.track, closed: false, on() {},
        async replaceTrack({ track }: { track: never }) {
          this.track = track;
        },
        close() {
          this.closed = true;
        },
      };
    }
    async consume(options: { id: string; kind: "audio" | "video" }) {
      await this.connect();
      return { id: options.id, track: { kind: options.kind, id: options.id, addEventListener() {} }, paused: false, resume: async () => {}, close() {} };
    }
    // Like mediasoup-client: the node is told the DTLS parameters on the first produce or consume, which resolves before
    // ICE and DTLS are up; the connection state says when they are.
    private async connect() {
      if (this.connected) return;
      await new Promise((resolve, reject) => this.handlers.get("connect")!({ dtlsParameters: {} }, resolve as never, reject));
      this.connected = true;
      if (media.autoConnect) setTimeout(() => this.emit("connectionstatechange", "connected"), 0);
    }
    close() {}
  }
  class Device {
    rtpCapabilities = { caps: true };
    // Like mediasoup-client: the router's capabilities by name, an object (given bare, it threw "caps is not an object").
    async load(options: { routerRtpCapabilities?: unknown }) {
      if (typeof options?.routerRtpCapabilities !== "object" || options.routerRtpCapabilities === null) throw new TypeError("caps is not an object");
    }
    async createSendTransport() {
      return new Transport();
    }
    async createRecvTransport() {
      return new Transport();
    }
  }
  return { Device };
});

// One authorized node, online unless a test takes it away.
vi.mock("../../src/p2p/nodes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/p2p/nodes")>()),
  authorizedNodes: () => media.authorized,
  nodeLinkOf: () => ({ onlineNodes: () => media.online }),
}));

// sfuSettings only reads the one nodes_settings row; that is all the ledger it needs.
const ledgerWith = (row: Record<string, unknown> | null): Ledger => ({ select: () => (row ? [row] : []) }) as unknown as Ledger;

describe("sfu settings", () => {
  it("takes the defaults when a server never wrote them", () => {
    expect(sfuSettings(ledgerWith(null))).toEqual({ enabled: true, min: 5, max: 20, forced: false });
  });

  it("reads the stored values", () => {
    const settings = sfuSettings(ledgerWith({ sfu_calls: true, sfu_min_members: 8, sfu_capacity: 30, sfu_forced: true }));
    expect(settings).toEqual({ enabled: true, min: 8, max: 30, forced: true });
  });

  it("turns calls-through-nodes off when the server said so", () => {
    expect(sfuSettings(ledgerWith({ sfu_calls: false })).enabled).toBe(false);
  });

  it("keeps a call worth serving: at least 2 members, at least 1 sender", () => {
    // 1 is below the least a call can be, and garbage falls back to the default rather than to 0.
    expect(sfuSettings(ledgerWith({ sfu_min_members: 1 })).min).toBe(2);
    expect(sfuSettings(ledgerWith({ sfu_min_members: "x" })).min).toBe(5);
    expect(sfuSettings(ledgerWith({ sfu_capacity: 0 })).max).toBe(20);
  });
});

describe("when a call goes through a node", () => {
  const base = (over: Partial<SfuSettings>): SfuSettings => ({ enabled: true, min: 5, max: 20, forced: false, ...over });

  it("stays a mesh below the threshold", () => {
    expect(sfuDriven(base({}), 4)).toBe(false);
    expect(sfuDriven(base({}), 5)).toBe(true);
  });

  it("goes through a node always when forced", () => {
    expect(sfuDriven(base({ forced: true }), 2)).toBe(true);
  });

  it("never goes through a node when the server switched it off", () => {
    expect(sfuDriven(base({ enabled: false, forced: true }), 50)).toBe(false);
  });
});

describe("the call's node order", () => {
  it("is the same on every device, whatever order the nodes arrive in", () => {
    const first = callNodeOrder(7, [11, 22, 33, 44, 55]);
    expect(callNodeOrder(7, [55, 33, 11, 44, 22])).toEqual(first);
    expect(new Set(first).size).toBe(5);
  });

  it("depends on the call, so calls spread over the nodes", () => {
    const orders = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((call) => callNodeOrder(call, [11, 22, 33, 44]).slice(0, 2).join(",")),
    );
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe("what each call kind is for mediasoup", () => {
  it("sends the mic and the shared computer sound as audio, the camera and the screen's picture as video", () => {
    expect(mediaKind("mic")).toBe("audio");
    expect(mediaKind("screen-sound")).toBe("audio");
    expect(mediaKind("camera")).toBe("video");
    expect(mediaKind("screen")).toBe("video");
  });
});

describe("the join's signed text", () => {
  it("covers the server, the call, the user and the time", () => {
    expect(sfuJoinText("srv", 12, 34, 999)).toBe("sfu srv 12 34 999");
  });
});

describe("a member's side of a call through a node: the screen share, a lost node", () => {
  const call = 5;
  // What the node refuses to take from this member (an error text), and what it was asked to take.
  let refuse: (kind: string) => string | null;
  let asked: string[];
  // The producers this member asked the node to close.
  let closes: string[];
  // The node telling this member something (sfu-notify).
  let notify: (notice: SfuNotify) => Promise<void>;
  let remote: { user: number; kind: MediaKind; stream: { getTracks(): unknown[] } | null }[];
  // Set to make the view callback throw once (a broken view somewhere in the app).
  let viewThrows: boolean;
  // Set to have every node answer a join "busy", or answer like a node from before screen sound (no `kinds`).
  let busy: boolean;
  let oldNode: boolean;
  // Set to have the nodes at capacity: they take a member only as its last resort.
  let fullUnlessLast: boolean;
  // How many consumes the node answers "not yet" (no data) before it can send them.
  let notYet: number;
  // Set to have the direct connection to the first node joined drop right after its answer, the node still online.
  let dropFirstJoined: boolean;
  let modes: string[];
  // Which node each join went to, and the second node telling this member something.
  let joins: string[];
  let leaves: string[];
  let notifyFrom2: (notice: SfuNotify) => Promise<void>;
  // Requests the nodes answer only once the promise resolves (a slow node), by request type (consume, close, ...).
  const held = new Map<string, Promise<void>>();
  let link: SfuLink;
  let network: Network;
  let mesh: Mesh;
  // The server's nodes_settings row, and telling the link it changed (as the ledger does for a commit).
  let settings: Record<string, unknown>;
  let changeSettings: (row: Record<string, unknown>) => void;

  const answer = (data: SfuRequest): SfuReply => {
    if ("join" in data) return busy || (fullUnlessLast && !data.join.last) ? { serve: false, reason: "busy" } : { serve: true, rtpCapabilities: {}, producers: [], ...(oldNode ? {} : { kinds: sfuKinds }) };
    if ("create" in data) return { ok: true, data: { id: `t-${data.create.kind}`, iceParameters: {}, iceCandidates: [], dtlsParameters: {} } };
    if ("produce" in data) {
      asked.push(data.produce.kind);
      const refusal = refuse(data.produce.kind);
      return refusal ? { ok: false, error: refusal } : { ok: true, data: { id: `p-${data.produce.kind}` } };
    }
    if ("close" in data) closes.push(data.close.id);
    // A node that hasn't got the producer in its router yet (piped in a moment later) answers no data.
    if ("consume" in data && notYet > 0) {
      notYet--;
      return { ok: true, data: null };
    }
    if ("consume" in data) return { ok: true, data: { id: `c-${data.consume.producerId}`, rtpParameters: {}, paused: false } };
    return { ok: true };
  };

  // node has no MediaStream; the link only builds them from tracks.
  beforeAll(() => {
    (globalThis as { MediaStream?: unknown }).MediaStream = class {
      constructor(private readonly tracks: unknown[]) {}
      getTracks() {
        return this.tracks;
      }
    };
  });
  afterAll(() => {
    delete (globalThis as { MediaStream?: unknown }).MediaStream;
  });

  beforeEach(() => {
    media.produced.length = 0;
    media.transports.length = 0;
    media.online = new Map([[11, "nodePeer"]]);
    media.authorized = [11];
    media.autoConnect = true;
    modes = [];
    joins = [];
    leaves = [];
    held.clear();
    refuse = () => null;
    asked = [];
    closes = [];
    remote = [];
    viewThrows = false;
    busy = false;
    oldNode = false;
    fullUnlessLast = false;
    notYet = 0;
    dropFirstJoined = false;
    // The member's side is the app's RoomGroup over the fake network; the node ("nodePeer", whom the mocked NodeLink
    // reports online) answers on a request action and sends notices on a message action, as node/host.ts does.
    network = new Network();
    const group = new RoomGroup();
    group.add("hub", network.room("me", "hub") as unknown as Room);
    // The member's mesh over the same rooms, as in WorkspaceSync: it says when a direct connection opens or closes.
    mesh = new Mesh(group as never, "me");
    // Two nodes answer alike; only the first is authorized unless a test says otherwise.
    const node = (peer: string) => {
      const room = network.room(peer, "hub");
      room.makeAction(sfuRequestChannel, {
        kind: "request",
        onRequest: (data) => {
          if ("join" in (data as SfuRequest)) joins.push(peer);
          if ("join" in (data as SfuRequest) && dropFirstJoined && joins.length === 1) network.unlink("me", peer, "hub");
          if ("leave" in (data as SfuRequest)) leaves.push(peer);
          const wait = held.get(Object.keys(data as SfuRequest)[0]);
          if (wait) return wait.then(() => answer(data as SfuRequest));
          return answer(data as SfuRequest);
        },
      });
      const notice = room.makeAction(sfuNotifyChannel);
      network.link("me", peer, "hub");
      return (data: SfuNotify) => notice.send(data, { target: "me" });
    };
    notify = node("nodePeer");
    notifyFrom2 = node("nodePeer2");
    // Calls through nodes forced, so even a small call is served.
    settings = { sfu_calls: true, sfu_forced: true };
    const listeners = new Set<(event: { plugin: string; table: string; change: string; ids: number[] }) => void>();
    changeSettings = (row) => {
      settings = row;
      listeners.forEach((l) => l({ plugin: "nodes", table: "nodes_settings", change: "update", ids: [1] }));
    };
    const ledger = {
      select: () => [settings],
      subscribe: (l: never) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    } as unknown as Ledger;
    link = new SfuLink(
      "srv", { room: group, mesh } as unknown as WorkspaceSync, ledger, 1, () => 8, (mode) => modes.push(mode),
      (user, kind, stream) => {
        if (viewThrows) {
          viewThrows = false;
          throw new Error("view broke");
        }
        remote.push({ user, kind, stream: stream as never });
      },
      () => ({ key: { x: "x", y: "y" }, sign: async () => "sig" }),
      // Short waits, so retries happen within a test.
      { joinRetryMs: 300, refusedRetryMs: 300, avoidMs: 200 },
    );
  });
  afterEach(async () => {
    await link.close();
    mesh.close();
  });

  const mic = fakeTrack("audio");
  const picture = fakeTrack("video");
  const sound = fakeTrack("audio");
  const streams = () => ({ mic: fakeStream(mic), camera: null, screen: fakeStream(picture, sound) }) as never;
  const producedOf = (kind: string) => media.produced.find((p) => p.kind === kind);

  it("sends the picture and the sound as their own kinds, one copy at the chosen quality however big the call", async () => {
    link.setQuality({ resolution: 1440, frameRate: 60, favour: "detail", bitrate: "auto" });
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(media.produced.map((p) => p.kind)).toEqual(["mic", "screen", "screen-sound"]));
    expect(asked).toEqual(["mic", "screen", "screen-sound"]);
    expect(producedOf("screen")!.sender.track).toBe(picture);
    expect(producedOf("screen-sound")!.sender.track).toBe(sound);
    expect(producedOf("screen")!.encodings).toEqual([{ maxBitrate: 12_000_000, maxFramerate: 60, priority: "low", networkPriority: "low" }]);
    expect(producedOf("mic")!.encodings).toEqual([{ priority: "high", networkPriority: "high" }]);
    await vi.waitFor(() => expect(producedOf("screen")!.sender.current.degradationPreference).toBe("maintain-resolution"));
    await vi.waitFor(() => expect(producedOf("screen-sound")!.sender.current.encodings[0]).toMatchObject({ maxBitrate: 128_000, priority: "medium" }));
    expect(producedOf("mic")!.sender.sets).toBe(0);
  });

  it("moves a running call to a node when calls through nodes are switched on, and back when they are switched off", async () => {
    settings = { sfu_calls: false };
    link.setIntent(call, streams());
    await new Promise((r) => setTimeout(r, 100));
    expect(joins).toEqual([]);
    changeSettings({ sfu_calls: true, sfu_forced: true });
    await vi.waitFor(() => expect(link.modeOf(call)).toBe("sfu"));
    expect(joins).toEqual(["nodePeer"]);
    changeSettings({ sfu_calls: false });
    await vi.waitFor(() => expect(link.modeOf(call)).toBe("mesh"));
    expect(modes.at(-1)).toBe("mesh");
  });

  it("sends the mic and the computer sound with silence suppression, the picture without", async () => {
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(media.produced.map((p) => p.kind)).toEqual(["mic", "screen", "screen-sound"]));
    expect(producedOf("mic")!.codecOptions).toEqual({ opusDtx: true });
    expect(producedOf("screen-sound")!.codecOptions).toEqual({ opusDtx: true });
    expect(producedOf("screen")!.codecOptions).toBeUndefined();
  });

  it("takes a new quality on the picture already going out", async () => {
    link.setQuality({ resolution: 1080, frameRate: 30, favour: "detail", bitrate: "auto" });
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(producedOf("screen")).toBeDefined());
    link.setQuality({ resolution: 720, frameRate: 60, favour: "motion", bitrate: 10 });
    await vi.waitFor(() => expect(producedOf("screen")!.sender.current.encodings[0]).toMatchObject({ maxBitrate: 10_000_000, maxFramerate: 60 }));
  });

  it("keeps sending the picture to a node that can't carry screen sound (its answer doesn't list it), says so, and never asks", async () => {
    oldNode = true;
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(media.produced.map((p) => p.kind)).toEqual(["mic", "screen"]));
    expect(link.screenSoundRefused()).toBe(true);
    link.setIntent(call, streams());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).not.toContain("screen-sound");
  });

  it("takes a failed screen sound on a node that carries it for a failure, not for a node that can't, and asks again", async () => {
    refuse = (kind) => (kind === "screen-sound" ? "Join the call first." : null);
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(asked).toContain("screen-sound"));
    expect(link.screenSoundRefused()).toBe(false);
    refuse = () => null;
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(media.produced.map((p) => p.kind)).toContain("screen-sound"));
  });

  it("holds back a voice-muted member's mic and sound but not the picture, and sends both once the mute lifts", async () => {
    refuse = (kind) => (mediaKind(kind as never) === "audio" ? sfuMutedError : null);
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(media.produced.map((p) => p.kind)).toEqual(["screen"]));
    expect(link.screenSoundRefused()).toBe(false);
    refuse = () => null;
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(media.produced.map((p) => p.kind).sort()).toEqual(["mic", "screen", "screen-sound"]));
  });

  it("shows another member's screen picture and sound as one stream", async () => {
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(media.produced).toHaveLength(3));
    await notify({ newProducer: { id: "x1", kind: "screen", user: 2 } });
    await notify({ newProducer: { id: "x2", kind: "screen-sound", user: 2 } });
    await vi.waitFor(() => expect(remote.at(-1)?.stream?.getTracks()).toHaveLength(2));
    expect(remote.every((r) => r.user === 2 && r.kind === "screen")).toBe(true);
  });

  it("goes back to the mesh when its node leaves, and joins again once a node answers", async () => {
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(link.modeOf(call)).toBe("sfu"));
    // The node stopped: it drops out of the online nodes, and the mesh's peer change asks the link again.
    media.online = new Map();
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(link.modeOf(call)).toBe("mesh"));
    expect(modes).toEqual(["sfu", "mesh"]);
    media.online = new Map([[11, "nodePeer"]]);
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(link.modeOf(call)).toBe("sfu"));
  });

  it("leaves a node whose transport failed without waiting for the next change, and stays a mesh call without another", async () => {
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(link.modeOf(call)).toBe("sfu"));
    const before = modes.length;
    media.transports[0].emit("connectionstatechange", "failed");
    await vi.waitFor(() => expect(modes.slice(before)).toEqual(["mesh"]));
    // The node is still online and would answer, but it can't carry media: it isn't asked again for now.
    link.setIntent(call, streams());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(joins).toHaveLength(1);
    expect(link.modeOf(call)).toBe("mesh");
  });

  it("keeps the call on the mesh until the node's media connects, holding back what it receives from it", async () => {
    // A node on the member's LAN announcing its public address, its port not forwarded: it answers the join over the
    // mesh, and ICE to its media port never gets through. The call left the mesh at the answer, and nothing came.
    media.autoConnect = false;
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(media.produced).toHaveLength(3));
    await notify({ newProducer: { id: "cam2", kind: "camera", user: 2 } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(link.modeOf(call)).toBe("mesh");
    expect(modes).toEqual([]);
    expect(remote).toEqual([]);
    // Its media gets through: the call leaves the mesh, then shows what came meanwhile.
    media.transports[0].emit("connectionstatechange", "connected");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(link.modeOf(call)).toBe("mesh");
    expect(remote).toEqual([]);
    media.transports[1].emit("connectionstatechange", "connected");
    await vi.waitFor(() => expect(link.modeOf(call)).toBe("sfu"));
    expect(modes).toEqual(["sfu"]);
    await vi.waitFor(() => expect(remote.at(-1)).toMatchObject({ user: 2, kind: "camera" }));
    expect(remote.at(-1)?.stream).not.toBeNull();
  });

  it("returns to mesh while a newly needed receive direction is still connecting", async () => {
    media.autoConnect = false;
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(media.produced).toHaveLength(3));
    // Nobody else is producing yet: only sending needs a connected transport.
    expect(media.transports).toHaveLength(1);
    media.transports[0].emit("connectionstatechange", "connected");
    await vi.waitFor(() => expect(link.modeOf(call)).toBe("sfu"));
    await notify({ newProducer: { id: "mic2", kind: "mic", user: 2 } });
    await vi.waitFor(() => expect(media.transports).toHaveLength(2));
    expect(link.modeOf(call)).toBe("mesh");
    expect(remote).toEqual([]);
    media.transports[1].emit("connectionstatechange", "connected");
    await vi.waitFor(() => expect(link.modeOf(call)).toBe("sfu"));
    expect(modes).toEqual(["sfu", "mesh", "sfu"]);
    expect(remote.at(-1)).toMatchObject({ user: 2, kind: "mic" });
  });

  it("can receive through the node without requiring an unused send transport", async () => {
    media.autoConnect = false;
    link.setIntent(call, { mic: null, camera: null, screen: null });
    await vi.waitFor(() => expect(joins).toHaveLength(1));
    await notify({ newProducer: { id: "mic2", kind: "mic", user: 2 } });
    await vi.waitFor(() => expect(media.transports).toHaveLength(1));
    media.transports[0].emit("connectionstatechange", "connected");
    await vi.waitFor(() => expect(link.modeOf(call)).toBe("sfu"));
    expect(media.produced).toEqual([]);
    expect(remote.at(-1)).toMatchObject({ user: 2, kind: "mic" });
  });

  it("leaves a node whose media never connects, and waits longer each time it fails again", async () => {
    media.autoConnect = false;
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(media.produced).toHaveLength(3));
    // ICE gives up: the member never left the mesh, so nothing changes for the call.
    let failedAt = Date.now();
    media.transports.at(-1)!.emit("connectionstatechange", "failed");
    await vi.waitFor(() => expect(joins).toHaveLength(2), { timeout: 2000 });
    const first = Date.now() - failedAt;
    expect(first).toBeGreaterThanOrEqual(190);
    await vi.waitFor(() => expect(media.produced).toHaveLength(6));
    failedAt = Date.now();
    media.transports.at(-1)!.emit("connectionstatechange", "failed");
    await vi.waitFor(() => expect(joins).toHaveLength(3), { timeout: 2000 });
    expect(Date.now() - failedAt).toBeGreaterThanOrEqual(390);
    expect(modes.filter((mode) => mode === "sfu")).toEqual([]);
  });

  it("switches a restarted mic's new track into the producer, without a second producer", async () => {
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(media.produced).toHaveLength(3));
    const restarted = fakeTrack("audio");
    link.setIntent(call, { mic: fakeStream(restarted), camera: null, screen: fakeStream(picture, sound) } as never);
    await vi.waitFor(() => expect(producedOf("mic")!.producer!.track).toBe(restarted));
    expect(media.produced).toHaveLength(3);
    expect(asked.filter((kind) => kind === "mic")).toHaveLength(1);
    expect(closes).toEqual([]);
  });

  it("never sends an ended track", async () => {
    const ended = { ...fakeTrack("audio"), readyState: "ended" };
    link.setIntent(call, { mic: fakeStream(ended as never), camera: null, screen: null } as never);
    link.setIntent(call, { mic: null, camera: fakeStream(fakeTrack("video")), screen: null } as never);
    await vi.waitFor(() => expect(asked).toEqual(["camera"]));
  });

  it("tells the node when a kind stops, so turning it on again is taken", async () => {
    const camera = fakeTrack("video");
    link.setIntent(call, { mic: null, camera: fakeStream(camera), screen: null } as never);
    await vi.waitFor(() => expect(asked).toEqual(["camera"]));
    link.setIntent(call, { mic: null, camera: null, screen: null } as never);
    await vi.waitFor(() => expect(closes).toEqual(["p-camera"]));
    link.setIntent(call, { mic: null, camera: fakeStream(fakeTrack("video")), screen: null } as never);
    await vi.waitFor(() => expect(asked).toEqual(["camera", "camera"]));
  });

  it("clears another member's camera when the node says its producer closed", async () => {
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(media.produced).toHaveLength(3));
    await notify({ newProducer: { id: "cam2", kind: "camera", user: 2 } });
    await vi.waitFor(() => expect(remote.at(-1)).toMatchObject({ user: 2, kind: "camera" }));
    expect(remote.at(-1)?.stream).not.toBeNull();
    await notify({ producerClosed: { id: "cam2" } });
    await vi.waitFor(() => expect(remote.at(-1)).toEqual({ user: 2, kind: "camera", stream: null }));
  });

  it("never lets a producer stop the app's tracks (the mesh sends them too)", async () => {
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(media.produced).toHaveLength(3));
    // mediasoup-client's default (true) stopped the mic when the link left a node that died.
    expect(media.produced.map((p) => p.stopTracks)).toEqual([false, false, false]);
  });

  it("moves to the next node when its transport to this one fails, instead of joining the same one again", async () => {
    media.authorized = [11, 22];
    media.online = new Map([[11, "nodePeer"], [22, "nodePeer2"]]);
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(media.produced).toHaveLength(3));
    expect(joins).toHaveLength(1);
    // Reachable on the mesh but not for media (its RTC ports blocked): ICE gives up on the transport.
    media.transports[0].emit("connectionstatechange", "failed");
    await vi.waitFor(() => expect(joins).toHaveLength(2));
    expect(joins[1]).not.toBe(joins[0]);
    await vi.waitFor(() => expect(link.modeOf(call)).toBe("sfu"));
  });

  it("moves to the next node when the one it joined can't be reached right after taking it (still online through the mesh)", async () => {
    media.authorized = [11, 22];
    media.online = new Map([[11, "nodePeer"], [22, "nodePeer2"]]);
    // mesh-test s11: the direct connection broke right after the join answer (an SDP glare), while the node's pings
    // still came through the mesh. Every request failed at once, no transport was ever made to fail, and the member
    // stayed on that node, unheard, for 16 minutes.
    dropFirstJoined = true;
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(joins).toHaveLength(2));
    expect(joins[1]).not.toBe(joins[0]);
    await vi.waitFor(() => expect(media.produced).toHaveLength(3));
    expect(link.modeOf(call)).toBe("sfu");
  });

  it("leaves its node as soon as its direct connection to it closes (the node drops it from the call then)", async () => {
    media.authorized = [11, 22];
    media.online = new Map([[11, "nodePeer"], [22, "nodePeer2"]]);
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(media.produced).toHaveLength(3));
    const first = joins[0];
    // mesh-test s11: the connection closed and came back 5 s later, the node had closed this member's transports, and
    // the member stayed in a silent call until ICE gave up 15 s later. No transport fails here.
    network.unlink("me", first, "hub");
    await vi.waitFor(() => expect(joins).toHaveLength(2));
    expect(joins[1]).not.toBe(first);
    await vi.waitFor(() => expect(link.modeOf(call)).toBe("sfu"));
  });

  it("takes notices only from the node it joined", async () => {
    media.authorized = [11, 22];
    media.online = new Map([[11, "nodePeer"], [22, "nodePeer2"]]);
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(media.produced).toHaveLength(3));
    const [joined, other] = joins[0] === "nodePeer" ? [notify, notifyFrom2] : [notifyFrom2, notify];
    await joined({ newProducer: { id: "cam2", kind: "camera", user: 2 } });
    await vi.waitFor(() => expect(remote.at(-1)).toMatchObject({ user: 2, kind: "camera" }));
    const shown = remote.length;
    // Another peer (a node the call isn't on, or any member) can't take a member's camera away or add one.
    await other({ producerClosed: { id: "cam2" } });
    await other({ newProducer: { id: "cam3", kind: "camera", user: 3 } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(remote).toHaveLength(shown);
  });

  it("doesn't keep showing a producer that closed while it was being consumed", async () => {
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(media.produced).toHaveLength(3));
    let release!: () => void;
    held.set("consume", new Promise((resolve) => (release = resolve)));
    await notify({ newProducer: { id: "cam2", kind: "camera", user: 2 } });
    // The member turns the camera off before the node has answered the consume.
    await notify({ producerClosed: { id: "cam2" } });
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const last = remote.filter((r) => r.user === 2 && r.kind === "camera").at(-1);
    expect(last?.stream ?? null).toBeNull();
  });

  it("goes on without waiting for the node to answer a close", async () => {
    link.setIntent(call, { mic: null, camera: fakeStream(fakeTrack("video")), screen: null } as never);
    await vi.waitFor(() => expect(asked).toEqual(["camera"]));
    // The node never answers the close: the camera turned off must not hold up what comes next.
    held.set("close", new Promise(() => {}));
    link.setIntent(call, { mic: null, camera: null, screen: null } as never);
    await notify({ newProducer: { id: "mic2", kind: "mic", user: 2 } });
    await vi.waitFor(() => expect(remote.at(-1)).toMatchObject({ user: 2, kind: "mic" }), { timeout: 2000 });
  });

  it("hangs up when the link closes: tells the node, and stops sending", async () => {
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(media.produced).toHaveLength(3));
    await link.close();
    expect(leaves).toEqual(["nodePeer"]);
    expect(media.produced.every((p) => p.producer?.closed === true)).toBe(true);
    // Nothing joins again once closed.
    link.setIntent(call, streams());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(joins).toHaveLength(1);
  });

  it("keeps working, and still hangs up, after a queued step threw", async () => {
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(media.produced).toHaveLength(3));
    await notify({ newProducer: { id: "cam2", kind: "camera", user: 2 } });
    await vi.waitFor(() => expect(remote.at(-1)).toMatchObject({ user: 2, kind: "camera" }));
    // Clearing the closed camera throws in the view: the steps queued after it must still run.
    viewThrows = true;
    await notify({ producerClosed: { id: "cam2" } });
    await notify({ newProducer: { id: "cam3", kind: "camera", user: 3 } });
    await vi.waitFor(() => expect(remote.at(-1)).toMatchObject({ user: 3, kind: "camera" }), { timeout: 2000 });
    await link.close();
    expect(leaves).toEqual(["nodePeer"]);
  });

  it("runs only the latest of the intents queued meanwhile, and doesn't ask busy nodes again on every change", async () => {
    busy = true;
    // Presence changes in a big call: every one says "this call, these streams" again.
    for (let i = 0; i < 20; i++) link.setIntent(call, streams());
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (let i = 0; i < 20; i++) link.setIntent(call, streams());
    await new Promise((resolve) => setTimeout(resolve, 100));
    // One round of asks: the node, then the same node as the last resort.
    expect(joins).toHaveLength(2);
    expect(link.modeOf(call)).toBe("mesh");
  });

  it("asks the nodes again when its retry is due, even if that timer runs a moment early", async () => {
    busy = true;
    link.setIntent(call, streams());
    // Asked, then asked again as the last resort: both busy.
    await vi.waitFor(() => expect(joins).toHaveLength(2));
    busy = false;
    // The clock stands still: by the clock the retry is never due, only the timer says it is.
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await vi.waitFor(() => expect(link.modeOf(call)).toBe("sfu"), { timeout: 1000 });
      expect(joins).toHaveLength(3);
    } finally {
      clock.mockRestore();
    }
  });

  it("doesn't ask the node again on every change for a kind it refused (a voice-muted mic), but does in a while", async () => {
    refuse = (kind) => (kind === "mic" ? sfuMutedError : null);
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(asked).toContain("mic"));
    // Presence changes while muted: no new ask (each one is a renegotiation and a request to the node).
    for (let i = 0; i < 10; i++) link.setIntent(call, streams());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked.filter((kind) => kind === "mic")).toHaveLength(1);
    // The mute lifts: asked again once the wait is over, without anything else changing.
    refuse = () => null;
    await vi.waitFor(() => expect(media.produced.map((p) => p.kind)).toContain("mic"), { timeout: 1000 });
  });

  it("runs what the device wants now when a retry timer fires, not the call it was asking for then", async () => {
    busy = true;
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(joins).toHaveLength(2));
    // The nodes change, so it asks again at once, and that answer is slow.
    busy = false;
    let release!: () => void;
    held.set("join", new Promise((resolve) => (release = resolve)));
    media.authorized = [11, 22];
    media.online = new Map([[11, "nodePeer"], [22, "nodePeer2"]]);
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(joins).toHaveLength(3));
    // The member moves to another channel meanwhile, and the old retry timer fires before the answer comes.
    link.setIntent(call + 1, streams());
    await new Promise((resolve) => setTimeout(resolve, 350));
    release();
    await vi.waitFor(() => expect(link.modeOf(call + 1)).toBe("sfu"), { timeout: 2000 });
  });

  it("takes a producer the node announced while its join answer was on the way", async () => {
    let release!: () => void;
    held.set("join", new Promise((resolve) => (release = resolve)));
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(joins).toHaveLength(1));
    // The node took the join (and listed nobody yet); a member starts a camera before the answer arrives.
    await notify({ newProducer: { id: "cam9", kind: "camera", user: 2 } });
    release();
    await vi.waitFor(() => expect(remote.find((r) => r.user === 2 && r.kind === "camera" && r.stream)).toBeDefined(), { timeout: 2000 });
  });

  it("asks again as its last resort when every node it reaches is at capacity, and is taken", async () => {
    fullUnlessLast = true;
    media.authorized = [11, 22];
    media.online = new Map([[11, "nodePeer"], [22, "nodePeer2"]]);
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(link.modeOf(call)).toBe("sfu"));
    // Both asked normally (busy), then the first in the call's order again, as the last resort.
    expect(joins).toHaveLength(3);
    expect(joins[2]).toBe(joins[0]);
  });

  it("keeps a member's new mic when the end of its old one is announced late (it moved node)", async () => {
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(media.produced).toHaveLength(3));
    await notify({ newProducer: { id: "mic-old", kind: "mic", user: 2 } });
    await vi.waitFor(() => expect(remote.at(-1)).toMatchObject({ user: 2, kind: "mic" }));
    // Its node died; it joined another, whose bridge brings the new mic here first.
    await notify({ newProducer: { id: "mic-new", kind: "mic", user: 2 } });
    await vi.waitFor(() => expect(remote.filter((r) => r.user === 2 && r.kind === "mic" && r.stream)).toHaveLength(2));
    const shown = remote.at(-1)!.stream;
    // Only then does this node notice the dead node: the old mic's end must not clear the new one.
    await notify({ producerClosed: { id: "mic-old" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(remote.filter((r) => r.user === 2 && r.kind === "mic").at(-1)?.stream).toBe(shown);
  });

  it("goes back to a member's new mic when the old one it received after it ends (it joined while the old one was still listed)", async () => {
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(media.produced).toHaveLength(3));
    // mesh-test s11: this member joined a node that listed both the moved member's new mic and its old one, piped in
    // from a node that had just died. The old one came last, so it was shown, and its end then cleared the member.
    await notify({ newProducer: { id: "mic-new", kind: "mic", user: 2 } });
    await vi.waitFor(() => expect(remote.at(-1)).toMatchObject({ user: 2, kind: "mic" }));
    const fresh = remote.at(-1)!.stream!.getTracks()[0];
    await notify({ newProducer: { id: "mic-old", kind: "mic", user: 2 } });
    await vi.waitFor(() => expect(remote.filter((r) => r.user === 2 && r.kind === "mic" && r.stream)).toHaveLength(2));
    await notify({ producerClosed: { id: "mic-old" } });
    await vi.waitFor(() => expect(remote.filter((r) => r.user === 2 && r.kind === "mic").at(-1)?.stream?.getTracks()[0]).toBe(fresh));
  });

  it("tries a producer again when the node couldn't send it yet, instead of never receiving it", async () => {
    notYet = 1;
    link.setIntent(call, streams());
    await vi.waitFor(() => expect(media.produced).toHaveLength(3));
    await notify({ newProducer: { id: "mic7", kind: "mic", user: 7 } });
    await vi.waitFor(() => expect(remote.find((r) => r.user === 7 && r.kind === "mic" && r.stream)).toBeDefined(), { timeout: 3000 });
  });
});
