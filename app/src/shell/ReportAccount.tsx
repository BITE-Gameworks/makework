import { Show, createSignal } from "solid-js";
import { showToast } from "../core/notices";
import { setSidePanel } from "../core/ui";
import { hostOf } from "../core/userServer";
import { changeFriend, isBlocked, reportPerson } from "../dm/friends";
import Collapse from "../ui/Collapse";

// Reports an account to whoever runs the user server. Workspaces are run by their own members, so this can't remove
// anything from one; it is for accounts that break the terms.
export default function ReportAccount(props: { accountId: string; name: string }) {
  const [reason, setReason] = createSignal("");
  const [block, setBlock] = createSignal(!isBlocked(props.accountId));
  const [busy, setBusy] = createSignal(false);
  const [problem, setProblem] = createSignal("");

  const submit = async (event: Event) => {
    event.preventDefault();
    if (busy() || !reason().trim()) return;
    setBusy(true);
    setProblem("");
    try {
      await reportPerson(props.accountId, reason().trim());
      if (block() && !isBlocked(props.accountId)) await changeFriend("block", props.accountId);
      setSidePanel(null);
      showToast(`${props.name} was reported. Thank you.`);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="feedback-form report-form" onSubmit={submit}>
      <p class="hint">
        Report {props.name}'s account to {hostOf()} if it breaks the terms, for example with abuse, threats or illegal
        content. It includes your account and email, so it can be answered. What happens inside a workspace is up to
        the people who run it.
      </p>
      <label class="feedback-field">
        <span>What happened?</span>
        <textarea class="mw-input mw-box" rows={6} maxLength={4000} value={reason()} onInput={(e) => setReason(e.currentTarget.value)} />
      </label>
      <Show when={!isBlocked(props.accountId)}>
        <label class="settings-check">
          <input type="checkbox" checked={block()} onChange={(e) => setBlock(e.currentTarget.checked)} />
          Also block {props.name}
        </label>
      </Show>
      <Collapse open={!!problem()}><p class="warning">{problem()}</p></Collapse>
      <div class="feedback-actions">
        <button type="button" class="mw-button mw-box" onClick={() => setSidePanel(null)}>Cancel</button>
        <button type="submit" class="mw-button primary mw-box" disabled={busy() || !reason().trim()}>{busy() ? "Sending..." : "Send report"}</button>
      </div>
    </form>
  );
}
