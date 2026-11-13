// Call buttons shared by the bottom-left call panel and the stage view.
import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack, type JSX } from "solid-js";
import { Icon } from "../theme/icons";
import Collapse from "../ui/Collapse";
import Popover from "../ui/Popover";
import Select from "../ui/Select";
import Skeleton from "../ui/Skeleton";
import { Switch } from "../ui/Switch";
import { rangeFill } from "../ui/range";
import { micVolume, outputVolume, setMicVolume, setOutputVolume } from "./volume";
import VolumeSlider from "./VolumeSlider";
import {
  bitrateStops, describeBitrate, describeShareStats, manualBitrate, nodeStutterBits, shareFavourOrder, shareFrameRates, shareResolutionOrder,
  type ShareFavour, type ShareResolution, type ShareStats,
} from "./shareQuality";
import {
  cameraId, cameras, cameraStream, canShareSound, deafened, inputId, inputs, leaveVoice, muted, outputId, outputs, pttTalking, refreshDevices,
  screenSources, setCameraDevice, setInputDevice, setOutputDevice, setShareQuality, sharedPicture, sharedSound, shareQuality,
  shareStats, sharedSource, stopSharing, startingCamera, startingPicture, startingSound, supportsOutputSelection, supportsScreenShare, toggleCamera,
  toggleDeafen, toggleMute, togglePicture, toggleSound, voiceBlocked, voiceMutedByModerator,
} from "./state";
import { inputMode, pttKey } from "./micSettings";
import { isPushToTalk, pttKeyLabel } from "./pushToTalk";
import type { ScreenSource } from "../core/desktop";

export function CameraButton() {
  return (
    <SplitButton
      icon={cameraStream() ? "camera" : "camera-off"} on={!!cameraStream()} disabled={startingCamera()}
      title={cameraStream() ? "Turn camera off" : "Turn camera on"} onToggle={() => void toggleCamera()}
      menuLabel="Camera" devices={cameras()} selected={cameraId()} onSelect={(id) => void setCameraDevice(id)} />
  );
}

// One box with two toggles: the picture (a screen or window; our own picker on desktops that have one, else the
// system's) and the computer's sound. Either, both or neither. Clicking one that is starting gives it up. Clicking
// the picture while it is shared opens the share's popover: stop it, or change its quality.
export function ScreenButton() {
  const [open, setOpen] = createSignal(false);
  const [sharing, setSharing] = createSignal(false);
  const [sources, setSources] = createSignal<ScreenSource[]>([]);
  // The picture ending (from the system's own controls too) takes its popover with it.
  createEffect(() => {
    if (!sharedPicture()) setSharing(false);
  });
  const clickPicture = async () => {
    if (open()) return setOpen(false);
    if (sharing()) return setSharing(false);
    if (startingPicture()) return void togglePicture();
    if (sharedPicture()) return setSharing(true);
    const list = await screenSources().catch(() => null);
    if (!list) return void togglePicture();
    setSources(list);
    setOpen(true);
  };
  const pick = (id: string) => {
    setOpen(false);
    void togglePicture(id);
  };
  // While sharing: another screen or window replaces the share without stopping it.
  const switchTo = (id?: string) => {
    setSharing(false);
    void togglePicture(id, true);
  };
  const pictureTitle = () => (startingPicture() ? "Waiting for the screen picker (click to give up)" : sharedPicture() ? "Switch screen, stop sharing or change its quality" : "Share your screen");
  const soundTitle = () => (startingSound() ? "Starting to share sound (click to give up)" : sharedSound() ? "Stop sharing your computer's sound" : "Share your computer's sound");
  return (
    <Show when={supportsScreenShare}>
      <div class="voice-split voice-share-button mw-box">
        <div class="voice-menu-anchor">
          <button class="voice-split-main" classList={{ on: !!sharedPicture(), starting: startingPicture() }}
            onClick={() => void clickPicture()} title={pictureTitle()} aria-label={pictureTitle()}
            aria-pressed={!!sharedPicture()} aria-expanded={open() || sharing()}>
            <Icon name="screen-share" />
          </button>
          <Popover open={open()} onClose={() => setOpen(false)} label="Share a screen or window">
            <div class="voice-share">
              <div class="voice-sources mw-scroll-fade">
                <SourceGroup title="Screens" sources={sources().filter((x) => x.screen)} onPick={pick} />
                <SourceGroup title="Windows" sources={sources().filter((x) => !x.screen)} onPick={pick} />
              </div>
            </div>
          </Popover>
          <SharingMenu open={sharing()} onClose={() => setSharing(false)} onSwitch={switchTo} />
        </div>
        <Show when={canShareSound}>
          <button class="voice-split-menu voice-share-sound" classList={{ on: !!sharedSound(), starting: startingSound() }}
            onClick={() => void toggleSound()} title={soundTitle()} aria-label={soundTitle()} aria-pressed={!!sharedSound()}>
            <Icon name="volume" size={14} />
          </button>
        </Show>
      </div>
    </Show>
  );
}

