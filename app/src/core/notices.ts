// Short notices shown in the corner until dismissed, for things that happened without the user doing them
// (e.g. being removed from a workspace).
import { createSignal } from "solid-js";

export interface NoticeAction {
  label: string;
  run(): void;
}

export interface Notice {
  id: number;
  title: string;
  text: string;
  // Buttons that answer it (each dismisses it); just OK without.
  actions?: NoticeAction[];
}

const [notices, setNotices] = createSignal<Notice[]>([]);
export { notices };
let next = 1;

export function showNotice(title: string, text: string, actions?: NoticeAction[]): void {
  if (notices().some((notice) => notice.title === title && notice.text === text)) return;
  setNotices([...notices(), { id: next++, title, text, actions }]);
}

export interface Toast {
  id: number;
  text: string;
  action?: NoticeAction;
}

const toastMs = 3500;
const [toasts, setToasts] = createSignal<Toast[]>([]);
export { toasts };

// A short note that goes away by itself, for what the user just did (Saved, Copied), with an optional action (Undo).
export function showToast(text: string, options: { action?: NoticeAction; ms?: number } = {}): void {
  const id = next++;
  setToasts([...toasts().filter((t) => t.text !== text), { id, text, action: options.action }]);
  setTimeout(() => dismissToast(id), options.ms ?? toastMs);
}

export function dismissToast(id: number): void {
  setToasts(toasts().filter((t) => t.id !== id));
}

export function dismissNotice(id: number): void {
  setNotices(notices().filter((n) => n.id !== id));
}
