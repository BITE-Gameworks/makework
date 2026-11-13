import { copyText } from "../core/clipboard";
import { createSignal } from "solid-js";
import { ApiRequestError, userMessage } from "../api/client";
import { exportChannel } from "../core/channelArchive";
import { channelType } from "../core/channelTypes";
import { closeTabs, moveToWindow, openChannel, openInNewTab, poppable, tabLocation, tabs } from "../core/navigation";
import { can } from "../core/roles";
import { isServerless } from "../core/serverless";
import {
  deleteCategory, deleteChannel, findCategory, renameCategory, renameChannel, workspaces, type Category, type Channel,
} from "../core/workspaces";
import Collapse from "../ui/Collapse";
import { Icon, type IconName } from "../theme/icons";
import ConfirmPrompt from "../ui/ConfirmPrompt";
import { closeContextMenu } from "../ui/contextMenu";
import { saveBlob } from "../ui/download";
import { isStarred, isUnread, markRead, toggleStar } from "../core/sidebar";
import { setSidePanel } from "../core/ui";
import type { MenuEntry } from "../ui/contextMenu";
import { playSound } from "../theme/sounds";
import { isInCall, joinVoice, leaveVoice } from "../voice/state";
import ChannelDetails from "./ChannelDetails";
import VisibilityPanel from "./VisibilityPanel";
import type { VisibilityTarget } from "../p2p/visibility";
import { copyLink, linkUrl } from "../core/links";
import { contentSync, forgetChannel, isForgotten, isSynced, restoreChannel, setSynced } from "../core/content";
import { desktop } from "../core/desktop";
import { diskLayoutFor } from "../plugins/registry";
import { localFolder } from "../plugins/builtin/git/data";
import { newWindowEntry } from "./windowMenu";

// Channel types whose files and attachments can be kept on this device.
export const syncableTypes = ["files", "chat", "design"];
// The same, plus docs: the channels with fetchable content (or a readable folder) that can be forgotten locally.
export const forgettableTypes = [...syncableTypes, "docs", "code"];

// The channel's folder on this computer: a git working copy, or its folder in the workspace's readable folder.
function folderEntry(workspaceId: string, channel: Channel): MenuEntry[] {
  const working = channel.type === "git" && desktop?.git?.openFolder ? localFolder(workspaceId, channel.id) : null;
  const sync = contentSync(workspaceId);
  const open = working ? () => void desktop!.git!.openFolder(working).catch(() => playSound("error"))
    : desktop?.mirror && sync?.openFolder && diskLayoutFor(channel.type) ? () => sync.openFolder!(channel.id)
      : null;
  return open ? [{ label: "Open in file browser", icon: "folder", action: open }] : [];
}

