// The "create an account" form: email and the code sent to it, then username, display name and password. Used by
// Auth for a new account, and by Settings > Account to register an offline account (keeping its id and workspaces).
// `agreement` shows the terms checkboxes here; Auth shows its own for every way in.
import { Show, createSignal, createUniqueId, type JSX } from "solid-js";
import { AuthError, minPasswordLength, sendSignUpCode } from "../core/account";
import { UserServerError } from "../core/userServer";
import Collapse from "../ui/Collapse";
import PasswordRule from "./PasswordRule";
import { focusWhenShown } from "../ui/focus";
import AccountAgreement, { rememberAgreement } from "./AccountAgreement";

export interface RegisterInput {
  email: string;
  code: string;
  username: string;
  displayName: string;
  password: string;
}

export default function RegisterForm(props: { onSubmit: (input: RegisterInput) => Promise<void>; busy?: boolean; agreement?: boolean }) {
  const [email, setEmail] = createSignal("");
  const [code, setCode] = createSignal("");
  const [displayName, setDisplayName] = createSignal("");
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [confirm, setConfirm] = createSignal("");
  const [confirming, setConfirming] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const mismatch = () => confirm() !== "" && confirm() !== password();
  const [agreed, setAgreed] = createSignal(!props.agreement);
  const working = () => busy() || props.busy === true || !agreed();
  const ruleId = createUniqueId();

  const attempt = async (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError("");
    try {
      await action();
      return true;
    } catch (e) {
      if (!(e instanceof AuthError || e instanceof UserServerError)) console.warn("Creating the account failed:", e);
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="auth-form" onSubmit={async (e) => {
      e.preventDefault();
      if (!confirming()) {
        if (await attempt(() => sendSignUpCode(email()))) setConfirming(true);
        return;
      }
      void attempt(async () => {
        await props.onSubmit({ email: email(), code: code(), username: username(), displayName: displayName(), password: password() });
        if (props.agreement) rememberAgreement();
      });
    }}>
      <h2>Create an account</h2>
      <Show when={confirming()}>
        <p class="hint">We sent a 6-digit code to <strong>{email()}</strong>. It works for 15 minutes; check your spam folder too.</p>
        <Field label="Code">
          <input class="mw-input mw-box auth-code" inputMode="numeric" autocomplete="one-time-code" maxLength={6} required
            value={code()} onInput={(e) => setCode(e.currentTarget.value.replace(/\D/g, ""))}
            ref={focusWhenShown} />
        </Field>
        <button class="mw-button primary mw-box auth-submit" type="submit" disabled={working() || code().length !== 6}>Create account</button>
        <button type="button" class="auth-link auth-forgot" disabled={working()} onClick={() => void attempt(() => sendSignUpCode(email()))}>Send a new code</button>
        <button type="button" class="auth-link auth-forgot" onClick={() => setConfirming(false)}>Change details</button>
      </Show>
      <Show when={!confirming()}>
        <Field label="Email">
          <input class="mw-input mw-box" type="email" autocomplete="email" required maxLength={254} spellcheck={false}
            value={email()} onInput={(e) => setEmail(e.currentTarget.value)} />
        </Field>
        <Field label="Display name">
          <input class="mw-input mw-box" autocomplete="nickname" maxLength={48}
            value={displayName()} onInput={(e) => setDisplayName(e.currentTarget.value)} />
        </Field>
        <Field label="Username">
          <input class="mw-input mw-box" autocomplete="nickname" required maxLength={32} spellcheck={false}
            value={username()} onInput={(e) => setUsername(e.currentTarget.value.toLowerCase())} />
        </Field>
        <p class="hint auth-field-hint">Others may share it; a short tag from your account tells you apart.</p>
        <Field label="Password">
          <input class="mw-input mw-box" type="password" autocomplete="new-password" required minLength={minPasswordLength}
            aria-describedby={ruleId} value={password()} onInput={(e) => setPassword(e.currentTarget.value)} />
        </Field>
        <PasswordRule id={ruleId} password={password()} />
        <Field label="Confirm password">
          <input class="mw-input mw-box" type="password" autocomplete="new-password" required
            classList={{ invalid: mismatch() }} value={confirm()} onInput={(e) => setConfirm(e.currentTarget.value)} />
        </Field>
        <Collapse open={mismatch()}>
          <p class="auth-error">The passwords don't match.</p>
        </Collapse>
        <Show when={props.agreement}><AccountAgreement onChange={setAgreed} /></Show>
        <button class="mw-button primary mw-box auth-submit" type="submit"
          disabled={working() || mismatch() || !email().trim() || username() === "" || password().length < minPasswordLength}>
          Continue
        </button>
      </Show>
      <Collapse open={error() !== ""}>
        <p class="auth-error" role="alert">{error()}</p>
      </Collapse>
    </form>
  );
}

function Field(props: { label: string; children: JSX.Element }) {
  return (
    <label class="auth-field">
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}
