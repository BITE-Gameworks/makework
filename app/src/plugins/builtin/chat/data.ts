import type { Accessor } from "solid-js";
import type { PluginClient } from "../../../api/client";
import type { ApiValue } from "../../../api/types";
import { decodeEmoji, encodeEmoji } from "../../../markdown/emoji";
import type { Upload } from "../../../core/files";
import { createLive } from "../../live";

export interface Attachment {
  id: number;
  name: string;
  mime: string;
  size: number;
  url: string | null;
  thumb: string | null;
  width: number | null;
  height: number | null;
}

export type { ReactionSummary as Reaction } from "../../../ui/Reactions";
import type { ReactionSummary as Reaction } from "../../../ui/Reactions";

export interface Poll {
  multiple: boolean;
  options: { id: number; label: string; count: number; users: number[] }[];
}

export interface PollOptionInput {
  id?: number;
  label: string;
}

export interface ChatMessage {
  id: number;
  channelId: number;
  authorId: number;
  threadId: number | null;
  // join, leave and kick are notes about members (kick: the body is JSON { user_id, name } of who was kicked).
  kind: "message" | "join" | "leave" | "kick" | "move" | "poll";
  body: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  replyCount: number;
  lastReplyAt: string | null;
  reactions: Reaction[];
  attachments: Attachment[];
  poll: Poll | null;
  pinnedBy: number | null;
  buttons: { label: string; command: string; input?: boolean }[];
  action: boolean;
  // A bot's operations before this answer, one per entry.
  steps: string[];
  // Members who replied in the thread, most recent first.
  repliers: number[];
  // Sealed with a channel key this device doesn't have yet (ADR 0021).
  locked: boolean;
  // A thread reply also sent in the channel, with what it answers.
  inChannel: boolean;
  threadParent: { authorId: number | null; body: string } | null;
}

export const isMemberEvent = (m: { kind: ChatMessage["kind"] }) => m.kind === "join" || m.kind === "leave" || m.kind === "kick" || m.kind === "move";

type RawMessage = Record<string, ApiValue> & { reactions: Reaction[]; attachments: Record<string, ApiValue>[]; poll: Poll | null };

function parseButtons(value: unknown): ChatMessage["buttons"] {
  if (typeof value !== "string" || !value) return [];
  try { return JSON.parse(value); } catch { return []; }
}

function parentOf(value: unknown): ChatMessage["threadParent"] {
  if (!value || typeof value !== "object") return null;
  const parent = value as { author_id?: unknown; body?: unknown };
  return { authorId: parent.author_id == null ? null : Number(parent.author_id), body: String(parent.body ?? "") };
}

function toMessage(row: RawMessage): ChatMessage {
  return {
    id: Number(row.id),
    channelId: Number(row.channel_id),
    authorId: Number(row.author_id),
    threadId: row.thread_id === null ? null : Number(row.thread_id),
    kind: ["join", "leave", "kick", "move", "poll"].includes(String(row.kind)) ? row.kind as ChatMessage["kind"] : "message",
    body: String(row.body ?? ""),
    createdAt: String(row.created_at),
    editedAt: row.edited_at ? String(row.edited_at) : null,
    deleted: row.deleted === true,
    replyCount: Number(row.reply_count ?? 0),
    lastReplyAt: row.last_reply_at ? String(row.last_reply_at) : null,
    reactions: row.reactions ?? [],
    attachments: (row.attachments ?? []).map((a) => ({
      id: Number(a.id), name: String(a.name), mime: String(a.mime ?? ""), size: Number(a.size ?? 0),
      url: a.url ? String(a.url) : null, thumb: a.thumb ? String(a.thumb) : null,
      width: a.width === null ? null : Number(a.width), height: a.height === null ? null : Number(a.height),
    })),
    poll: row.poll ?? null,
    buttons: parseButtons(row.buttons),
    action: row.action === true,
    steps: typeof row.steps === "string" && row.steps ? row.steps.split("\n") : [],
    repliers: Array.isArray(row.repliers) ? (row.repliers as ApiValue[]).map(Number) : [],
    pinnedBy: row.pinned_by === null || row.pinned_by === undefined ? null : Number(row.pinned_by),
    locked: row.locked === true,
    inChannel: row.in_channel === true,
    threadParent: parentOf(row.thread_parent),
  };
}

