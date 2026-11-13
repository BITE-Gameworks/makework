import { createEffect, createSignal, on } from "solid-js";
import { closeFeedback, feedbackAddress, feedbackDraft, systemLabel } from "../core/feedback";
import { showToast } from "../core/notices";
import { hostOf, sendFeedback } from "../core/userServer";
import { appVersion } from "../core/version";
import Collapse from "../ui/Collapse";
import Dialog from "../ui/Dialog";
import Disclosure from "../ui/Disclosure";

// The form for feedback and crash reports. Shows everything that gets sent before it is.
export default function FeedbackDialog() {
  const [message, setMessage] = createSignal("");
  const [reply, setReply] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [problem, setProblem] = createSignal("");
  const [showSent, setShowSent] = createSignal(false);
  const report = () => feedbackDraft()?.report ?? "";

  createEffect(on(feedbackDraft, (draft) => {
    if (!draft) return;
    setMessage("");
    setProblem("");
    setShowSent(!!draft.report);
  }));

  const details = () => [`Version: ${appVersion}`, `System: ${systemLabel()}`, report()].filter(Boolean).join("\n");

  const submit = async (event: Event) => {
    event.preventDefault();
    if (busy()) return;
    if (!message().trim() && !report()) {
      setProblem("Write something first.");
      return;
    }
    const wasReport = !!report();
    setBusy(true);
    setProblem("");
    try {
      await sendFeedback({ message: message(), report: report(), reply: reply().trim(), version: appVersion, system: systemLabel() });
      closeFeedback();
      showToast(wasReport ? "Report sent. Thank you!" : "Feedback sent. Thank you!");
    } catch (e) {
      setProblem(`${e instanceof Error ? e.message : String(e)} You can also email ${feedbackAddress}.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={feedbackDraft() !== null} title={report() ? "Send a crash report" : "Send feedback"} onClose={closeFeedback}>
      <form class="feedback-form" onSubmit={submit}>
        <label class="feedback-field">
          <span>{report() ? "What were you doing? (optional)" : "What's on your mind? A bug, an idea, anything."}</span>
          <textarea class="mw-input mw-box" rows={6} maxLength={8000} value={message()} onInput={(e) => setMessage(e.currentTarget.value)} />
        </label>
        <label class="feedback-field">
          <span>Your email (optional)</span>
          <input class="mw-input mw-box" type="email" maxLength={254} value={reply()} onInput={(e) => setReply(e.currentTarget.value)} />
          <span class="hint">Only if you'd like an answer. Without it, this is sent with no name or account attached.</span>
        </label>
        <div>
          <Disclosure open={showSent()} onToggle={() => setShowSent(!showSent())}>What else gets sent</Disclosure>
          <Collapse open={showSent()}>
            <pre class="feedback-details mw-box mw-scroll-fade">{details()}</pre>
          </Collapse>
        </div>
        <p class="hint">
          Sent through {hostOf()}. You can also email <a href={`mailto:${feedbackAddress}`} target="_blank" rel="noopener noreferrer">{feedbackAddress}</a>.
        </p>
        <Collapse open={!!problem()}><p class="warning">{problem()}</p></Collapse>
        <div class="feedback-actions">
          <button type="button" class="mw-button mw-box" onClick={closeFeedback}>Cancel</button>
          <button type="submit" class="mw-button primary mw-box" disabled={busy()}>{busy() ? "Sending..." : "Send"}</button>
        </div>
      </form>
    </Dialog>
  );
}
