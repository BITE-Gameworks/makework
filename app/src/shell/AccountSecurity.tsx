// Settings > Account: the email people sign in with, the password, the authenticator app, and how a forgotten
// password can be reset (core/account.ts). The recovery copy is off unless turned on; the page says plainly what it costs.
import { For, Match, Show, Switch, createResource, createSignal, createUniqueId, type JSX } from "solid-js";
import { encode } from "uqr";
import {
  beginTotp, changePassword, connectGitHub, createRecoveryKey, finishTotp, minPasswordLength, NeedsPassword, ownAccountInfo, removeTotp,
  sendEmailCode, setEmail, setRecoveryCopy, type Account,
} from "../core/account";
import { hostOf, serverFeatures } from "../core/userServer";
import { Icon } from "../theme/icons";
import Collapse from "../ui/Collapse";
import ConfirmPrompt from "../ui/ConfirmPrompt";
import { saveBlob } from "../ui/download";
import PasswordRule from "./PasswordRule";
import { createCopied } from "../ui/clipboard";

export default function AccountSecurity(props: { me: Account }) {
  const [info, { refetch }] = createResource(() => props.me.id, () => ownAccountInfo());
  return (
    <>
      <EmailField me={props.me} onChanged={() => void refetch()} />
      <GitHubField me={props.me} linked={info()?.github ?? props.me.github?.login ?? null} onChanged={() => void refetch()} />
      <Show when={props.me.hasPassword}><PasswordField /></Show>
      <Show when={info() && (props.me.hasPassword || info()!.recoveryCopy)}>
        <TotpSetting on={!!info()!.totp} backupCodes={info()!.backupCodes ?? 0} hasEmail={!!props.me.email} onChanged={() => void refetch()} />
      </Show>
      {/* Google accounts without a password come back through Google Drive; linking GitHub (for signing in or the
          git channels) doesn't change that. */}
      <Show when={!(props.me.google && !props.me.hasPassword) && (props.me.hasPassword || props.me.github || info()?.recoveryCopy)} fallback={
        <Show when={props.me.google}>{(g) => <GoogleRecovery email={g().email} inDrive={!!props.me.inDrive} github={!!props.me.github} />}</Show>
      }>
        <Show when={info()} fallback={<Show when={info.error}><p class="warning">Recovery settings couldn't be loaded from {hostOf()}.</p></Show>}>
          {(i) => <Recovery info={i()} hasPassword={props.me.hasPassword} onChanged={() => void refetch()} />}
        </Show>
      </Show>
    </>
  );
}

// Runs an action that needs the account key; on a device without its own copy it asks for the password first.
function useKeyAction() {
  const [password, setPassword] = createSignal<string | null>(null);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const run = async (action: (password?: string) => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError("");
    try {
      await action(password() ?? undefined);
      setPassword(null);
      return true;
    } catch (e) {
      if (e instanceof NeedsPassword) setPassword("");
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const field = () => (
    <Show when={password() !== null}>
      <input class="mw-input mw-box mw-fade-in" type="password" placeholder="Current password" aria-label="Current password"
        autocomplete="current-password" value={password()!} onInput={(e) => setPassword(e.currentTarget.value)} />
    </Show>
  );
  return { run, field, error, busy, needsPassword: () => password() === "" };
}

function EmailField(props: { me: Account; onChanged: () => void }) {
  const [editing, setEditing] = createSignal(false);
  const [email, setEmailInput] = createSignal("");
  const [code, setCode] = createSignal("");
  const [sent, setSent] = createSignal(false);
  const action = useKeyAction();
  const close = () => {
    setEditing(false);
    setSent(false);
    setCode("");
  };
  return (
    <div class="account-field">
      <span>Email</span>
      <Show when={!editing()} fallback={
        <form class="account-inline-form mw-fade-in" onSubmit={async (e) => {
          e.preventDefault();
          if (!sent()) setSent(await action.run(() => sendEmailCode(email())));
          else if (await action.run(() => setEmail(email(), code()))) {
            close();
            props.onChanged();
          }
        }}>
          <input class="mw-input mw-box" type="email" placeholder="you@example.com" aria-label="Email" disabled={sent()}
            value={email()} onInput={(e) => setEmailInput(e.currentTarget.value)} />
          <Show when={sent()}>
            <input class="mw-input mw-box account-code" inputMode="numeric" maxLength={6} placeholder="Code from the email" aria-label="Code"
              value={code()} onInput={(e) => setCode(e.currentTarget.value.replace(/\D/g, ""))} />
          </Show>
          <button type="submit" class="mw-button primary mw-box" disabled={action.busy() || !email().trim() || (sent() && code().length !== 6)}>
            {sent() ? "Confirm" : "Send code"}
          </button>
          <button type="button" class="mw-button mw-box" onClick={close}>Cancel</button>
        </form>
      }>
        <div class="account-inline-form">
          <span>{props.me.email ?? <span class="hint">No email yet</span>}</span>
          <button class="mw-button mw-box" onClick={() => { setEmailInput(props.me.email ?? ""); setEditing(true); }}>
            {props.me.email ? "Change" : "Add email"}
          </button>
        </div>
        <Show when={!props.me.email && props.me.hasPassword}>
          <p class="warning">Add an email: you sign in with it on other computers, and it is the only way to reset a forgotten password.</p>
        </Show>
      </Show>
      <Show when={action.error()}><p class="warning">{action.error()}</p></Show>
    </div>
  );
}

// Sign in with GitHub on other computers. Linking moves the GitHub user off another MakeWork account it was on.
function GitHubField(props: { me: Account; linked: string | null; onChanged: () => void }) {
  const [features] = createResource(() => serverFeatures().catch(() => ({ github: false })));
  const [waiting, setWaiting] = createSignal<AbortController | null>(null);
  const [error, setError] = createSignal("");
  const connect = async () => {
    const controller = new AbortController();
    setWaiting(controller);
    setError("");
    try {
      await connectGitHub(controller.signal);
      props.onChanged();
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWaiting(null);
    }
  };
  return (
    <Show when={features()?.github || props.linked}>
      <div class="account-field">
        <span>GitHub</span>
        <div class="account-inline-form">
          <Show when={props.linked} fallback={<span class="hint">Not connected</span>}>
            {(login) => <span>Connected as {login()}</span>}
          </Show>
          <Show when={!waiting()} fallback={
            <>
              <span class="hint mw-fade-in">Finish on GitHub in the window that opened...</span>
              <button class="mw-button mw-box" onClick={() => waiting()?.abort()}>Cancel</button>
            </>
          }>
            <button class="mw-button mw-box" onClick={() => void connect()}>{props.linked ? "Connect another" : "Connect GitHub"}</button>
          </Show>
        </div>
        <p class="hint">Lets you sign in with GitHub on other computers. Its key comes back the same ways as after a password reset.</p>
        <Show when={error()}><p class="warning">{error()}</p></Show>
      </div>
    </Show>
  );
}

function PasswordField() {
  const [open, setOpen] = createSignal(false);
  const [next, setNext] = createSignal("");
  const [confirm, setConfirm] = createSignal("");
  const [done, setDone] = createSignal(false);
  const action = useKeyAction();
  const mismatch = () => confirm() !== "" && confirm() !== next();
  const ruleId = createUniqueId();
  return (
    <div class="account-field">
      <span>Password</span>
      <Show when={open()} fallback={
        <div class="account-inline-form">
          <button class="mw-button mw-box" onClick={() => { setOpen(true); setDone(false); }}>Change password</button>
          <Show when={done()}><span class="hint mw-fade-in">Password changed.</span></Show>
        </div>
      }>
        <form class="account-stack mw-fade-in" onSubmit={async (e) => {
          e.preventDefault();
          if (next() !== confirm()) return;
          if (await action.run((current) => changePassword(next(), current))) {
            setOpen(false);
            setNext("");
            setConfirm("");
            setDone(true);
          }
        }}>
          {action.field()}
          <input class="mw-input mw-box" type="password" placeholder="New password" aria-label="New password" autocomplete="new-password"
            aria-describedby={ruleId} value={next()} onInput={(e) => setNext(e.currentTarget.value)} />
          <PasswordRule id={ruleId} password={next()} />
          <input class="mw-input mw-box" type="password" placeholder="New password again" aria-label="Confirm new password"
            autocomplete="new-password" classList={{ invalid: mismatch() }}
            value={confirm()} onInput={(e) => setConfirm(e.currentTarget.value)} />
          <Collapse open={mismatch()}>
            <p class="warning account-stack-note">The passwords don't match.</p>
          </Collapse>
          <div class="account-inline-form">
            <button type="submit" class="mw-button primary mw-box"
              disabled={action.busy() || next().length < minPasswordLength || next() !== confirm() || action.needsPassword()}>
              Change password
            </button>
            <button type="button" class="mw-button mw-box" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      </Show>
      <Show when={action.error()}><p class="warning">{action.error()}</p></Show>
    </div>
  );
}

// Two-step sign-in with an authenticator app: password sign-ins on a new computer, and the recovery copy, then take
// one of its codes instead of a code by email.
function TotpSetting(props: { on: boolean; backupCodes: number; hasEmail: boolean; onChanged: () => void }) {
  const [setup, setSetup] = createSignal<{ secret: string; uri: string } | null>(null);
  const [backupCodes, setBackupCodes] = createSignal<string[] | null>(null);
  const [turningOff, setTurningOff] = createSignal(false);
  const [code, setCode] = createSignal("");
  const [saved, setSaved] = createSignal(false);
  const { copied: secretCopied, copy: copySecret } = createCopied();
  const { copied: codesCopied, copy: copyCodes } = createCopied();
  const action = useKeyAction();
  const cancel = () => {
    setSetup(null);
    setTurningOff(false);
    setCode("");
  };
  const codesText = () => `MakeWork backup codes\n${backupCodes()!.join("\n")}\n`;
  return (
    <div class="account-field">
      <span>Authenticator app</span>
      <Switch>
        <Match when={backupCodes()}>
          {(codes) => (
            <div class="recovery-key mw-box mw-fade-in">
              <p>Your backup codes. Each one works once in place of a code from the app, for when your phone is lost. They are shown only now.</p>
              <div class="totp-backup-codes"><For each={codes()}>{(c) => <code class="recovery-key-value">{c}</code>}</For></div>
              <div class="account-inline-form">
                <button class="mw-button mw-box" onClick={() => void copyCodes(codesText())}>
                  <Icon name={codesCopied() ? "check" : "copy"} /> {codesCopied() ? "Copied" : "Copy"}
                </button>
                <button class="mw-button mw-box" onClick={() => saveBlob(new Blob([codesText()], { type: "text/plain" }), "makework-backup-codes.txt")}>
                  <Icon name="download" /> Save as file
                </button>
              </div>
              <label class="settings-check">
                <input type="checkbox" checked={saved()} onChange={(e) => setSaved(e.currentTarget.checked)} />
                I saved my backup codes somewhere safe
              </label>
              <Show when={saved()}>
                <button class="mw-button mw-box mw-fade-in" onClick={() => { setBackupCodes(null); setSaved(false); props.onChanged(); }}>Done</button>
              </Show>
            </div>
          )}
        </Match>
        <Match when={setup()}>
          {(s) => (
            <form class="account-stack mw-fade-in" onSubmit={async (e) => {
              e.preventDefault();
              let codes: string[] = [];
              if (await action.run(async () => (codes = await finishTotp(code())))) {
                cancel();
                setBackupCodes(codes);
              }
            }}>
              <p class="hint">Scan this with an authenticator app (such as Aegis, 2FAS, Google Authenticator or a password manager), then enter the code it shows.</p>
              <QrCode text={s().uri} label="QR code for your authenticator app" />
              <div class="account-inline-form">
                <code class="totp-secret">{s().secret}</code>
                <button type="button" class="mw-button mw-box" onClick={() => void copySecret(s().secret)}>
                  <Icon name={secretCopied() ? "check" : "copy"} /> {secretCopied() ? "Copied" : "Copy key"}
                </button>
              </div>
              <div class="account-inline-form">
                <input class="mw-input mw-box account-code" inputMode="numeric" maxLength={6} placeholder="Code from the app" aria-label="Code"
                  autocomplete="one-time-code" value={code()} onInput={(e) => setCode(e.currentTarget.value.replace(/\D/g, ""))} />
                <button type="submit" class="mw-button primary mw-box" disabled={action.busy() || code().length !== 6}>Turn on</button>
                <button type="button" class="mw-button mw-box" onClick={cancel}>Cancel</button>
              </div>
            </form>
          )}
        </Match>
        <Match when={turningOff()}>
          <form class="account-inline-form mw-fade-in" onSubmit={async (e) => {
            e.preventDefault();
            if (await action.run(() => removeTotp(code()))) {
              cancel();
              props.onChanged();
            }
          }}>
            <input class="mw-input mw-box account-code" maxLength={16} placeholder="Code or backup code" aria-label="Code" autocomplete="one-time-code"
              spellcheck={false} value={code()} onInput={(e) => setCode(e.currentTarget.value)} />
            <button type="submit" class="mw-button primary mw-box" disabled={action.busy() || code().trim().length < 6}>Turn off</button>
            <button type="button" class="mw-button mw-box" onClick={cancel}>Cancel</button>
          </form>
        </Match>
        <Match when={props.on}>
          <div class="account-inline-form">
            <span>On</span>
            <span class="hint">{props.backupCodes === 1 ? "1 backup code left" : `${props.backupCodes} backup codes left`}</span>
            <button class="mw-button mw-box" onClick={() => setTurningOff(true)}>Turn off</button>
          </div>
          <p class="hint">Signing in with your password on a new computer takes a code from the app, and so does the recovery copy.</p>
        </Match>
        <Match when={!props.on}>
          <div class="account-inline-form">
            <span class="hint">Off</span>
            <button class="mw-button mw-box" disabled={action.busy()}
              onClick={async () => { let started = null as { secret: string; uri: string } | null; if (await action.run(async () => (started = await beginTotp()))) setSetup(started); }}>
              Set up
            </button>
          </div>
          <p class="hint">
            {props.hasEmail ? "Signing in with your password on a new computer takes a code sent to your email. " : ""}
            With an authenticator app it takes a code from the app instead, so someone who gets into your email can't use it.
          </p>
        </Match>
      </Switch>
      <Show when={action.error()}><p class="warning">{action.error()}</p></Show>
    </div>
  );
}

// Drawn from the code's modules; dark on light whatever the theme, since some scanners can't read inverted codes.
function QrCode(props: { text: string; label: string }) {
  const qr = () => encode(props.text, { ecc: "M", border: 2 });
  const path = () => {
    const parts: string[] = [];
    qr().data.forEach((row, y) => row.forEach((dark, x) => { if (dark) parts.push(`M${x} ${y}h1v1h-1z`); }));
    return parts.join("");
  };
  return (
    <svg class="totp-qr mw-box" viewBox={`0 0 ${qr().size} ${qr().size}`} role="img" aria-label={props.label} shape-rendering="crispEdges">
      <rect class="totp-qr-light" width={qr().size} height={qr().size} />
      <path class="totp-qr-dark" d={path()} />
    </svg>
  );
}

function Recovery(props: { info: Awaited<ReturnType<typeof ownAccountInfo>>; hasPassword: boolean; onChanged: () => void }) {
  // Accounts without a password (GitHub) only need recovery to sign in on a new computer.
  const lost = () => (props.hasPassword ? "a forgotten password" : "signing in on a new computer");
  const [shownKey, setShownKey] = createSignal<string | null>(null);
  const { copied: keyCopied, copy: copyKey } = createCopied();
  const [saved, setSaved] = createSignal(false);
  const [confirmingOff, setConfirmingOff] = createSignal(false);
  const action = useKeyAction();
  const hasKey = () => props.info.recoveryKey || saved();
  const makeKey = async () => {
    let key = "";
    if (await action.run(async (password) => (key = await createRecoveryKey(password)))) {
      setShownKey(key);
      setSaved(false);
    }
  };
  const turnOff = async () => {
    setConfirmingOff(false);
    if (await action.run(() => setRecoveryCopy(false))) props.onChanged();
  };
  const host = hostOf();

  return (
    <div class="account-field">
      <span>{props.hasPassword ? "Password recovery" : "Account recovery"}</span>
      <Switch>
        <Match when={!props.info.keepsCopies}>
          <p class="hint">{host} doesn't keep recovery copies. Save a recovery key so {lost()} doesn't cost you this account.</p>
        </Match>
        <Match when={props.info.recoveryCopy}>
          <Notice tone="warning" icon="unlock" title={`A recovery copy of your account is kept on ${host}`}>
            <p>
              This lets you reset a forgotten password with only your email, and sign in with GitHub on a new computer. It also means <strong>whoever runs {host} could
              read your private messages and act as you</strong>, and so could anyone who breaks into it.
            </p>
            <p>
              <strong>To protect your data, turn the recovery copy off.</strong> Before you do, save a recovery key somewhere safe
              (a password manager, or printed and put away). Without the copy, a forgotten password can only be reset with that
              key or from another computer where you are still signed in.
            </p>
          </Notice>
        </Match>
        <Match when={!props.info.recoveryCopy}>
          <Notice tone="safe" icon="lock" title="Your account's key is only yours">
            <p>
              {host} can't read your private messages or act as you. {props.hasPassword ? "A forgotten password, or a GitHub sign-in on a new computer," : "A GitHub sign-in on a new computer"}
              needs your recovery key or another computer where you are signed in. {props.info.recoveryKey ? "Keep your recovery key safe." : ""}
            </p>
            <Show when={!props.info.recoveryKey}>
              <p class="warning"><strong>You have no recovery key.</strong> {props.hasPassword
                ? "If you forget your password with no other computer signed in, this account is lost."
                : "If this computer's data is lost with no other computer signed in, this account is lost."} Make one now.</p>
            </Show>
          </Notice>
        </Match>
      </Switch>

      <Show when={shownKey()}>
        {(key) => (
          <div class="recovery-key mw-box mw-fade-in">
            <p>Your recovery key. It is shown only now: save it where you'll find it in a year. Anyone with it and your email can take over your account.</p>
            <code class="recovery-key-value">{key()}</code>
            <div class="account-inline-form">
              <button class="mw-button mw-box" onClick={() => void copyKey(key())}><Icon name={keyCopied() ? "check" : "copy"} /> {keyCopied() ? "Copied" : "Copy"}</button>
              <button class="mw-button mw-box" onClick={() => saveBlob(new Blob([`MakeWork recovery key\n${key()}\n`], { type: "text/plain" }), "makework-recovery-key.txt")}>
                <Icon name="download" /> Save as file
              </button>
            </div>
            <label class="settings-check">
              <input type="checkbox" checked={saved()} onChange={(e) => setSaved(e.currentTarget.checked)} />
              I saved my recovery key somewhere safe
            </label>
            <Show when={saved()}>
              <button class="mw-button mw-box mw-fade-in" onClick={() => { setShownKey(null); props.onChanged(); }}>Done</button>
            </Show>
          </div>
        )}
      </Show>

      {action.field()}
      <div class="account-inline-form">
        <Show when={!shownKey()}>
          <button class="mw-button mw-box" disabled={action.busy() || action.needsPassword()} onClick={() => void makeKey()}>
            <Icon name="lock" /> {props.info.recoveryKey ? "Make a new recovery key" : "Make a recovery key"}
          </button>
        </Show>
        <Show when={props.info.recoveryCopy} fallback={
          <Show when={props.info.keepsCopies}>
            <button class="mw-button mw-box" disabled={action.busy() || action.needsPassword()}
              onClick={async () => { if (await action.run((password) => setRecoveryCopy(true, password))) props.onChanged(); }}>
              Turn on recovery copy
            </button>
          </Show>
        }>
          <button class="mw-button primary mw-box" disabled={action.busy()} aria-expanded={confirmingOff()}
            onClick={() => (hasKey() ? void turnOff() : setConfirmingOff(!confirmingOff()))}>
            <Icon name="lock" /> Turn off recovery copy
          </button>
        </Show>
      </div>
      <ConfirmPrompt open={confirmingOff()} confirmLabel="Turn off without a key"
        question={`You haven't saved a recovery key. Without it, ${lost()} with no other computer signed in loses this account for good. Make a recovery key first?`}
        onConfirm={() => void turnOff()} onCancel={() => setConfirmingOff(false)} />
      <Show when={action.error()}><p class="warning">{action.error()}</p></Show>
    </div>
  );
}

// Google accounts keep their key in the Google account's Drive (core/drive.ts), not on the user server.
function GoogleRecovery(props: { email: string; inDrive: boolean; github: boolean }) {
  return (
    <div class="account-field">
      <span>Account recovery</span>
      <Show when={props.inDrive} fallback={
        <Notice tone="warning" icon="unlock" title="This account only exists on this computer">
          <p>
            It was made before accounts were saved to Google Drive, so its key is only here and {hostOf()} keeps no
            copy. If this computer's app data is lost, so is the account: keep it backed up.
          </p>
        </Notice>
      }>
        <Notice tone="safe" icon="lock" title={`Your account's key is in the Google Drive of ${props.email}`}>
          <p>
            {hostOf()} keeps no copy of it. Signing in with Google on any computer brings the account back, so keeping
            this Google account safe (a strong password, two-step verification) keeps this account safe. If you lose
            the Google account, this account can't be recovered.
          </p>
          <Show when={props.github}>
            <p>GitHub is linked for signing in and git channels. On a new computer, sign in with Google to bring this account back.</p>
          </Show>
        </Notice>
      </Show>
    </div>
  );
}

function Notice(props: { tone: "warning" | "safe"; icon: string; title: string; children: JSX.Element }) {
  return (
    <div class={`account-notice ${props.tone} mw-box`}>
      <p class="account-notice-title"><Icon name={props.icon} /> {props.title}</p>
      {props.children}
    </div>
  );
}
