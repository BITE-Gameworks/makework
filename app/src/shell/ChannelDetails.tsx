import { For, Show } from "solid-js";
import { channelType } from "../core/channelTypes";
import { contentSync, isForgotten, isSynced, setSynced } from "../core/content";
import { copyLink, linkUrl } from "../core/links";
import { member } from "../core/members";
import { current, moveToWindow, openChannel, openInNewTab, poppable } from "../core/navigation";
import { canPopOutWindows } from "../core/popout";
import { can } from "../core/roles";
import { findCategory, findChannel, seenBy, setSlowMode, workspaces, type Channel } from "../core/workspaces";
import Select from "../ui/Select";
import { isStarred, isUnread, mentionCount, toggleStar } from "../core/sidebar";
import { isNode } from "../core/nodes";
import { Icon } from "../theme/icons";
import Avatar from "../ui/Avatar";
import { openContextMenu } from "../ui/contextMenu";
import InfoPanel, { InfoActions, InfoHeader, InfoRow, InfoSection } from "../ui/InfoPanel";
import { isInCall, joinVoice, leaveVoice, participants } from "../voice/state";
import SpeakerName from "../voice/SpeakerName";
import { showVisibility, syncableTypes } from "./channelMenu";
import { userMenu } from "./userMenu";

const slowModes = [
  { value: "0", label: "Off" }, { value: "5", label: "5 seconds" }, { value: "10", label: "10 seconds" },
  { value: "30", label: "30 seconds" }, { value: "60", label: "1 minute" }, { value: "300", label: "5 minutes" },
  { value: "900", label: "15 minutes" }, { value: "3600", label: "1 hour" },
];