// Right-click menu of a channel in the channel bar.
export function channelMenu(workspaceId: string, channel: Channel): MenuEntry[] {
  const path = `${findCategory(workspaceId, channel.categoryId)?.name ?? ""}/${channel.name}`;
  const starred = isStarred(workspaceId, channel.id);
  const voice: MenuEntry[] = channel.type !== "voice" ? [] : isInCall(workspaceId, channel.id)
    ? [{ label: "Leave call", icon: "hang-up", danger: true, action: () => void leaveVoice() }]
    : [{ label: "Join call", icon: "channel-voice", action: () => { openChannel(workspaceId, channel.id); void joinVoice(workspaceId, channel.id); } }];
  const mark = { kind: "channel" as const, id: channel.id };
  // Calls stay in the main window, so a voice channel can't be given one (core/navigation.ts `poppable`).
  const windowable = poppable({ workspaceId, channelId: channel.id }, channelType(channel.type));
  const sync = contentSync(workspaceId);
  const forgotten = isForgotten(workspaceId, channel.id);
  const syncing = isSynced(workspaceId, mark);
  const content: MenuEntry[] = !sync || !forgettableTypes.includes(channel.type) ? [] : forgotten ? [
    // A forgotten channel's only content entry: bring it back (which also syncs it: a default join on a files
    // channel would fetch almost nothing).
    "separator",
    { label: "Sync this channel…", icon: "download", action: () => restoreChannel(workspaceId, channel.id) },
  ] : [
    "separator",
    syncing
      ? { label: "Stop syncing", icon: "close", action: () => setSynced(workspaceId, mark, false) }
      : { label: "Sync channel", icon: "download", action: () => setSynced(workspaceId, mark, true) },
    {
      render: () => (
        <ConfirmItem label="Remove from this device…" icon="cloud-off" confirmLabel="Remove"
          question={`Remove #${channel.name} from this device? Its history and files stay with everyone in the workspace; only this device stops keeping them. Files you changed in the readable folder are left alone.`}
          onConfirm={async () => forgetChannel(workspaceId, channel.id)} />
      ),
    },
  ];
  return [
    { label: "Open", icon: channelType(channel.type).icon, action: () => openChannel(workspaceId, channel.id) },
    { label: "Open in new tab", icon: "tab-new", action: () => openInNewTab({ workspaceId, channelId: channel.id }) },
    ...(windowable ? [newWindowEntry("Open in new window", () => moveToWindow(workspaceId, channel.id, channelType(channel.type)))] : []),
    ...folderEntry(workspaceId, channel),
    ...voice,
    ...content,
    "separator",
    { label: starred ? "Unstar" : "Star", icon: "star", action: () => toggleStar(workspaceId, channel.id) },
    { label: "Mark as read", icon: "check", disabled: !isUnread(workspaceId, channel.id), action: () => markRead(workspaceId, channel.id) },
    "separator",
    { label: "Copy link", icon: "link", action: () => copyLink(linkUrl({ workspaceId, channelId: channel.id })) },
    { label: "Copy name", icon: "copy", action: () => void copyText(path) },
    {
      label: "Details", icon: "info",
      action: () => setSidePanel({ title: "Channel details", render: () => <ChannelDetails workspaceId={workspaceId} channel={channel} /> }),
    },
    ...(isServerless(workspaceId) ? [{ label: "Export as .zip", icon: "download", action: () => void exportZip(workspaceId, channel) }] : []),
    ...(can(workspaceId, "manage_channels") ? [{ label: "Permissions", icon: "lock", action: () => showVisibility(workspaceId, "channel", channel.id) }] : []),
    ...(can(workspaceId, "manage_channels") ? ["separator" as const, {
      render: () => (
        <RenameItem value={channel.name} label="Rename channel"
          clean={(name) => name.trim().toLowerCase().replace(/\s+/g, "-")}
          onSave={(name) => renameChannel(workspaceId, channel.id, name)} />
      ),
    }, {
      render: () => (
        <ConfirmItem label="Delete channel" question={`Delete #${channel.name}? It disappears for everyone.`}
          onConfirm={async () => {
            await deleteChannel(workspaceId, channel.id);
            closeTabsOf(workspaceId, [channel.id]);
          }} />
      ),
    }] : []),
  ];
}

async function exportZip(workspaceId: string, channel: Channel) {
  try {
    const { blob, missing } = await exportChannel(workspaceId, channel);
    saveBlob(blob, `${channel.name}.zip`);
    if (missing > 0) console.warn(`${missing} files of #${channel.name} were not on this device and are only referenced.`);
  } catch (e) {
    playSound("error");
    console.warn("Export failed:", e);
  }
}

