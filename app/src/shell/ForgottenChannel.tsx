import { Show } from "solid-js";
import { isForgotten, restoreChannel } from "../core/content";
import type { Channel } from "../core/workspaces";
import { Icon } from "../theme/icons";

// A channel forgotten on this device: its signed history rows are still here (the workspace and every member keep
// their own copy), only this device no longer keeps its files. Shown instead of the channel's view, which would
// otherwise fetch the channel's content again the moment it mounts.
export default function ForgottenChannel(props: { workspaceId: string; channel: Channel }) {
  return (
    <div class="view">
      <header class="view-header">
        <h2 class="view-title"><Icon name="cloud-off" /> {props.channel.name}</h2>
      </header>
      <div class="forgotten-channel mw-scroll-fade">
        <p>This channel isn't on this device.</p>
        <p class="hint">
          Its history and files stay on the server and with the people there; only this device no longer keeps
          this channel's files. Files you changed in the readable folder are left alone.
        </p>
        <Show when={isForgotten(props.workspaceId, props.channel.id)}>
          <button class="mw-button primary mw-box" onClick={() => restoreChannel(props.workspaceId, props.channel.id)}>
            <Icon name="download" /> Sync it
          </button>
        </Show>
      </div>
    </div>
  );
}