import { copyText } from "../core/clipboard";
import { For, Show, createResource, onCleanup } from "solid-js";
import { currentId, member, myId } from "../core/members";
import { can, canModerate, isMuted, roleTablesOf, rolesOf, workspaceOwner, setMuted, standingOf } from "../core/roles";
import { openChannel } from "../core/navigation";
import { channelLabel, findChannel, workspaceApi, workspaces } from "../core/workspaces";
import { channelType } from "../core/channelTypes";
import { canSee, ruleSource, type VisibilityTarget } from "../p2p/visibility";
import { openSettings, workspacePage, setBotFocus, setSidePanel, showOverlay } from "../core/ui";
import { botTypes } from "../plugins/registry";
import { BotRow } from "./BotCard";
import { Icon } from "../theme/icons";
import InfoPanel, { InfoActions, InfoHeader, InfoRow, InfoSection } from "../ui/InfoPanel";
import SpeakerName from "../voice/SpeakerName";
import type { MenuEntry, MenuItem, MenuSubmenu } from "../ui/contextMenu";
import Avatar from "../ui/Avatar";
import StatusDot from "../ui/StatusDot";
import { onlineStatus } from "../core/onlineStatus";
import { peerStatusOf, peerVersionOf } from "../core/presence";
import { appVersion, newerThanMine } from "../core/version";
import { voiceChannelOf } from "../voice/state";
import Diagnostics from "../voice/Diagnostics";
import { setStreamVolume, setUserVolume, streamVolume, userVolume } from "../voice/volume";
import VolumeSlider from "../voice/VolumeSlider";
import { handleOf } from "../core/userServer";
import { accountIdOf } from "../core/serverless";
import { showNotice } from "../core/notices";
import { isBlockedMember } from "../dm/friends";
import type { MuteKind } from "../p2p/permissions";
import { userMessage } from "../api/client";
import { ConfirmItem } from "./channelMenu";
import { personEntries } from "./personEntries";

// Right-click menu of a member, wherever they are shown.
export function userMenu(workspaceId: string, userId: number): MenuEntry[] {
  userId = currentId(workspaceId, userId);
  const who = member(workspaceId, userId);
  if (who.bot) return botUserMenu(workspaceId, userId, who);
  const voice = voiceChannelOf(workspaceId, userId);
  const voiceChannel = voice === null ? undefined : findChannel(workspaceId, voice);
  return [
    {
      label: "Profile", icon: "profile",
      action: () => setSidePanel({ title: "Profile", render: () => <UserProfile workspaceId={workspaceId} userId={userId} /> }),
    },
    ...(voiceChannel ? [{ label: `Go to ${voiceChannel.name}`, icon: "channel-voice", action: () => openChannel(workspaceId, voiceChannel.id) }] : []),
    ...(voiceChannel && userId !== myId(workspaceId) ? [
      "separator" as const,
      ...volumeEntries(userId),
      {
        label: "Call diagnostics", icon: "info",
        action: () => setSidePanel({ title: "Call diagnostics", render: () => <Diagnostics workspaceId={workspaceId} userId={userId} /> }),
      },
    ] : []),
    ...relationEntries(workspaceId, userId),
    ...moderationEntries(workspaceId, userId),
    ...accessEntries(workspaceId, userId),
    "separator",
    { label: "Copy username", icon: "copy", action: () => void copyText(`${who.username}·${who.tag}`) },
    { label: "Copy name", icon: "copy", action: () => void copyText(who.displayName) },
  ];
}

// A member's voice and the sound they share have their own volumes, on this device.
function volumeEntries(userId: number): MenuEntry[] {
  return [
    { render: () => <VolumeSlider label="Voice" labelWidth="3.6em" value={userVolume(userId)} onChange={(v) => setUserVolume(userId, v)} /> },
    { render: () => <VolumeSlider label="Stream" labelWidth="3.6em" value={streamVolume(userId)} onChange={(v) => setStreamVolume(userId, v)} /> },
  ];
}

