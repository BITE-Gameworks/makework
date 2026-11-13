// Screen-share quality (src/voice/shareQuality.ts): what each resolution, frame rate, favour and bitrate means for the
// capture and the senders, the upload budget, what a device keeps, and the live line under the control. Expected
// values come from ADR 0025 (sizes, Auto table, a chosen bitrate as the whole upload) and ADR 0019 (the budget).
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyCallPriorities, applyShareQuality, cameraBitrate, captureConstraints, defaultShareQuality, describeBitrate, describeShareStats, effectiveBitrate, loadShareQuality, manualBitrate,
  readOutbound, saveShareQuality, shareQualityFrom, summarizeShare, type OutboundSample, type ShareQuality, type ShareStats,
} from "../../src/voice/shareQuality";
import { FakeSender, fakeTrack } from "./fakeSender";

// core/storage reads localStorage, which node doesn't have.
function fakeStorage(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
  };
  return store;
}

// The share's quality, written out: resolution (by height), frame rate, what to favour, bitrate.
const q = (over: Partial<ShareQuality> = {}): ShareQuality => ({ ...defaultShareQuality, ...over });

describe("the capture", () => {
  // Before the screen is known: a square box, so a portrait screen isn't squeezed into a landscape one.
  it("first asks for at most 32:9 of the chosen height on both sides, at the chosen rate", () => {
    expect(captureConstraints(q({ resolution: 1440, frameRate: 60 }))).toEqual({
      width: { max: 5120 }, height: { max: 5120 }, frameRate: { ideal: 60, max: 60 },
    });
  });

  it("holds a landscape screen's height to the chosen one, its width up to 32:9", () => {
    expect(captureConstraints(q({ resolution: 1080, frameRate: 30 }), { width: 3840, height: 2160 })).toEqual({
      width: { max: 3840 }, height: { max: 1080 }, frameRate: { ideal: 30, max: 30 },
    });
    expect(captureConstraints(q({ resolution: 720 }), { width: 1000, height: 1000 })).toMatchObject({ width: { max: 2560 }, height: { max: 720 } });
  });

  it("holds a portrait screen's width to the chosen height instead, so it stays whole", () => {
    expect(captureConstraints(q({ resolution: 1080 }), { width: 1080, height: 1920 })).toMatchObject({
      width: { max: 1080 }, height: { max: 3840 },
    });
  });
});

describe("effective bitrate", () => {
  it("takes the size and rate's own on Auto, whatever the favour", () => {
    expect(effectiveBitrate(q({ resolution: 720, frameRate: 30 }), 1).bitrate).toBe(2_000_000);
    expect(effectiveBitrate(q({ resolution: 720, frameRate: 60 }), 1).bitrate).toBe(3_000_000);
    expect(effectiveBitrate(q({ resolution: 1080, frameRate: 30 }), 1).bitrate).toBe(4_000_000);
    expect(effectiveBitrate(q({ resolution: 1080, frameRate: 60 }), 1).bitrate).toBe(7_000_000);
    expect(effectiveBitrate(q({ resolution: 1440, frameRate: 30 }), 1).bitrate).toBe(7_000_000);
    expect(effectiveBitrate(q({ resolution: 1440, frameRate: 60, favour: "detail" }), 1).bitrate).toBe(12_000_000);
  });

  it("sends one copy at the chosen bitrate, and doesn't call it lowered", () => {
    expect(effectiveBitrate(q({ bitrate: 30 }), 1)).toEqual({ bitrate: 30_000_000, capped: false });
    expect(effectiveBitrate(q({ bitrate: 2.5 }), 0)).toEqual({ bitrate: 2_500_000, capped: false });
  });

  // ADR 0025: a chosen bitrate is the whole upload, split between the copies, never more in all than chosen.
  it("splits a chosen bitrate between the viewers' copies, and says so", () => {
    expect(effectiveBitrate(q({ bitrate: 10 }), 4))
      .toEqual({ bitrate: 2_500_000, capped: true, reason: "2.5 Mbit/s each for 4 viewers" });
    expect(effectiveBitrate(q({ bitrate: 20 }), 3))
      .toEqual({ bitrate: 6_600_000, capped: true, reason: "6.6 Mbit/s each for 3 viewers" });
  });

  it("keeps a chosen bitrate's copies at half a megabit at least", () => {
    expect(effectiveBitrate(q({ bitrate: 2 }), 10))
      .toEqual({ bitrate: 500_000, capped: true, reason: "0.5 Mbit/s each for 10 viewers" });
  });

  // ADR 0019: on Auto each copy gets the Auto rate, all of them together within 8 Mbit/s.
  it("keeps Auto's copies together within the upload budget, and says why", () => {
    expect(effectiveBitrate(q(), 2)).toEqual({ bitrate: 4_000_000, capped: false });
    expect(effectiveBitrate(q({ resolution: 720, frameRate: 60 }), 2)).toEqual({ bitrate: 3_000_000, capped: false });
    expect(effectiveBitrate(q({ resolution: 1440, frameRate: 60 }), 3))
      .toEqual({ bitrate: 2_700_000, capped: true, reason: "lowered to 2.7 Mbit/s for 3 viewers" });
  });

  it("goes down to half a megabit a copy on Auto, and no lower", () => {
    expect(effectiveBitrate(q(), 16)).toEqual({ bitrate: 500_000, capped: true, reason: "lowered to 0.5 Mbit/s for 16 viewers" });
    expect(effectiveBitrate(q(), 40).bitrate).toBe(500_000);
  });
});

