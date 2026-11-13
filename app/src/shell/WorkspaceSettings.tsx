// A workspace's settings: overview, roles, members and bans, invite. Controls the signed-in user may not use are
// disabled; every member's policy refuses those changes anyway.
import { showToast } from "../core/notices";
import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { credentials, removeCredential, replaceCredential, storeCredential } from "../core/credentials";
import { detailedMessage, ShownError, userMessage } from "../api/client";
import { account, accountAgreementKey, avatarColors } from "../core/account";
import { matchMembers, member, memberListVisible, myId } from "../core/members";
import { bans, can, roleList, rolesOf, standingOf } from "../core/roles";
import { isServerless, leaveQuestion, leaveServerless, postKickNote, rotateWorkspaceSecret, workspaceInvite, workspaceLedger } from "../core/serverless";
import { historyKinds, workspaceHistory, type HistoryKind } from "../core/workspaceHistory";
import {
  applyWorkspaceRevert, applyWorkspaceUndo, planWorkspaceRevert, planWorkspaceUndo, type RevertPlan, type UndoPlan,
} from "../core/workspaceHistoryActions";
import { deleteContent, isSynced, setSynced } from "../core/content";
import { customEmojiList, customEmojiSrc, loadCustomEmoji, removeCustomEmoji, type CustomEmoji } from "../core/customEmoji";
import { createWorkspaceSnapshot, exportWorkspaceArchive, readWorkspaceArchive } from "../core/workspaceSnapshots";
import { storeFile } from "../core/stream";
import { formatBytes, relativeTime, timeUntil } from "../core/time";
import { channelLabel, workspaceApi, workspaceImage, workspaces } from "../core/workspaces";
import { botFocus, closeOverlays, openSettings, setBotFocus } from "../core/ui";
import { allPermissions, parsePermissions, permissionInfo, type Permission, type Row } from "../p2p/permissions";
import { Icon } from "../theme/icons";
import Avatar from "../ui/Avatar";
import { avatarFromFile } from "../ui/avatarImage";
import Collapse from "../ui/Collapse";
import ColorSwatches from "../ui/ColorSwatches";
import ConfirmPrompt from "../ui/ConfirmPrompt";
import CustomEmojiForm from "../ui/CustomEmojiForm";
import Select from "../ui/Select";
import "./WorkspaceSettings.css";
import { handleOf } from "../core/userServer";
import MoveMember, { canMoveMember } from "./MoveMember";
import NodesSettings from "./NodesSettings";
import { isNode } from "../core/nodes";
import { AccessTitle, ChannelAccess } from "./VisibilityPanel";
import type { VisibilityTarget } from "../p2p/visibility";
import { channelType } from "../core/channelTypes";
import WorkspacePlugins from "./WorkspacePlugins";
import { BotRow } from "./BotCard";
import { botTypes } from "../plugins/registry";
import { botPermissionLabel } from "../core/botCommands";
import { openContextMenu, type MenuEntry } from "../ui/contextMenu";
import Disclosure from "../ui/Disclosure";
import { userMenu } from "./userMenu";
import StatusDot from "../ui/StatusDot";
import { saveBlob } from "../ui/download";
import { onlineStatus } from "../core/onlineStatus";
import { peerStatusOf } from "../core/presence";
import { isSealed, pairKeys, seal, unseal } from "../dm/crypto";
import { inviteOpen, inviteTokenKey, inviteUses, newInviteToken } from "../p2p/invite";
import { createCopied } from "../ui/clipboard";

export const workspaceSettingsSections = [
  { id: "profile", label: "Your profile", keywords: "nickname about" },
  { id: "overview", label: "Overview", keywords: "name icon color welcome leave delete" },
  { id: "roles", label: "Roles", keywords: "permissions administrator" },
  { id: "channels", label: "Channels", keywords: "visibility access private rules" },
  { id: "emoji", label: "Emoji", keywords: "custom" },
  { id: "members", label: "Members", keywords: "kick ban people" },
  { id: "plugins", label: "Plugins", keywords: "" },
  { id: "bots", label: "Bots", keywords: "credentials agents" },
  { id: "invite", label: "Invite", keywords: "invites code link guest" },
  { id: "nodes", label: "Nodes", keywords: "storage copies" },
  { id: "history", label: "History", keywords: "undo revert snapshot archive log" },
] as const;

// One server's settings sections, shown in the overlay page (shell/Overlays.tsx).
export function WorkspaceSettingsContent(props: { workspaceId: string; section: string }) {
  return (
    <Show when={props.workspaceId} keyed>
      {(id) => (
        <Switch>
          <Match when={props.section === "profile"}><div class="mw-fade-in"><Profile workspaceId={id} /></div></Match>
          <Match when={props.section === "overview"}><div class="mw-fade-in"><Overview workspaceId={id} /></div></Match>
          <Match when={props.section === "roles"}><div class="mw-fade-in"><Roles workspaceId={id} /></div></Match>
          <Match when={props.section === "channels"}><div class="mw-fade-in"><Channels workspaceId={id} /></div></Match>
          <Match when={props.section === "emoji"}><div class="mw-fade-in"><EmojiSettings workspaceId={id} /></div></Match>
          <Match when={props.section === "plugins"}><div class="mw-fade-in"><WorkspacePlugins workspaceId={id} /></div></Match>
          <Match when={props.section === "bots"}><div class="mw-fade-in"><Bots workspaceId={id} /></div></Match>
          <Match when={props.section === "members"}><div class="mw-fade-in"><Members workspaceId={id} /></div></Match>
          <Match when={props.section === "invite"}><div class="mw-fade-in"><Invite workspaceId={id} /></div></Match>
          <Match when={props.section === "nodes"}><div class="mw-fade-in"><NodesSettings workspaceId={id} /></div></Match>
          <Match when={props.section === "history"}><div class="mw-fade-in"><History workspaceId={id} /></div></Match>
        </Switch>
      )}
    </Show>
  );
}

// After a change that takes someone's way in away (it stands either way): the room secret follows. A sentence for the user
// when that didn't fully work, else "".
async function changeRoomSecret(workspaceId: string, done: string): Promise<string> {
  try {
    const { missed } = await rotateWorkspaceSecret(workspaceId);
    return missed ? `${done}. ${missed === 1 ? "One member" : `${missed} members`} couldn't be given the new room secret from this device and may need a new invite.` : "";
  } catch (e) {
    return `${done}, but the room secret couldn't be changed, so anyone who already has it can still reach the room: ${detailedMessage(e)}`;
  }
}

function useError() {
  const [error, setError] = createSignal("");
  const run = async (action: () => Promise<unknown>) => {
    setError("");
    try {
      await action();
    } catch (e) {
      setError(detailedMessage(e));
    }
  };
  // What changes on the spot, with no Save button to press, says it was saved.
  const save = (action: () => Promise<unknown>) => run(async () => {
    await action();
    showToast("Saved");
  });
  return [error, run, save] as const;
}

// What others see of you in this workspace: a nickname and about text of its own, and your roles.
function Profile(props: { workspaceId: string }) {
  const me = () => member(props.workspaceId, myId(props.workspaceId) ?? -1);
  const owner = () => standingOf(props.workspaceId, me().id).owner;
  const [error, , saved] = useError();
  const save = (changes: { nickname?: string; bio?: string }) => saved(() =>
    workspaceApi(props.workspaceId).plugin("members").call("set-workspace-profile", {
      nickname: changes.nickname ?? me().nickname, bio: changes.bio ?? me().bio,
    }));

  return (
    <div class="settings-section account-settings">
      <h2>Your profile</h2>
      <div class="account-header">
        <span class="status-avatar">
          <Avatar user={me()} size={56} />
          <StatusDot status={onlineStatus()} />
        </span>
        <div>
          <div class="account-name">{me().displayName}</div>
          <div class="hint">{handleOf(me())}</div>
        </div>
      </div>
      <label class="account-field">
        <span>Nickname in this workspace</span>
        <input class="mw-input mw-box" maxLength={48} placeholder={me().accountName} value={me().nickname}
          onChange={(e) => void save({ nickname: e.currentTarget.value.trim() })} />
      </label>
      <label class="account-field">
        <span>About me</span>
        <textarea class="mw-input mw-box profile-bio" maxLength={500} rows={4} value={me().bio}
          onChange={(e) => void save({ bio: e.currentTarget.value.trim() })} />
      </label>
      <div class="account-field">
        <span>Your roles</span>
        <div class="workspace-member-roles">
          <Show when={owner()}><span class="role-chip mw-box">owner</span></Show>
          <For each={rolesOf(props.workspaceId, me().id)}>
            {(role) => (
              <span class="role-chip mw-box">
                <span class="role-dot" style={{ background: String(role.color || "var(--mw-text-disabled)") }} />
                {String(role.name)}
              </span>
            )}
          </For>
          <Show when={!owner() && rolesOf(props.workspaceId, me().id).length === 0}><span class="hint">Only @everyone.</span></Show>
        </div>
      </div>
      <p class="hint">Your avatar, color and display name belong to your account and are the same in every workspace.</p>
      <button class="mw-button mw-box" onClick={() => openSettings("profile")}><Icon name="profile" /> Edit profile</button>
      <Show when={error()}><p class="warning">{error()}</p></Show>
    </div>
  );
}