function botUserMenu(workspaceId: string, userId: number, who: ReturnType<typeof member>): MenuEntry[] {
  const manage = can(workspaceId, "manage_bots");
  const findBot = async () => {
    const rows = await workspaceApi(workspaceId).plugin("bots").read("bots_bots", { user_id: userId });
    if (!rows[0]) throw new Error("This bot is no longer registered.");
    return rows[0];
  };
  const run = (action: () => Promise<unknown>) => action().catch((e) =>
    showNotice("Bot action failed", userMessage(e)));
  const voice = voiceChannelOf(workspaceId, userId);
  const voiceChannel = voice === null ? undefined : findChannel(workspaceId, voice);
  return [
    { label: "Profile", icon: "profile", action: () => setSidePanel({ title: "Profile", render: () => <UserProfile workspaceId={workspaceId} userId={userId} /> }) },
    ...(voiceChannel ? [
      { label: `Go to ${voiceChannel.name}`, icon: "channel-voice", action: () => openChannel(workspaceId, voiceChannel.id) },
      "separator" as const,
      ...volumeEntries(userId),
      "separator" as const,
    ] : []),
    ...(manage ? [
      {
        label: "Start / stop bot",
        icon: "refresh",
        action: () => run(async () => {
          const row = await findBot();
          await workspaceApi(workspaceId).plugin("bots").call("set-status", {
            id: row.id, status: row.status === "enabled" ? "disabled" : "enabled",
          });
        }),
      },
      { render: () => <ConfirmItem label="Remove bot" icon="delete" question={`Remove ${who.displayName}?`} onConfirm={() => run(async () => {
        const row = await findBot();
        await workspaceApi(workspaceId).plugin("bots").call("remove", { id: row.id });
      }).then(() => undefined)} /> },
    ] : []),
    "separator",
    { label: "Copy username", icon: "copy", action: () => void copyText(handleOf(who)) },
    { label: "Copy name", icon: "copy", action: () => void copyText(who.displayName) },
  ];
}

function relationEntries(workspaceId: string, userId: number): MenuEntry[] {
  if (userId === myId(workspaceId)) return [];
  const id = accountIdOf(workspaceId, userId);
  return id ? ["separator", ...personEntries(id, member(workspaceId, userId).displayName)] : [];
}

// Moderators: mute in calls or in chat, until unmuted.
function moderationEntries(workspaceId: string, userId: number): MenuEntry[] {
  if (!canModerate(workspaceId, userId, "mute_members")) return [];
  const toggle = (kind: MuteKind) => {
    const on = !isMuted(workspaceId, userId, kind);
    return () => void setMuted(workspaceApi(workspaceId), userId, kind, on).catch((e) =>
      showNotice(on ? "Not muted" : "Not unmuted", userMessage(e)));
  };
  return ["separator",
    { label: isMuted(workspaceId, userId, "voice") ? "Unmute in calls" : "Mute in calls", icon: "mic-off", action: toggle("voice") },
    { label: isMuted(workspaceId, userId, "chat") ? "Unmute in chat" : "Mute in chat", icon: "comment", action: toggle("chat") },
  ];
}

