// A small working copy of the app for Settings > Appearance, built from the real pieces (server and channel bar
// rows, chat messages, the message box, buttons, fields, call controls), so it shows the theme as the app uses it,
// hover and click states included, and never falls behind the real look.
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import MessageComposer from "../messaging/MessageComposer";
import MessageCard from "../messaging/MessageCard";
import Avatar from "../ui/Avatar";
import Collapse from "../ui/Collapse";
import OverlayButton from "../ui/OverlayButton";
import Reactions, { type ReactionSummary } from "../ui/Reactions";
import Select from "../ui/Select";
import { rangeFill } from "../ui/range";
import { Icon, iconNames, type IconName } from "./icons";
import { colorKeys, type ColorKey } from "./schema";
import { theme } from "./store";
import "../plugins/builtin/views.css";
import "../plugins/builtin/chat/chat.css";
import MicMeter from "../voice/MicMeter";
import "../voice/voice.css";

const servers = [
  { short: "MW", color: "", unread: false, mentions: 0 },
  { short: "BG", color: "#2f8fbf", unread: true, mentions: 2 },
  { short: "", color: "#611f49", unread: false, mentions: 0, icon: "channel-design" as IconName },
];

const channels: { name: string; icon: IconName; unread?: boolean; mentions?: number }[] = [
  { name: "general", icon: "channel-chat" },
  { name: "shared-files", icon: "channel-files", unread: true },
  { name: "tasks", icon: "channel-tasks", mentions: 3 },
  { name: "version-control", icon: "channel-git" },
  { name: "meet-talk", icon: "channel-voice" },
];

const gwim = { username: "gwim", displayName: "Gwim", color: "#e0a030", avatar: "gen:gwim" };
const frenchie = { username: "frenchiehl2", displayName: "Frenchie", color: "#4fb3d9", avatar: "gen:frenchie" };

