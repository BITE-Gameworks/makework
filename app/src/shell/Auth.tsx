// Sign in and register, shown before the shell. Accounts are kept on this device and on the user server
// (see core/account.ts).
import { For, Match, Show, Switch, createResource, createSignal, createUniqueId, onCleanup, type JSX } from "solid-js";
import AccountAgreement, { agreedBefore, rememberAgreement } from "./AccountAgreement";
import {
  AuthError, continueWithGitHub, continueWithGoogle, createAccountWithGitHub, createOfflineAccount, finishPasswordReset, forgetAccount,
  importAccount, keyFromDevice, keyFromRecoveryKey, keyFromServerCopy, listAccounts, minPasswordLength, register, resetToFreshAccount,
  sendResetCode, signIn, signInOnline, startPasswordReset, type Account, type PasswordReset,
} from "../core/account";
import { googleAvailable } from "../core/google";
import { showToast } from "../core/notices";
import { handleOf, hostOf, serverFeatures, userServer, UserServerError, type GitHubSignIn, type SecondStep } from "../core/userServer";
import { Icon } from "../theme/icons";
import ConfirmPrompt from "../ui/ConfirmPrompt";
import Avatar from "../ui/Avatar";
import Collapse from "../ui/Collapse";
import { UserServerField } from "./AddressField";
import PasswordRule from "./PasswordRule";
import RegisterForm from "./RegisterForm";
import WindowControls from "./WindowControls";
import "./auth.css";
import { focusWhenShown } from "../ui/focus";

type Mode = "sign-in" | "online" | "register" | "import" | "reset" | "github" | "github-unlinked";

