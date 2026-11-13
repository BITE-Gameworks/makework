// Settings > Audio: app sounds, call output, the microphone (input mode, push to talk key, noise suppression, input
// sensitivity with a live meter, volume) and mention notifications.
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { notificationPermission, notificationsOn, enableNotifications } from "../core/notifier";
import { Icon } from "../theme/icons";
import { playSound, setSoundVolume, soundVolume } from "../theme/sounds";
import { rangeFill } from "../ui/range";
import {
  capturingPttKey, inputMode, noiseSuppression, pttKey, sensitivityDb, sensitivityRange, setCapturingPttKey,
  setInputMode, setNoiseSuppression, setPttKey, setSensitivityDb, type NoiseSuppression,
} from "./micSettings";
import { defaultPttKey, isPushToTalk, pttKeyFromEvent, pttKeyLabel, type InputMode } from "./pushToTalk";
import { call, micDb, micTesting, speakingSelf, toggleMicTest, transmitting } from "./state";
import { loudnessSafety, micVolume, outputVolume, setLoudnessSafety, setMicVolume, setOutputVolume } from "./volume";
import VolumeSlider from "./VolumeSlider";
import "./voice.css";

const choices: { value: NoiseSuppression; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "Your microphone as it is." },
  { value: "standard", label: "Standard", hint: "The browser's suppression: steady hiss and hum." },
  { value: "strong", label: "Strong", hint: "RNNoise on top: keyboards, fans, background voices. Uses a little more CPU." },
];

const modes: { value: InputMode; label: string; hint: string }[] = [
  { value: "voice", label: "Voice activation", hint: "The noise gate decides when to send, from the sensitivity below." },
  { value: "push-to-talk", label: "Push to talk", hint: "Others hear you only while you hold the key." },
];

// The meter's scale, dBFS.
const scale = { min: -80, max: 0 };
const position = (db: number) => `${Math.min(100, Math.max(0, ((db - scale.min) / (scale.max - scale.min)) * 100))}%`;

function RadioChoices<T extends string>(props: {
  name: string;
  label: string;
  value: T;
  options: { value: T; label: string; hint: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div class="voice-settings-choices" role="radiogroup" aria-label={props.label}>
      <For each={props.options}>
        {(option) => (
          <label class="voice-settings-choice mw-box" classList={{ selected: props.value === option.value }}>
            <input type="radio" name={props.name} checked={props.value === option.value} onChange={() => props.onChange(option.value)} />
            <span>
              <strong>{option.label}</strong>
              <span class="hint">{option.hint}</span>
            </span>
          </label>
        )}
      </For>
    </div>
  );
}

// The push to talk key: show it, and listen for the next key while capturing (Escape cancels).
function PttKeySetting() {
  const [capturing, setCapturing] = createSignal(false);
  let button!: HTMLButtonElement;
  const stop = () => {
    setCapturing(false);
    setCapturingPttKey(false);
  };
  createEffect(() => {
    if (!capturing()) return;
    setCapturingPttKey(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") return stop();
      const key = pttKeyFromEvent(e);
      if (!key) return;
      setPttKey(key);
      stop();
    };
    // Clicking anywhere else gives up, so the next key press isn't swallowed as a binding.
    const onPointer = (e: PointerEvent) => {
      if (!button.contains(e.target as Node)) stop();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
      setCapturingPttKey(false);
    });
  });
  const changed = () => pttKeyLabel(pttKey()) !== pttKeyLabel(defaultPttKey);
  return (
    <>
      <div class="voice-settings-key">
        <span class="voice-settings-key-label">Hold to talk</span>
        <button ref={button} class="mw-button mw-box voice-key-button" classList={{ capturing: capturing() }} onClick={() => setCapturing(!capturing())}>
          {capturing() ? "Press a key…" : pttKeyLabel(pttKey())}
        </button>
        <Show when={changed()}>
          <button class="mw-button mw-box" onClick={() => setPttKey({ ...defaultPttKey })}>Reset</button>
        </Show>
      </div>
      <p class="hint">Hold this key while you speak. It works while MakeWork is focused; pick a key you don't type.</p>
    </>
  );
}