function Bots(props: { workspaceId: string }) {
  const [rows, setRows] = createSignal<Row[]>([]);
  const [selectedId, setSelectedId] = createSignal<number | null>(null);
  const [nickname, setNickname] = createSignal("");
  const [type, setType] = createSignal(botTypes()[0]?.id ?? "");
  const wanted = () => botTypes().find((b) => b.id === type())?.type.permissions ?? [];
  const [declined, setDeclined] = createSignal<string[]>([]);
  const load = async (): Promise<void> => {
    const api = workspaceApi(props.workspaceId);
    let [next, profiles] = await Promise.all([
      api.plugin("bots").read("bots_bots"),
      api.plugin("members").read("members_profiles"),
    ]);
    if (can(props.workspaceId, "manage_bots")) {
      const unnamed = next.filter((row) => row.nickname == null || String(row.nickname).trim().toLowerCase() === "null");
      if (unnamed.length) {
        await Promise.all(unnamed.map((row) => api.plugin("bots").call("update", { id: row.id, nickname: "" })));
        [next, profiles] = await Promise.all([
          api.plugin("bots").read("bots_bots"),
          api.plugin("members").read("members_profiles"),
        ]);
      }
      const byId = new Map(profiles.map((profile) => [Number(profile.user_id), profile]));
      await Promise.all(next.filter((row) => {
        const profile = byId.get(Number(row.user_id));
        return !profile || profile.username !== row.username || Number(profile.bot_number) !== Number(row.bot_number)
          || profile.nickname !== row.nickname || profile.bot_type !== row.type;
      }).map((row) => api.plugin("members").call("set-bot-profile", {
        user_id: row.user_id, bot_type: row.type, nickname: row.nickname, bot_number: row.bot_number,
      })));
    }
    setRows(next);
    const focus = next.find((row) => Number(row.user_id) === botFocus());
    if (focus) {
      setSelectedId(Number(focus.id));
      setBotFocus(null);
    }
    if (selectedId() === null || !next.some((row) => Number(row.id) === selectedId()))
      setSelectedId(next[0] ? Number(next[0].id) : null);
  };
  void load();
  const stopListening = workspaceApi(props.workspaceId).plugin("bots").onEvent((event) => {
    if (event.table === "bots_bots") void load();
  });
  onCleanup(stopListening);
  // A leader's assistants sit under it, indented.
  const ordered = () => {
    const parentOf = (row: Row): number | null => {
      try { const parent = Number(JSON.parse(String(row.config || "{}"))._parent); return parent > 0 ? parent : null; } catch { return null; }
    };
    const list = rows();
    const ids = new Set(list.map((row) => Number(row.user_id)));
    const top = list.filter((row) => { const p = parentOf(row); return p === null || !ids.has(p); });
    return top.flatMap((row) => [
      { row, child: false },
      ...list.filter((other) => parentOf(other) === Number(row.user_id)).map((other) => ({ row: other, child: true })),
    ]);
  };
  const [error, run] = useError();
  const add = () => run(async () => {
    const existing = new Set((await workspaceApi(props.workspaceId).plugin("bots").read("bots_bots")).map((row) => Number(row.user_id)));
    let userId = Math.floor(Date.now() * 1000 + Math.random() * 1000);
    while (existing.has(userId)) userId++;
    if (!type()) throw new Error("Choose a bot type.");
    const name = nickname().trim() || botTypes().find((b) => b.id === type())?.type.randomName?.(userId) || "";
    const created = await workspaceApi(props.workspaceId).plugin("bots").call<{ nickname: string; bot_number: number }>("create", {
      user_id: userId, type: type(), nickname: name,
      config: JSON.stringify({ ...botTypes().find((b) => b.id === type())?.type.defaultConfig?.(), _permissions: wanted().filter((permission) => !declined().includes(permission)) }),
    });
    await workspaceApi(props.workspaceId).plugin("members").call("set-bot-profile", {
      user_id: userId, bot_type: type(), nickname: created.nickname, bot_number: created.bot_number,
    });
    setNickname("");
    setDeclined([]);
    await load();
  });
  return (
    <section class="settings-section bot-settings">
      <h2>Bots</h2>
      <p class="hint">Bots run on a member's device. Only one device runs a bot at a time.</p>
      <Show when={botTypes().length === 0}>
        <p class="hint">
          Install a client plugin that contributes bot types, such as Bot examples, in Plugin settings.{" "}
          <button class="mw-button mw-box" onClick={() => openSettings("plugins")}>Open Plugin settings</button>
        </p>
      </Show>
      <Show when={can(props.workspaceId, "store_credentials")}><Credentials workspaceId={props.workspaceId} /></Show>
      <div class="bot-layout">
        <aside class="bot-sidebar">
          <Show when={can(props.workspaceId, "manage_bots") && botTypes().length}>
            <div class="bot-add">
              <label class="account-field">
                <span>Display name <span class="hint">(optional)</span></span>
                <input class="mw-input mw-box" placeholder="A name that fits the type, if empty" value={nickname()} onInput={(e) => setNickname(e.currentTarget.value)} />
              </label>
              <div class="bot-add-row">
                <Select label="Bot type" options={botTypes().map((b) => ({ value: b.id, label: b.type.label }))} value={type()}
                  onChange={(value) => { setType(value); setDeclined([]); }} />
                <button class="mw-button mw-box" onClick={() => void add()}>{wanted().length ? "Approve and add" : "Add bot"}</button>
              </div>
              <Show when={wanted().length}>
                <div class="bot-permissions">
                  <span class="hint">This bot asks to:</span>
                  <For each={wanted()}>{(permission) =>
                    <label class="bot-permission">
                      <input type="checkbox" checked={!declined().includes(permission)}
                        onChange={(e) => setDeclined((old) => e.currentTarget.checked ? old.filter((p) => p !== permission) : [...old, permission])} />
                      <span>{botPermissionLabel(permission)}</span>
                    </label>
                  }</For>
                  <span class="hint">Anything you uncheck is refused, and the commands that need it say so.</span>
                </div>
              </Show>
            </div>
          </Show>
          <div class="bot-list">
            <For each={ordered()}>{({ row, child }) => {
              const who = () => member(props.workspaceId, Number(row.user_id));
              return (
                <button class="bot-list-item mw-box" classList={{ selected: selectedId() === Number(row.id), child }}
                  onClick={() => setSelectedId(Number(row.id))}
                  onContextMenu={(event) => openContextMenu(event, userMenu(props.workspaceId, Number(row.user_id)))}>
                  <Avatar user={who()} size={32} />
                  <span class="bot-list-name">
                    <strong>{who().displayName}</strong>
                    <span class="hint">{handleOf(who())}</span>
                  </span>
                  <span class="bot-status" classList={{ disabled: row.status !== "enabled" }} />
                </button>
              );
            }}</For>
          </div>
        </aside>
        <main class="bot-detail">
          <Show when={rows().find((row) => Number(row.id) === selectedId())} keyed fallback={<p class="hint">Select a bot to view its settings.</p>}>
            {(row) => <BotRow workspaceId={props.workspaceId} row={row} reload={load} run={run} />}
          </Show>
        </main>
      </div>
      <Show when={error()}><p class="warning">{error()}</p></Show>
    </section>
  );
}

