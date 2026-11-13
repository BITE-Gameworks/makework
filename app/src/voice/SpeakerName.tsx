import { member } from "../core/members";
import { isSpeaking, notConnected } from "./state";

// A call participant's name: muted, brighter while they speak, and pulsing in the warning color while a member of this
// device's call isn't connected here. Use it wherever a participant's name shows. The bright copy fades in on top
// (voice.css .voice-meter-lit says why).
export default function SpeakerName(props: { workspaceId: string; userId: number; class?: string }) {
  const name = () => member(props.workspaceId, props.userId).displayName;
  return (
    <span class={`speaker-name ${props.class ?? ""}`}
      classList={{ speaking: isSpeaking(props.workspaceId, props.userId), unconnected: notConnected(props.workspaceId, props.userId) }}
      title={notConnected(props.workspaceId, props.userId) ? "Not connected to them yet" : undefined}>
      {name()}
      <span class="speaker-name-lit" aria-hidden="true">{name()}</span>
    </span>
  );
}