// A channel's top-level messages, or one thread's replies, kept current with the plugin's events.
export function createMessages(api: PluginClient, channelId: number, threadId: Accessor<number | null>) {
  return createLive<ChatMessage[]>(api, [], threadId, async () => {
    const { rows } = await api.call<{ rows: RawMessage[] }>("list-messages", { channel_id: channelId, thread_id: threadId() });
    return rows.map(toMessage);
  });
}

// The thread parent itself; list-messages only lists replies for a thread.
export function createMessage(api: PluginClient, id: Accessor<number>) {
  return createLive<ChatMessage | null>(api, null, id, async () => {
    const { message } = await api.call<{ message: RawMessage }>("get-message", { message_id: id() });
    return toMessage(message);
  });
}

// `inChannel`: a thread reply also shown in the channel.
export async function postMessage(api: PluginClient, channelId: number, threadId: number | null, text: string, uploads: Upload[], inChannel = false) {
  const { id } = await api.call<{ id: number }>("post-message", {
    channel_id: channelId, body: encodeEmoji(text), thread_id: threadId, ...(inChannel && threadId !== null ? { in_channel: true } : {}),
  });
  for (const upload of uploads)
    await api.call("attach", {
      message_id: id, name: upload.file.name, mime: upload.file.type || "application/octet-stream", size: upload.file.size,
      url: upload.url, thumb: upload.thumb, width: upload.width, height: upload.height,
    });
  return id;
}

export function postPoll(api: PluginClient, channelId: number, threadId: number | null, question: string, options: string[], multiple: boolean) {
  return api.call<{ id: number }>("post-poll", {
    channel_id: channelId, thread_id: threadId, question: encodeEmoji(question), options: options.map(encodeEmoji).join("\n"), multiple,
  });
}

export function editPoll(api: PluginClient, messageId: number, question: string, options: PollOptionInput[], multiple: boolean) {
  return api.call<{ updated: number }>("edit-poll", {
    message_id: messageId, question: encodeEmoji(question),
    options: JSON.stringify(options.map((option) => ({ ...option, label: encodeEmoji(option.label) }))), multiple,
  });
}


export const editMessage = (api: PluginClient, id: number, text: string) =>
  api.call<{ updated: number }>("edit-message", { message_id: id, body: encodeEmoji(text) });

export const deleteMessage = (api: PluginClient, id: number) => api.call<{ deleted: number }>("delete-message", { message_id: id });

export const vote = (api: PluginClient, optionId: number) => api.call<{ voted: boolean }>("vote", { option_id: optionId });

export const pinMessage = (api: PluginClient, id: number, pin: boolean) =>
  api.call<{ changed: boolean }>("pin-message", { message_id: id, pin });

// A channel's pinned messages, most recently pinned first.
export function createPins(api: PluginClient, channelId: number) {
  return createLive<ChatMessage[]>(api, [], () => channelId, async () => {
    const { rows } = await api.call<{ rows: RawMessage[] }>("list-pins", { channel_id: channelId });
    return rows.map(toMessage);
  });
}

export async function getMessage(api: PluginClient, id: number): Promise<ChatMessage> {
  const { message } = await api.call<{ message: RawMessage }>("get-message", { message_id: id });
  return toMessage(message);
}

export async function listMessages(api: PluginClient, channelId: number): Promise<ChatMessage[]> {
  const { rows } = await api.call<{ rows: RawMessage[] }>("list-messages", { channel_id: channelId });
  return rows.map(toMessage);
}

// One line of plain text from a message, for link titles.
export function snippet(body: string, length = 60): string {
  const text = decodeEmoji(body).replace(/```[\s\S]*?(```|$)/g, " code ").replace(/\[([^\][]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`>#|]/g, "").replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length - 1)}...` : text || "(no text)";
}

export function react(api: PluginClient, messageId: number, code: string) {
  return api.call<{ added: boolean }>("react", { message_id: messageId, code });
}
