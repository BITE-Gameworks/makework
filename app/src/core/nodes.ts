// The nodes of each server (`nodes` plugin), for Server settings > Nodes and the "node" tag on members.
import { createStore, reconcile } from "solid-js/store";
import { ShownError, type ApiClient } from "../api/client";
import { pagePathRule, validPagePath, type NodeStatus } from "../system/nodes";
import { defaultStorage, stripeLimit } from "../p2p/pieces";
import { defaultCopies } from "../p2p/placement";
import { defaultSfuCapacity, defaultSfuMinMembers } from "../p2p/sfuProtocol";
import { trimEnd } from "./text";

export interface NodeInfo {
  id: number;
  userId: number;
  name: string;
  status: NodeStatus;
  address: string;
  url: string;
  page: string;
  city: string;
  country: string;
  lat: number | null;
  lon: number | null;
  decidedBy: number | null;
  createdAt: string;
}

const [lists, setLists] = createStore<Record<string, NodeInfo[]>>({});
// How the nodes store files and serve calls, per server (nodes_settings; p2p/placement.ts, p2p/pieces.ts, p2p/sfuProtocol.ts).
export type NodeStorage = {
  copies: number;
  stripeMb: number;
  parity: number;
  // Calls through a node (ADR 0005): whether they may go through at all, the call size they start at, how many
  // senders one node takes, and whether they always do (never the mesh, however small).
  sfuCalls: boolean;
  sfuMinMembers: number;
  sfuCapacity: number;
  sfuForced: boolean;
};
const defaults = (): NodeStorage => ({
  copies: defaultCopies, stripeMb: stripeLimit(null) / 1024 / 1024, parity: defaultStorage.parity,
  sfuCalls: true, sfuMinMembers: defaultSfuMinMembers, sfuCapacity: defaultSfuCapacity, sfuForced: false,
});
const [storage, setStorage] = createStore<Record<string, NodeStorage>>({});

export async function loadNodes(workspaceId: string, api: ApiClient): Promise<void> {
  const ext = api.plugin("nodes");
  const load = async () => {
    try {
      const rows = await ext.read("nodes_nodes");
      setLists(workspaceId, reconcile(rows.map(toInfo), { key: "id" }));
      const [settings] = await ext.read("nodes_settings");
      const number = (value: unknown, fallback: number) => (value === null || value === undefined || value === "" ? fallback : Number(value));
      const bool = (value: unknown, fallback: boolean) => (value === null || value === undefined || value === "" ? fallback : !!value);
      const fallback = defaults();
      const stripe = settings?.stripe_mb;
      setStorage(workspaceId, {
        copies: number(settings?.copies, fallback.copies) || fallback.copies,
        // Below the minimum (rows from before it) counts as the minimum, like the nodes read it (p2p/nodes.ts).
        stripeMb: stripeLimit(stripe === null || stripe === undefined || stripe === "" ? null : Number(stripe)) / 1024 / 1024,
        parity: number(settings?.parity, fallback.parity),
        sfuCalls: bool(settings?.sfu_calls, fallback.sfuCalls),
        sfuMinMembers: number(settings?.sfu_min_members, fallback.sfuMinMembers) || fallback.sfuMinMembers,
        sfuCapacity: number(settings?.sfu_capacity, fallback.sfuCapacity) || fallback.sfuCapacity,
        sfuForced: bool(settings?.sfu_forced, fallback.sfuForced),
      });
    } catch (e) {
      console.warn(`Nodes of '${workspaceId}' not loaded:`, e);
    }
  };
  ext.onEvent(() => void load());
  await load();
}

export function forgetNodes(workspaceId: string): void {
  setLists(workspaceId, undefined!);
}

export function nodeStorage(workspaceId: string): NodeStorage {
  return storage[workspaceId] ?? defaults();
}

export function setNodeStorage(api: ApiClient, changes: Partial<NodeStorage>): Promise<unknown> {
  const args: Record<string, number | boolean> = {};
  if (changes.copies !== undefined) args.copies = changes.copies;
  if (changes.stripeMb !== undefined) args.stripe_mb = changes.stripeMb;
  if (changes.parity !== undefined) args.parity = changes.parity;
  if (changes.sfuCalls !== undefined) args.sfu_calls = changes.sfuCalls;
  if (changes.sfuMinMembers !== undefined) args.sfu_min_members = changes.sfuMinMembers;
  if (changes.sfuCapacity !== undefined) args.sfu_capacity = changes.sfuCapacity;
  if (changes.sfuForced !== undefined) args.sfu_forced = changes.sfuForced;
  return api.plugin("nodes").call("set-storage", args);
}

export function nodeList(workspaceId: string): NodeInfo[] {
  return lists[workspaceId] ?? [];
}

export function isNode(workspaceId: string, userId: number): boolean {
  return nodeList(workspaceId).some((n) => n.userId === userId);
}

// Where a node's invite page is, when it has one.
export function nodePage(node: NodeInfo): string | null {
  return node.url && node.page ? `${trimEnd(node.url, "/")}/${node.page}` : null;
}

export function decideNode(api: ApiClient, userId: number, status: NodeStatus): Promise<unknown> {
  return api.plugin("nodes").call("decide", { user_id: userId, status });
}

// The path of a node's invite page on its web server (letters, digits, - and _), "" for none.
export async function setNodePage(api: ApiClient, userId: number, page: string): Promise<unknown> {
  if (!validPagePath(page)) throw new ShownError(pagePathRule);
  return api.plugin("nodes").call("set-page", { user_id: userId, page });
}

export function removeNode(api: ApiClient, userId: number): Promise<unknown> {
  return api.plugin("nodes").call("remove", { user_id: userId });
}

function toInfo(r: Record<string, unknown>): NodeInfo {
  const number = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
  return {
    id: Number(r.id), userId: Number(r.user_id), name: String(r.name ?? ""), status: (r.status as NodeStatus) ?? "pending",
    address: String(r.address ?? ""), url: String(r.url ?? ""), page: String(r.page ?? ""), city: String(r.city ?? ""),
    country: String(r.country ?? ""), lat: number(r.lat), lon: number(r.lon), decidedBy: number(r.decided_by),
    createdAt: String(r.created_at ?? ""),
  };
}