describe("the bitrate reading", () => {
  it("names what Auto works out to, and a chosen bitrate as it is", () => {
    expect(describeBitrate(q({ resolution: 1440, frameRate: 60 }), 1)).toBe("Auto (12 Mbit/s)");
    expect(describeBitrate(q({ bitrate: 15 }), 1)).toBe("15 Mbit/s");
    expect(describeBitrate(q({ bitrate: 15 }), 0)).toBe("15 Mbit/s");
  });

  it("says what each copy gets when there are several, and the real total when the floor raised it", () => {
    expect(describeBitrate(q(), 3)).toBe("Auto (2.7 Mbit/s each)");
    expect(describeBitrate(q({ bitrate: 15 }), 4)).toBe("15 Mbit/s in all, 3.7 each");
    expect(describeBitrate(q({ bitrate: 2 }), 10)).toBe("5 Mbit/s in all, 0.5 each");
  });
});

describe("leaving Auto", () => {
  it("starts the bitrate at the stop nearest what Auto gave", () => {
    expect(manualBitrate(q({ resolution: 1440, frameRate: 60 }), 1)).toBe(12);
    expect(manualBitrate(q({ resolution: 1080, frameRate: 60 }), 0)).toBe(7);
    expect(manualBitrate(q({ resolution: 720, frameRate: 30, bitrate: 15 }), 3)).toBe(15);
  });

  // A chosen bitrate is the whole upload (ADR 0025), so it starts at what Auto's copies used together.
  it("starts at what all the copies used together, so no viewer's picture drops", () => {
    expect(manualBitrate(q(), 2)).toBe(8);
    expect(manualBitrate(q(), 4)).toBe(8);
    expect(manualBitrate(q({ resolution: 720, frameRate: 60 }), 2)).toBe(6);
  });

  it("takes the higher stop when two are as near, so no picture drops", () => {
    // 18 viewers on Auto: half a megabit each (the floor), 9 in all, as near 8 as 10.
    expect(manualBitrate(q(), 18)).toBe(10);
  });
});

describe("camera bitrate", () => {
  it("shares 3 Mbit/s between the copies, at most 1.5 and at least a quarter megabit each", () => {
    expect(cameraBitrate(1)).toBe(1_500_000);
    expect(cameraBitrate(2)).toBe(1_500_000);
    expect(cameraBitrate(3)).toBe(1_000_000);
    expect(cameraBitrate(12)).toBe(250_000);
    expect(cameraBitrate(30)).toBe(250_000);
  });
});

