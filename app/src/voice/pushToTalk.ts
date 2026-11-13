// Push to talk: how the microphone sends while a key is held, and the keys that can be chosen for it. Pure, so the
// matching and labels are tested in node; the signals and storage are in micSettings.ts and the key listeners in
// state.ts.

export type InputMode = "voice" | "push-to-talk";

export const isPushToTalk = (mode: InputMode): boolean => mode === "push-to-talk";

export interface PttKey {
  // KeyboardEvent.code: the physical key, whatever the layout types with it.
  code: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface PttEvent {
  code: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

export const defaultPttKey: PttKey = { code: "F8", ctrl: false, alt: false, shift: false, meta: false };

// How long the microphone stays on after the key is released, so the last syllable isn't cut.
export const pttReleaseMs = 200;

// Presses that are only a modifier (or a lock) don't make a binding.
const modifierCodes = new Set([
  "ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight",
  "CapsLock", "NumLock", "ScrollLock", "Dead",
]);

const namedCodes: Record<string, string> = {
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "Page Up",
  PageDown: "Page Down",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  NumpadAdd: "Num +",
  NumpadSubtract: "Num -",
  NumpadMultiply: "Num *",
  NumpadDivide: "Num /",
  NumpadEnter: "Num Enter",
  NumpadDecimal: "Num .",
};

function codeLabel(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `Num ${code.slice(6)}`;
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  return namedCodes[code] ?? code;
}

// "Ctrl+Shift+F8": what the settings row shows.
export function pttKeyLabel(key: PttKey): string {
  const parts: string[] = [];
  if (key.ctrl) parts.push("Ctrl");
  if (key.alt) parts.push("Alt");
  if (key.shift) parts.push("Shift");
  if (key.meta) parts.push("Meta");
  parts.push(codeLabel(key.code));
  return parts.join("+");
}

// The next binding from a key press; null while only a modifier is down.
export function pttKeyFromEvent(event: PttEvent): PttKey | null {
  if (!event.code || modifierCodes.has(event.code)) return null;
  return {
    code: event.code,
    ctrl: event.ctrlKey === true,
    alt: event.altKey === true,
    shift: event.shiftKey === true,
    meta: event.metaKey === true,
  };
}

// Exact match, so an extra modifier doesn't start sending by accident.
export function matchesPttKey(event: PttEvent, key: PttKey): boolean {
  return event.code === key.code
    && (event.ctrlKey === true) === key.ctrl
    && (event.altKey === true) === key.alt
    && (event.shiftKey === true) === key.shift
    && (event.metaKey === true) === key.meta;
}

// Whether the microphone's track is on: voice activation sends whenever the member isn't muted; push to talk sends
// only while the key is held (or its release tail is running).
export interface MicSendState {
  mode: InputMode;
  muted: boolean;
  deafened: boolean;
  talking: boolean;
}

export function micTransmits(state: MicSendState): boolean {
  return !state.muted && !state.deafened && (state.mode === "voice" || state.talking);
}
