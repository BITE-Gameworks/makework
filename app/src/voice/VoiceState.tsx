import { Show } from "solid-js";
import { myId } from "../core/members";
import { Icon } from "../theme/icons";
import { isSpeaking, speakingLevel, type Participant } from "./state";
import { isLocallyMuted, toggleLocalMute } from "./volume";

// Deafened or muted icon, else a dot while speaking that grows with how loud they are. Clicking another member's
// dot mutes them for you only: it turns red and keeps moving while they speak.
export default function VoiceState(props: { workspaceId: string; participant: Participant }) {
  const p = () => props.participant;
  const mine = () => p().userId === myId(props.workspaceId);
  const mutedHere = () => !mine() && isLocallyMuted(p().userId);
  const speaking = () => isSpeaking(props.workspaceId, p().userId);
  const title = () => (mine() ? (speaking() ? "Speaking" : undefined) : mutedHere() ? "Muted for you. Click to hear them again" : "Click to mute for you only");
  return (
    <Show when={!p().deafened} fallback={<span class="voice-state" title="Deafened"><Icon name="headset-off" /></span>}>
      <Show when={!p().muted} fallback={<span class="voice-state" title="Muted"><Icon name="mic-off" /></span>}>
        <Show when={!mine()} fallback={
          <span class="voice-state" title={title()}>
            <span class="voice-dot" classList={{ on: speaking() }} style={{ "--level": speakingLevel(props.workspaceId, p().userId) }} />
          </span>
        }>
          <button class="voice-state voice-state-button" title={title()} aria-label={title()} aria-pressed={mutedHere()}
            onClick={(e) => {
              e.stopPropagation();
              toggleLocalMute(p().userId);
            }}>
            <span class="voice-dot" classList={{ on: speaking(), muted: mutedHere() }}
              style={{ "--level": speakingLevel(props.workspaceId, p().userId) }} />
          </button>
        </Show>
      </Show>
    </Show>
  );
}