// Secrets bots can use (a model server's key). Sealed for the members who store credentials; never shown again.
function Credentials(props: { workspaceId: string }) {
  const [list, { refetch }] = createResource(() => props.workspaceId, credentials);
  const [name, setName] = createSignal("");
  const [secret, setSecret] = createSignal("");
  const [error, setError] = createSignal("");
  const [removing, setRemoving] = createSignal<Row | null>(null);
  const [replacing, setReplacing] = createSignal<number | null>(null);
  onCleanup(workspaceApi(props.workspaceId).plugin("bots").onEvent((event) => { if (event.table === "bots_credentials") void refetch(); }));
  const run = async (action: () => Promise<void>) => {
    setError("");
    try { await action(); void refetch(); } catch (e) { setError(detailedMessage(e)); }
  };
  return (
    <div class="bot-credentials">
      <h3>Credentials</h3>
      <span class="hint">Secrets for bots, such as a model server's key. Only members who store credentials can read them.</span>
      <For each={list() ?? []}>{(row) =>
        <div class="bot-credential">
          <span>{String(row.name)}</span>
          <Show when={replacing() === Number(row.id)} fallback={
            <button class="mw-button mw-box" onClick={() => { setSecret(""); setReplacing(Number(row.id)); }}>Replace</button>
          }>
            <input class="mw-input mw-box" type="password" placeholder="New secret" value={secret()} onInput={(e) => setSecret(e.currentTarget.value)} />
            <button class="mw-button mw-box" onClick={() => void run(async () => { await replaceCredential(props.workspaceId, Number(row.id), String(row.name), secret()); setReplacing(null); setSecret(""); })}>Save</button>
            <button class="mw-button mw-box" onClick={() => setReplacing(null)}>Cancel</button>
          </Show>
          <button class="mw-button mw-box" onClick={() => setRemoving(row)}>Remove</button>
        </div>
      }</For>
      <div class="bot-credential">
        <input class="mw-input mw-box" placeholder="Name" maxLength={64} value={name()} onInput={(e) => setName(e.currentTarget.value)} />
        <input class="mw-input mw-box" type="password" placeholder="Secret" autocomplete="off" value={secret()} onInput={(e) => setSecret(e.currentTarget.value)} />
        <button class="mw-button mw-box" disabled={!name().trim() || !secret() || replacing() !== null}
          onClick={() => void run(async () => { await storeCredential(props.workspaceId, name().trim(), secret()); setName(""); setSecret(""); })}>Save credential</button>
      </div>
      <Show when={error()}><p class="warning">{error()}</p></Show>
      <ConfirmPrompt open={removing() !== null} question={`Remove the credential '${String(removing()?.name ?? "")}'? Bots using it stop being able to sign in.`} confirmLabel="Remove"
        onCancel={() => setRemoving(null)}
        onConfirm={() => { const row = removing(); setRemoving(null); if (row) void run(() => removeCredential(props.workspaceId, Number(row.id))); }} />
    </div>
  );
}

function Overview(props: { workspaceId: string }) {
  const ext = () => workspaceApi(props.workspaceId).plugin("channels");
  const info = () => workspaces.byId[props.workspaceId]?.info;
  const allowed = () => can(props.workspaceId, "manage_workspace");
  const [error, run, saved] = useError();
  let picker!: HTMLInputElement;
  const chatChannels = () => (workspaces.byId[props.workspaceId]?.channels ?? []).filter((c) => c.type === "chat");
  const save = (values: Record<string, string | number | null>) => saved(async () => {
    const [current] = await ext().read("channels_workspace");
    if (current) await ext().update("channels_workspace", values, { id: current.id });
    else await ext().insert("channels_workspace", { name: info()?.name ?? "", short: "", color: "", icon: "", ...values });
  });

  return (
    <div class="settings-section account-settings">
      <h2>Overview</h2>
      <Show when={!allowed()}><p class="hint">You need the "Manage workspace" permission to change these.</p></Show>
      <label class="account-field">
        <span>Name</span>
        <input class="mw-input mw-box" maxLength={64} value={info()?.name ?? ""} disabled={!allowed()}
          onChange={(e) => e.currentTarget.value.trim() && void save({ name: e.currentTarget.value.trim() })} />
      </label>
      <div class="account-field">
        <span>Icon</span>
        <div class="workspace-icon-field">
          <Show when={info()}>{(i) => <span class="workspace-button workspace-icon-preview mw-box" style={{ background: i().color || undefined }}>
            <Show when={workspaceImage(i())} fallback={i().short || i().name.slice(0, 2)}>{(src) => <img class="workspace-image" src={src()} alt="" />}</Show>
          </span>}</Show>
          <button class="mw-button mw-box" disabled={!allowed()} onClick={() => picker.click()}><Icon name="image" /> Upload picture</button>
          <Show when={info() && workspaceImage(info()!)}>
            <button class="mw-button mw-box" disabled={!allowed()} onClick={() => void save({ icon: "" })}><Icon name="close" /> Remove</button>
          </Show>
          <input ref={picker} type="file" accept="image/*" hidden onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (file) void run(async () => save({ icon: await avatarFromFile(file).catch((err: Error) => { throw new ShownError(err.message); }) }));
          }} />
        </div>
        <span class="hint">Cropped to a square. Members see it in their workspace bar.</span>
      </div>
      <label class="account-field">
        <span>Short name (shown when there is no icon)</span>
        <input class="mw-input mw-box workspace-short" maxLength={3} value={info()?.short ?? ""} disabled={!allowed()}
          onChange={(e) => void save({ short: e.currentTarget.value.trim() })} />
      </label>
      <div class="account-field">
        <span>Color</span>
        <ColorSwatches colors={avatarColors} label="Color" none custom value={info()?.color ?? ""} disabled={!allowed()} onPick={(color) => void save({ color })} />
      </div>
      <label class="account-field">
        <span>Welcome channel</span>
        <Select label="Welcome channel" disabled={!allowed()} value={info()?.welcomeChannelId ?? 0}
          options={[{ value: 0, label: "None" }, ...chatChannels().map((channel) => ({ value: channel.id, label: channelLabel(props.workspaceId, channel) }))]}
          onChange={(id) => void save({ welcome_channel_id: id || null })} />
        <span class="hint">New members get a "joined" message here.</span>
      </label>
      <Show when={error()}><p class="warning">{error()}</p></Show>
      <Show when={isServerless(props.workspaceId)}><LeaveWorkspace workspaceId={props.workspaceId} /></Show>
    </div>
  );
}

function LeaveWorkspace(props: { workspaceId: string }) {
  const name = () => workspaces.byId[props.workspaceId]?.info.name ?? "this workspace";
  const [asking, setAsking] = createSignal<"keep" | "delete" | null>(null);
  const leave = (keepData: boolean) => {
    setAsking(null);
    closeOverlays();
    void leaveServerless(props.workspaceId, keepData);
  };
  return (
    <section class="workspace-leave">
      <h3>Leave this workspace</h3>
      <div class="workspace-member-actions">
        <button class="mw-button mw-box" aria-expanded={asking() === "keep"} onClick={() => setAsking(asking() === "keep" ? null : "keep")}>
          <Icon name="sign-out" /> Leave
        </button>
        <button class="mw-button mw-box" aria-expanded={asking() === "delete"} onClick={() => setAsking(asking() === "delete" ? null : "delete")}>
          Leave and delete data
        </button>
      </div>
      <ConfirmPrompt open={asking() === "keep"} question={leaveQuestion(name(), true)} confirmLabel="Leave"
        onCancel={() => setAsking(null)} onConfirm={() => leave(true)} />
      <ConfirmPrompt open={asking() === "delete"} question={leaveQuestion(name(), false)} confirmLabel="Leave and delete"
        onCancel={() => setAsking(null)} onConfirm={() => leave(false)} />
    </section>
  );
}