// Managers: give this member their own view or edit rule on a category or channel (shell/VisibilityPanel.tsx
// edits all rules). A check marks where they can see or edit, however they got it, and the label says what decides
// it. Their own rule there is removed by choosing it again; access from elsewhere (roles, a rule on the category,
// owner or administrator) is only shown. Without access, choosing it gives them their own rule, which beats roles.
function accessEntries(workspaceId: string, userId: number): MenuEntry[] {
  const server = workspaces.byId[workspaceId];
  if (!server || !can(workspaceId, "manage_channels") || server.allCategories.length === 0) return [];
  const roles = roleTablesOf(workspaceId);
  const owner = workspaceOwner(workspaceId);
  const standing = standingOf(workspaceId, userId);
  const categoryName = (id: number | null) => server.allCategories.find((c) => c.id === id)?.name ?? "the category";
  const roleName = (id?: number) => String(roles.roles.find((r) => r.id === id)?.name ?? "a role");
  const where = (target: VisibilityTarget, id: number) => target === "channel"
    ? { channelId: id, categoryId: server.allChannels.find((c) => c.id === id)?.categoryId ?? null }
    : { categoryId: id };
  const sees = (target: VisibilityTarget, id: number) => canSee(server.visibility, roles, owner, userId, where(target, id));

  // Whether they may, and why, in a few words.
  const decide = (setting: Setting, target: VisibilityTarget, id: number): { on: boolean; own: boolean; why: string } => {
    if (standing.owner) return { on: true, own: false, why: "owner" };
    if (standing.permissions.has("administrator")) return { on: true, own: false, why: "administrator" };
    if (setting === "edit" && !sees(target, id)) return { on: false, own: false, why: "can't see it" };
    const at = where(target, id);
    const source = ruleSource(setting, server.visibility, roles, userId, at);
    if (source) {
      const own = source.subject === "member" && source.at === target;
      const on = source.value;
      const place = source.at === "category" && target === "channel" ? ` on ${categoryName(at.categoryId)}` : "";
      const who = source.subject === "member" ? "their rule" : source.subject === "everyone" ? "@everyone" : `role ${roleName(source.roleId)}`;
      const verb = setting === "visible" ? (on ? "" : "hidden by ") : (on ? "" : "read-only by ");
      return { on, own: own && on, why: own ? (on ? "" : `${verb}their rule`) : `${verb}${who}${place}` };
    }
    if (setting === "visible") return { on: sees(target, id), own: false, why: sees(target, id) ? "role default" : "hidden by role default" };
    // Chat channels need "Send messages"; everything else "Edit content".
    const chat = target === "channel" && server.allChannels.find((c) => c.id === id)?.type === "chat";
    const permission = chat ? "send_messages" : "edit_content";
    const may = standing.permissions.has(permission);
    return { on: may, own: false, why: may ? "workspace permission" : `no ${chat ? "Send messages" : "Edit content"} permission` };
  };

  const toggle = (setting: Setting, target: VisibilityTarget, id: number, on: boolean) => () => {
    void workspaceApi(workspaceId).plugin("channels").call(setting === "visible" ? "set-visibility" : "set-edit", {
      target, target_id: id, subject: "member", subject_id: userId, [setting]: on ? true : null,
    }).catch((e) => showNotice("Permission not changed", userMessage(e)));
  };
  const item = (setting: Setting, target: VisibilityTarget, id: number, label: string, icon: string): MenuItem => {
    const { on, own, why } = decide(setting, target, id);
    const text = why ? `${label} (${why})` : label;
    if (own) return { label: text, icon: "check", action: toggle(setting, target, id, false) };
    if (on) return { label: text, icon: "check", disabled: true, action: () => {} };
    return { label: text, icon, action: toggle(setting, target, id, true) };
  };
  const grant = (setting: Setting, label: string, icon: string): MenuSubmenu => ({
    label, icon,
    items: server.allCategories.map((category) => ({
      label: category.name, icon: "folder",
      items: [
        item(setting, "category", category.id, `All of ${category.name}`, "folder"),
        ...server.allChannels.filter((c) => c.categoryId === category.id)
          .map((c) => item(setting, "channel", c.id, c.name, channelType(c.type).icon)),
      ],
    })),
  });
  return ["separator", grant("visible", "Grant view permission", "visible"), grant("edit", "Grant edit permission", "rename")];
}

type Setting = "visible" | "edit";

