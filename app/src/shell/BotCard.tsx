// One bot's settings, permissions, memory and log: in Workspace settings > Bots and in the bot's profile.
import { For, Show, createResource, createSignal, onCleanup } from "solid-js";
import { userMessage } from "../api/client";
import { credentialSecret, credentials } from "../core/credentials";
import { member, myId } from "../core/members";
import { can } from "../core/roles";
import { workspaceApi, workspaces } from "../core/workspaces";
import { type Row } from "../p2p/permissions";
import Avatar from "../ui/Avatar";
import Combobox from "../ui/Combobox";
import ConfirmPrompt from "../ui/ConfirmPrompt";
import Select from "../ui/Select";
import "./WorkspaceSettings.css";
import { botLog, runsHere } from "../core/bots";
import { botTypes } from "../plugins/registry";
import { botUsername, cleanBotUsername } from "../core/botName";
import { botPermissionLabel, grantedPermissions } from "../core/botCommands";
import { botConfig } from "../core/botConfig";


const channelsOf = (config: Record<string, unknown>, key: string): number[] => (Array.isArray(config[key]) ? (config[key] as unknown[]).map(Number) : []);

const memoryLimit = 64 * 1024;

// What the bot remembers: how much, and a way to empty it.
function BotMemory(props: { workspaceId: string; botId: number }) {
  const [entries, setEntries] = createSignal<Row[]>([]);
  const [asking, setAsking] = createSignal(false);
  const [error, setError] = createSignal("");
  const api = () => workspaceApi(props.workspaceId).plugin("bots");
  const failed = (e: unknown) => setError(userMessage(e));
  const load = () => void api().read("bots_memory", { bot_id: props.botId }).then((rows) => {
    setEntries(rows);
    setError("");
  }, failed);
  load();
  onCleanup(api().onEvent((event) => { if (event.table === "bots_memory") load(); }));
  const size = () => entries().reduce((sum, row) => sum + String(row.key).length + String(row.value ?? "").length, 0);
  const kb = (bytes: number) => `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return (
    <div class="bot-memory">
      <strong>Memory</strong>
      <span class="hint">{entries().length} {entries().length === 1 ? "entry" : "entries"}, {kb(size())} of {kb(memoryLimit)} used.</span>
      <Show when={entries().length > 0 && can(props.workspaceId, "manage_bots")}>
        <button class="mw-button mw-box" onClick={() => setAsking(true)}>Clear memory</button>
      </Show>
      <ConfirmPrompt open={asking()} question="Clear everything this bot remembers (reminders, counters, warnings)?" confirmLabel="Clear"
        onCancel={() => setAsking(false)}
        onConfirm={() => { setAsking(false); void api().call("memory-clear", { bot_id: props.botId }).then(load, failed); }} />
      <Show when={error()}><p class="warning mw-fade-in">{error()}</p></Show>
    </div>
  );
}

// A text field offering what the bot's server lists (models), while still taking anything typed. Refetches when the
// server address changes, and says when the server can't be reached.
function SuggestField(props: { label: string; placeholder?: string; value: string; server: string; suggest: () => Promise<string[]>; onCommit: (value: string) => void }) {
  const [options] = createResource(() => props.server, () => props.suggest().catch(() => null));
  return (
    <>
      <Combobox label={props.label} placeholder={props.placeholder} value={props.value} suggestions={options() ?? []} onCommit={props.onCommit} />
      <Show when={options() === null}><span class="hint">The server did not answer, so no list. You can still type a name.</span></Show>
    </>
  );
}

export function BotRow(props: { workspaceId: string; row: Row; reload: () => Promise<void>; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const initialConfig = botConfig(props.row);
  const [config, setConfig] = createSignal<Record<string, unknown>>(initialConfig);
  const definition = () => botTypes().find((b) => b.id === String(props.row.type));
  const channelOptions = (type?: string) => (workspaces.byId[props.workspaceId]?.channels ?? []).filter((channel) => !type || channel.type === type).map((channel) => ({
    value: String(channel.id), label: `#${channel.name}`,
  }));
  const [saved] = createResource(() => props.workspaceId, credentials);
  const credentialOptions = () => (saved() ?? []).map((row) => ({ value: String(row.id), label: String(row.name) }));
  const save = () => props.run(async () => {
    await workspaceApi(props.workspaceId).plugin("bots").call("update", { id: props.row.id, config: JSON.stringify(config()) });
    await props.reload();
  });
  const set = (key: string, value: unknown) => setConfig((old) => ({ ...old, [key]: value }));
  // The name and icon live in the bot's member profile (shown everywhere); the nickname is also kept on the bot.
  const profile = (changes: { nickname?: string; avatar?: string }) => props.run(async () => {
    const api = workspaceApi(props.workspaceId);
    const nickname = changes.nickname ?? String(props.row.nickname);
    if (changes.nickname !== undefined) await api.plugin("bots").call("update", { id: props.row.id, nickname });
    await api.plugin("members").call("set-bot-profile", {
      user_id: props.row.user_id, bot_type: String(props.row.type), nickname, bot_number: props.row.bot_number, avatar: changes.avatar ?? null,
    });
    await props.reload();
  });
  const rename = (name: string) => (name.trim() && name.trim() !== String(props.row.nickname) ? profile({ nickname: name.trim() }) : undefined);
  const host = () => Number(props.row.host);
  const hostIsMe = () => host() === myId(props.workspaceId);
  return (
    <article class="bot-card mw-box">
      <header class="bot-card-header">
        <Avatar user={member(props.workspaceId, Number(props.row.user_id))} size={48} />
        <div class="bot-card-title">
          <input class="mw-input mw-box bot-name" aria-label="Bot name" maxLength={48} value={String(props.row.nickname)}
            disabled={!can(props.workspaceId, "manage_bots")}
            onChange={(e) => void rename(e.currentTarget.value)} />
          <span class="hint">@{cleanBotUsername(String(props.row.username ?? botUsername(String(props.row.type))))}#{String(props.row.bot_number ?? 1)} · {definition()?.type.label ?? String(props.row.type)}</span>
        </div>
        <div class="bot-card-actions">
          <button class="mw-button mw-box" disabled={!can(props.workspaceId, "manage_bots")} onClick={() => void profile({ avatar: `gen:${Math.random().toString(36).slice(2, 10)}` })}>New icon</button>
          <button class="mw-button mw-box" disabled={!can(props.workspaceId, "manage_bots")}
            onClick={() => void props.run(async () => {
              await workspaceApi(props.workspaceId).plugin("bots").call("set-status", { id: props.row.id, status: props.row.status === "enabled" ? "disabled" : "enabled" });
              await props.reload();
            })}>{props.row.status === "enabled" ? "Disable" : "Enable"}</button>
          <button class="mw-button mw-box" disabled={!can(props.workspaceId, "manage_bots")}
            onClick={() => void props.run(async () => {
              await workspaceApi(props.workspaceId).plugin("bots").call("remove", { id: props.row.id });
              await props.reload();
            })}>Remove</button>
        </div>
      </header>
      <Show when={definition()?.type.description}><p class="hint">{definition()!.type.description}</p></Show>
      <div class="bot-config">
        <For each={Object.entries(definition()?.type.settings ?? {})}>{([key, field]) =>
          <Show when={key !== "channel"}><label class="account-field">
            <span>{field.label}</span>
            <Show when={field.type === "channel"}>
              <Select label={field.label} options={[{ value: "", label: "Not set" }, ...channelOptions(field.channelType)]} value={String(config()[key] ?? "")}
                onChange={(value) => set(key, value === "" ? undefined : Number(value))} />
            </Show>
            <Show when={field.type === "credential"}>
              <Select label={field.label} options={[{ value: "", label: "None" }, ...credentialOptions()]} value={String(config()[key] ?? "")}
                onChange={(value) => set(key, value === "" ? undefined : Number(value))} />
              <span class="hint">{credentialOptions().length ? "Saved under Credentials in this tab." : "Save one under Credentials in this tab first."}</span>
            </Show>
            <Show when={field.type === "channels"}>
              <div class="bot-channels mw-scroll-fade">
                <For each={channelOptions()}>{(option) =>
                  <label class="bot-permission">
                    <input type="checkbox" checked={channelsOf(config(), key).includes(Number(option.value))}
                      onChange={(e) => {
                        const rest = channelsOf(config(), key).filter((id) => id !== Number(option.value));
                        set(key, e.currentTarget.checked ? [...rest, Number(option.value)] : rest);
                      }} />
                    <span>{option.label}</span>
                  </label>
                }</For>
              </div>
              <span class="hint">{channelsOf(config(), key).length ? "Only the channels checked." : "Any channel the bot can see."}</span>
            </Show>
            <Show when={field.type !== "channel" && field.type !== "channels" && field.type !== "credential"}>
            <Show when={field.type === "bool"} fallback={
              <Show when={field.type === "number"} fallback={
                <Show when={field.suggest} fallback={
                  <input class="mw-input mw-box" type={field.secret ? "password" : "text"} placeholder={field.placeholder}
                    value={String(config()[key] ?? field.default ?? "")} onInput={(e) => set(key, e.currentTarget.value)} />
                }>
                  <SuggestField label={field.label} placeholder={field.placeholder} value={String(config()[key] ?? "")}
                    suggest={async () => field.suggest!(config(), await credentialSecret(props.workspaceId, Number(config().apiKey)).catch(() => null), workspaceApi(props.workspaceId).plugin("bots"))} server={`${String(config().server ?? "")}|${String(config().apiKey ?? "")}`} onCommit={(value) => set(key, value)} />
                </Show>
              }>
                <input class="mw-input mw-box" type="number" value={String(config()[key] ?? field.default ?? "")}
                  onInput={(e) => set(key, Number(e.currentTarget.value))} />
              </Show>
            }>
              <input type="checkbox" checked={config()[key] === true}
                onChange={(e) => set(key, e.currentTarget.checked)} />
            </Show>
            </Show>
          </label></Show>
        }</For>
        <Show when={definition()?.type.settings?.channel}>
          <label class="account-field">
            <span>Channel</span>
            <Select label="Bot channel" options={channelOptions()} value={String(config().channel ?? "")}
              onChange={(value) => set("channel", Number(value))} />
          </label>
        </Show>
      </div>
      <label class="bot-permission bot-assignable">
        <input type="checkbox" disabled={!can(props.workspaceId, "manage_bots")} checked={config()._assignable === true}
          onChange={(e) => {
            const on = e.currentTarget.checked;
            set("_assignable", on);
            void props.run(async () => {
              const saved = { ...botConfig(props.row), _assignable: on };
              await workspaceApi(props.workspaceId).plugin("bots").call("update", { id: props.row.id, config: JSON.stringify(saved) });
              await props.reload();
            });
          }} />
        <span>Assignable: shows up when assigning tasks and issues</span>
      </label>
      <Show when={(definition()?.type.permissions ?? []).length}>
        <div class="bot-permissions">
          <strong>Permissions</strong>
          <For each={definition()!.type.permissions}>{(permission) =>
            <label class="bot-permission">
              <input type="checkbox" disabled={!can(props.workspaceId, "manage_bots")}
                checked={grantedPermissions(config()).includes(permission)}
                onChange={(e) => {
                  const rest = grantedPermissions(config()).filter((p) => p !== permission);
                  set("_permissions", e.currentTarget.checked ? [...rest, permission] : rest);
                }} />
              <span>{botPermissionLabel(permission)}</span>
            </label>
          }</For>
          <span class="hint">Changes apply when you save the settings.</span>
        </div>
      </Show>
      <Show when={grantedPermissions(config()).includes("memory")}>
        <BotMemory workspaceId={props.workspaceId} botId={Number(props.row.id)} />
      </Show>
      <footer class="bot-card-footer">
        <span class="hint">{props.row.status === "enabled" ? "Enabled" : "Disabled"} · runs on {hostIsMe() ? "your devices" : `${member(props.workspaceId, host()).displayName}'s devices`}</span>
        <Show when={!hostIsMe()}>
          <button class="mw-button mw-box" disabled={!can(props.workspaceId, "manage_bots")} onClick={() => void props.run(() =>
            workspaceApi(props.workspaceId).plugin("bots").call("update", { id: props.row.id, host: myId(props.workspaceId) }))}>Run on my devices</button>
        </Show>
        <Show when={hostIsMe() && definition()?.type.isBusy?.(Number(props.row.user_id))}>
          <button class="mw-button mw-box" disabled={!can(props.workspaceId, "manage_bots")} onClick={() => definition()?.type.stop?.(Number(props.row.user_id))}>Stop</button>
        </Show>
        <button class="mw-button mw-box" disabled={!can(props.workspaceId, "manage_bots")} onClick={() => void save()}>Save settings</button>
      </footer>
      <Show when={hostIsMe()}>
        <Show when={botLog(props.workspaceId, Number(props.row.id)).length} fallback={
          <p class="hint">{runsHere(props.workspaceId, Number(props.row.id)) ? "Running on this device." : "Not running on this device."}</p>
        }>
          <pre class="bot-log mw-box mw-scroll-fade">{botLog(props.workspaceId, Number(props.row.id)).join("\n")}</pre>
        </Show>
      </Show>
    </article>
  );
}