// Right-click menu of a category header in the channel bar.
export function categoryMenu(workspaceId: string, category: Category, onAddChannel: () => void): MenuEntry[] {
  if (!can(workspaceId, "manage_channels")) return [{ label: "Copy name", icon: "copy", action: () => void copyText(category.name) }];
  const channels = workspaces.byId[workspaceId]?.channels.filter((c) => c.categoryId === category.id) ?? [];
  const what = channels.length === 0 ? "" : channels.length === 1 ? " and its channel" : ` and its ${channels.length} channels`;
  return [
    { label: "Add channel", icon: "add", action: onAddChannel },
    { label: "Copy name", icon: "copy", action: () => void copyText(category.name) },
    { label: "Permissions", icon: "lock", action: () => showVisibility(workspaceId, "category", category.id) },
    "separator",
    {
      render: () => (
        <RenameItem value={category.name} label="Rename category" clean={(name) => name.trim()}
          onSave={(name) => renameCategory(workspaceId, category.id, name)} />
      ),
    },
    {
      render: () => (
        <ConfirmItem label="Delete category" question={`Delete ${category.name}${what}? It disappears for everyone.`}
          onConfirm={async () => {
            await deleteCategory(workspaceId, category.id);
            closeTabsOf(workspaceId, channels.map((c) => c.id));
          }} />
      ),
    },
  ];
}

export function showVisibility(workspaceId: string, target: VisibilityTarget, id: number) {
  setSidePanel({ title: "Permissions", render: () => <VisibilityPanel workspaceId={workspaceId} target={target} id={id} /> });
}

function closeTabsOf(workspaceId: string, channelIds: number[]) {
  closeTabs(tabs().filter((t) => {
    const at = tabLocation(t);
    return at?.workspaceId === workspaceId && at.channelId !== null && channelIds.includes(at.channelId);
  }).map((t) => t.id));
}

// A menu entry that opens a name field inside the menu; Enter saves, Escape cancels.
export function RenameItem(props: { value: string; label: string; clean: (name: string) => string; onSave: (name: string) => Promise<void> }) {
  const [editing, setEditing] = createSignal(false);
  const [name, setName] = createSignal(props.value);
  const [error, setError] = createSignal("");
  let input!: HTMLInputElement;
  const open = () => {
    setEditing(true);
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  };
  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const cleaned = props.clean(name());
    if (!cleaned || cleaned === props.value) return closeContextMenu();
    try {
      await props.onSave(cleaned);
      closeContextMenu();
    } catch (e) {
      setError(e instanceof ApiRequestError && e.code === "invalid_request" ? e.message : userMessage(e));
    }
  };
  return (
    <>
      <button class="mw-menu-item" role="menuitem" onClick={() => (editing() ? setEditing(false) : open())}>
        <Icon name="rename" /> {props.label}
      </button>
      <Collapse open={editing()}>
        <form class="menu-rename" onSubmit={(e) => void save(e)}
          onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setEditing(false))}>
          <input ref={input} class="mw-input mw-box" value={name()} maxLength={64} aria-label={props.label}
            onInput={(e) => setName(e.currentTarget.value)} />
          <button type="submit" class="mw-button primary mw-box" disabled={!props.clean(name())}>Save</button>
        </form>
      </Collapse>
      {error() && <p class="warning mw-menu-note">{error()}</p>}
    </>
  );
}

// A destructive menu entry that asks inside the menu before it acts.
export function ConfirmItem(props: {
  label: string; question: string; onConfirm: () => Promise<void>; icon?: IconName; confirmLabel?: string;
}) {
  const [asking, setAsking] = createSignal(false);
  const [error, setError] = createSignal("");
  const confirm = async () => {
    try {
      await props.onConfirm();
      closeContextMenu();
    } catch (e) {
      setError(userMessage(e));
    }
  };
  return (
    <>
      <button class="mw-menu-item danger" role="menuitem" onClick={() => setAsking(!asking())}>
        <Icon name={props.icon ?? "delete"} /> {props.label}
      </button>
      <ConfirmPrompt open={asking()} question={props.question} confirmLabel={props.confirmLabel ?? "Delete"}
        onConfirm={() => void confirm()} onCancel={() => setAsking(false)} />
      {error() && <p class="warning mw-menu-note">{error()}</p>}
    </>
  );
}