function UserProfile(props: { workspaceId: string; userId: number }) {
  const who = () => member(props.workspaceId, props.userId);
  const mine = () => props.userId === myId(props.workspaceId);
  const owner = () => standingOf(props.workspaceId, props.userId).owner;
  const roles = () => rolesOf(props.workspaceId, props.userId);
  const version = () => mine() ? appVersion : peerVersionOf(props.workspaceId, props.userId);
  const voice = () => {
    const id = voiceChannelOf(props.workspaceId, props.userId);
    return id === null ? undefined : findChannel(props.workspaceId, id);
  };
  return (
    <InfoPanel>
      <InfoHeader accent={who().color || undefined}
        media={
          <span class="status-avatar">
            <Avatar user={who()} size={64} />
            <StatusDot status={mine() ? onlineStatus() : peerStatusOf(props.workspaceId, props.userId)} />
          </span>
        }
        title={who().displayName}
        subtitle={<>{handleOf(who())}{mine() ? " (you)" : ""}<Show when={who().nickname}><br />Account name {who().accountName}</Show></>}
      />

      <Show when={mine()}>
        <InfoActions>
          <button class="mw-button mw-box" onClick={() => openSettings("profile")}><Icon name="profile" /> Edit profile</button>
          <button class="mw-button mw-box" onClick={() => showOverlay(workspacePage(props.workspaceId, "profile"))}>
            <Icon name="settings" /> Workspace profile
          </button>
        </InfoActions>
      </Show>

      <Show when={who().bio}>
        <InfoSection title="About me"><p>{who().bio}</p></InfoSection>
      </Show>

      <Show when={who().bot}><BotProfile workspaceId={props.workspaceId} userId={props.userId} /></Show>

      <Show when={owner() || roles().length > 0}>
        <InfoSection title="Roles">
          <div class="user-profile-roles">
            <Show when={owner()}><span class="role-chip mw-box"><Icon name="admin" size={12} /> Owner</span></Show>
            <For each={roles()}>
              {(role) => (
                <span class="role-chip mw-box">
                  <span class="role-dot" style={{ background: String(role.color || "var(--mw-text-disabled)") }} />
                  {String(role.name)}
                </span>
              )}
            </For>
          </div>
        </InfoSection>
      </Show>

      <Show when={isMuted(props.workspaceId, props.userId, "voice") || isMuted(props.workspaceId, props.userId, "chat") || isBlockedMember(props.userId)}>
        <InfoSection title="Restrictions">
          <Show when={isMuted(props.workspaceId, props.userId, "voice")}><InfoRow icon="mic-off">Muted in calls by a moderator</InfoRow></Show>
          <Show when={isMuted(props.workspaceId, props.userId, "chat")}><InfoRow icon="comment">Muted in chat by a moderator</InfoRow></Show>
          <Show when={isBlockedMember(props.userId)}><InfoRow icon="hidden">You blocked them: their messages are hidden</InfoRow></Show>
        </InfoSection>
      </Show>

      <Show when={voice()}>
        {(channel) => (
          <InfoSection title="In a call">
            <InfoRow icon="channel-voice" action={
              <button class="mw-button mw-box" onClick={() => openChannel(props.workspaceId, channel().id)}>Go there</button>
            }>
              <SpeakerName workspaceId={props.workspaceId} userId={props.userId} /> in {channelLabel(props.workspaceId, channel())}
            </InfoRow>
            <Show when={!mine()}>
              <VolumeSlider label="Voice" labelWidth="3.6em" value={userVolume(props.userId)} onChange={(v) => setUserVolume(props.userId, v)} />
              <VolumeSlider label="Stream" labelWidth="3.6em" value={streamVolume(props.userId)} onChange={(v) => setStreamVolume(props.userId, v)} />
            </Show>
          </InfoSection>
        )}
      </Show>

      <Show when={version()}>
        <InfoSection title="MakeWork">
          <InfoRow icon="info">Version {version()}<Show when={newerThanMine(version()!)}> (newer than yours)</Show></InfoRow>
        </InfoSection>
      </Show>

      <InfoActions>
        <button class="mw-button mw-box" onClick={() => void copyText(`${who().username}·${who().tag}`)}>
          <Icon name="copy" /> Copy username
        </button>
      </InfoActions>
    </InfoPanel>
  );
}

// A bot's side of its profile: what it is, and for those who manage bots its settings and what it was just doing.
function BotProfile(props: { workspaceId: string; userId: number }) {
  const api = () => workspaceApi(props.workspaceId).plugin("bots");
  const [row, { refetch }] = createResource(() => props.userId, async (userId) => (await api().read("bots_bots", { user_id: userId }))[0]);
  onCleanup(api().onEvent((event) => { if (event.table === "bots_bots") void refetch(); }));
  const definition = () => botTypes().find((b) => b.id === String(row()?.type));
  const run = async (action: () => Promise<unknown>) => {
    try { await action(); } catch (e) { showNotice("Bot action failed", userMessage(e)); }
  };
  return (
    <Show when={row()}>
      {(bot) => (
        <>
          <InfoSection title={definition()?.type.label ?? String(bot().type)}>
            <Show when={definition()?.type.description}><p>{definition()!.type.description}</p></Show>
            <InfoRow icon="info">
              {bot().status === "enabled" ? "Enabled" : "Disabled"} · runs on {Number(bot().host) === myId(props.workspaceId) ? "your devices" : `${member(props.workspaceId, Number(bot().host)).displayName}'s devices`}
            </InfoRow>
          </InfoSection>
          <InfoActions>
            <button class="mw-button mw-box" onClick={() => { setBotFocus(props.userId); showOverlay(workspacePage(props.workspaceId, "bots")); }}>
              <Icon name="settings" /> Open in workspace settings
            </button>
          </InfoActions>
          <Show when={can(props.workspaceId, "manage_bots")}>
            <BotRow workspaceId={props.workspaceId} row={bot()} reload={async () => void (await refetch())} run={run} />
          </Show>
        </>
      )}
    </Show>
  );
}