const favourNames: Record<ShareFavour, string> = { motion: "Smooth motion", balanced: "Balanced", detail: "Sharp detail" };
const resolutionNames: Record<ShareResolution, string> = { 720: "720p", 1080: "1080p", 1440: "1440p (2K)" };

// A running share: stop it, or set its quality (voice/shareQuality.ts, kept on this device): the resolution, frame
// rate, what to favour, the bitrate, and the live numbers, read from the senders once a second while open.
function SharingMenu(props: { open: boolean; onClose: () => void; onSwitch: (id?: string) => void }) {
  const [stats, setStats] = createSignal<ShareStats | null>(null);
  const stop = () => {
    props.onClose();
    stopSharing();
  };
  // The other screens and windows, listed beside the menu while it is open (desktop only; elsewhere a button opens
  // the system's picker).
  const [others, setOthers] = createSignal<ScreenSource[] | null | undefined>(undefined);
  createEffect(() => {
    if (!props.open) return;
    let current = true;
    onCleanup(() => (current = false));
    void screenSources().catch(() => null).then((list) => current && setOthers(list));
  });
  const alternatives = () => others()?.filter((x) => x.id !== sharedSource());
  createEffect(() => {
    if (!props.open) return;
    let stopped = false;
    // Polled every second: a connection closing meanwhile only skips a reading, never piles up rejections.
    const refresh = async () => {
      const next = await shareStats().catch(() => undefined);
      if (!stopped && next !== undefined) setStats(next);
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    onCleanup(() => {
      stopped = true;
      clearInterval(timer);
    });
  });
  // The bitrate: Auto on a switch, a chosen one on the slider over the stops (resting on Auto's rate while Auto is on).
  // While the slider is dragged only the reading follows; the senders get the new bitrate when it is let go (each
  // step would retune every copy).
  const auto = () => shareQuality().bitrate === "auto";
  const [dragging, setDragging] = createSignal<number | null>(null);
  const copies = () => stats()?.copies ?? 0;
  const bitrateIndex = createMemo(() => dragging() ?? bitrateStops.indexOf(manualBitrate(shareQuality(), copies())));
  const bitrateReading = createMemo(() => {
    const index = dragging();
    return describeBitrate(index === null ? shareQuality() : { ...shareQuality(), bitrate: bitrateStops[index] }, copies());
  });
  const setAuto = (on: boolean) => {
    setDragging(null);
    setShareQuality({ ...shareQuality(), bitrate: on ? "auto" : manualBitrate(shareQuality(), copies()) });
  };
  // A drag ends on change, on letting go, on leaving the slider (one let go where it started fires no change) and
  // with the menu closing: the dragged stop is taken then, once.
  const endDrag = () => {
    const index = dragging();
    setDragging(null);
    if (index !== null && bitrateStops[index] !== shareQuality().bitrate) setShareQuality({ ...shareQuality(), bitrate: bitrateStops[index] });
  };
  createEffect(() => {
    if (!props.open) untrack(endDrag);
  });
  return (
    <Popover open={props.open} onClose={props.onClose} label="Your screen share">
      <div class="voice-sharing">
      <div class="voice-quality">
        <Show when={others() === null}>
          <button class="mw-menu-item" onClick={() => props.onSwitch()}>
            <Icon name="screen-share" /> Switch screen
          </button>
        </Show>
        <button class="mw-menu-item danger" onClick={stop}>
          <Icon name="screen-share-stop" /> Stop sharing
        </button>
        <div class="mw-menu-heading">Stream quality</div>
        <div class="voice-quality-field">
          <span class="voice-volume-label">Resolution</span>
          <Select label="Resolution" value={shareQuality().resolution}
            onChange={(resolution) => setShareQuality({ ...shareQuality(), resolution })}
            options={shareResolutionOrder.map((resolution) => ({ value: resolution, label: resolutionNames[resolution] }))} />
        </div>
        <div class="voice-quality-field">
          <span class="voice-volume-label">Frame rate</span>
          <Select label="Frame rate" value={shareQuality().frameRate}
            onChange={(frameRate) => setShareQuality({ ...shareQuality(), frameRate })}
            options={shareFrameRates.map((rate) => ({ value: rate, label: `${rate} fps` }))} />
        </div>
        <div class="voice-quality-field">
          <span class="voice-volume-label">Favour</span>
          <Select label="Favour" value={shareQuality().favour}
            onChange={(favour) => setShareQuality({ ...shareQuality(), favour })}
            options={shareFavourOrder.map((favour) => ({ value: favour, label: favourNames[favour] }))} />
        </div>
        <div class="voice-quality-field">
          <span class="voice-volume-label">Bitrate</span>
          {/* Off only once the viewers are counted: a chosen bitrate starts at what all their copies use. */}
          <Switch checked={auto()} onChange={setAuto} label="Auto" disabled={stats() === null} />
        </div>
        <div class="voice-quality-field">
          <span />
          <input type="range" min="0" max={bitrateStops.length - 1} step="1" value={bitrateIndex()} disabled={auto()}
            aria-label="Bitrate" style={rangeFill(bitrateIndex(), 0, bitrateStops.length - 1)} aria-valuetext={bitrateReading()}
            onInput={(e) => setDragging(Number(e.currentTarget.value))}
            onChange={endDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onBlur={endDrag} />
        </div>
        <div class="voice-quality-field voice-quality-reading">
          <span />
          <span>{bitrateReading()}</span>
        </div>
        <Show when={stats()} fallback={<div class="voice-quality-line"><Skeleton kind="line" /></div>}>
          {(now) => (
            <>
              <p class="voice-quality-line mw-fade-in" aria-live="polite">
                {describeShareStats(now())}{now().copies === 0 && !now().viaNode ? " (nobody receives it yet)" : ""}
              </p>
              <Collapse open={now().cap.capped}>
                <p class="mw-menu-note">
                  You send a copy to each of the {now().copies} viewers, and they share your upload. A call through a
                  node sends one copy at full quality (Workspace settings, Nodes).
                </p>
              </Collapse>
              <Collapse open={now().viaNode}>
                <p class="mw-menu-note">
                  This call goes through a node: you send one copy, whatever its size.
                  {now().cap.bitrate > nodeStutterBits
                    ? ` Viewers on slow connections may stutter above about ${nodeStutterBits / 1_000_000} Mbit/s.` : ""}
                </p>
              </Collapse>
              <Collapse open={now().soundRefused}>
                <p class="mw-menu-note">This call's node can't carry your computer's sound yet.</p>
              </Collapse>
            </>
          )}
        </Show>
      </div>
      <Show when={alternatives()?.length}>
        <div class="voice-switch mw-fade-in">
          <div class="voice-sources mw-scroll-fade">
            <SourceGroup title="Switch to a screen" sources={alternatives()!.filter((x) => x.screen)} onPick={props.onSwitch} />
            <SourceGroup title="Switch to a window" sources={alternatives()!.filter((x) => !x.screen)} onPick={props.onSwitch} />
          </div>
        </div>
      </Show>
      </div>
    </Popover>
  );
}

function SourceGroup(props: { title: string; sources: ScreenSource[]; onPick: (id: string) => void }) {
  return (
    <Show when={props.sources.length > 0}>
      <div class="mw-menu-heading">{props.title}</div>
      <div class="voice-source-grid">
        <For each={props.sources}>
          {(source) => (
            <button class="voice-source mw-box" title={source.name} onClick={() => props.onPick(source.id)}>
              <Show when={source.thumbnail} fallback={<span class="voice-source-empty"><Icon name="screen-share" /></span>}>
                <img src={source.thumbnail} alt="" />
              </Show>
              <span class="voice-source-name">{source.name}</span>
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}

export function MicButton() {
  const pushToTalk = () => isPushToTalk(inputMode());
  const talking = () => pushToTalk() && pttTalking() && !voiceBlocked();
  const title = () => {
    if (voiceMutedByModerator()) return "A moderator muted you in calls";
    if (pushToTalk()) {
      if (voiceBlocked()) return muted() ? "Unmute" : "Push to talk is blocked";
      return talking() ? `Talking (release ${pttKeyLabel(pttKey())})` : `Push to talk (hold ${pttKeyLabel(pttKey())})`;
    }
    return muted() ? "Unmute" : "Mute";
  };
  return (
    <SplitButton
      icon={voiceBlocked() ? "mic-off" : "mic"} off={voiceBlocked()} on={talking()} onToggle={toggleMute}
      title={title()}
      menuLabel="Microphone" devices={inputs()} selected={inputId()} onSelect={(id) => void setInputDevice(id)}
      extra={<VolumeSlider label="Mic volume" value={micVolume()} onChange={setMicVolume} />} />
  );
}

export function HeadsetButton() {
  return (
    <SplitButton
      icon={deafened() ? "headset-off" : "headset"} off={deafened()} title={deafened() ? "Undeafen" : "Deafen"} onToggle={toggleDeafen}
      menuLabel="Output" devices={outputs()} selected={outputId()} onSelect={setOutputDevice}
      extra={<VolumeSlider label="Output volume" value={outputVolume()} onChange={setOutputVolume} />}
      note={supportsOutputSelection ? undefined : "This app can't switch outputs here yet; sound plays on the system default. Change it in your system sound settings."} />
  );
}

// While sharing, the first click only stops the share: people reach for this button to end a stream, not the call.
export function HangUpButton(props: { wide?: boolean }) {
  const isSharing = () => !!sharedPicture() || !!sharedSound() || startingPicture() || startingSound();
  const label = () => (isSharing() ? "Stop sharing (click again to leave the call)" : "Leave call");
  const click = (event: MouseEvent) => {
    if (isSharing()) return stopSharing();
    // The second half of a double click that stopped the share doesn't count as clicking again.
    if (event.detail <= 1) void leaveVoice();
  };
  return (
    <button class="voice-button hang-up mw-box" classList={{ wide: props.wide }} onClick={click} title={label()} aria-label={label()}>
      <Icon name={isSharing() ? "screen-share-stop" : "hang-up"} />
    </button>
  );
}

function SplitButton(props: {
  icon: "mic" | "mic-off" | "headset" | "headset-off" | "camera" | "camera-off";
  // off: muted or deafened (warning color); on: a camera that is on (accent).
  off?: boolean;
  on?: boolean;
  disabled?: boolean;
  title: string;
  onToggle: () => void;
  menuLabel: string;
  devices: MediaDeviceInfo[];
  selected: string;
  onSelect: (id: string) => void;
  note?: string;
  extra?: JSX.Element;
}) {
  const [open, setOpen] = createSignal(false);
  const choose = (id: string) => {
    props.onSelect(id);
    setOpen(false);
  };
  return (
    <div class="voice-split mw-box" classList={{ off: props.off, on: props.on }}>
      <button class="voice-split-main" onClick={props.onToggle} title={props.title} aria-label={props.title} aria-pressed={props.off ?? props.on}
        disabled={props.disabled}>
        <Icon name={props.icon} />
      </button>
      <div class="voice-menu-anchor">
        <button class="voice-split-menu" aria-label={`${props.menuLabel} devices`} aria-expanded={open()}
          onClick={() => {
            if (!open()) void refreshDevices();
            setOpen(!open());
          }}>
          <Icon name="menu-up" size={14} />
        </button>
        <Popover open={open()} onClose={() => setOpen(false)} label={`${props.menuLabel} devices`}>
          <div class="mw-menu-heading">{props.menuLabel}</div>
          <Show when={props.note}><p class="mw-menu-note">{props.note}</p></Show>
          <button class="mw-menu-item" classList={{ selected: !props.selected }} disabled={!!props.note} onClick={() => choose("")}>
            <Icon name="check" /> System default
          </button>
          <For each={props.devices.filter((d) => d.deviceId && d.deviceId !== "default")}>
            {(d, i) => (
              <button class="mw-menu-item" classList={{ selected: props.selected === d.deviceId }} disabled={!!props.note}
                onClick={() => choose(d.deviceId)}>
                <Icon name="check" /> {d.label || `${props.menuLabel} ${i() + 1}`}
              </button>
            )}
          </For>
          <Show when={props.extra}><div class="mw-menu-extra">{props.extra}</div></Show>
        </Popover>
      </div>
    </div>
  );
}