export default function ThemePreview(props: { colorLabels: Record<ColorKey, string> }) {
  const [server, setServer] = createSignal(0);
  const [channel, setChannel] = createSignal("general");
  const [open, setOpen] = createSignal(true);
  const [selected, setSelected] = createSignal<number | null>(1);
  const [reactions, setReactions] = createSignal<ReactionSummary[]>([
    { code: "fire", count: 2, users: [1, 2] },
    { code: "eyes", count: 1, users: [2] },
  ]);
  const toggleReaction = (code: string) => {
    const list = reactions();
    const r = list.find((x) => x.code === code);
    if (!r) return setReactions([...list, { code, count: 1, users: [1] }]);
    const users = r.users.includes(1) ? r.users.filter((u) => u !== 1) : [...r.users, 1];
    setReactions(users.length ? list.map((x) => (x === r ? { ...r, users, count: users.length } : x)) : list.filter((x) => x !== r));
  };
  const [kind, setKind] = createSignal("chat");
  const [checked, setChecked] = createSignal(true);
  const [volume, setVolume] = createSignal(0.7);
  const [muted, setMuted] = createSignal(false);
  const [deafened, setDeafened] = createSignal(false);
  const [camera, setCamera] = createSignal(false);
  const [sharing, setSharing] = createSignal(false);
  const [sound, setSound] = createSignal(false);
  const [overlay, setOverlay] = createSignal<string | null>(null);

  // The bars keep room for the call panel over them, and the indicator follows the active server, as in the shell.
  let sidebars!: HTMLDivElement;
  let serverBar!: HTMLElement;
  let panel!: HTMLElement;
  const [indicator, setIndicator] = createSignal(0);
  onMount(() => {
    const measure = () => {
      const height = `${panel.offsetHeight + Number.parseFloat(getComputedStyle(panel).marginBottom)}px`;
      sidebars.style.setProperty("--user-box-height", height);
      sidebars.style.setProperty("--user-box-wide-height", height);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    onCleanup(() => observer.disconnect());
  });
  createEffect(() => {
    server();
    const active = serverBar.querySelector<HTMLElement>('[aria-current="page"]');
    if (active) setIndicator(active.offsetTop + active.offsetHeight / 2);
  });
  const run = (action: Promise<unknown>) => void action;
  const noop = async () => {};
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  return (
    <section class="theme-preview" aria-label="Theme preview">
      <div class="preview-app">
        <div class="sidebars" ref={sidebars}>
          <div class="sidebars-top">
            <nav class="workspace-bar" aria-label="Workspaces (preview)" ref={serverBar}>
              <span class="workspace-indicator visible" style={{ transform: `translateY(${indicator()}px) translateY(-50%)` }} aria-hidden="true" />
              <button class="workspace-button messages-button mw-box" title="Private messages"><Icon name="messages" size={22} /></button>
              <For each={servers}>
                {(s, i) => (
                  <button class="workspace-button mw-box" classList={{ active: server() === i(), unread: s.unread && server() !== i() }}
                    aria-current={server() === i() ? "page" : undefined}
                    style={{ background: s.color || undefined }} onClick={() => setServer(i())} title={`Workspace ${i() + 1}`}>
                    <Show when={s.icon} fallback={s.short}>{(name) => <Icon name={name()} size={22} />}</Show>
                    <Show when={s.mentions && server() !== i()}>
                      <span class="mention-badge workspace-mentions mw-fade-in">{s.mentions}</span>
                    </Show>
                  </button>
                )}
              </For>
              <button class="workspace-button add mw-box" title="Add a workspace"><Icon name="add" /></button>
            </nav>
            <aside class="channel-bar" aria-label="Channels (preview)">
              <div class="workspace-channels">
                <header class="channel-bar-header">
                  <h1>Makeworks</h1>
                  <OverlayButton class="icon-button" icon="profile" label="Your profile in this workspace" motion="grow"
                    open={overlay() === "profile"} onToggle={() => setOverlay(overlay() === "profile" ? null : "profile")} />
                  <OverlayButton class="icon-button" icon="admin" label="Workspace settings" motion="tilt"
                    open={overlay() === "workspace"} onToggle={() => setOverlay(overlay() === "workspace" ? null : "workspace")} />
                </header>
                <div class="channel-tools">
                  <label class="channel-search mw-box">
                    <input placeholder="Search channels..." aria-label="Search channels (preview)" />
                    <Icon name="search" />
                  </label>
                  <div class="history-buttons mw-box">
                    <button title="Back" aria-label="Back"><Icon name="back" /></button>
                    <button disabled title="Forward" aria-label="Forward"><Icon name="forward" /></button>
                  </div>
                </div>
                <div class="channel-list mw-scroll-fade">
                  <section class="channel-section mw-box" classList={{ collapsed: !open() }}>
                    <div class="channel-section-header">
                      <button class="channel-section-toggle" aria-expanded={open()} onClick={() => setOpen(!open())}>
                        <span class="chevron"><Icon name="expanded" /></span>
                        dev
                      </button>
                      <button class="icon-button" title="Add channel"><Icon name="add" /></button>
                    </div>
                    <Collapse open={open()}>
                      <For each={channels}>
                        {(c) => (
                          <div class="channel-row" classList={{ active: channel() === c.name, unread: c.unread && channel() !== c.name, mentioned: !!c.mentions }}>
                            <button class="channel-open" onClick={() => setChannel(c.name)} aria-current={channel() === c.name ? "page" : undefined}>
                              <span class="channel-line" />
                              <span class="channel-label">
                                <Icon name={c.icon} />
                                <span class="channel-name">{c.name}</span>
                              </span>
                              <Show when={c.mentions && channel() !== c.name}>
                                <span class="mention-badge mw-box mw-fade-in">@{c.mentions}</span>
                              </Show>
                            </button>
                          </div>
                        )}
                      </For>
                    </Collapse>
                  </section>
                </div>
              </div>
            </aside>
          </div>
          <section class="voice-panel in-call" aria-label="Call (preview)" ref={panel}>
            <button class="voice-panel-avatar" title="Profile settings"><Avatar user={gwim} size={36} /></button>
            <OverlayButton class="voice-button plain voice-panel-gear" icon="settings" label="Settings" size={22}
              open={overlay() === "settings"} onToggle={() => setOverlay(overlay() === "settings" ? null : "settings")} />
            <div class="voice-panel-who">
              <div class="voice-panel-names">
                <span class="voice-panel-name">{gwim.displayName}</span>
                <span class="muted">{gwim.username}·4f2a</span>
              </div>
              <div class="voice-panel-status">
                <button class="voice-panel-channel" onClick={() => setChannel("meet-talk")}>meet-talk</button>
                <MicMeter level={0.6} speaking />
              </div>
            </div>
            <div class="voice-panel-call">
              <div class="voice-panel-controls">
                <div class="voice-panel-group tools">
                  <PreviewSplit icon={camera() ? "camera" : "camera-off"} on={camera()} onClick={() => setCamera(!camera())} label="Camera" />
                  <div class="voice-split voice-share-button mw-box">
                    <div class="voice-menu-anchor">
                      <button class="voice-split-main" classList={{ on: sharing() }} title="Share your screen" onClick={() => setSharing(!sharing())}>
                        <Icon name={sharing() ? "screen-share-stop" : "screen-share"} />
                      </button>
                    </div>
                    <button class="voice-split-menu voice-share-sound" classList={{ on: sound() }} title="Share your computer's sound"
                      onClick={() => setSound(!sound())}>
                      <Icon name="volume" size={14} />
                    </button>
                  </div>
                </div>
                <div class="voice-panel-group devices">
                  <PreviewSplit icon={muted() ? "mic-off" : "mic"} off={muted()} onClick={() => setMuted(!muted())} label="Microphone" />
                  <PreviewSplit icon={deafened() ? "headset-off" : "headset"} off={deafened()} onClick={() => setDeafened(!deafened())} label="Output" />
                </div>
                <button class="voice-button hang-up mw-box wide" title="Leave call"><Icon name="hang-up" /></button>
              </div>
            </div>
          </section>
        </div>
        <main class="preview-main chat">
          <header class="view-header">
            <h2 class="view-title"><Icon name="channel-chat" /> {channel()}</h2>
          </header>
          <div class="chat-scroll mw-scroll-fade">
            <div class="chat-list">
              <div role="presentation" onClick={() => setSelected(1)}>
                <MessageCard id="preview-1" author={gwim} createdAt={ago(3)} workspaceId=""
                  body={"A message with a [link](#preview), **bold**, `code` and a block:\n```\nprivate void OnClick() {\n  GD.Print(\"Hello world!\");\n}\n```"}
                  canEdit canDelete onEdit={noop} onDelete={noop} run={run} classList={{ selected: selected() === 1 }}
                  footer={
                    <>
                      <button class="chat-replies">3 replies <span class="muted">(last 1 minute ago)</span></button>
                      <Reactions reactions={reactions()} me={1} nameOf={(id) => (id === 1 ? "You" : "Frenchie")} onToggle={toggleReaction} />
                    </>
                  } />
              </div>
              <div role="presentation" onClick={() => setSelected(2)}>
                <MessageCard id="preview-2" author={frenchie} createdAt={ago(0)} editedAt={ago(0)} workspaceId=""
                  body={"@you have a look when you can :eyes:"} mentions={(name) => (name === "you" ? { name: "You", me: true } : undefined)}
                  canEdit={false} canDelete={false} onEdit={noop} onDelete={noop} run={run}
                  classList={{ selected: selected() === 2, mentioned: true }}>
                  <p class="warning">Warning text</p>
                  <p class="success">Success text</p>
                  <p class="muted">Disabled text</p>
                </MessageCard>
              </div>
            </div>
          </div>
          <MessageComposer place="theme-preview" workspaceId="" placeholder={`Message ${channel()}`} send={noop} />
        </main>
      </div>

      <div class="preview-controls">
        <div class="row">
          <button class="mw-button primary mw-box">Primary</button>
          <button class="mw-button mw-box">Button</button>
          <button class="mw-button mw-box" disabled>Disabled</button>
          <button class="icon-button" title="Icon button"><Icon name="settings" /></button>
          <button class="icon-button accent" title="Accent icon button"><Icon name="send" /></button>
        </div>
        <div class="row">
          <input class="mw-input mw-box" placeholder="Text field" aria-label="Text field (preview)" />
          <Select label="Dropdown (preview)" value={kind()} onChange={setKind} options={[
            { value: "chat", label: "Chat", icon: "channel-chat" },
            { value: "tasks", label: "Tasks", icon: "channel-tasks" },
            { value: "design", label: "Design", icon: "channel-design" },
          ]} />
        </div>
        <div class="row preview-inline">
          <label class="voice-settings-check">
            <input type="checkbox" checked={checked()} onChange={(e) => setChecked(e.currentTarget.checked)} /> Checkbox
          </label>
          <input type="range" min="0" max="100" value={Math.round(volume() * 100)} style={rangeFill(volume(), 0, 1)}
            aria-label="Slider (preview)" onInput={(e) => setVolume(Number(e.currentTarget.value) / 100)} />
          <a href="#preview" onClick={(e) => e.preventDefault()}>A link</a>
        </div>
      </div>

      <div class="preview-swatches">
        <For each={colorKeys}>
          {(key) => <div class="swatch mw-box" style={{ background: theme().colors[key] }} title={props.colorLabels[key]} />}
        </For>
      </div>
      <div class="preview-icons">
        <For each={iconNames}>{(name) => <Icon name={name} label={name} size={20} />}</For>
      </div>
    </section>
  );
}

// A call button with a device menu arrow, like voice/Controls' SplitButton, without touching real devices.
function PreviewSplit(props: { icon: IconName; label: string; on?: boolean; off?: boolean; onClick: () => void }) {
  return (
    <div class="voice-split mw-box" classList={{ on: props.on, off: props.off }}>
      <button class="voice-split-main" title={props.label} aria-pressed={props.on ?? props.off} onClick={props.onClick}>
        <Icon name={props.icon} />
      </button>
      <div class="voice-menu-anchor">
        <button class="voice-split-menu" aria-label={`${props.label} devices`}><Icon name="menu-up" size={14} /></button>
      </div>
    </div>
  );
}