// Who sees and who may change each category and channel: every one of them, with the rules editor of the picked one.
function EmojiSettings(props: { workspaceId: string }) {
  const canManage = () => can(props.workspaceId, "manage_emojis");
  const [adding, setAdding] = createSignal(false);
  const [removing, setRemoving] = createSignal<CustomEmoji | null>(null);
  const [error, setError] = createSignal("");
  createEffect(() => { void loadCustomEmoji(props.workspaceId); });
  const list = () => customEmojiList(props.workspaceId);
  const remove = async () => {
    const emoji = removing();
    if (!emoji) return;
    setRemoving(null);
    setError("");
    try {
      await removeCustomEmoji(props.workspaceId, emoji.id);
    } catch (e) {
      setError(userMessage(e));
    }
  };
  return (
    <div class="settings-section emoji-settings">
      <h2>Emoji</h2>
      <p class="hint">
        Custom emoji belong to this workspace and work in messages, comments, documents and reactions. Removing one
        hides it from the picker; old messages keep showing it and its name stays reserved.
      </p>
      <Show when={canManage()}>
        <Show when={adding()} fallback={
          <button class="mw-button mw-box" onClick={() => setAdding(true)}><Icon name="add" /> Add emoji</button>
        }>
          <CustomEmojiForm workspaceId={props.workspaceId} onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />
        </Show>
      </Show>
      <Show when={list().length > 0} fallback={<p class="hint">{canManage() ? "No custom emoji yet." : "This workspace has no custom emoji."}</p>}>
        <div class="emoji-settings-list">
          <For each={list()}>
            {(emoji) => (
              <div class="emoji-settings-row mw-box mw-fade-in">
                <Show when={customEmojiSrc(emoji)} fallback={<span class="emoji-settings-image muted">{`:${emoji.name}:`}</span>}>
                  {(src) => <img class="emoji-settings-image" src={src()} alt={`:${emoji.name}:`} loading="lazy" />}
                </Show>
                <div class="emoji-settings-name">
                  <strong>:{emoji.name}:</strong>
                  <span class="hint">{formatBytes(emoji.size)}</span>
                </div>
                <Show when={canManage()}>
                  <button class="mw-button mw-box danger" title={`Remove :${emoji.name}:`} aria-label={`Remove :${emoji.name}:`}
                    onClick={() => setRemoving(emoji)}><Icon name="delete" /></button>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={error()}><p class="warning">{error()}</p></Show>
      <ConfirmPrompt open={!!removing()} question={`Remove :${removing()?.name ?? ""}: from the picker? Old messages keep it.`}
        confirmLabel="Remove" onConfirm={() => void remove()} onCancel={() => setRemoving(null)} />
    </div>
  );
}

function Channels(props: { workspaceId: string }) {
  const server = () => workspaces.byId[props.workspaceId];
  const [picked, setPicked] = createSignal<{ target: VisibilityTarget; id: number } | null>(null);
  const shown = () => {
    const p = picked();
    const exists = p && (p.target === "channel" ? server()?.allChannels : server()?.allCategories)?.some((x) => x.id === p.id);
    if (exists) return p;
    const first = server()?.allCategories[0];
    return first ? { target: "category" as const, id: first.id } : null;
  };
  const isShown = (target: VisibilityTarget, id: number) => shown()?.target === target && shown()?.id === id;
  const ruleCount = (target: VisibilityTarget, id: number) =>
    (server()?.visibility ?? []).filter((r) => r.target === target && r.target_id === id).length;

  return (
    <div class="settings-section">
      <h2>Channels</h2>
      <p class="hint">
        Who sees each category and channel, and who may change things in it. Channels without rules follow their
        category. Right-click a channel or category in the channel bar for the same rules.
      </p>
      <div class="roles-layout">
        <div class="roles-list access-list mw-scroll-fade">
          <For each={server()?.allCategories ?? []}>
            {(category) => (
              <>
                <button class="roles-item mw-box" classList={{ selected: isShown("category", category.id) }}
                  onClick={() => setPicked({ target: "category", id: category.id })}>
                  <Icon name="folder" />
                  <span class="roles-item-name">{category.name}</span>
                  <Show when={ruleCount("category", category.id)}>{(n) => <span class="access-count" title={`${n()} rules`}>{n()}</span>}</Show>
                </button>
                <For each={(server()?.allChannels ?? []).filter((c) => c.categoryId === category.id)}>
                  {(channel) => (
                    <button class="roles-item access-channel mw-box" classList={{ selected: isShown("channel", channel.id) }}
                      onClick={() => setPicked({ target: "channel", id: channel.id })}>
                      <Icon name={channelType(channel.type).icon} />
                      <span class="roles-item-name">{channel.name}</span>
                      <Show when={ruleCount("channel", channel.id)}>{(n) => <span class="access-count" title={`${n()} rules`}>{n()}</span>}</Show>
                    </button>
                  )}
                </For>
              </>
            )}
          </For>
        </div>
        <Show when={shown()} keyed fallback={<p class="hint">This workspace has no channels yet.</p>}>
          {(p) => (
            <div class="access-editor visibility-panel">
              <AccessTitle workspaceId={props.workspaceId} target={p.target} id={p.id} />
              <ChannelAccess workspaceId={props.workspaceId} target={p.target} id={p.id} />
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}

function Roles(props: { workspaceId: string }) {
  const roles = () => workspaceApi(props.workspaceId).plugin("roles");
  const list = () => roleList(props.workspaceId);
  const me = () => standingOf(props.workspaceId, myId(props.workspaceId) ?? -1);
  const allowed = () => can(props.workspaceId, "manage_roles");
  const [selectedId, setSelectedId] = createSignal<number | null>(null);
  const selected = createMemo(() => list().find((r) => r.id === selectedId()) ?? list()[0]);
  const [error, run] = useError();
  const create = () => run(async () => {
    const { id } = await roles().call<{ id: number }>("create-role", { name: "new role" });
    setSelectedId(id);
  });

  return (
    <div class="settings-section">
      <h2>Roles</h2>
      <p class="hint">
        Members have the permissions of @everyone plus those of each of their roles. Roles higher in the list can
        manage the ones below them.
      </p>
      <div class="roles-layout">
        <div class="roles-list">
          <For each={list()}>
            {(role) => (
              <button class="roles-item mw-box" classList={{ selected: selected()?.id === role.id }} onClick={() => setSelectedId(role.id)}>
                <span class="role-dot" style={{ background: String(role.color || "var(--mw-text-disabled)") }} />
                <span class="roles-item-name">{role.everyone ? "@everyone" : String(role.name)}</span>
              </button>
            )}
          </For>
          <Show when={allowed()}>
            <button class="mw-button mw-box" onClick={() => void create()}><Icon name="add" /> Create role</button>
          </Show>
        </div>
        <Show when={selected()} keyed fallback={<p class="hint">This workspace has no roles yet.</p>}>
          {(role) => <RoleEditor workspaceId={props.workspaceId} role={role} editable={allowed() && (!!role.everyone || Number(role.position) < me().highest)}
            mine={me().permissions} onError={(e) => run(() => Promise.reject(e))} onDeleted={() => setSelectedId(null)} />}
        </Show>
      </div>
      <Show when={error()}><p class="warning">{error()}</p></Show>
    </div>
  );
}

function RoleEditor(props: {
  workspaceId: string; role: Row; editable: boolean; mine: Set<Permission>; onError: (e: unknown) => void; onDeleted: () => void;
}) {
  const roles = () => workspaceApi(props.workspaceId).plugin("roles");
  const permissions = () => new Set(parsePermissions(props.role.permissions));
  const [asking, setAsking] = createSignal(false);
  const edit = (changes: { name?: string; color?: string; permissions?: Permission[]; mentionable?: boolean; channels?: string }) =>
    roles().call("edit-role", {
      id: props.role.id,
      name: changes.name ?? String(props.role.name),
      color: changes.color ?? String(props.role.color ?? ""),
      permissions: (changes.permissions ?? [...permissions()]).join(","),
      mentionable: changes.mentionable ?? !!props.role.mentionable,
      channels: changes.channels ?? String(props.role.channels ?? ""),
    }).catch(props.onError);
  const channelOptions = () => [
    ...(props.role.everyone ? [] : [{ value: "", label: "Like @everyone" }]),
    { value: "show", label: "Visible", icon: "visible" },
    { value: "hide", label: "Hidden", icon: "hidden" },
  ];
  const toggle = (permission: Permission, on: boolean) => {
    const next = new Set(permissions());
    if (on) next.add(permission);
    else next.delete(permission);
    void edit({ permissions: allPermissions.filter((p) => next.has(p)) });
  };
  const move = (direction: 1 | -1) => {
    const others = roleList(props.workspaceId).filter((r) => !r.everyone);
    const index = others.findIndex((r) => r.id === props.role.id);
    // Up: below the role two above; down: below the next one.
    const target = direction < 0 ? others[index - 2] : others[index + 1];
    if (direction < 0 && index === 0) return;
    if (direction > 0 && !target) return;
    void roles().call("move-role", { id: props.role.id, below_id: target?.id ?? null }).catch(props.onError);
  };
  const remove = () => {
    setAsking(false);
    void roles().call("delete-role", { id: props.role.id }).then(props.onDeleted, props.onError);
  };

  return (
    <div class="role-editor">
      <Show when={!props.editable}>
        <p class="hint">You can only change roles below your highest role, with the "Manage roles" permission.</p>
      </Show>
      <Show when={!props.role.everyone}>
        <label class="account-field">
          <span>Name</span>
          <input class="mw-input mw-box" maxLength={32} value={String(props.role.name)} disabled={!props.editable}
            onChange={(e) => e.currentTarget.value.trim() && void edit({ name: e.currentTarget.value.trim() })} />
        </label>
        <div class="account-field">
          <span>Color</span>
          <ColorSwatches colors={avatarColors} label="Role color" none custom value={String(props.role.color ?? "")} disabled={!props.editable} onPick={(color) => void edit({ color })} />
        </div>
        <label class="role-check">
          <input type="checkbox" checked={!!props.role.mentionable} disabled={!props.editable}
            onChange={(e) => void edit({ mentionable: e.currentTarget.checked })} />
          <span>Anyone can mention this role</span>
        </label>
      </Show>
      <h3>Channels</h3>
      <label class="account-field">
        <span>Channels without visibility rules</span>
        <Select label="Channels without visibility rules" disabled={!props.editable} options={channelOptions()}
          value={props.role.channels === "show" || props.role.channels === "hide" ? String(props.role.channels) : props.role.everyone ? "show" : ""}
          onChange={(channels) => void edit({ channels })} />
      </label>
      <p class="hint">
        {props.role.everyone
          ? "Hidden makes every channel private until a rule shows it (right-click a channel or category, Visibility)."
          : "A role set to Visible sees them even when @everyone doesn't. The owner and administrators always do."}
      </p>
      <h3>Permissions</h3>
      <For each={allPermissions}>
        {(permission) => {
          // Granting needs the permission yourself; taking one away doesn't.
          const blocked = () => !props.editable || (!permissions().has(permission) && !props.mine.has(permission));
          return (
            <label class="role-check" classList={{ disabled: blocked() }}>
              <input type="checkbox" checked={permissions().has(permission)} disabled={blocked()}
                onChange={(e) => toggle(permission, e.currentTarget.checked)} />
              <span>
                {permissionInfo[permission].label}
                <span class="hint"> {permissionInfo[permission].description}</span>
              </span>
            </label>
          );
        }}
      </For>
      <Show when={!props.role.everyone && props.editable}>
        <div class="role-actions">
          <button class="mw-button mw-box" onClick={() => move(-1)}><Icon name="menu-up" /> Move up</button>
          <button class="mw-button mw-box" onClick={() => move(1)}><Icon name="expanded" /> Move down</button>
          <button class="mw-button mw-box" onClick={() => setAsking(true)}><Icon name="delete" /> Delete role</button>
        </div>
        <ConfirmPrompt open={asking()} question={`Delete the role ${String(props.role.name)}?`} confirmLabel="Delete"
          onConfirm={remove} onCancel={() => setAsking(false)} />
      </Show>
    </div>
  );
}

const memberPage = 100;

function Members(props: { workspaceId: string }) {
  const banned = () => new Set(bans(props.workspaceId).map((b) => b.user_id));
  const [query, setQuery] = createSignal("");
  const [shown, setShown] = createSignal(memberPage);
  const people = createMemo(() => matchMembers(
    memberListVisible(props.workspaceId).filter((m) => !m.bot && !banned().has(m.id)), query()));
  const [error, run] = useError();
  return (
    <div class="settings-section">
      <h2>Members</h2>
      <input class="mw-input mw-box workspace-member-search" type="search" value={query()} placeholder="Find a member" aria-label="Find a member"
        onInput={(e) => { setQuery(e.currentTarget.value); setShown(memberPage); }} />
      <ul class="workspace-members">
        <For each={people().slice(0, shown())} fallback={<li class="hint">Nobody matches.</li>}>
          {(m) => <MemberRow workspaceId={props.workspaceId} userId={m.id} run={run} />}
        </For>
      </ul>
      <Show when={people().length > shown()}>
        <button class="mw-button mw-box" onClick={() => setShown(shown() + memberPage)}>Show more ({people().length - shown()})</button>
      </Show>
      <Show when={bans(props.workspaceId).length > 0}>
        <h3>Banned</h3>
        <ul class="workspace-members">
          <For each={bans(props.workspaceId)}>
            {(ban) => {
              const who = () => member(props.workspaceId, Number(ban.user_id));
              const by = () => member(props.workspaceId, Number(ban.banned_by)).displayName;
              const [moving, setMoving] = createSignal(false);
              return (
                <li class="workspace-member">
                  <Avatar user={who()} size={32} />
                  <div class="workspace-member-names">
                    <span>{String(ban.name || who().displayName)}</span>
                    <span class="hint">
                      Banned by {by()} {relativeTime(String(ban.created_at))}{ban.reason ? `: ${String(ban.reason)}` : ""}
                    </span>
                  </div>
                  <div class="workspace-member-actions">
                    <Show when={can(props.workspaceId, "ban_members")}>
                      <button class="mw-button mw-box" onClick={() => void run(() =>
                        workspaceApi(props.workspaceId).plugin("roles").call("unban", { user_id: ban.user_id }))}>Unban</button>
                    </Show>
                    <Show when={canMoveMember(props.workspaceId, Number(ban.user_id))}>
                      <button class="icon-button" title="More" aria-label={`More for ${String(ban.name || who().displayName)}`}
                        onClick={(e) => openContextMenu(e, [{ label: "Move to account...", icon: "profile", action: () => setMoving(true) }])}><Icon name="more" /></button>
                    </Show>
                  </div>
                  <div class="workspace-member-prompts">
                    <Show when={canMoveMember(props.workspaceId, Number(ban.user_id))}>
                      <MoveMember workspaceId={props.workspaceId} userId={Number(ban.user_id)} name={String(ban.name || who().displayName)}
                        open={moving()} onClose={() => setMoving(false)} />
                    </Show>
                  </div>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
      <p class="hint">
        A banned member still has the workspace's data they already got, but everyone refuses their changes from then on.
        After an unban they can join again with an invite.
      </p>
      <Show when={error()}><p class="warning">{error()}</p></Show>
    </div>
  );
}

function MemberRow(props: { workspaceId: string; userId: number; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const roles = () => workspaceApi(props.workspaceId).plugin("roles");
  const who = () => member(props.workspaceId, props.userId);
  const me = () => standingOf(props.workspaceId, myId(props.workspaceId) ?? -1);
  const them = () => standingOf(props.workspaceId, props.userId);
  const theirRoles = () => rolesOf(props.workspaceId, props.userId);
  const assignable = () => can(props.workspaceId, "manage_roles")
    ? roleList(props.workspaceId).filter((r) => !r.everyone && !r.guest && Number(r.position) < me().highest && !theirRoles().some((t) => t.id === r.id))
    : [];
  const below = () => !them().owner && them().highest < me().highest && props.userId !== myId(props.workspaceId);
  const canBan = () => can(props.workspaceId, "ban_members") && below();
  const canKick = () => can(props.workspaceId, "kick_members") && below();
  const [asking, setAsking] = createSignal<"kick" | "ban" | null>(null);
  const [moving, setMoving] = createSignal(false);
  // A ban also removes them like a kick, so they leave the member list and their app leaves the workspace.
  const kick = (ban = false) => props.run(async () => {
    const name = who().displayName;
    if (ban) await roles().call("ban", { user_id: props.userId, name });
    await roles().call("kick", { user_id: props.userId });
    await workspaceApi(props.workspaceId).plugin("members").call("kick", { user_id: props.userId });
    const note = await changeRoomSecret(props.workspaceId, `${name} is removed`);
    await postKickNote(props.workspaceId, props.userId, name, ban);
    if (note) throw new ShownError(note);
  });
  const assign = (roleId: number, remove = false) =>
    props.run(() => roles().call("assign-role", { user_id: props.userId, role_id: roleId, remove }));
  // Guests hold the Guest role by how they joined; taking it away makes them full members.
  const promote = () => props.run(() => workspaceApi(props.workspaceId).plugin("members").call("promote-guest", { user_id: props.userId }));

  return (
    <li class="workspace-member" onContextMenu={(event) => openContextMenu(event, userMenu(props.workspaceId, props.userId))}>
      <span class="status-avatar">
        <Avatar user={who()} size={32} />
        <StatusDot status={peerStatusOf(props.workspaceId, props.userId)} />
      </span>
      <div class="workspace-member-names">
        <span>
          {who().displayName}<Show when={them().owner}><span class="workspace-owner"> owner</span></Show>
          <Show when={isNode(props.workspaceId, props.userId)}><span class="workspace-owner"> node</span></Show>
        </span>
        <span class="hint">{handleOf(who())}</span>
      </div>
      <div class="workspace-member-roles">
        <For each={theirRoles()}>
          {(role) => (
            <span class="role-chip mw-box">
              <span class="role-dot" style={{ background: String(role.color || "var(--mw-text-disabled)") }} />
              {String(role.name)}
              <Show when={can(props.workspaceId, "manage_roles") && (role.guest === true || Number(role.position) < me().highest)}>
                <button class="role-chip-remove" title={role.guest === true ? "Make full member (they get the older chat too)" : `Take ${String(role.name)} away`}
                  aria-label={role.guest === true ? "Make full member" : `Remove role ${String(role.name)}`}
                  onClick={() => void (role.guest === true ? promote() : assign(role.id, true))}><Icon name="close" size={12} /></button>
              </Show>
            </span>
          )}
        </For>
        <Show when={assignable().length > 0}>
          <Select class="role-add" label="Give a role" value={null} placeholder="+ Role"
            options={assignable().map((role) => ({ value: role.id, label: String(role.name) }))} onChange={(id) => void assign(id)} />
        </Show>
      </div>
      <Show when={canKick() || canBan() || canMoveMember(props.workspaceId, props.userId)}>
        <button class="icon-button" title="More" aria-label={`More for ${who().displayName}`} onClick={(e) => openContextMenu(e, [
          ...(canMoveMember(props.workspaceId, props.userId) ? [{ label: "Move to account...", icon: "profile", action: () => setMoving(true) }] : []),
          ...(canKick() ? [{ label: "Kick...", icon: "sign-out", danger: true, action: () => setAsking("kick" as const) }] : []),
          ...(canBan() ? [{ label: "Ban...", icon: "close", danger: true, action: () => setAsking("ban" as const) }] : []),
        ])}><Icon name="more" /></button>
        <div class="workspace-member-prompts">
          <Show when={canMoveMember(props.workspaceId, props.userId)}>
            <MoveMember workspaceId={props.workspaceId} userId={props.userId} name={who().displayName} open={moving()} onClose={() => setMoving(false)} />
          </Show>
          <ConfirmPrompt open={asking() === "kick"} confirmLabel="Kick" onCancel={() => setAsking(null)}
            question={`Kick ${who().displayName}? They leave the member list and lose their roles, but can join again with an invite.`}
            onConfirm={() => { setAsking(null); void kick(); }} />
          <ConfirmPrompt open={asking() === "ban"} question={`Ban ${who().displayName}? They are removed, and their changes are refused from now on, even if they join again.`}
            confirmLabel="Ban" onCancel={() => setAsking(null)}
            onConfirm={() => { setAsking(null); void kick(true); }} />
        </div>
      </Show>
    </li>
  );
}

function Invite(props: { workspaceId: string }) {
  const api = () => workspaceApi(props.workspaceId).plugin("members");
  // Kept by id, so a refetch changes rows in place instead of remounting them (a new row fades in once).
  const [invites, setInvites] = createStore<Row[]>([]);
  const [label, setLabel] = createSignal("");
  const [expiry, setExpiry] = createSignal("never");
  const [customExpiry, setCustomExpiry] = createSignal("");
  const [maxUses, setMaxUses] = createSignal("");
  // Shown on the nodes' invite pages: its token is kept readable in the workspace (p2p/invite.ts, node/page.ts).
  const [onPages, setOnPages] = createSignal(false);
  const [asGuest, setAsGuest] = createSignal(false);
  // The token of the invite just made here: its row also shows the code. Matched by token, not id, since a new
  // row's id can still change once its commit settles.
  const [fresh, setFresh] = createSignal("");
  const [copiedToken, setCopiedToken] = createSignal("");
  const [tokens, setTokens] = createSignal<Record<number, string>>({});
  const [joins, setJoins] = createSignal<Record<number, number>>({});
  const [revokeId, setRevokeId] = createSignal<number | null>(null);
  const [deleteId, setDeleteId] = createSignal<number | null>(null);
  const { copied, copy: copyInvite, reset: resetCopied } = createCopied();
  const [error, run] = useError();
  const load = async () => {
    const rows = await api().read("members_invites");
    const identity = account();
    const agreement = accountAgreementKey();
    const recovered: Record<number, string> = {};
    // A public invite's code is on the nodes' pages anyway: every manager can copy it.
    for (const row of rows) if (typeof row.public_token === "string" && row.public_token) recovered[Number(row.id)] = row.public_token;
    const counted: Record<number, number> = {};
    for (const row of await api().read("members_invite_joins")) counted[Number(row.invite_id)] = (counted[Number(row.invite_id)] ?? 0) + 1;
    if (identity && agreement) {
      const keys = await pairKeys(agreement, identity.id, { id: identity.id, publicKey: identity.publicKey });
      for (const row of rows) {
        if (Number(row.created_by) !== (myId(props.workspaceId) ?? -1) || recovered[Number(row.id)]) continue;
        const value: unknown = JSON.parse(String(row.sealed_token));
        if (!isSealed(value) || value.from !== identity.id || value.to !== identity.id)
          throw new Error("A saved invite secret is malformed.");
        const payload = await unseal(keys, value);
        if (!payload?.text || inviteTokenKey(payload.text) !== row.token_key)
          throw new Error("A saved invite secret could not be opened with this account.");
        recovered[Number(row.id)] = payload.text;
      }
    }
    // Newest first: the invite just made sits right under the form.
    setInvites(reconcile([...rows].reverse(), { key: "id" }));
    setTokens(recovered);
    setJoins(counted);
  };
  void run(load);
  const stop = api().onEvent((event) => {
    if (event.table === "members_invites" || event.table === "members_invite_joins") void run(load);
  });
  onCleanup(stop);
  const copy = async (token: string) => {
    const code = workspaceInvite(props.workspaceId, token);
    if (code && (await copyInvite(code))) setCopiedToken(token);
  };
  const isCopied = (token: string) => copied() && copiedToken() === token;
  const create = () => run(async () => {
    if (expiry() === "custom" && (!customExpiry() || !Number.isFinite(Date.parse(customExpiry()))))
      throw new Error("Choose a valid expiry date and time.");
    const expiresAt = expiry() === "24h" ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      : expiry() === "7d" ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        : expiry() === "custom" ? new Date(customExpiry()).toISOString() : null;
    const limit = maxUses().trim() ? Number(maxUses()) : null;
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1))
      throw new Error("Use limit must be a positive whole number.");
    const identity = account();
    const agreement = accountAgreementKey();
    if (!identity || !agreement) throw new Error("Sign in to create workspace invites.");
    const token = newInviteToken();
    const keys = await pairKeys(agreement, identity.id, { id: identity.id, publicKey: identity.publicKey });
    const sealedToken = await seal(keys, {
      id: crypto.randomUUID(), from: identity.id, to: identity.id, at: Date.now(),
    }, { text: token, attachments: [] });
    if (asGuest()) await workspaceApi(props.workspaceId).plugin("roles").call("ensure-guest-role");
    const created = await api().call<{ id: number; token: string }>("create-invite", {
      token, sealed_token: JSON.stringify(sealedToken), label: label().trim(), expires_at: expiresAt, max_uses: limit, public: onPages(),
      guest: asGuest(),
    });
    if (!workspaceInvite(props.workspaceId, created.token)) throw new Error("Couldn't create a code for this workspace.");
    setFresh(created.token);
    resetCopied();
    setLabel("");
    setOnPages(false);
    setAsGuest(false);
    await load();
  });
  const revoke = (id: number) => run(async () => {
    await api().call("revoke-invite", { id });
    const note = await changeRoomSecret(props.workspaceId, "The invite is revoked and can't admit anyone");
    setRevokeId(null);
    await load();
    if (note) throw new ShownError(note);
  });
  const purge = (id: number) => run(async () => {
    await api().call("delete-invite", { id });
    setDeleteId(null);
    await load();
  });
  return (
  <div class="settings-section account-settings">
  <h2>Invite</h2>
  <Show when={account()?.offline}
    fallback={
      <>
        <p class="hint">
          Anyone with an invite can join and read the workspace; what they can
          change depends on their roles.
        </p>

        <Show when={can(props.workspaceId, "manage_invites")}>
          <div class="invite-create">
            <div class="invite-field">
              <label class="account-field">
                <span>Key name</span>
                <input
                  class="mw-input mw-box"
                  maxLength={64}
                  value={label()}
                  onInput={(e) => setLabel(e.currentTarget.value)}
                  placeholder="Optional"
                />
              </label>
            </div>

            <div class="invite-field">
              <div class="account-field">
                <span>Expiration timer</span>
                <Select
                  label="Expiration timer"
                  value={expiry()}
                  onChange={setExpiry}
                  options={[
                    { value: "never", label: "Never" },
                    { value: "24h", label: "24 hours" },
                    { value: "7d", label: "7 days" },
                    { value: "custom", label: "Custom" },
                  ]}
                />
              </div>
              <Collapse open={expiry() === "custom"}>
                <label class="account-field">
                  <span>Expires</span>
                  <input
                    class="mw-input mw-box"
                    type="datetime-local"
                    value={customExpiry()}
                    onInput={(e) => setCustomExpiry(e.currentTarget.value)}
                  />
                </label>
              </Collapse>
            </div>

            <div class="invite-field">
              <label class="account-field">
                <span>
                  Use limit <span class="hint">(optional)</span>
                </span>
                <input
                  class="mw-input mw-box"
                  type="number"
                  min="1"
                  step="1"
                  value={maxUses()}
                  onInput={(e) => setMaxUses(e.currentTarget.value)}
                  placeholder="Unlimited"
                />
              </label>

            </div>

            <div class="invite-field">
              <label class="settings-check">
                <input
                  type="checkbox"
                  checked={onPages()}
                  onChange={(e) => setOnPages(e.currentTarget.checked)}
                />
                Show on the nodes' invite pages
              </label>
              <p class="hint">
                Anyone who opens one of this workspace's node pages can copy it,
                and every manager can copy it here.
              </p>
            </div>

            <div class="invite-field">
              <label class="settings-check">
                <input type="checkbox" checked={asGuest()} onChange={(e) => setAsGuest(e.currentTarget.checked)} />
                Guest invite
              </label>
              <p class="hint">
                People who join with it get the Guest role instead of @everyone's permissions and can't read chat from
                before they joined. Members with Manage roles can make them full members later.
              </p>
            </div>

            <button class="mw-button mw-box" onClick={() => void create()}>
              Create invite
            </button>
          </div>
        </Show>

        <Show when={invites.length > 0}>
          <ul class="invite-list">
            <For each={invites}>
              {(invite) => {
                // The row changes in place on refetches (reconcile), so these are read when shown.
                const expired = () =>
                  !!invite.expires_at &&
                  Date.parse(String(invite.expires_at)) <= Date.now();
                const revoked = () => invite.revoked === true;
                // The invite just made here shows its code once, in its own row.
                const freshCode = () =>
                  fresh() && tokens()[Number(invite.id)] === fresh()
                    ? workspaceInvite(props.workspaceId, fresh())
                    : null;
                const uses = () =>
                  inviteUses(invite, joins()[Number(invite.id)] ?? 0);
                // A closed invite can no longer let anyone in (inviteOpen, p2p/invite.ts): it can be permanently
                // deleted. The policy judges this at the commit's time; here the device's own clock is the match.
                const closed = () =>
                  !inviteOpen(invite, joins()[Number(invite.id)] ?? 0);

                return (
                  <li class="invite-row mw-box mw-fade-in">
                    <div>
                      <strong>{String(invite.label || "Invite")}</strong>
                      <Show when={freshCode()}>
                        {(code) => <code class="workspace-invite mw-box">{code()}</code>}
                      </Show>
                      <span class="hint">
                        Created by{" "}
                        {member(
                          props.workspaceId,
                          Number(invite.created_by),
                        ).displayName}
                      </span>
                      <span class="hint">
                        {uses()}{" "}
                        uses
                        {invite.max_uses == null
                          ? ""
                          : ` of ${String(invite.max_uses)}`}{" "}
                        ·{" "}
                        {invite.expires_at
                          ? `Expires ${timeUntil(String(invite.expires_at))}`
                          : "Never expires"}
                      </span>

                      <Show when={invite.public_token}>
                        <span class="hint">
                          On the nodes' invite pages
                        </span>
                      </Show>

                      <Show when={invite.guest === true}>
                        <span class="hint">Guest invite</span>
                      </Show>

                      <Show when={closed()}>
                        <span class="hint">
                          {revoked() ? "Revoked" : expired() ? "Expired" : "Used up"}
                        </span>
                      </Show>
                    </div>

                    <Show when={tokens()[Number(invite.id)]}>
                      {(token) => (
                        <button class="mw-button mw-box" onClick={() => void copy(token())}>
                          <Icon name={isCopied(token()) ? "check" : "copy"} />{" "}
                          {isCopied(token()) ? "Copied" : "Copy code"}
                        </button>
                      )}
                    </Show>

                    <Show
                      when={
                        can(props.workspaceId, "manage_invites") && !closed()
                      }
                    >
                      <button
                        class="mw-button mw-box"
                        onClick={() => setRevokeId(Number(invite.id))}
                      >
                        Revoke
                      </button>
                      <ConfirmPrompt
                        open={revokeId() === Number(invite.id)}
                        question={`Revoke the invite "${String(invite.label || "Invite")}"? Anyone with its code will no longer be able to join.`}
                        confirmLabel="Revoke"
                        onConfirm={() => void revoke(Number(invite.id))}
                        onCancel={() => setRevokeId(null)}
                      />
                    </Show>

                    <Show
                      when={can(props.workspaceId, "manage_invites") && closed()}
                    >
                      <button
                        class="mw-button mw-box"
                        style="color: var(--mw-danger)"
                        onClick={() => setDeleteId(Number(invite.id))}
                      >
                        Delete permanently
                      </button>
                      <ConfirmPrompt
                        open={deleteId() === Number(invite.id)}
                        question="Permanently delete this invite? This cannot be undone."
                        confirmLabel="Delete permanently"
                        onConfirm={() => void purge(Number(invite.id))}
                        onCancel={() => setDeleteId(null)}
                      />
                    </Show>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>
      </>
    }
  >
    <p class="hint">
      Create an account to share workspaces: invite codes are tied to the
      account that made the workspace, so members can find you on the user
      server.
    </p>
  </Show>

  <Show when={error()}>
    <p class="warning">{error()}</p>
  </Show>
</div>
  );
}

const historyPage = 100;

function History(props: { workspaceId: string }) {
  const ledger = workspaceLedger(props.workspaceId);
  // Rebuilt shortly after changes arrive, not for each one.
  const [version, setVersion] = createSignal(0);
  if (ledger) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = ledger.subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setVersion((v) => v + 1), 500);
    });
    onCleanup(() => {
      stop();
      clearTimeout(timer);
    });
  }
  const lines = createMemo(() => {
    version();
    return ledger ? workspaceHistory(props.workspaceId, ledger.log()) : [];
  });
  const [person, setPerson] = createSignal<number | null>(null);
  const [kind, setKind] = createSignal<HistoryKind | null>(null);
  const [refusedOnly, setRefusedOnly] = createSignal(false);
  const [shown, setShown] = createSignal(historyPage);
  const [snapshotPrompt, setSnapshotPrompt] = createSignal(false);
  const [snapshotError, runSnapshot] = useError();
  const [archiveError, runArchive] = useError();
  let archivePicker!: HTMLInputElement;
  const [undoPlan, setUndoPlan] = createSignal<UndoPlan | null>(null);
  const [undoError, runUndo] = useError();
  const [undoPreparing, setUndoPreparing] = createSignal(false);
  const [revertPrompt, setRevertPrompt] = createSignal<{ plan: RevertPlan; question: string } | null>(null);
  const [revertError, runRevert] = useError();
  const [revertPreparing, setRevertPreparing] = createSignal(false);
  const [snapshotsOpen, setSnapshotsOpen] = createSignal(false);
  // The history entry whose confirmation is showing.
  const [promptLine, setPromptLine] = createSignal<string | null>(null);
  const filtered = createMemo(() => lines().filter((l) =>
    (person() === null || l.userId === person()) && (kind() === null || l.kind === kind()) && (!refusedOnly() || l.rejected)));
  const people = () => [...new Set(lines().map((l) => l.userId))].map((id) => member(props.workspaceId, id))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const latestSnapshot = () => {
    version();
    return ledger?.snapshotForBootstrap() ?? null;
  };
  const archiveId = () => latestSnapshot()?.commit.ops.find((op) => op.table === "members_snapshots")?.id ?? null;
  const prepareUndo = async (hash: string) => {
    if (!ledger || undoPreparing()) return;
    setUndoPreparing(true);
    try {
      setRevertPrompt(null);
      setUndoPlan(await planWorkspaceUndo(ledger, hash));
      setPromptLine(hash);
    } catch (error) {
      await runUndo(async () => { throw error; });
    } finally {
      setUndoPreparing(false);
    }
  };
  const prepareRevert = async (hash: string, channelId: number | null) => {
    if (!ledger || revertPreparing()) return;
    setRevertPreparing(true);
    try {
      const index = ledger.log().findIndex(({ commit }) => commit.hash === hash);
      if (index < 0) throw new Error("That history entry is no longer available.");
      const plan = await planWorkspaceRevert(ledger, index, channelId);
      const channel = channelId === null ? undefined
        : workspaces.byId[props.workspaceId]?.allChannels.find((item) => item.id === channelId);
      const target = channelId === null ? "the whole workspace"
        : channel ? channelLabel(props.workspaceId, channel) : "this channel";
      setUndoPlan(null);
      setRevertPrompt({
        plan,
        question: `Revert ${target} to after this history entry? This will write ${plan.operations.length} changes.`,
      });
      setPromptLine(hash);
    } catch (error) {
      await runRevert(async () => { throw error; });
    } finally {
      setRevertPreparing(false);
    }
  };
  const revertEntries = (hash: string): MenuEntry[] => {
    const channels = workspaces.byId[props.workspaceId]?.allChannels ?? [];
    return [
      ...(channels.length ? [{
        label: "Revert a channel to here", icon: "history",
        items: channels.map((channel) => ({ label: channelLabel(props.workspaceId, channel), action: () => void prepareRevert(hash, channel.id) })),
      }] : []),
      ...(standingOf(props.workspaceId, myId(props.workspaceId) ?? -1).owner
        ? ["separator" as const, { label: "Revert the workspace to here", icon: "history", danger: true, action: () => void prepareRevert(hash, null) }]
        : []),
    ];
  };

  return (
    <div class="settings-section">
      <h2>History</h2>
      <Show when={ledger} fallback={<p class="hint">History is kept for serverless workspaces.</p>}>
        <Show when={can(props.workspaceId, "view_history")} fallback={<p class="hint">You need the "View history" permission.</p>}>
          <p class="hint">
            Every change to the workspace, signed by whoever made it. Refused changes were not allowed for their author
            and changed nothing.
          </p>
          <div class="history-filters">
            <Select label="Person" value={person() ?? 0}
              options={[{ value: 0, label: "Everyone" }, ...people().map((m) => ({ value: m.id, label: m.displayName }))]}
              onChange={(id) => { setPerson(id || null); setShown(historyPage); }} />
            <Select<HistoryKind | ""> label="Kind of change" value={kind() ?? ""}
              options={[{ value: "", label: "All changes" }, ...historyKinds.map((k) => ({ value: k.id, label: k.label }))]}
              onChange={(k) => { setKind(k || null); setShown(historyPage); }} />
            <label class="role-check">
              <input type="checkbox" checked={refusedOnly()} onChange={(e) => setRefusedOnly(e.currentTarget.checked)} />
              <span>Only refused</span>
            </label>
          </div>
          <Show when={undoError()}><p class="warning">{undoError()}</p></Show>
          <Show when={revertError()}><p class="warning">{revertError()}</p></Show>
          <ul class="history-list">
            <For each={filtered().slice(0, shown())} fallback={<li class="hint">Nothing here.</li>}>
              {(line) => {
                const who = () => member(props.workspaceId, line.userId);
                const commit = () => ledger?.log().find((entry) => entry.commit.hash === line.id)?.commit;
                return (
                  <li class="history-line" classList={{ refused: !!line.rejected }}>
                    <Avatar user={who()} size={24} />
                    <div class="history-text">
                      <span><strong>{who().displayName}</strong> {line.text}<Show when={line.host !== undefined}> <span class="muted">(by {member(props.workspaceId, line.host!).displayName} for the bot)</span></Show></span>
                      <Show when={line.rejected}><span class="warning history-refused">Refused: {line.rejected}</span></Show>
                    </div>
                    <time class="hint" title={new Date(line.time).toLocaleString()}>{relativeTime(new Date(line.until).toISOString())}</time>
                    <Show when={!line.rejected && commit()?.action !== "workspace.snapshot"}>
                      <button class="mw-button mw-box" disabled={undoPreparing()} onClick={() => void prepareUndo(line.id)}
                        title="Undo this change">Undo</button>
                      <button class="icon-button" title="More" aria-label="More" disabled={revertPreparing()} onClick={(e) => openContextMenu(e, revertEntries(line.id))}>
                        <Icon name="more" />
                      </button>
                    </Show>
                    <Show when={promptLine() === line.id}>
                      <div class="history-line-prompt">
                        <ConfirmPrompt open={!!undoPlan()}
                          question={undoPlan()?.conflicts.length
                            ? `Later changes overlap this change. Undoing will also replace them: ${undoPlan()!.conflicts.join("; ")}. Continue?`
                            : "Write a new signed change that undoes this history entry?"}
                          confirmLabel="Undo change"
                          onCancel={() => setUndoPlan(null)}
                          onConfirm={() => {
                            const plan = undoPlan();
                            setUndoPlan(null);
                            if (ledger && plan) void runUndo(() => applyWorkspaceUndo(ledger, plan, true));
                          }} />
                        <ConfirmPrompt open={!!revertPrompt()}
                          question={revertPrompt()?.question ?? ""}
                          confirmLabel="Revert"
                          onCancel={() => setRevertPrompt(null)}
                          onConfirm={() => {
                            const prompt = revertPrompt();
                            setRevertPrompt(null);
                            if (ledger && prompt) void runRevert(() => applyWorkspaceRevert(ledger, prompt.plan));
                          }} />
                      </div>
                    </Show>
                  </li>
                );
              }}
            </For>
          </ul>
          <Show when={filtered().length > shown()}>
            <button class="mw-button mw-box" onClick={() => setShown(shown() + historyPage)}>
              Show more ({filtered().length - shown()} older)
            </button>
          </Show>
          <Show when={can(props.workspaceId, "manage_history") || (latestSnapshot()?.ref.archiveContent && archiveId() !== null)}>
            <Disclosure class="history-more" open={snapshotsOpen()} onToggle={() => setSnapshotsOpen(!snapshotsOpen())}>Snapshots and archive</Disclosure>
            <Collapse open={snapshotsOpen()}>
          <Show when={latestSnapshot()?.ref.archiveContent && archiveId() !== null}>
            <div class="history-archive">
              <p class="hint">Older history is archived with this snapshot. Import the archive to browse or search it.</p>
              <label class="role-check">
                <input type="checkbox" checked={isSynced(props.workspaceId, { kind: "archive", id: archiveId()! })}
                  onChange={(event) => setSynced(props.workspaceId, { kind: "archive", id: archiveId()! }, event.currentTarget.checked)} />
                <span>Keep the archive on this device</span>
              </label>
              <button class="mw-button mw-box" onClick={() => void runArchive(async () => {
                const archive = latestSnapshot()?.ref.archiveContent;
                if (!archive) throw new Error("The workspace has no history archive.");
                saveBlob(await exportWorkspaceArchive(archive), `${workspaces.byId[props.workspaceId]?.info.name ?? "workspace"}-history.mwhistory`);
              })}>Export archive</button>
              <button class="mw-button mw-box" onClick={() => archivePicker.click()}>Import archive</button>
              <input ref={archivePicker} type="file" accept=".mwhistory,application/json" hidden onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (!file || !ledger) return;
                void runArchive(async () => {
                  const snapshot = latestSnapshot();
                  if (!snapshot?.ref.archiveContent) throw new Error("The workspace has no snapshot archive.");
                  const commits = await readWorkspaceArchive(file, props.workspaceId, snapshot.ref.hash, snapshot.ref.index);
                  const stored = await storeFile(file, { workspaceId: props.workspaceId });
                  if (stored.hash !== snapshot.ref.archiveContent.slice(4)) {
                    if (!stored.existed) await deleteContent(stored.hash);
                    throw new Error("This file doesn't match the archive content signed by the snapshot.");
                  }
                  await ledger.accept(commits);
                  const rowId = snapshot.commit.ops.find((op) => op.table === "members_snapshots")?.id;
                  if (rowId === undefined) throw new Error("The signed snapshot record is missing.");
                  setSynced(props.workspaceId, { kind: "archive", id: rowId }, true);
                  const archivedSnapshot = ledger.log().find(({ commit }) => commit.hash === snapshot.commit.hash);
                  if (!archivedSnapshot || archivedSnapshot.rejected
                    || ledger.snapshotForBootstrap()?.commit.hash !== snapshot.commit.hash)
                    throw new Error("The archive didn't match the signed snapshot and was not accepted as full history.");
                });
              }} />
              <Show when={archiveError()}><p class="warning">{archiveError()}</p></Show>
            </div>
          </Show>
          <Show when={can(props.workspaceId, "manage_history")}>
            <p class="hint">
              Before making a snapshot, ask members who have been offline to sync. Changes that arrive before its cutoff
              later will be refused.
            </p>
            <button class="mw-button mw-box" onClick={() => setSnapshotPrompt(true)}>Make snapshot</button>
            <ConfirmPrompt open={snapshotPrompt()}
              question="Create a signed snapshot of the current workspace tables? Members who haven't synced through the cutoff may need to reapply their changes."
              confirmLabel="Make snapshot"
              onCancel={() => setSnapshotPrompt(false)}
              onConfirm={() => {
                setSnapshotPrompt(false);
                if (ledger) void runSnapshot(() => createWorkspaceSnapshot(ledger));
              }} />
            <Show when={snapshotError()}><p class="warning">{snapshotError()}</p></Show>
          </Show>
            </Collapse>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
