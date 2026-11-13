import { Match, Show, Switch, createSignal } from "solid-js";
import {
  account, accountSync, allowSignInElsewhere, deleteAccount, exportAccount, registerExisting, signOut, syncAccount, type Account,
} from "../core/account";
import { showToast } from "../core/notices";
import { resumeSync } from "../core/serverless";
import { handleOf, hostOf, userServer } from "../core/userServer";
import AccountSecurity from "./AccountSecurity";
import RegisterForm, { type RegisterInput } from "./RegisterForm";
import { Icon } from "../theme/icons";
import Avatar from "../ui/Avatar";
import Collapse from "../ui/Collapse";
import StatusDot from "../ui/StatusDot";
import { onlineStatus } from "../core/onlineStatus";
import { saveBlob } from "../ui/download";
import { startMessages, stopMessages } from "../dm/messages";

export default function AccountSettings() {
  const exportFile = async () => {
    const { fileName, text } = await exportAccount();
    saveBlob(new Blob([text], { type: "application/json" }), fileName);
  };
  return (
    <Show when={account()}>
      {(me) => (
        <div class="settings-section account-settings">
          <h2>Account</h2>
          <AccountHeader me={me()} />

          <Show when={!me().offline}><AccountSecurity me={me()} /></Show>
          <Show when={me().offline} fallback={<UserServerStatus me={me()} />}>
            <OfflineAccount />
          </Show>
          <Show when={me().hasPassword} fallback={
            <Show when={me().inDrive}>
              <p class="hint">Saved to your Google Drive: sign in with Google on any computer to use this account.</p>
            </Show>
          }>
            <div class="account-field">
              <span>Use on another computer</span>
              <div>
                <button class="mw-button mw-box" onClick={() => void exportFile()}><Icon name="download" /> Export account file</button>
                <p class="hint">
                  There, sign in with your email and password, or import this file and use the account's password.
                  Keep the file private.
                </p>
              </div>
            </div>
          </Show>
          <p class="hint">Account id {me().id}</p>
          <button class="mw-button mw-box" onClick={() => void signOut()}>
            <Icon name="sign-out" /> Sign out
          </button>
          <Show when={!me().offline}><DeleteAccount me={me()} /></Show>
        </div>
      )}
    </Show>
  );
}

// Whether the account is on the user server (so others can find it), and on it as a password sign-in.
function UserServerStatus(props: { me: Account }) {
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      setPassword("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const problem = () => {
    const state = accountSync();
    return state.state === "offline" || state.state === "error" ? state.message : null;
  };
  const needsLogin = () => props.me.hasPassword && props.me.loginOn !== userServer() && accountSync().state === "ok";

  return (
    <div class="account-field">
      <span>User server</span>
      <Switch>
        <Match when={accountSync().state === "syncing"}><p class="hint">Updating your account on {hostOf()}...</p></Match>
        <Match when={accountSync().state === "ok"}>
          <p class="hint">Others can find you on {hostOf()} as {handleOf(props.me)} or by your email, and send you private messages.</p>
        </Match>
        <Match when={problem()}>
          {(message) => (
            <div class="account-inline-form">
              <p class="warning">{message()}</p>
              <button class="mw-button mw-box" disabled={busy()} onClick={() => void syncAccount()}>Try again</button>
            </div>
          )}
        </Match>
      </Switch>
      <Show when={needsLogin()}>
        <p class="hint">Enter your password to sign in to this account on other computers.</p>
        <form class="account-inline-form" onSubmit={(e) => {
          e.preventDefault();
          void run(() => allowSignInElsewhere(password()));
        }}>
          <input class="mw-input mw-box" type="password" aria-label="Password" autocomplete="current-password"
            value={password()} onInput={(e) => setPassword(e.currentTarget.value)} />
          <button type="submit" class="mw-button primary mw-box" disabled={busy() || !password()}>Allow</button>
        </form>
      </Show>
      <Show when={error()}><p class="warning">{error()}</p></Show>
    </div>
  );
}

const deleteWord = "DELETE";

// Deletes the account from the user server once DELETE is typed. Copies in workspaces stay with their members.
function DeleteAccount(props: { me: Account }) {
  const [open, setOpen] = createSignal(false);
  const [typed, setTyped] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const confirmed = () => typed().trim() === deleteWord;
  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await deleteAccount();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const close = () => {
    setOpen(false);
    setTyped("");
    setError("");
  };
  return (
    <div class="account-field account-delete">
      <Show when={!open()}>
        <button class="mw-button mw-box danger" onClick={() => setOpen(true)}><Icon name="delete" /> Delete account</button>
      </Show>
      <Collapse open={open()}>
        <div class="account-delete-confirm mw-box">
          <p>
            <strong>This deletes your account for good.</strong> {hostOf()} removes your email, profile, friends, blocks,
            waiting private messages and everything else it keeps for you. It can't be undone.
          </p>
          <Show when={props.me.inDrive}>
            <p class="hint">Its copy in your Google Drive is deleted too: Google asks you to sign in first.</p>
          </Show>
          <p class="hint">
            What you posted in workspaces stays with their members and nodes, since every member keeps the history.
            Other computers signed in to this account sign out the next time they start.
          </p>
          <form class="account-inline-form" onSubmit={(e) => {
            e.preventDefault();
            if (confirmed()) void remove();
          }}>
            <input class="mw-input mw-box" aria-label={`Type ${deleteWord} to confirm`} placeholder={`Type ${deleteWord}`}
              autocomplete="off" spellcheck={false} value={typed()} onInput={(e) => setTyped(e.currentTarget.value)} />
            <button type="submit" class="mw-button mw-box danger" disabled={busy() || !confirmed()}>
              <Icon name="delete" /> {busy() ? "Deleting..." : "Delete account"}
            </button>
            <button type="button" class="mw-button mw-box" disabled={busy()} onClick={close}>Cancel</button>
          </form>
          <Show when={error()}><p class="warning">{error()}</p></Show>
        </div>
      </Collapse>
    </div>
  );
}

// An offline account: creating one publishes the same key, so its id, its workspaces and their history stay as they
// are. Afterwards sync is turned on for the open workspaces (their id didn't change, so the app won't reopen them).
function OfflineAccount() {
  const [creating, setCreating] = createSignal(false);
  const create = async (input: RegisterInput) => {
    await registerExisting({ ...input, remember: true });
    await resumeSync();
    stopMessages();
    startMessages();
    showToast("Account made: you can now share workspaces and work with others.", { ms: 6000 });
  };
  return (
    <div class="account-field">
      <p class="hint">
        You're working on this computer only. Create an account to share workspaces, message people and use your work
        on other computers. Your workspaces and their history stay with you.
      </p>
      <Show when={!creating()}>
        <button class="mw-button primary mw-box account-create" onClick={() => setCreating(true)}>Create an account</button>
      </Show>
      <Collapse open={creating()}><Show when={creating()}><RegisterForm agreement onSubmit={create} /></Show></Collapse>
    </div>
  );
}

// Who is signed in, at the top of Settings > Account and Profile.
export function AccountHeader(props: { me: Account }) {
  return (
    <div class="account-header">
      <span class="status-avatar account-header-avatar">
        <Avatar user={props.me} size={56} />
        <StatusDot status={onlineStatus()} />
      </span>
      <div>
        <div class="account-name">{props.me.displayName}</div>
        <div class="hint">{handleOf(props.me)}</div>
        <Show when={props.me.google}>{(g) => <div class="hint">Google: {g().email}</div>}</Show>
      </div>
    </div>
  );
}
