import { Icon } from "../theme/icons";

// The own microphone's level, lit while speaking (voice.css .voice-meter-lit).
export default function MicMeter(props: { level: number; speaking: boolean }) {
  return (
    <span class="voice-meter" classList={{ speaking: props.speaking }} style={{ "--level": props.level }} title="Microphone level">
      <Icon name="activity" size={20} />
      <span class="voice-meter-lit"><Icon name="activity" size={20} /></span>
    </span>
  );
}