export default function AudioSettings() {
  const running = () => call() !== null || micTesting();
  const manual = () => sensitivityDb() !== null;
  const pushToTalk = () => isPushToTalk(inputMode());

  return (
    <div class="settings-section voice-settings">
      <h2>Audio</h2>

      <h3>Sounds</h3>
      <VolumeSlider label="Sound volume" value={soundVolume()} max={1} onChange={setSoundVolume} onCommit={() => playSound("mention")} />
      <p class="hint">Plays for calls, mentions, finished tasks and uploads, and errors. Themes can change the sounds.</p>

      <h3>Call volume</h3>
      <p class="hint">Everyone you hear in calls. Each member has their own volume too (right-click them).</p>
      <VolumeSlider label="Output volume" value={outputVolume()} onChange={setOutputVolume} />
      <label class="voice-settings-check">
        <input type="checkbox" checked={loudnessSafety()} onChange={(e) => setLoudnessSafety(e.currentTarget.checked)} />
        Loudness safety
      </label>
      <p class="hint">Volumes over 100% boost quiet sound only: someone you turned up for a quiet microphone can't blast loud music at you.</p>

      <h3>Input mode</h3>
      <RadioChoices name="input-mode" label="Input mode" value={inputMode()} options={modes} onChange={setInputMode} />
      <Show when={pushToTalk()}>
        <div class="mw-fade-in"><PttKeySetting /></div>
      </Show>

      <h3>Noise suppression</h3>
      <RadioChoices name="noise" label="Noise suppression" value={noiseSuppression()} options={choices} onChange={setNoiseSuppression} />

      <Show when={!pushToTalk()}>
        <h3>Input sensitivity</h3>
        <p class="hint">How loud your voice has to be before others hear it. Quieter sound is not sent.</p>
        <label class="voice-settings-check">
          <input type="checkbox" checked={!manual()} onChange={(e) => setSensitivityDb(e.currentTarget.checked ? null : Math.round(Math.max(micDb(), -60) + 6))} />
          Decide automatically from the room's noise
        </label>
        <div class="voice-sensitivity" classList={{ manual: manual() }}>
          <div class="voice-sensitivity-meter mw-box" classList={{ speaking: speakingSelf() }}>
            <span class="voice-sensitivity-fill" style={{ transform: `scaleX(${Number.parseFloat(position(micDb())) / 100})` }} />
            <Show when={manual()}>
              <span class="voice-sensitivity-mark" style={{ left: position(sensitivityDb()!) }} />
            </Show>
          </div>
          <Show when={manual()}>
            <input type="range" min={sensitivityRange.min} max={sensitivityRange.max} step="1" value={sensitivityDb()!}
              style={rangeFill(sensitivityDb()!, sensitivityRange.min, sensitivityRange.max)} aria-label="Minimum level" onInput={(e) => setSensitivityDb(Number(e.currentTarget.value))} />
            <span class="voice-sensitivity-value">{sensitivityDb()} dB</span>
          </Show>
        </div>
      </Show>

      <div class="voice-settings-row">
        <Show when={!call()} fallback={
          <span class="hint">
            {pushToTalk()
              ? `You are in a call; hold ${pttKeyLabel(pttKey())} to talk.`
              : "You are in a call; the meter shows your microphone live."}
          </span>
        }>
          <button class="mw-button mw-box" onClick={() => void toggleMicTest()}>
            <Icon name={micTesting() ? "mic-off" : "mic"} /> {micTesting() ? "Stop test" : "Test microphone"}
          </button>
        </Show>
        <Show when={running()}>
          <span class="hint">
            {pushToTalk()
              ? (transmitting() ? "Others would hear you now." : `Hold ${capturingPttKey() ? "a key" : pttKeyLabel(pttKey())} to talk.`)
              : speakingSelf() ? "Others would hear you now." : "Not sending."}
          </span>
        </Show>
      </div>

      <h3>Microphone volume</h3>
      <VolumeSlider label="Mic volume" value={micVolume()} onChange={setMicVolume} />

      <h3>Notifications</h3>
      <label class="settings-check">
        <input type="checkbox" checked={notificationsOn()} onChange={(e) => void enableNotifications(e.currentTarget.checked)} />
        Desktop notifications when someone mentions you
      </label>
      <Show when={notificationsOn() && (notificationPermission() === "denied" || notificationPermission() === "unsupported")}>
        <p class="hint warning mw-fade-in">
          {notificationPermission() === "unsupported"
            ? "This browser can't show notifications."
            : "Notifications are blocked for this app in your system or browser settings."}
        </p>
      </Show>
      <p class="hint">Not while you're already looking at that channel.</p>
    </div>
  );
}
