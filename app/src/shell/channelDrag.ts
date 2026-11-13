// A channel or category being dragged in the channel list, and where it would land.
import { createSignal } from "solid-js";

export interface ChannelDrop {
  categoryId: number;
  beforeId: number | null;   // null: the end of the category
  // What to mark: the row the line shows at, or the category header.
  rowId: number | null;
  edge: "above" | "below" | "into";
}

// Dropping a category header above/below another one. The order is personal, never sent to the workspace.
export interface CategoryDrop {
  beforeId: number | null;   // the category it goes before; null: after the last one
  rowId: number | null;
  edge: "above" | "below";
}

export const [draggedChannel, setDraggedChannel] = createSignal<{ workspaceId: string; channelId: number } | null>(null);
export const [channelDrop, setChannelDrop] = createSignal<ChannelDrop | null>(null);
export const [draggedCategory, setDraggedCategory] = createSignal<{ workspaceId: string; categoryId: number } | null>(null);
export const [categoryDrop, setCategoryDrop] = createSignal<CategoryDrop | null>(null);