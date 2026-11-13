// The feedback form (shell/FeedbackDialog.tsx): open from anywhere, optionally with a crash report to review.
import { createSignal } from "solid-js";
import { desktop } from "./desktop";
import { deviceLabel } from "./device";

export const feedbackAddress = "hello@makework.dev";

const [draft, setDraft] = createSignal<{ report: string } | null>(null);
export const feedbackDraft = draft;

export function openFeedback(report = ""): void {
  setDraft({ report });
}

export function closeFeedback(): void {
  setDraft(null);
}

export function systemLabel(): string {
  return `${deviceLabel()} · ${desktop ? "desktop app" : "web"}`;
}
