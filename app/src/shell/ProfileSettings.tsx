import { Show, createSignal } from "solid-js";
import { setShareLocation, shareLocation } from "../core/locationSharing";
import { account, avatarColors, renameAccount, updateProfile, type Account } from "../core/account";
import { onlineStatus, setOnlineStatus } from "../core/onlineStatus";
import { sendTyping, setSendTyping } from "../core/typing";
import { StrangersSetting } from "../dm/FriendsPage";
import { Icon } from "../theme/icons";
import { avatarFromFile } from "../ui/avatarImage";
import ColorSwatches from "../ui/ColorSwatches";
import Select from "../ui/Select";
import { randomSeed } from "../ui/identicon";
import { AccountHeader } from "./AccountSettings";

// Settings > Profile: how others see you, and what they see of you.
export default function ProfileSettings() {
  const [displayName, setDisplayName] = createSignal(account()?.displayName ?? "");
  const [avatarError, setAvatarError] = createSignal("");
  const [statusError, setStatusError] = createSignal("");
  let picker!: HTMLInputElement;

  // The workspaces get the change from core/members.ts watchOwnProfile.
  const save = (changes: Parameters<typeof updateProfile>[0]) => updateProfile(changes);
  const upload = async (file: File | undefined) => {
    if (!file) return;
    try {
      await save({ avatarImage: await avatarFromFile(file) });
      setAvatarError("");
    } catch (e) {
      setAvatarError(e instanceof Error ? e.message : String(e));
    }
  };
  const changeStatus = async (value: "online" | "dnd" | "hidden" | "offline") => {
    setStatusError("");
    try {
      await setOnlineStatus(value);
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Show when={account()}>
      {(me) => (
        <div class="settings-section account-settings">
          <h2>Profile</h2>
          <AccountHeader me={me()} />

          <div class="account-field">
            <span>Avatar</span>
            <div class="account-avatar-actions">
              <button class="mw-button mw-box" onClick={() => picker.click()}><Icon name="upload" /> Upload image</button>
              <Show when={me().avatarImage} fallback={
                <button class="mw-button mw-box" title="Pick a new random pattern" onClick={() => void save({ avatarSeed: randomSeed() })}>
                  <Icon name="shuffle" /> New pattern
                </button>
              }>
                <button class="mw-button mw-box" onClick={() => void save({ avatarImage: null })}>
                  <Icon name="close" /> Remove image
                </button>
              </Show>
              <input ref={picker} type="file" accept="image/*" hidden
                onChange={(e) => { void upload(e.currentTarget.files?.[0]); e.currentTarget.value = ""; }} />
            </div>
          </div>
          <Show when={avatarError()}><p class="warning">{avatarError()}</p></Show>

          <label class="account-field">
            <span>Display name</span>
            <input class="mw-input mw-box" maxLength={48} value={displayName()}
              onInput={(e) => setDisplayName(e.currentTarget.value)}
              onChange={() => void save({ displayName: displayName() })} />
          </label>

          <UsernameField me={me()} onRenamed={() => void save({})} />

          <div class="account-field">
            <span>Color</span>
            <ColorSwatches colors={avatarColors} label="Avatar color" value={me().color} onPick={(color) => void save({ color })} />
          </div>
          <p class="hint">Each workspace can also have its own nickname and about me (Workspace settings, Your profile).</p>

          <div class="account-field">
            <span>Private messages</span>
            <StrangersSetting />
          </div>
          <div class="account-field">
            <span>Activity</span>
            <label class="account-field">
              <span>Status</span>
              <Select label="Online status" value={onlineStatus() === "away" ? "online" : onlineStatus()}
                options={[
                  { value: "online", label: "Online", swatch: "var(--mw-success)", disabled: me().offline },
                  { value: "dnd", label: "Do not disturb", swatch: "var(--mw-danger)", disabled: me().offline },
                  { value: "hidden", label: "Hidden", disabled: me().offline },
                  { value: "offline", label: "Offline" },
                ]}
                onChange={(value) => {
                  if (value === "online" || value === "dnd" || value === "hidden" || value === "offline")
                    void changeStatus(value);
                }} />
            </label>
            <Show when={statusError()}><p class="warning">{statusError()}</p></Show>
            <p class="hint">Away appears after 15 minutes without input. Do not disturb mutes notifications and sounds, including calls.</p>
            <label class="settings-check">
              <input type="checkbox" checked={sendTyping()} onChange={(e) => setSendTyping(e.currentTarget.checked)} />
              Show others when I'm typing
            </label>
            <label class="settings-check">
              <input type="checkbox" checked={shareLocation()} onChange={(e) => setShareLocation(e.currentTarget.checked)} />
              Show my rough location to workspace admins
            </label>
            <p class="hint">
              People who manage a workspace's nodes then see on a globe roughly where you are (from your time zone).
              Off, they still see which node you use and whom you are connected to on the Nodes page, but not where
              you are. It is never stored in the workspace.
            </p>
          </div>
        </div>
      )}
    </Show>
  );
}

// Usernames can change any time and anyone may share one: everything else knows the account by its id.
function UsernameField(props: { me: Account; onRenamed: () => void }) {
  const [value, setValue] = createSignal(props.me.username);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await renameAccount(value());
      props.onRenamed();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="account-field">
      <span>Username</span>
      <form class="account-inline-form" onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}>
        <input class="mw-input mw-box" aria-label="Username" maxLength={32} spellcheck={false}
          value={value()} onInput={(e) => setValue(e.currentTarget.value.toLowerCase())} />
        <Show when={value() !== props.me.username}>
          <button type="submit" class="mw-button primary mw-box mw-fade-in" disabled={busy() || !value()}>Change</button>
        </Show>
      </form>
      <Show when={error()}><p class="warning">{error()}</p></Show>
    </div>
  );
}
