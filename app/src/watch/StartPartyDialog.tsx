// Planning a watch party from a video in a files channel: which videos of its folder, in which voice channel, when,
// and the chat channel that hears about it. The announcement is a chat message showing the party (PartyCard).
import { For, Show, createSignal } from "solid-js";
import { userMessage } from "../api/client";
import { linkUrl } from "../core/links";
import { openChannel } from "../core/navigation";
import { readJson, writeJson } from "../core/storage";
import { formatBytes } from "../core/time";
import { canInChannel, channelLabel, workspaceApi, workspaces } from "../core/workspaces";
import { postMessage } from "../plugins/builtin/chat/data";
import Dialog from "../ui/Dialog";
import Select from "../ui/Select";
import { call } from "../voice/state";
import { createParty, endParty, partyLinkKind, setPartyMessage, type NewPartyItem } from "./data";
import "./watch.css";

const lastChatKey = (workspaceId: string) => `mw.watch.chatChannel.${workspaceId}`;
// For a datetime-local field, in local time.
const localInput = (at: Date) => new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const inQuarterHour = () => {
  const at = new Date(Date.now() + 15 * 60_000);
  at.setSeconds(0, 0);
  return at;
};

export default function StartPartyDialog(props: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  // The videos of the folder, in its order, and the one being viewed.
  videos: NewPartyItem[];
  from: number;
}) {
  const channels = () => workspaces.byId[props.workspaceId]?.channels ?? [];
  const voices = () => channels().filter((c) => c.type === "voice" && canInChannel(props.workspaceId, c.id, "send_messages"));
  const chats = () => channels().filter((c) => c.type === "chat" && canInChannel(props.workspaceId, c.id, "send_messages"));
  const inCall = call()?.workspaceId === props.workspaceId ? call()!.channelId : null;
  const [voiceId, setVoiceId] = createSignal<number | null>(inCall ?? voices()[0]?.id ?? null);
  const lastChat = readJson<number | null>(lastChatKey(props.workspaceId), null);
  const [chatId, setChatId] = createSignal<number | null>(chats().some((c) => c.id === lastChat) ? lastChat : chats()[0]?.id ?? null);
  const [picked, setPicked] = createSignal<number[]>([props.from]);
  const [title, setTitle] = createSignal(props.videos.find((v) => v.fileId === props.from)?.name.replace(/\.[^.]+$/, "") ?? "");
  const [startsAt, setStartsAt] = createSignal(localInput(inQuarterHour()));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const chosen = () => props.videos.filter((v) => picked().includes(v.fileId));
  const toggle = (fileId: number, on: boolean) => setPicked(on ? [...picked(), fileId] : picked().filter((id) => id !== fileId));
  const ready = () => !!title().trim() && chosen().length > 0 && voiceId() !== null && chatId() !== null && !!startsAt() && !busy();

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!ready()) return;
    setBusy(true);
    try {
      const at = new Date(startsAt());
      const id = await createParty(props.workspaceId, {
        channelId: voiceId()!, chatChannelId: chatId()!, title: title().trim(), startsAt: (Number.isNaN(at.getTime()) ? new Date() : at).toISOString(), items: chosen(),
      });
      const link = linkUrl({ workspaceId: props.workspaceId, channelId: voiceId()!, target: { kind: partyLinkKind, id } });
      let messageId: number;
      try {
        messageId = await postMessage(workspaceApi(props.workspaceId).plugin("chat"), chatId()!, null, `Watch party: **${title().trim()}**\n${link}`, []);
      } catch (err) {
        // Nobody would hear of a party that wasn't announced, and trying again makes a new one: this one ends.
        await endParty(props.workspaceId, id).catch((e) => console.warn("Unannounced watch party not ended:", e));
        throw err;
      }
      await setPartyMessage(props.workspaceId, id, messageId);
      writeJson(lastChatKey(props.workspaceId), chatId());
      props.onClose();
      openChannel(props.workspaceId, chatId(), { kind: "message", id: messageId });
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} title="Start a watch party" onClose={props.onClose}>
      <form class="watch-form" onSubmit={submit}>
        <p class="muted">Everyone plays their own copy of the videos at full quality, in step: they get them before the party starts.</p>
        <label class="watch-field">
          <span>Title</span>
          <input class="mw-input mw-box" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} aria-label="Title" />
        </label>
        <div class="watch-field">
          <span>Videos</span>
          <ul class="watch-pick mw-scroll-fade">
            <For each={props.videos}>
              {(v) => (
                <li>
                  <label>
                    <input type="checkbox" checked={picked().includes(v.fileId)} onChange={(e) => toggle(v.fileId, e.currentTarget.checked)} />
                    <span class="watch-card-name">{v.name}</span>
                    <span class="muted">{formatBytes(v.size)}</span>
                  </label>
                </li>
              )}
            </For>
          </ul>
          <span class="muted">{chosen().length} picked, {formatBytes(chosen().reduce((sum, v) => sum + v.size, 0))}. They play in this order.</span>
        </div>
        <div class="watch-row">
          <label class="watch-field">
            <span>Starts</span>
            <input class="mw-input mw-box" type="datetime-local" value={startsAt()} onInput={(e) => setStartsAt(e.currentTarget.value)} aria-label="Starts" />
          </label>
          <button type="button" class="mw-button mw-box" onClick={() => setStartsAt(localInput(new Date()))}>Now</button>
        </div>
        <div class="watch-field">
          <span>Voice channel</span>
          <Select label="Voice channel" value={voiceId()} onChange={setVoiceId} placeholder="No voice channel"
            options={voices().map((c) => ({ value: c.id, label: channelLabel(props.workspaceId, c), icon: "channel-voice" }))} />
        </div>
        <div class="watch-field">
          <span>Announce in</span>
          <Select label="Announce in" value={chatId()} onChange={setChatId} placeholder="No chat channel"
            options={chats().map((c) => ({ value: c.id, label: channelLabel(props.workspaceId, c), icon: "channel-chat" }))} />
        </div>
        <Show when={error()}><p class="warning">{error()}</p></Show>
        <div class="watch-actions">
          <button type="button" class="mw-button mw-box" onClick={props.onClose}>Cancel</button>
          <button type="submit" class="mw-button primary mw-box" disabled={!ready()}>
            <Show when={busy()} fallback="Start watch party"><span class="mw-spinner" /> Starting...</Show>
          </button>
        </div>
      </form>
    </Dialog>
  );
}