describe("kept on this device", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = fakeStorage();
  });

  it("starts at 1080p, 30 fps, balanced, on Auto", () => {
    expect(loadShareQuality()).toEqual({ resolution: 1080, frameRate: 30, favour: "balanced", bitrate: "auto" });
    expect(defaultShareQuality).toEqual({ resolution: 1080, frameRate: 30, favour: "balanced", bitrate: "auto" });
  });

  it("comes back as it was saved", () => {
    saveShareQuality({ resolution: 1440, frameRate: 60, favour: "detail", bitrate: 25 });
    expect(loadShareQuality()).toEqual({ resolution: 1440, frameRate: 60, favour: "detail", bitrate: 25 });
    saveShareQuality({ resolution: 720, frameRate: 30, favour: "motion", bitrate: "auto" });
    expect(loadShareQuality()).toEqual({ resolution: 720, frameRate: 30, favour: "motion", bitrate: "auto" });
  });

  it("carries over what an older version saved (a profile and a maximum bitrate)", () => {
    store.set("mw.voice.shareQuality", JSON.stringify({ profile: "smooth", maxBitrate: "auto" }));
    expect(loadShareQuality()).toEqual({ resolution: 720, frameRate: 60, favour: "motion", bitrate: "auto" });
    store.set("mw.voice.shareQuality", JSON.stringify({ profile: "balanced", maxBitrate: 4 }));
    expect(loadShareQuality()).toEqual({ resolution: 1080, frameRate: 30, favour: "balanced", bitrate: 4 });
    store.set("mw.voice.shareQuality", JSON.stringify({ profile: "sharp", maxBitrate: 10 }));
    expect(loadShareQuality()).toEqual({ resolution: 1080, frameRate: 30, favour: "detail", bitrate: 10 });
  });

  it("falls back to the default for what it doesn't know", () => {
    store.set("mw.voice.shareQuality", JSON.stringify({ resolution: 2160, frameRate: 120, favour: "constructor", bitrate: 9 }));
    expect(loadShareQuality()).toEqual(defaultShareQuality);
    store.set("mw.voice.shareQuality", JSON.stringify({ profile: "ultra", maxBitrate: 9 }));
    expect(loadShareQuality()).toEqual(defaultShareQuality);
    store.set("mw.voice.shareQuality", JSON.stringify({ resolution: 1440 }));
    expect(loadShareQuality()).toEqual({ ...defaultShareQuality, resolution: 1440 });
    store.set("mw.voice.shareQuality", "null");
    expect(loadShareQuality()).toEqual(defaultShareQuality);
  });
});

describe("a quality from elsewhere", () => {
  it("is held to the choices on offer, like a saved one", () => {
    expect(shareQualityFrom({ resolution: 1440, frameRate: 60, favour: "detail", bitrate: 9 }))
      .toEqual({ resolution: 1440, frameRate: 60, favour: "detail", bitrate: "auto" });
    expect(shareQualityFrom({ profile: "smooth", maxBitrate: 4 })).toEqual({ resolution: 720, frameRate: 60, favour: "motion", bitrate: 4 });
    expect(shareQualityFrom(null)).toEqual(defaultShareQuality);
  });
});

describe("tuning the senders of a share", () => {
  it("gives the picture the bitrate, frame rate and the favour's trade-off, the sound 128 kbit/s, both below voices", async () => {
    const picture = new FakeSender(fakeTrack("video"));
    const sound = new FakeSender(fakeTrack("audio"));
    await applyShareQuality({ video: [picture], audio: [sound] }, q({ resolution: 1440, frameRate: 60, favour: "detail" }), 1);
    expect(picture.current.encodings).toEqual([{ active: true, maxBitrate: 12_000_000, maxFramerate: 60, priority: "low", networkPriority: "low" }]);
    expect(picture.current.degradationPreference).toBe("maintain-resolution");
    expect(sound.current.encodings).toEqual([{ active: true, maxBitrate: 128_000, priority: "medium", networkPriority: "medium" }]);
    expect(sound.current.degradationPreference).toBeUndefined();
  });

  it("holds every copy to its share of the chosen bitrate", async () => {
    const copies = [1, 2, 3, 4].map(() => new FakeSender(fakeTrack("video")));
    await applyShareQuality({ video: copies, audio: [] }, q({ favour: "detail", bitrate: 10 }), copies.length);
    for (const copy of copies) expect(copy.current.encodings[0].maxBitrate).toBe(2_500_000);
  });

  it("puts microphones first and cameras with the pictures", async () => {
    const mic = new FakeSender(fakeTrack("audio"));
    const camera = new FakeSender(fakeTrack("video"));
    await applyCallPriorities({ mic: [mic], camera: [camera] });
    expect(mic.current.encodings).toEqual([{ active: true, priority: "high", networkPriority: "high" }]);
    expect(camera.current.encodings).toEqual([{ active: true, priority: "low", networkPriority: "low" }]);
  });

  it("holds a mesh call's camera copies to their share of the camera budget", async () => {
    const copies = [1, 2, 3].map(() => new FakeSender(fakeTrack("video")));
    await applyCallPriorities({ mic: [], camera: copies }, copies.length);
    for (const copy of copies) expect(copy.current.encodings[0]).toMatchObject({ maxBitrate: 1_000_000, priority: "low" });
  });

  it("leaves a sender that isn't negotiated yet, and one that already has the settings", async () => {
    const early = new FakeSender(fakeTrack("video"), []);
    const picture = new FakeSender(fakeTrack("video"));
    const quality = q();
    await applyShareQuality({ video: [early, picture], audio: [] }, quality, 2);
    await applyShareQuality({ video: [early, picture], audio: [] }, quality, 2);
    expect(early.sets).toBe(0);
    expect(picture.sets).toBe(1);
  });

  it("goes on with the others when one sender refuses", async () => {
    const refusing = new FakeSender(fakeTrack("video"));
    refusing.refuse = true;
    const picture = new FakeSender(fakeTrack("video"));
    await expect(applyShareQuality({ video: [refusing, picture], audio: [] }, q({ resolution: 720, frameRate: 60, favour: "motion" }), 2))
      .resolves.toBeUndefined();
    expect(picture.current.encodings[0]).toMatchObject({ maxBitrate: 3_000_000, maxFramerate: 60 });
  });
});

