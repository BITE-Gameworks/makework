// A call through a node (calls through a self-hosted SFU, ADR 0005). The node is the single arbiter of a call's
// mode: members ask it to serve with `sfu-join` (signed, so the node can check the member against the ledger), and
// it answers whether it serves (the call is an SFU call) or says the call stays a mesh call. Only the joined call's
// members are asked; the deterministic order comes from p2p/placement.ts (rendezvous hashing over the channel id),
// so everyone asks the same node first, and the first to answer gets the call. The client and the node share this
// file text, so both agree on the shape of every exchange.
import type { Ledger } from "./ledger";
import { rank } from "./placement";

// The action names, used with Trystero's makeAction (the request one from both sides, `onRequest` on the node).
export const sfuRequestChannel = "sfu-request";
export const sfuNotifyChannel = "sfu-notify";

// What one member can send into a call: a screen share is two kinds, its picture and the computer's sound. Nodes from
// before "screen-sound" take it for video and refuse it; the client then sends the picture alone.
export type SfuKind = "mic" | "camera" | "screen" | "screen-sound";

// The media kind mediasoup speaks (ProducerOptions.kind, ConsumerData.kind): a call kind's audio or video. The wire
// keeps the call kind ("mic"/"camera"/"screen"/"screen-sound"); convert only at the mediasoup boundary.
export function mediaKind(kind: SfuKind): "audio" | "video" {
  return kind === "mic" || kind === "screen-sound" ? "audio" : "video";
}

// The node's answer to a voice-muted member's mic or screen sound, which the client asks again once the mute lifts.
export const sfuMutedError = "Your voice is muted in this server.";

// How many members in a voice channel make an SFU call worth it (in nodes_settings, Server settings > Nodes).
export const defaultSfuMinMembers = 5;

// How many members of a call one node takes (`sfu_capacity`). A member past it is answered "busy" and asks the next
// node in the call's order, and the nodes serving the call link to each other (ADR 0007), so it stays one call.
export const defaultSfuCapacity = 20;

// What the settings say about calls through nodes (nodes_settings; add to nodes like copies/storage).
export interface SfuSettings {
  // Whether calls may leave the mesh and go through nodes at all.
  enabled: boolean;
  // A call becomes an SFU call once this many members are in it.
  min: number;
  // How many members of a call one node takes: the next ones go to the next node, which links with it (ADR 0007).
  max: number;
  forced: boolean;
}

// The client's part of a call through nodes.
export interface SfuJoin {
  // The member's user number in the server (as commits write it).
  user: number;
  // The member's public key, so the node can recover the account id.
  key: { x: string; y: string };
  // Server-clock time (agreeing with the ledger's clock, not the device's), covered by `sig`.
  time: number;
  // Signature over `sfuJoinText` with the member's account key.
  sig: string;
  // The channel the call is in (a `channels_channels` row id).
  call: number;
  // Every node this member reaches answered "busy": this ask is its last resort, and the node takes it past its
  // capacity (the nodes serving the call bridge, ADR 0007), so the call stays whole instead of a member falling to
  // the mesh. A member reaches only its node group's nodes, so a call can't always spread over all of them.
  last?: boolean;
  // How many members the asking device sees in the call. The node decides the mode from it: voice presence is peer to
  // peer and local, so the node can't count the call itself (unlike files, which the ledger carries). Every member
  // already computes this (the same count the member list shows), so the node re-checks the setting against it.
  members: number;
}

// What a member asks of the serve node, one request at a time (`id` is whatever the client received from the node:
// a transport id, a producer id, a consumer id).
export type SfuRequest =
  | { join: SfuJoin }
  | { leave: boolean }
  | { create: { kind: "send" | "recv" } }
  | { connect: { id: string; dtlsParameters: unknown } }
  // `as`: a bot this member hosts sends it (the node checks the bots table); its producers carry the bot's user number.
  | { produce: { kind: SfuKind; rtpParameters: unknown; as?: number } }
  | { consume: { producerId: string; rtpCapabilities: unknown } }
  | { resume: { id: string } }
  | { close: { id: string } };

// The kinds a node of this version carries; its `serve` says so, and a member sends only those. A node from before
// `kinds` was said carries no screen sound.
export const sfuKinds: SfuKind[] = ["mic", "camera", "screen", "screen-sound"];

// The node's answer. `join` either serves (with the router's capabilities, who is already sending and the kinds it
// carries) or says the call stays a mesh call; everything else is a plain ack (with the transport or consumer it made)
// or an error.
export type SfuReply =
  | { serve: true; rtpCapabilities: unknown; producers: SfuProducerInfo[]; kinds?: SfuKind[] }
  | { serve: false; reason: "none" | "busy" }
  | { ok: true; data?: Record<string, unknown> | null }
  | { ok: false; error: string };

export interface SfuProducerInfo {
  id: string;
  kind: SfuKind;
  user: number;
}

// What the node tells the members of a call: a member started sending, or one of their producers went away. The
// node is the only one who can say it; consumers in the call hear the same from mediasoup, but this is what lets a
// member start a consumer without asking in a loop.
export type SfuNotify = { newProducer: SfuProducerInfo } | { producerClosed: { id: string } };

// What the member signs over, mirroring how commits sign their author: the request's `time` and the node it is for
// (its account id helps when a member is on several servers at once, though the action goes over one server's mesh).
export function sfuJoinText(workspaceId: string, call: number, user: number, time: number): string {
  return `sfu ${workspaceId} ${call} ${user} ${time}`;
}

// The order members ask nodes for a call: `rank(String(call), users)` in p2p/placement.ts (the same everywhere),
// then the reachable ones in that order.
export function callNodeOrder(call: number, users: number[]): number[] {
  return rank(String(call), users);
}

// The nodes_settings row's call settings, with the defaults where a server never wrote them.
export function sfuSettings(ledger: Ledger): SfuSettings {
  const row = ledger.select("nodes", "nodes_settings", {})[0] ?? {};
  const enabled = row.sfu_calls !== false;
  return {
    enabled,
    min: Math.max(2, Number(row.sfu_min_members) || defaultSfuMinMembers),
    max: Math.max(1, Number(row.sfu_capacity) || defaultSfuCapacity),
    forced: !!row.sfu_forced,
  };
}

// How the settings decide a call's mode once it is a candidate. The node is always the arbiter: it calls this with the
// member count the asking device reported, and the client calls it with its own count before asking, so the two sides
// agree on the label they show.
export function sfuDriven(settings: SfuSettings, members: number): boolean {
  return settings.enabled && (settings.forced || members >= settings.min);
}