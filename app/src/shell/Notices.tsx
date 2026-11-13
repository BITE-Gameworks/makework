import { For, Show } from "solid-js";
import { dismissNotice, dismissToast, notices, toasts } from "../core/notices";
import { Icon } from "../theme/icons";
import "./ResetPrompt.css";

// Shares the corner (and look) with the password reset prompts.
export default function Notices() {
  return (
    <>
    <div class="reset-prompts notices">
      <For each={notices()}>
        {(notice) => (
          <div class="reset-prompt notice mw-box mw-fade-in" role="status">
            <p class="reset-prompt-title">
              <Icon name="info" /> <span class="notice-title">{notice.title}</span>
              <button class="icon-button notice-close" title="Dismiss" aria-label="Dismiss" onClick={() => dismissNotice(notice.id)}><Icon name="close" size={14} /></button>
            </p>
            <p class="hint mw-scroll-fade">{notice.text}</p>
            <div class="reset-prompt-actions">
              <For each={notice.actions ?? [{ label: "OK", run: () => {} }]}>
                {(action) => (
                  <button class="mw-button mw-box" onClick={() => {
                    dismissNotice(notice.id);
                    action.run();
                  }}>{action.label}</button>
                )}
              </For>
            </div>
          </div>
        )}
      </For>
    </div>
    <div class="toasts" role="status" aria-live="polite">
      <For each={toasts()}>
        {(toast) => (
          <div class="toast mw-box mw-fade-in">
            <span>{toast.text}</span>
            <Show when={toast.action}>
              {(action) => <button class="toast-action" onClick={() => { dismissToast(toast.id); action().run(); }}>{action().label}</button>}
            </Show>
          </div>
        )}
      </For>
    </div>
    </>
  );
}