export default function ChannelDetails(props: { workspaceId: string; channel: Channel }) {
  const channel = () => findChannel(props.workspaceId, props.channel.id) ?? props.channel;
  const type = () => channelType(channel().type);
  const category = () => findCategory(props.workspaceId, channel().categoryId)?.name;
  const here = () => current()?.workspaceId === props.workspaceId && current()?.channelId === channel().id;
  const seen = () => seenBy(props.workspaceId, { channelId: channel().id, categoryId: channel().categoryId });
  const mark = () => ({ kind: "channel" as const, id: channel().id });
  const syncable = () => !!contentSync(props.workspaceId) && syncableTypes.includes(channel().type);
  const inCall = () => (channel().type === "voice" ? participants(props.workspaceId, channel().id) : []);
  const mentions = () => mentionCount(props.workspaceId, channel().id);

  return (
    <InfoPanel>
      <InfoHeader
        media={<span class="icon-tile mw-box"><Icon name={type().icon} size={28} /></span>}
        title={channel().name}
        subtitle={<>{type().label} channel{category() ? ` in ${category()}` : ""} · {workspaces.byId[props.workspaceId]?.info.name}</>}
      />

      <InfoActions>
        <Show when={!here()}>
          <button class="mw-button primary mw-box" onClick={() => openChannel(props.workspaceId, channel().id)}>
            <Icon name={type().icon} /> Open
          </button>
        </Show>
        <button class="mw-button mw-box" onClick={() => openInNewTab({ workspaceId: props.workspaceId, channelId: channel().id })}>
          <Icon name="tab-new" /> New tab
        </button>
        <Show when={poppable({ workspaceId: props.workspaceId, channelId: channel().id }, type())}>
          <button class="mw-button mw-box" disabled={!canPopOutWindows()} onClick={() => moveToWindow(props.workspaceId, channel().id, type())}>
            <Icon name="window-new" /> New window
          </button>
        </Show>
        <button class="mw-button mw-box" onClick={() => copyLink(linkUrl({ workspaceId: props.workspaceId, channelId: channel().id }))}>
          <Icon name="link" /> Copy link
        </button>
      </InfoActions>

      <InfoSection title="For you">
        <InfoRow icon="star" action={
          <button class="mw-button mw-box" onClick={() => toggleStar(props.workspaceId, channel().id)}>
            {isStarred(props.workspaceId, channel().id) ? "Unstar" : "Star"}
          </button>
        }>
          {isStarred(props.workspaceId, channel().id) ? "Starred, at the top of the channel list" : "Not starred"}
        </InfoRow>
        <Show when={isUnread(props.workspaceId, channel().id)}>
          <InfoRow icon="comment">
            New messages{mentions() > 0 ? `, ${mentions()} mentioning you` : ""}
          </InfoRow>
        </Show>
        <Show when={syncable() && !isForgotten(props.workspaceId, channel().id)}>
          <InfoRow icon="download" action={
            <button class="mw-button mw-box" onClick={() => setSynced(props.workspaceId, mark(), !isSynced(props.workspaceId, mark()))}>
              {isSynced(props.workspaceId, mark()) ? "Stop syncing" : "Sync"}
            </button>
          }>
            {isSynced(props.workspaceId, mark())
              ? "Synced: its files are kept on this device"
              : "Not synced: large files download when opened"}
          </InfoRow>
        </Show>
      </InfoSection>

      <Show when={channel().type === "voice"}>
        <InfoSection title={inCall().length ? `In the call (${inCall().length})` : "Call"}>
          <ul class="info-people">
            <For each={inCall().filter((p) => !isNode(props.workspaceId, p.userId))} fallback={<li class="hint">Nobody is here right now.</li>}>
              {(p) => (
                <li class="mw-fade-in">
                  <button type="button" class="info-person mw-box" onClick={(e) => openContextMenu(e, userMenu(props.workspaceId, p.userId))}
                    onContextMenu={(e) => openContextMenu(e, userMenu(props.workspaceId, p.userId))}>
                    <Avatar user={member(props.workspaceId, p.userId)} size={24} />
                    <SpeakerName workspaceId={props.workspaceId} userId={p.userId} />
                    <Show when={p.muted || p.deafened}>
                      <Icon name={p.deafened ? "headset-off" : "mic-off"} size={14} />
                    </Show>
                  </button>
                </li>
              )}
            </For>
          </ul>
          <InfoActions>
            <Show when={isInCall(props.workspaceId, channel().id)} fallback={
              <button class="mw-button primary mw-box" onClick={() => {
                openChannel(props.workspaceId, channel().id);
                void joinVoice(props.workspaceId, channel().id);
              }}><Icon name="channel-voice" /> Join call</button>
            }>
              <button class="mw-button mw-box" onClick={() => void leaveVoice()}><Icon name="hang-up" /> Leave call</button>
            </Show>
          </InfoActions>
        </InfoSection>
      </Show>

      <Show when={channel().type === "chat"}>
        <InfoSection title="Slow mode">
          <InfoRow icon="history" action={
            <Show when={can(props.workspaceId, "manage_channels")}>
              <Select label="Slow mode" options={slowModes} value={String(channel().slowMode)}
                onChange={(value) => void setSlowMode(props.workspaceId, channel().id, Number(value))} />
            </Show>
          }>
            {channel().slowMode > 0
              ? `One message every ${slowModes.find((m) => m.value === String(channel().slowMode))?.label.toLowerCase() ?? `${channel().slowMode} seconds`} per member`
              : "Off"}
          </InfoRow>
        </InfoSection>
      </Show>

      <InfoSection title="Who sees it">
        <InfoRow icon="visible" action={
          <Show when={can(props.workspaceId, "manage_channels")}>
            <button class="mw-button mw-box" onClick={() => showVisibility(props.workspaceId, "channel", channel().id)}>Change</button>
          </Show>
        }>
          {seen().seeing === seen().total ? `Everyone (${seen().total} members)` : `${seen().seeing} of ${seen().total} members`}
        </InfoRow>
      </InfoSection>
    </InfoPanel>
  );
}
