// The box at the bottom left, floating over both bars: your avatar with the settings button under it, growing into
// the call panel while in a call (mockup stream.png). Avatar and settings stay put while the box grows around them.
import { Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { account } from "../core/account";
import { member, myId } from "../core/members";
import { onlineStatus, setOnlineStatus } from "../core/onlineStatus";
import { openChannel } from "../core/navigation";
import { findChannel } from "../core/workspaces";
import { showNotice } from "../core/notices";
import { appSettings, openSettings, overlayShowing, toggleOverlay } from "../core/ui";
import Avatar from "../ui/Avatar";
import { openFeedback } from "../core/feedback";
import StatusDot from "../ui/StatusDot";
import OverlayButton from "../ui/OverlayButton";
import { openContextMenu } from "../ui/contextMenu";
import { CameraButton, HangUpButton, HeadsetButton, MicButton, ScreenButton } from "./Controls";
import MicMeter from "./MicMeter";
import Collapse from "../ui/Collapse";
import { call, callConnecting, callConnectingLong, level, speakingSelf, voiceError, type Call } from "./state";
import "./voice.css";
import { handleOf } from "../core/userServer";

export default function VoicePanel() {
  // Joining or leaving switches the layout inside a view transition, so the browser grows or shrinks the box
  // between the two and keeps the avatar and settings button in place.
  const [shown, setShown] = createSignal<Call | null>(call());
  createEffect(on(call, (next) => {
    const resizes = (next === null) !== (shown() === null);
    if (resizes && document.startViewTransition) document.startViewTransition(() => setShown(next));
    else setShown(next);
  }, { defer: true }));

  // In a call you show as that workspace's member (its nickname); otherwise as your account.
  const me = () => {
    const c = shown();
    const signedIn = account();
    if (c) return member(c.workspaceId, myId(c.workspaceId) ?? -1);
    return { username: signedIn?.username ?? "", displayName: signedIn?.displayName ?? "", color: signedIn?.color ?? "", avatar: signedIn?.avatar ?? "" };
  };
  const statusMenu = (event: MouseEvent) => openContextMenu(event, [
    { label: "Online", swatch: "var(--mw-success)", disabled: account()?.offline, action: () => changeStatus("online") },
    { label: "Do not disturb", swatch: "var(--mw-danger)", disabled: account()?.offline, action: () => changeStatus("dnd") },
    { label: "Hidden", disabled: account()?.offline, action: () => changeStatus("hidden") },
    "separator",
    { label: "Offline", action: () => changeStatus("offline") },
    "separator",
    { label: "Send feedback", icon: "comment", action: () => openFeedback() },
  ]);
  const changeStatus = (status: "online" | "dnd" | "hidden" | "offline") => {
    void setOnlineStatus(status).catch((e) => showNotice("Status not changed", e instanceof Error ? e.message : String(e)));
  };

  // The bars keep room under their lists for the box floating over them: the workspace bar always, the channel bar
  // while the box spans it.
  let box!: HTMLElement;
  onMount(() => {
    const host = box.parentElement!;
    const measure = () => {
      const height = box.offsetHeight + Number.parseFloat(getComputedStyle(box).marginBottom);
      host.style.setProperty("--user-box-height", `${height}px`);
      host.style.setProperty("--user-box-wide-height", shown() ? `${height}px` : "0px");
    };
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    onCleanup(() => observer.disconnect());
  });

  return (
    <section class="voice-panel" classList={{ "in-call": shown() !== null }} aria-label={shown() ? "Call" : "You"} ref={box}>
      <button class="voice-panel-avatar" title="Profile settings; right-click to change status" aria-label="Profile settings"
        onClick={() => openSettings("profile")} onContextMenu={statusMenu}>
        <Avatar user={me()} size={36} />
        <StatusDot status={onlineStatus()} class="voice-panel-status-dot" />
      </button>
      <OverlayButton class="voice-button plain voice-panel-gear" icon="settings" label="Settings" size={22} open={overlayShowing(appSettings())}
        onToggle={() => toggleOverlay(appSettings())} />
      <Show when={shown()}>
        {(c) => (
          <>
            <div class="voice-panel-who">
              <div class="voice-panel-names">
                <span class="voice-panel-name">{me().displayName}</span>
                <span class="muted">{handleOf(me())}</span>
              </div>
              <div class="voice-panel-status">
                <button class="voice-panel-channel" onClick={() => openChannel(c().workspaceId, c().channelId)} title="Open the call">
                  {findChannel(c().workspaceId, c().channelId)?.name}
                </button>
                <MicMeter level={level()} speaking={speakingSelf()} />
              </div>
            </div>
            <div class="voice-panel-call">
              <Show when={voiceError()}><p class="voice-error warning">{voiceError()}</p></Show>
              <Collapse open={callConnecting()}>
                <p class="voice-panel-connecting" role="status" aria-live="polite">
                  <span class="mw-spinner" />
                  {callConnectingLong() ? "Still connecting to the call…" : "Connecting to the call…"}
                </p>
              </Collapse>
              <div class="voice-panel-controls">
                <div class="voice-panel-group tools">
                  <CameraButton />
                  <ScreenButton />
                </div>
                <div class="voice-panel-group devices">
                  <MicButton />
                  <HeadsetButton />
                </div>
                <HangUpButton wide />
              </div>
            </div>
          </>
        )}
      </Show>
    </section>
  );
}
