// New chat messages from others on the workspace. Unless you are already looking at that channel, it lights up as
// unread (with a mention count when it names you, core/sidebar.ts). A mention also plays the mention sound and,
// unless you are looking, shows a desktop notification; clicking it opens the message. @everyone and role mentions
// count only while the workspace allows them (core/notifier.ts). A reply in a thread you started plays the
// notification sound and shows a notification when you aren't looking.
import { isBlockedMember } from "../../../dm/friends";
import type { ApiClient } from "../../../api/client";
import { linkUrl, openLink } from "../../../core/links";
import { member, myId } from "../../../core/members";
import { groupMention } from "../../../core/roles";
import { groupMentionsOn, isLooking, notify } from "../../../core/notifier";
import { findChannel, workspaces } from "../../../core/workspaces";
import { markUnread } from "../../../core/sidebar";
import { playSound } from "../../../theme/sounds";
import { getMessage, isMemberEvent, snippet, type ChatMessage } from "./data";

// Synced servers insert old messages when they catch up; only recent ones ping.
const recentMs = 60_000;

export function watchMessages(workspaceId: string, api: ApiClient): void {
  const chat = api.plugin("chat");
  chat.onEvent(async (event) => {
    if (event.table !== "chat_messages" || event.change !== "insert") return;
    const me = myId(workspaceId);
    if (me === null) return;
    const mine = member(workspaceId, me);
    let pinged = false;
    let replied = false;
    for (const id of event.ids) {
      const message = await getMessage(chat, id).catch(() => null);
      if (!message || message.authorId === me || isMemberEvent(message) || Date.now() - Date.parse(message.createdAt) > recentMs) continue;
      if (isBlockedMember(message.authorId)) continue;
      const group = groupMention(workspaceId, message.body, message.authorId);
      const allowed = groupMentionsOn(workspaceId);
      const mentioned = mentions(message.body, mine)
        || (group === "everyone" && allowed.everyone) || (group === "role" && allowed.roles);
      const looking = isLooking(workspaceId, message.channelId);
      if (!looking) markUnread(workspaceId, message.channelId, mentioned);
      if (mentioned) {
        // One sound for messages that arrive together.
        if (!pinged) playSound("mention");
        pinged = true;
        if (!looking) notifyMention(workspaceId, message);
      } else if (!looking && message.threadId !== null && (await getMessage(chat, message.threadId).catch(() => null))?.authorId === me) {
        if (!replied && !pinged) playSound("notification");
        replied = true;
        notifyReply(workspaceId, message);
      }
    }
  });
}

function notifyMention(workspaceId: string, message: ChatMessage) {
  const author = member(workspaceId, message.authorId);
  const channel = findChannel(workspaceId, message.channelId)?.name ?? "chat";
  const server = workspaces.byId[workspaceId]?.info.name ?? "";
  notify({
    tag: `mention:${workspaceId}:${message.channelId}`,
    title: `${author.displayName} mentioned you`,
    body: `#${channel}${server ? ` · ${server}` : ""}\n${snippet(readableMentions(workspaceId, message.body), 140)}`,
    icon: author.avatar.startsWith("data:image/") ? author.avatar : undefined,
    onClick: () => openLink(linkUrl({ workspaceId, channelId: message.channelId, target: { kind: "message", id: message.id } })),
  });
}

function notifyReply(workspaceId: string, message: ChatMessage) {
  const author = member(workspaceId, message.authorId);
  const channel = findChannel(workspaceId, message.channelId)?.name ?? "chat";
  notify({
    tag: `reply:${workspaceId}:${message.threadId}`,
    title: `${author.displayName} replied to you`,
    body: `#${channel}\n${snippet(readableMentions(workspaceId, message.body), 140)}`,
    icon: author.avatar.startsWith("data:image/") ? author.avatar : undefined,
    onClick: () => openLink(linkUrl({ workspaceId, channelId: message.channelId, target: { kind: "message", id: message.id } })),
  });
}

// Whether the text names this member: <@id>, or @username in text from before mentions by id.
export function mentions(body: string, who: { id: number; username: string }): boolean {
  if (body.includes(`<@${who.id}>`)) return true;
  const escaped = who.username.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(String.raw`(^|[^\w@])@${escaped}(?![\w-])`, "i").test(body);
}

// <@id> as @Display Name, for plain text such as notifications.
export function readableMentions(workspaceId: string, body: string): string {
  return body.replace(/<@(\d+)>/g, (_, id: string) => `@${member(workspaceId, Number(id)).displayName}`);
}
