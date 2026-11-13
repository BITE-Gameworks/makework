// Shown on a device that is still signed in when a password reset of this account was started elsewhere: approving
// hands that device the account key.
import { For, Show, createSignal } from "solid-js";
import { approveReset, denyReset, NeedsPassword } from "../core/account";
import { dismissReset, resets } from "../core/resets";
import { relativeTime } from "../core/time";
import type { ResetRequest } from "../core/userServer";
import { Icon } from "../theme/icons";
import "./ResetPrompt.css";

export default function ResetPrompt() {
  return (
    <div class="reset-prompts">
      <For each={resets()}>{(request) => <ResetCard request={request} />}</For>
    </div>
  );
}

function ResetCard(props: { request: ResetRequest }) {
  const [password, setPassword] = createSignal<string | null>(null);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      dismissReset(props.request.id);
    } catch (e) {
      if (e instanceof NeedsPassword) setPassword("");
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="reset-prompt mw-box mw-fade-in" role="alertdialog" aria-label="Password reset">
      <p class="reset-prompt-title"><Icon name="lock" /> Someone is resetting your account</p>
      <p class="hint">
        Started {relativeTime(new Date(props.request.at).toISOString())}
        {props.request.device ? ` on ${props.request.device}` : " on another device"}.
        Approve only if that was you: it gives that device your account.
      </p>
      <Show when={password() !== null}>
        <input class="mw-input mw-box" type="password" placeholder="Your password on this device" aria-label="Password"
          value={password()!} onInput={(e) => setPassword(e.currentTarget.value)} />
      </Show>
      <Show when={error()}><p class="warning">{error()}</p></Show>
      <div class="reset-prompt-actions">
        <button class="mw-button mw-box" disabled={busy()} onClick={() => void run(() => denyReset(props.request))}>It wasn't me</button>
        <button class="mw-button primary mw-box" disabled={busy() || password() === ""}
          onClick={() => void run(() => approveReset(props.request, password() ?? undefined))}>Approve</button>
      </div>
    </div>
  );
}
