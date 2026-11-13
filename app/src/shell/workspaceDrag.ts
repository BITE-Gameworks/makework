// A workspace or group tile being dragged in the workspace bar, and where it would land.
import { createSignal } from "solid-js";
import {
  addToGroup, barEntries, groupOfWorkspace, groupToken, moveTopLevel, removeFromGroup, reorderGroupMembers,
  workspaceGroups, type BarEntry,
} from "../core/workspaceGroups";
import { savedWorkspaceOrder } from "../core/workspaceOrder";
import { workspaceList, workspaces } from "../core/workspaces";

export interface DraggedItem {
  kind: "workspace" | "group";
  id: string;
}

export type WorkspaceDrop =
  // Before or after a top-level entry: a workspace id or a `group:<id>` token.
  | { kind: "top"; id: string; edge: "above" | "below" }
  // Before or after a workspace inside a group.
  | { kind: "member"; groupId: string; workspaceId: string; edge: "above" | "below" }
  // On a group tile: into the group (the end of its members), or just before/after the tile.
  | { kind: "into"; groupId: string }
  | { kind: "group-edge"; groupId: string; edge: "above" | "below" }
  // Past the last top-level entry.
  | { kind: "end" };

export const [draggedItem, setDraggedItem] = createSignal<DraggedItem | null>(null);
export const [workspaceDrop, setWorkspaceDrop] = createSignal<WorkspaceDrop | null>(null);

const topTokens = (entries: readonly BarEntry[]) => entries.map((entry) => entry.id);

function nextToken(entries: readonly BarEntry[], token: string): string | null {
  const tokens = topTokens(entries);
  const at = tokens.indexOf(token);
  return at < 0 ? null : tokens[at + 1] ?? null;
}

function leaveGroup(workspaceId: string): void {
  const group = groupOfWorkspace(workspaceId);
  if (group) removeFromGroup(group.id, workspaceId);
}

// Puts a workspace among the top-level entries, workspaces and group tiles alike, before the entry `before` picks
// (null: last). Moving only among the workspaces left a group where it was and put the workspace on the wrong side of it.
function moveOut(workspaceId: string, before: (entries: readonly BarEntry[]) => string | null): void {
  leaveGroup(workspaceId);
  const entries = currentEntries();
  moveTopLevel(workspaceId, before(entries), entries);
}

function connectedMembers(groupId: string): string[] {
  const group = workspaceGroups().find((item) => item.id === groupId);
  if (!group) return [];
  return group.workspaceIds.filter((id) => !!workspaces.byId[id]);
}

// The bar after taking the dragged workspace out of its group, which may have removed the group too.
function currentEntries(): BarEntry[] {
  return barEntries(savedWorkspaceOrder(), workspaceGroups(), workspaceList().map((workspace) => workspace.id));
}

// Drops a workspace on the upper or lower edge of a group tile: it goes just before or just after the group among
// the top-level entries, without pulling the members out.
function dropAroundGroup(workspaceId: string, groupId: string, edge: "above" | "below"): void {
  leaveGroup(workspaceId);
  const entries = currentEntries();
  const token = groupToken(groupId);
  // The group is gone (this workspace was its only member): it is already where the tile was.
  if (!topTokens(entries).includes(token)) return;
  moveTopLevel(workspaceId, edge === "above" ? token : nextToken(entries, token), entries);
}

export function finishWorkspaceDrop(event: DragEvent, entries: readonly BarEntry[]): void {
  const dragged = draggedItem();
  const drop = workspaceDrop();
  setDraggedItem(null);
  setWorkspaceDrop(null);
  if (!dragged || !drop) return;
  event.preventDefault();

  if (dragged.kind === "group") {
    if (drop.kind === "top") {
      moveTopLevel(groupToken(dragged.id), drop.edge === "above" ? drop.id : nextToken(entries, drop.id), entries);
    } else if (drop.kind === "end") {
      moveTopLevel(groupToken(dragged.id), null, entries);
    }
    return;
  }

  const workspaceId = dragged.id;
  switch (drop.kind) {
    case "top": {
      if (drop.id === workspaceId) return;
      moveOut(workspaceId, (current) => (drop.edge === "above" ? drop.id : nextToken(current, drop.id)));
      return;
    }
    case "member": {
      if (drop.workspaceId === workspaceId) return;
      const members = connectedMembers(drop.groupId);
      const at = members.indexOf(drop.workspaceId);
      const before = drop.edge === "above" ? drop.workspaceId : at < 0 ? null : members[at + 1] ?? null;
      if (groupOfWorkspace(workspaceId)?.id === drop.groupId) reorderGroupMembers(drop.groupId, workspaceId, before);
      else addToGroup(drop.groupId, [workspaceId], before);
      return;
    }
    case "into": {
      const group = workspaceGroups().find((item) => item.id === drop.groupId);
      if (!group) return;
      // Dropping a member on its own tile's body puts it at the end of that group.
      if (group.workspaceIds.includes(workspaceId)) reorderGroupMembers(drop.groupId, workspaceId, null);
      else addToGroup(drop.groupId, [workspaceId]);
      return;
    }
    case "group-edge":
      dropAroundGroup(workspaceId, drop.groupId, drop.edge);
      return;
    case "end":
      moveOut(workspaceId, () => null);
      return;
  }
}
