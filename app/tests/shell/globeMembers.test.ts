import { describe, expect, it } from "vitest";
import type { Located, MapPlace } from "../../src/p2p/memberMap";
import { globeMembers, type Answer } from "../../src/shell/globeMembers";

const berlin: MapPlace = { lat: 52.5, lon: 13.4, country: "Germany" };
const belgrade: MapPlace = { lat: 44.8, lon: 20.5, country: "Serbia" };

// A map answer from `peer` of member `user`, `at` ms after the start.
function answer(user: number, peer: string, at: number, more: Partial<Located> = {}): Answer {
  return { user, peer, at, place: belgrade, via: null, peers: [], active: [], nodes: [], ...more };
}

// Member 1 is signed in on peer "here", which doesn't share its place unless `self` is given; now is 1000.
const merge = (answers: Answer[], self: Located | null = null) =>
  globeMembers({ me: 1, ownPeer: "here", self, answers, now: 1000, recentMs: 600 });

describe("globe members", () => {
  it("draws a member running two copies of the app once, where their newer answer puts them", () => {
    const { members } = merge([answer(2, "old", 500, { place: berlin }), answer(2, "new", 900, { place: belgrade, via: 9 })]);
    expect(members).toEqual([{ user: 2, place: belgrade, via: 9, devices: 2, self: false }]);
  });

  it("counts only the peers that answered lately as devices, not a session a restart replaced", () => {
    const { members } = merge([answer(2, "replaced", 100), answer(2, "new", 900)]);
    expect(members[0].devices).toBe(1);
  });

  it("draws you once, where this device puts you, though another copy of yours answered later", () => {
    const self = answer(1, "here", 0, { place: berlin });
    delete self.at;
    const { members } = merge([answer(1, "flatpak", 900, { place: belgrade })], self);
    expect(members).toEqual([{ user: 1, place: berlin, via: null, devices: 2, self: true }]);
  });

  it("draws you from another copy of yours when this device doesn't share its place", () => {
    const { members } = merge([answer(1, "flatpak", 900, { place: belgrade })]);
    expect(members).toEqual([{ user: 1, place: belgrade, via: null, devices: 1, self: true }]);
  });

  it("leaves off a member none of whose peers shares a place", () => {
    expect(merge([answer(3, "a", 800, { place: null }), answer(3, "b", 900, { place: null })]).members).toEqual([]);
  });
});

describe("globe member lines", () => {
  it("joins two members once, whichever of their peers are connected, and never a member to itself", () => {
    const { memberLines } = merge([
      answer(2, "g1", 800, { peers: ["g2", "m1"] }),
      answer(2, "g2", 900, { peers: ["g1", "m1"], active: [["m1", 1]] }),
      answer(3, "m1", 850, { peers: ["g1", "g2"] }),
    ]);
    expect(memberLines).toEqual([{ from: 2, to: 3, flow: 1 }]);
  });

  it("says data flows both ways when two of a member's peers send opposite ways", () => {
    const { memberLines } = merge([
      answer(2, "g1", 800, { peers: ["m1"], active: [["m1", -1]] }),
      answer(2, "g2", 900, { peers: ["m1"], active: [["m1", 1]] }),
      answer(3, "m1", 850),
    ]);
    expect(memberLines).toEqual([{ from: 2, to: 3, flow: 0 }]);
  });

  it("takes the flow the lower member's peers report, the other side's only when they report none", () => {
    const { memberLines } = merge([
      answer(2, "g1", 800, { peers: ["m1"], active: [["m1", 1]] }),
      answer(3, "m1", 850, { active: [["g1", 0]] }),
    ]);
    expect(memberLines).toEqual([{ from: 2, to: 3, flow: 1 }]);
  });

  it("turns a flow round when the higher member reported it", () => {
    const { memberLines } = merge([answer(2, "g1", 800), answer(3, "m1", 850, { peers: ["g1"], active: [["g1", 1]] })]);
    expect(memberLines).toEqual([{ from: 2, to: 3, flow: -1 }]);
  });

  it("joins you to members connected to this device, though this device doesn't share its place", () => {
    const { memberLines } = merge([answer(1, "flatpak", 900, { place: berlin }), answer(3, "m1", 850, { peers: ["here"] })]);
    expect(memberLines).toEqual([{ from: 1, to: 3 }]);
  });

  it("draws no line to a member who isn't on the globe", () => {
    expect(merge([answer(2, "g1", 800, { peers: ["x1"] }), answer(4, "x1", 800, { place: null })]).memberLines).toEqual([]);
  });

  it("links a member to every node any of their peers uses first or exchanges data with", () => {
    const { nodeLines } = merge([answer(2, "g1", 800, { via: 9 }), answer(2, "g2", 900, { via: 9, nodes: [[8, -1], [9, 1]] })]);
    expect(nodeLines).toEqual([{ user: 2, node: 9, flow: 1 }, { user: 2, node: 8, flow: -1 }]);
  });
});