export default function Auth() {
  const [accounts, { mutate: setAccounts }] = createResource(listAccounts);
  const [chosenMode, setMode] = createSignal<Mode | null>(null);
  // The account list only while there are accounts (the last one can be forgotten).
  const mode = (): Mode => {
    const has = (accounts()?.length ?? 0) > 0;
    const chosen = chosenMode();
    return chosen && (chosen !== "sign-in" || has) ? chosen : has ? "sign-in" : "online";
  };
  const [remember, setRemember] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [agreed, setAgreed] = createSignal(agreedBefore());
  // Every way in to an account waits for the agreement; offline use doesn't.
  const locked = () => busy() || !agreed();
  const [features] = createResource(userServer, () => serverFeatures().catch(() => ({ github: false })));
  // A GitHub sign-in waiting in the browser, one whose key has to come back another way, and a GitHub user no
  // account is linked to (with accounts on this device, creating one is the person's choice, not automatic).
  const [githubWaiting, setGithubWaiting] = createSignal<AbortController | null>(null);
  const [githubReset, setGithubReset] = createSignal<PasswordReset | null>(null);
  const [githubUnlinked, setGithubUnlinked] = createSignal<GitHubSignIn | null>(null);
  const github = () => {
    const controller = new AbortController();
    setGithubWaiting(controller);
    void attempt(async () => {
      const outcome = await continueWithGitHub(remember(), controller.signal, (accounts()?.length ?? 0) === 0);
      if (outcome.kind === "reset") {
        setGithubReset(outcome.reset);
        setMode("github");
      } else if (outcome.kind === "unlinked") {
        setGithubUnlinked(outcome.result);
        setMode("github-unlinked");
      }
    }).finally(() => setGithubWaiting(null));
  };
  onCleanup(() => githubWaiting()?.abort());

  // True when the action went through.
  const attempt = async (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError("");
    try {
      await action();
      if (agreed()) rememberAgreement();
      return true;
    } catch (e) {
      if (!(e instanceof AuthError || e instanceof UserServerError)) console.warn("Sign-in failed:", e);
      setError((e as Error).message || "Something went wrong.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const switchTo = (next: Mode) => {
    setError("");
    setMode(next);
  };

  return (
    <div class="auth" data-drag-region>
      <WindowControls />
      <Show when={!accounts.loading}>
        <main class="auth-card mw-box mw-fade-in">
          <h1 class="auth-title">MakeWork</h1>
          <AccountAgreement onChange={setAgreed} />
          <Switch>
            <Match when={mode() === "sign-in"}>
              <SignInForm accounts={accounts() ?? []} busy={locked()}
                onSubmit={(id, password) => attempt(() => signIn(id, password, remember()))}
                onGoogle={(email) => attempt(() => continueWithGoogle(remember(), email))}
                onGitHub={github} onForgot={() => switchTo("reset")}
                onForget={(id) => attempt(async () => {
                  await forgetAccount(id);
                  // Changed in place: a refetch would hide the whole card while it loads.
                  setAccounts((list) => list?.filter((a) => a.id !== id));
                })} />
            </Match>
            <Match when={mode() === "online"}>
              <OnlineSignInForm busy={locked()} remember={remember()} attempt={attempt}
                onForgot={() => switchTo("reset")} onBack={() => setError("")} />
            </Match>
            <Match when={mode() === "register"}>
              <RegisterForm busy={!agreed()} onSubmit={async (input) => {
                await register({ ...input, remember: remember() });
                rememberAgreement();
              }} />
            </Match>
            <Match when={mode() === "github" && githubReset()}>
              {(r) => (
                <form class="auth-form" onSubmit={(e) => e.preventDefault()}>
                  <h2>Signed in with GitHub</h2>
                  <p class="hint">
                    GitHub confirmed you as <strong>{r().github?.login}</strong>, linked to <strong>{r().account.profile.displayName}</strong>{" "}
                    ({handleOf(r().account)}). This computer doesn't have the account's key yet.
                  </p>
                  <KeyChoices reset={r()} password={null} ready busy={locked()} attempt={attempt} remember={remember()} />
                  <button type="button" class="auth-link auth-forgot" onClick={() => switchTo("online")}>Back to sign in</button>
                </form>
              )}
            </Match>
            <Match when={mode() === "github-unlinked" && githubUnlinked()}>
              {(r) => (
                <form class="auth-form" onSubmit={(e) => e.preventDefault()}>
                  <h2>GitHub not linked</h2>
                  <p class="hint">
                    GitHub confirmed you as <strong>{r().github.login}</strong>, but no account on {hostOf()} is linked to it.
                    This computer already has {accounts()?.length === 1 ? "an account" : "accounts"}.
                  </p>
                  <button type="button" class="mw-button primary mw-box auth-submit" disabled={locked()}
                    onClick={() => void attempt(() => createAccountWithGitHub(r(), remember()))}>
                    Create a new MakeWork account
                  </button>
                  <button type="button" class="auth-link auth-forgot" onClick={() => switchTo("sign-in")}>Back to sign in</button>
                </form>
              )}
            </Match>
            <Match when={mode() === "reset"}>
              <ResetForm busy={locked()} remember={remember()} attempt={attempt} onCancel={() => switchTo("online")} />
            </Match>
            <Match when={mode() === "import"}>
              <ImportForm busy={locked()} onSubmit={(text, password) => attempt(() => importAccount(text, password, remember()))} />
            </Match>
          </Switch>

          <Collapse open={error() !== ""}>
            <p class="auth-error" role="alert">{error()}</p>
          </Collapse>

          <Show when={googleAvailable()}>
            <div class="auth-divider"><span>or</span></div>
            <button class="mw-button auth-google mw-box" disabled={locked()}
              onClick={() => attempt(() => continueWithGoogle(remember()))}>
              <GoogleLogo /> Continue with Google
            </button>
          </Show>
          <Show when={features()?.github}>
            <Show when={!googleAvailable()}><div class="auth-divider"><span>or</span></div></Show>
            <Show when={!githubWaiting()} fallback={
              <div class="auth-waiting mw-box mw-fade-in">
                <p>Finish signing in on GitHub in the window that opened, then come back here.</p>
                <button type="button" class="mw-button mw-box" onClick={() => githubWaiting()?.abort()}>Cancel</button>
              </div>
            }>
              <button class="mw-button auth-google mw-box" disabled={locked()} onClick={github}>
                <GitHubLogo /> Continue with GitHub
              </button>
            </Show>
          </Show>

          <label class="auth-remember">
            <input type="checkbox" checked={remember()} onChange={(e) => setRemember(e.currentTarget.checked)} />
            Stay signed in on this device
          </label>

          <button class="auth-link auth-offline" type="button" disabled={busy()} title="No account needed: everything works on this computer. Create an account later to share workspaces."
            onClick={() => attempt(async () => {
              await createOfflineAccount(remember());
              showToast("Working offline: your work stays on this computer. Create an account any time to share it.", { ms: 8000 });
            })}>
            Skip, use MakeWork offline
          </button>

          <Show when={mode() !== "register"}>
            <p class="auth-switch">
              New here? <button class="auth-link" onClick={() => switchTo("register")}>Create an account</button>
            </p>
          </Show>
          <Show when={mode() !== "online"}>
            <p class="auth-switch">
              Account on another computer? <button class="auth-link" onClick={() => switchTo("online")}>Sign in with email</button>
            </p>
          </Show>
          <Show when={mode() !== "sign-in" && (accounts()?.length ?? 0) > 0}>
            <p class="auth-switch">
              <button class="auth-link" onClick={() => switchTo("sign-in")}>Accounts on this computer</button>
            </p>
          </Show>
          <Show when={mode() === "online"}>
            <p class="auth-switch">
              Have an account file? <button class="auth-link" onClick={() => switchTo("import")}>Import it</button>
            </p>
          </Show>
          <p class="hint auth-note">
            Your password never leaves this computer: the user server keeps your account's key locked with it, and
            hands it to another computer only with a code sent to your email.
            Google accounts are saved to your Google Drive.
          </p>
          <UserServerField label="Accounts on" />
        </main>
      </Show>
    </div>
  );
}

function SignInForm(props: {
  accounts: Account[]; busy: boolean; onSubmit: (id: string, password: string) => void; onGoogle: (email?: string) => void;
  onGitHub: () => void; onForgot: () => void; onForget: (id: string) => void;
}) {
  const [selected, setSelected] = createSignal(props.accounts[0]?.id ?? "");
  const [password, setPassword] = createSignal("");
  const [forgetting, setForgetting] = createSignal<string | null>(null);
  // Falls back to the first account once the chosen one was forgotten.
  const chosen = () => props.accounts.find((a) => a.id === selected()) ?? props.accounts[0];

  return (
    <form class="auth-form" onSubmit={(e) => {
      e.preventDefault();
      const a = chosen();
      if (a?.hasPassword) props.onSubmit(a.id, password());
    }}>
      <h2>Sign in</h2>
      <div class="auth-accounts mw-scroll-fade" role="radiogroup" aria-label="Accounts on this device">
        <For each={props.accounts}>
          {(a) => (
            <div class="auth-account-entry">
              <div class="auth-account-row">
                <button type="button" class="auth-account mw-box" classList={{ selected: a.id === chosen()?.id }}
                  role="radio" aria-checked={a.id === chosen()?.id} onClick={() => {
                    setSelected(a.id);
                    setPassword("");
                  }}>
                  <Avatar user={a} size={36} />
                  <span class="auth-account-name">
                    <span>{a.displayName}</span>
                    <span class="hint">{a.email ?? a.google?.email ?? handleOf(a)}</span>
                  </span>
                </button>
                <button type="button" class="auth-account-forget mw-box" classList={{ active: forgetting() === a.id }}
                  title="Forget on this device" aria-label={`Forget ${a.displayName} on this device`} disabled={props.busy}
                  onClick={() => setForgetting(forgetting() === a.id ? null : a.id)}>
                  <Icon name="close" />
                </button>
              </div>
              <ConfirmPrompt open={forgetting() === a.id} question={forgetQuestion(a)}
                confirmLabel={comesBackWith(a) ? "Forget" : "Delete for good"}
                onConfirm={() => {
                  setForgetting(null);
                  if (a.id === chosen()?.id) setPassword("");
                  props.onForget(a.id);
                }}
                onCancel={() => setForgetting(null)} />
            </div>
          )}
        </For>
      </div>
      <Show when={chosen()?.hasPassword} fallback={
        <Show when={!chosen()?.github} fallback={
          <button class="mw-button primary mw-box auth-submit" type="button" disabled={props.busy} onClick={props.onGitHub}>
            Sign in with GitHub ({chosen()!.github!.login})
          </button>
        }>
          <p class="hint">This account signs in with Google{chosen()?.google ? ` (${chosen()!.google!.email})` : ""}.</p>
          <button class="mw-button primary mw-box auth-submit" type="button" disabled={props.busy || !googleAvailable()}
            onClick={() => props.onGoogle(chosen()?.google?.email)}>
            Sign in with Google
          </button>
        </Show>
      }>
        <Field label="Password">
          <input class="mw-input mw-box" type="password" autocomplete="current-password" required
            value={password()} onInput={(e) => setPassword(e.currentTarget.value)} />
        </Field>
        <button class="mw-button primary mw-box auth-submit" type="submit" disabled={props.busy || password() === ""}>
          Sign in
        </button>
        <button type="button" class="auth-link auth-forgot" onClick={props.onForgot}>Forgot password?</button>
      </Show>
    </form>
  );
}

// Accounts made before emails sign in with their username in the same field.
// How a forgotten account can be signed in on this device again, or null when it exists only here (its key with it).
function comesBackWith(a: Account): string | null {
  if (a.loginOn) return a.email ? `your email (${a.email}) and password` : "your username and password";
  if (a.google && a.inDrive) return `Google (${a.google.email})`;
  if (a.github) return `GitHub (${a.github.login}), as long as its recovery copy or recovery key still exists`;
  return null;
}

function forgetQuestion(a: Account): string {
  const back = comesBackWith(a);
  return back
    ? `Forget ${a.displayName} on this device? You can sign in again with ${back}.`
    : `${a.displayName} is only on this device. Forgetting it deletes it for good; to keep it, sign in and export it first (Settings > Account).`;
}

// Email and password, then a second step: the user server hands an account's key to this computer only with a code
// from the account's authenticator app, or else one it mails to the account's email. (Accounts from before emails
// sign in with their username in the same field.) `onBack` runs when the person returns from the code to the password.
function OnlineSignInForm(props: { busy: boolean; remember: boolean; attempt: Attempt; onForgot: () => void; onBack: () => void }) {
  const [login, setLogin] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [code, setCode] = createSignal("");
  const [confirming, setConfirming] = createSignal<SecondStep | null>(null);
  // Without a code the user server says which step it needs (mailing a new code for "email").
  const signIn = (step?: { kind: SecondStep; code: string }) => props.attempt(async () => {
    const result = await signInOnline(login().trim(), password(), props.remember, step);
    if (result === "in") return;
    setCode("");
    setConfirming(result);
  });

  return (
    <Show when={confirming()} fallback={
      <form class="auth-form mw-fade-in" onSubmit={(e) => {
        e.preventDefault();
        void signIn();
      }}>
        <h2>Sign in</h2>
        <Field label="Email">
          <input class="mw-input mw-box" type="text" inputMode="email" autocomplete="username" required maxLength={254} spellcheck={false}
            value={login()} onInput={(e) => setLogin(e.currentTarget.value)} />
        </Field>
        <Field label="Password">
          <input class="mw-input mw-box" type="password" autocomplete="current-password" required
            value={password()} onInput={(e) => setPassword(e.currentTarget.value)} />
        </Field>
        <button class="mw-button primary mw-box auth-submit" type="submit" disabled={props.busy || !login().trim() || !password()}>
          Sign in
        </button>
        <button type="button" class="auth-link auth-forgot" onClick={props.onForgot}>Forgot password?</button>
      </form>
    }>
      <form class="auth-form mw-fade-in" onSubmit={(e) => {
        e.preventDefault();
        void signIn({ kind: confirming()!, code: code() });
      }}>
        <h2>Confirm it's you</h2>
        <Show when={confirming() === "totp"} fallback={
          <CodeField email={login().trim()} value={code()} onInput={setCode} busy={props.busy} onResend={() => signIn()} />
        }>
          <TotpField value={code()} onInput={setCode} />
        </Show>
        <button class="mw-button primary mw-box auth-submit" type="submit" disabled={props.busy || !codeReady(confirming(), code())}>Sign in</button>
        <button type="button" class="auth-link auth-forgot" onClick={() => {
          setConfirming(null);
          props.onBack();
        }}>
          Back to sign in
        </button>
      </form>
    </Show>
  );
}

type Attempt = (action: () => Promise<unknown>) => Promise<boolean>;

const codeReady = (step: SecondStep | null, code: string) => (step === "totp" ? code.trim().length >= 6 : code.length === 6);

// A code from the account's authenticator app, or one of its backup codes (letters and a dash).
function TotpField(props: { value: string; onInput: (code: string) => void }) {
  return (
    <>
      <p class="hint">Enter the 6-digit code from your authenticator app. Lost your phone? Enter one of your backup codes.</p>
      <Field label="Code">
        <input class="mw-input mw-box auth-code" autocomplete="one-time-code" maxLength={16} required spellcheck={false}
          value={props.value} onInput={(e) => props.onInput(e.currentTarget.value)} ref={focusWhenShown} />
      </Field>
    </>
  );
}

// The six digits from an email. `onResend` answers whether a new code went out, which this then says.
function CodeField(props: { email: string; value: string; onInput: (code: string) => void; onResend: () => Promise<boolean>; busy: boolean }) {
  const [resent, setResent] = createSignal(false);
  return (
    <>
      <p class="hint">We sent a 6-digit code to <strong>{props.email}</strong>. It works for 15 minutes; check your spam folder too.</p>
      <Field label="Code">
        <input class="mw-input mw-box auth-code" inputMode="numeric" autocomplete="one-time-code" maxLength={6} required
          value={props.value} onInput={(e) => {
            setResent(false);
            props.onInput(e.currentTarget.value.replace(/\D/g, ""));
          }}
          ref={focusWhenShown} />
      </Field>
      <button type="button" class="auth-link auth-forgot" disabled={props.busy} onClick={async () => {
        setResent(false);
        setResent(await props.onResend());
      }}>
        Send a new code
      </button>
      <Collapse open={resent()}>
        <p class="hint auth-resent" role="status">A new code is on its way. The one before no longer works.</p>
      </Collapse>
    </>
  );
}

// Forgot password: emailed code, then a new password, with the key coming back from the user server's recovery copy,
// the recovery key, or a device that is still signed in; else a fresh account on the same email.
function ResetForm(props: { busy: boolean; remember: boolean; attempt: Attempt; onCancel: () => void }) {
  const [email, setEmail] = createSignal("");
  const [code, setCode] = createSignal("");
  const [step, setStep] = createSignal<"email" | "code" | "password">("email");
  const [reset, setReset] = createSignal<PasswordReset | null>(null);
  const [password, setPassword] = createSignal("");
  const [confirm, setConfirm] = createSignal("");
  const mismatch = () => confirm() !== "" && confirm() !== password();
  const passwordReady = () => password().length >= minPasswordLength && password() === confirm();
  const ruleId = createUniqueId();

  return (
    <form class="auth-form" onSubmit={async (e) => {
      e.preventDefault();
      if (step() === "email" && await props.attempt(() => sendResetCode(email()))) setStep("code");
      else if (step() === "code") {
        let started: PasswordReset | null = null;
        if (await props.attempt(async () => (started = await startPasswordReset(email(), code())))) {
          setReset(started);
          setStep("password");
        }
      } else if (step() === "password" && reset()?.recoveryCopy && !reset()?.totp && passwordReady())
        void props.attempt(async () => finishPasswordReset(reset()!, await keyFromServerCopy(reset()!), password(), props.remember));
    }}>
      <h2>Reset password</h2>
      <Switch>
        <Match when={step() === "email"}>
          <Field label="Email of the account">
            <input class="mw-input mw-box" type="email" autocomplete="email" required maxLength={254} spellcheck={false}
              value={email()} onInput={(e) => setEmail(e.currentTarget.value)} />
          </Field>
          <button class="mw-button primary mw-box auth-submit" type="submit" disabled={props.busy || !email().trim()}>Send code</button>
        </Match>
        <Match when={step() === "code"}>
          <CodeField email={email()} value={code()} onInput={setCode} busy={props.busy}
            onResend={() => props.attempt(() => sendResetCode(email()))} />
          <button class="mw-button primary mw-box auth-submit" type="submit" disabled={props.busy || code().length !== 6}>Continue</button>
        </Match>
        <Match when={step() === "password" && reset()}>
          {(r) => (
            <>
              <p class="hint">Resetting the password of <strong>{r().account.profile.displayName}</strong> (@{r().account.username}·{r().account.tag}).</p>
              <Field label="New password">
                <input class="mw-input mw-box" type="password" autocomplete="new-password" required minLength={minPasswordLength}
                  aria-describedby={ruleId} value={password()} onInput={(e) => setPassword(e.currentTarget.value)} />
              </Field>
              <PasswordRule id={ruleId} password={password()} />
              <Field label="Confirm new password">
                <input class="mw-input mw-box" type="password" autocomplete="new-password" required classList={{ invalid: mismatch() }}
                  value={confirm()} onInput={(e) => setConfirm(e.currentTarget.value)} />
              </Field>
              <Collapse open={mismatch()}>
                <p class="auth-error">The passwords don't match.</p>
              </Collapse>
              <Show when={r().recoveryCopy && !r().totp} fallback={
                <KeyChoices reset={r()} password={password()} ready={passwordReady()} busy={props.busy} attempt={props.attempt} remember={props.remember} />
              }>
                <p class="hint">Your account comes back from the recovery copy on {hostOf()}.</p>
                <button class="mw-button primary mw-box auth-submit" type="submit" disabled={props.busy || !passwordReady()}>Set new password</button>
              </Show>
            </>
          )}
        </Match>
      </Switch>
      <button type="button" class="auth-link auth-forgot" onClick={props.onCancel}>Back to sign in</button>
    </form>
  );
}

// The ways an account's key can come back when the user server has no recovery copy of it: the recovery key, a
// device still signed in, or else a fresh account. `password` is null for a GitHub sign-in.
function KeyChoices(props: {
  reset: PasswordReset; password: string | null; ready: boolean; busy: boolean; attempt: Attempt; remember: boolean;
}) {
  const [recoveryKey, setRecoveryKey] = createSignal("");
  const [totp, setTotp] = createSignal("");
  const [waiting, setWaiting] = createSignal<AbortController | null>(null);
  const [fresh, setFresh] = createSignal(false);
  onCleanup(() => waiting()?.abort());
  const finish = (key: () => Promise<Uint8Array<ArrayBuffer>>) =>
    props.attempt(async () => finishPasswordReset(props.reset, await key(), props.password, props.remember));
  const askDevice = () => {
    const controller = new AbortController();
    setWaiting(controller);
    void finish(() => keyFromDevice(props.reset, controller.signal)).finally(() => setWaiting(null));
  };
  const where = () => (props.reset.github ? `GitHub (${props.reset.github.login})` : props.reset.email);
  return (
    <>
      <Show when={props.reset.recoveryCopy && props.reset.totp} fallback={
        <p class="hint">
          This account has no recovery copy on {hostOf()}, so its key has to come back another way. Without the key,
          your workspaces, roles and messages stay with the old account.
        </p>
      }>
        <p class="hint">Your account comes back from the recovery copy on {hostOf()} with a code from your authenticator app.</p>
        <TotpField value={totp()} onInput={setTotp} />
        <button type="button" class="mw-button primary mw-box auth-submit" disabled={props.busy || !props.ready || !codeReady("totp", totp())}
          onClick={() => void finish(() => keyFromServerCopy(props.reset, totp()))}>
          Continue
        </button>
        <p class="hint">No code at hand? These work too:</p>
      </Show>
      <Show when={props.reset.recoveryLocked}>
        <Field label="Recovery key">
          <input class="mw-input mw-box auth-code" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" spellcheck={false} autocomplete="off"
            value={recoveryKey()} onInput={(e) => setRecoveryKey(e.currentTarget.value)} />
        </Field>
        <button type="button" class="mw-button primary mw-box auth-submit" disabled={props.busy || !props.ready || !recoveryKey().trim()}
          onClick={() => void finish(() => keyFromRecoveryKey(props.reset, recoveryKey()))}>
          Continue with recovery key
        </button>
      </Show>
      <Show when={!waiting()} fallback={
        <div class="auth-waiting mw-box mw-fade-in">
          <p>Waiting for approval... On a computer where you are still signed in, MakeWork asks whether to approve this.</p>
          <button type="button" class="mw-button mw-box" onClick={() => waiting()?.abort()}>Stop waiting</button>
        </div>
      }>
        <button type="button" class="mw-button mw-box auth-submit" disabled={props.busy || !props.ready} onClick={askDevice}>
          Approve on a device where I'm signed in
        </button>
      </Show>
      <button type="button" class="auth-link auth-forgot" aria-expanded={fresh()} onClick={() => setFresh(!fresh())}>
        I have none of these
      </button>
      <ConfirmPrompt open={fresh()} confirmLabel="Start fresh"
        question={`Make a new account for ${where()}? It gets a new identity: your workspaces, friends and private messages won't know it, so you'll need new invites. The old account can't sign in this way any more.`}
        onConfirm={() => { setFresh(false); if (props.ready) void props.attempt(() => resetToFreshAccount(props.reset, props.password, props.remember)); }}
        onCancel={() => setFresh(false)} />
    </>
  );
}

function ImportForm(props: { busy: boolean; onSubmit: (text: string, password: string) => void }) {
  const [file, setFile] = createSignal<File | null>(null);
  const [password, setPassword] = createSignal("");
  let picker!: HTMLInputElement;

  return (
    <form class="auth-form" onSubmit={(e) => {
      e.preventDefault();
      const chosen = file();
      if (chosen) void chosen.text().then((text) => props.onSubmit(text, password()));
    }}>
      <h2>Import account</h2>
      <p class="hint">Use the account file you exported from MakeWork on another computer.</p>
      <button class="mw-button mw-box" type="button" onClick={() => picker.click()}>
        {file()?.name ?? "Choose account file..."}
      </button>
      <input ref={picker} type="file" accept=".json,application/json" hidden
        onChange={(e) => { setFile(e.currentTarget.files?.[0] ?? null); e.currentTarget.value = ""; }} />
      <Field label="Account password">
        <input class="mw-input mw-box" type="password" autocomplete="current-password" required
          value={password()} onInput={(e) => setPassword(e.currentTarget.value)} />
      </Field>
      <button class="mw-button primary mw-box auth-submit" type="submit" disabled={props.busy || !file() || password() === ""}>
        Import and sign in
      </button>
    </form>
  );
}

// Details first, then the code emailed to confirm the address.
function Field(props: { label: string; children: JSX.Element }) {
  return (
    <label class="auth-field">
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}

// GitHub's mark, in the text color.
function GitHubLogo() {
  return (
    <svg class="auth-google-logo" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

// Google's own mark, in its brand colors as its sign-in guidelines require.
function GoogleLogo() {
  return (
    <svg class="auth-google-logo" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