describe("the live line", () => {
  const sample = (over: Partial<OutboundSample>): OutboundSample => ({ id: "a", at: 1000, bytes: 0, ...over });

  it("reads a sender's report: the picture's numbers and what holds the encoder back", () => {
    const report = new Map<string, Record<string, unknown>>([
      ["T1", { id: "T1", type: "transport", selectedCandidatePairId: "CP1" }],
      ["OT1", {
        id: "OT1", type: "outbound-rtp", kind: "video", timestamp: 2000, bytesSent: 1000, frameWidth: 1920, frameHeight: 1080,
        framesPerSecond: 28, targetBitrate: 4_000_000, qualityLimitationReason: "bandwidth", transportId: "T1",
      }],
    ]) as unknown as RTCStatsReport;
    expect(readOutbound(report)).toEqual({
      id: "OT1", at: 2000, bytes: 1000, width: 1920, height: 1080, fps: 28, target: 4_000_000, limitation: "bandwidth",
    });
    expect(readOutbound(new Map() as unknown as RTCStatsReport)).toBeNull();
  });

  it("measures the bitrate between two polls and shows the copy with the lowest frame rate", () => {
    const before = new Map([["a", sample({ at: 1000, bytes: 0 })], ["b", sample({ id: "b", at: 1000, bytes: 0 })]]);
    const now = [
      sample({ at: 2000, bytes: 512_500, width: 1920, height: 1080, fps: 30, limitation: "none" }),
      sample({ id: "b", at: 2000, bytes: 512_500, width: 1280, height: 720, fps: 24, limitation: "bandwidth" }),
    ];
    expect(summarizeShare(now, before)).toEqual({ width: 1280, height: 720, fps: 24, bitrate: 4_100_000, limitation: "bandwidth" });
  });

  it("takes the encoder's target until there are two polls", () => {
    expect(summarizeShare([sample({ target: 3_000_000 })], new Map()).bitrate).toBe(3_000_000);
  });

  it("reads like the numbers a member wants to see", () => {
    const stats: ShareStats = {
      width: 1920, height: 1080, fps: 28, bitrate: 4_100_000, limitation: "bandwidth", copies: 2, viaNode: false,
      cap: { bitrate: 4_000_000, capped: false }, soundRefused: false,
    };
    expect(describeShareStats(stats)).toBe("1920x1080, 28 fps, 4.1 Mbit/s, limited by bandwidth");
    expect(describeShareStats({ ...stats, limitation: "cpu" })).toBe("1920x1080, 28 fps, 4.1 Mbit/s, limited by the CPU");
    const capped = { ...stats, limitation: undefined, cap: { bitrate: 2_500_000, capped: true, reason: "lowered to 2.5 Mbit/s for 5 viewers" } };
    expect(describeShareStats(capped)).toBe("1920x1080, 28 fps, 4.1 Mbit/s, lowered to 2.5 Mbit/s for 5 viewers");
  });
});
