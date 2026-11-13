// Terminals of code channels (desktop): a shell, or a Run's command, in the channel's run folder. They live here,
// not in the view, so a running program keeps going (and keeps its output) while the member is elsewhere. A terminal
// can be popped out into a terminal window (TerminalWindow.tsx); its tab stays here, marked away, until it returns.
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { desktop, desktopError, type TerminalState } from "../../../core/desktop";
import { openContextMenu } from "../../../ui/contextMenu";
import { themeColors } from "./editor";
import { copyToClipboard } from "../../../ui/clipboard";

export interface CodeTerminal {
  key: number;
  title: string;
  command: string | null;
  running: boolean;
  exitCode: number | null;
  // In its own terminal window.
  away: boolean;
}

export interface Screen {
  term: Terminal;
  fit: FitAddon;
  element: HTMLDivElement;
}

interface Live extends Screen {
  opened: boolean;
  process: number | null;
  options: { workspaceId: string; channelId: number; shell?: string };
}

// By place (`workspace:channel`).
const [terminals, setTerminals] = createStore<Record<string, CodeTerminal[]>>({});
const [activeKeys, setActiveKeys] = createStore<Record<string, number | null>>({});
export { terminals };
export const activeTerminal = (place: string) => activeKeys[place] ?? null;
export const setActiveTerminal = (place: string, key: number | null) => setActiveKeys(place, key);
const [shown, setShown] = createSignal<Record<string, boolean>>({});
export const panelShown = (place: string) => shown()[place] === true;
export const showPanel = (place: string, on: boolean) => setShown({ ...shown(), [place]: on });

const live = new Map<number, Live>();
const byProcess = new Map<number, { place: string; key: number }>();
let nextKey = 1;
let listening = false;

export const exitLine = (code: number) => `\r\n\x1b[2m[Exited with code ${code}]\x1b[0m\r\n`;
export const commandLine = (command: string) => `\x1b[2m$ ${command.replaceAll("\n", "\r\n")}\x1b[0m\r\n`;

function listen() {
  if (listening || !desktop?.code) return;
  listening = true;
  watchTheme();
  desktop.code.onTerminal((process, event) => {
    if (event.returned) return void returned(process, event.returned);
    const owner = byProcess.get(process);
    const entry = owner && live.get(owner.key);
    if (!owner || !entry) return;
    if (event.data !== undefined) entry.term.write(event.data);
    if (event.exit !== undefined) {
      entry.term.write(exitLine(event.exit));
      update(owner.place, owner.key, { running: false, exitCode: event.exit });
    }
  });
}

const update = (place: string, key: number, changes: Partial<CodeTerminal>) => setTerminals(place, (t) => t.key === key, changes);

function xtermTheme() {
  const c = themeColors();
  return { background: c.background, foreground: c.text, cursor: c.accent, selectionBackground: `${c.accent}55`, brightBlack: c.muted };
}

// Every screen of this page follows the theme.
const screens = new Set<Terminal>();
let watchingTheme = false;
function watchTheme() {
  if (watchingTheme) return;
  watchingTheme = true;
  new MutationObserver(() => {
    for (const term of screens) term.options.theme = xtermTheme();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme", "class"] });
}

// A terminal screen: xterm in the theme's code font and colors, with copy and paste keys and a right-click menu.
// Typing and size changes go to whatever process `processOf` names at the time.
export async function createScreen(processOf: () => number | null): Promise<Screen> {
  watchTheme();
  const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/xterm/css/xterm.css")]);
  const term = new Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mw-font-code") || "monospace",
    fontSize: 13, cursorBlink: true, scrollback: 5000, theme: xtermTheme(), allowProposedApi: false,
  });
  screens.add(term);
  const fit = new FitAddon();
  term.loadAddon(fit);
  const element = document.createElement("div");
  element.className = "code-terminal-screen";
  term.onData((data) => {
    const process = processOf();
    if (process != null) desktop!.code!.writeTerminal(process, data);
  });
  term.attachCustomKeyEventHandler((event) => clipboardKey(term, event));
  element.addEventListener("contextmenu", (event) => terminalMenu(term, event));
  term.onResize(({ cols, rows }) => {
    const process = processOf();
    if (process != null) desktop!.code!.resizeTerminal(process, cols, rows);
  });
  return { term, fit, element };
}

export function disposeScreen(term: Terminal) {
  screens.delete(term);
  term.dispose();
}

// Shows a terminal's state as another page left it: its last output, and how it ended if it did.
export function fillScreen(term: Terminal, state: TerminalState) {
  term.reset();
  term.write(state.backlog);
  if (!state.running && state.exitCode !== null) term.write(exitLine(state.exitCode));
}

async function addTerminal(place: string, options: Live["options"], title: string, command: string | null): Promise<number> {
  listen();
  const key = nextKey++;
  const screen = await createScreen(() => live.get(key)?.process ?? null);
  live.set(key, { ...screen, opened: false, process: null, options });
  setTerminals(place, (list = []) => [...list, { key, title, command, running: false, exitCode: null, away: false }]);
  setActiveTerminal(place, key);
  showPanel(place, true);
  return key;
}

// Opens a terminal tab; with a command it runs that command (a Run), else an interactive shell.
export async function openTerminal(place: string, options: Live["options"], title: string, command: string | null): Promise<number> {
  const key = await addTerminal(place, options, title, command);
  const entry = live.get(key)!;
  if (command) entry.term.write(commandLine(command));
  const process = await desktop!.code!.startTerminal({ ...options, title, command: command ?? undefined, cols: entry.term.cols, rows: entry.term.rows });
  entry.process = process;
  byProcess.set(process, { place, key });
  // The screen may have been fitted while the shell was starting; a shell wider or narrower than the screen
  // misplaces the cursor once a line wraps.
  desktop!.code!.resizeTerminal(process, entry.term.cols, entry.term.rows);
  update(place, key, { running: true, exitCode: null });
  return key;
}

// A popped-out terminal came back: its tab shows it again as it is now. One this page doesn't know (the page was
// reloaded while the terminal was away) gets a tab in its channel's panel.
async function returned(process: number, state: TerminalState) {
  let owner = byProcess.get(process);
  if (!owner) {
    const place = `${state.workspaceId}:${state.channelId}`;
    const key = await addTerminal(place, { workspaceId: state.workspaceId, channelId: state.channelId }, state.title, state.command);
    live.get(key)!.process = process;
    owner = { place, key };
    byProcess.set(process, owner);
  }
  const entry = live.get(owner.key);
  if (!entry) return;
  fillScreen(entry.term, state);
  update(owner.place, owner.key, { away: false, running: state.running, exitCode: state.exitCode });
  setActiveTerminal(owner.place, owner.key);
  showPanel(owner.place, true);
  desktop!.code!.resizeTerminal(process, entry.term.cols, entry.term.rows);
}

// Pops the terminal out into its own window (at a screen point, else the cursor); one already out comes forward.
export async function popOut(place: string, key: number, at?: { x: number; y: number }) {
  const process = live.get(key)?.process;
  if (process == null) return;
  await desktop!.code!.popOutTerminal(process, at);
  update(place, key, { away: true });
}

// Brings a popped-out terminal back into the panel (its window closes).
export function moveBack(key: number) {
  const process = live.get(key)?.process;
  if (process != null) desktop!.code!.returnTerminal(process);
}

const copySelection = (term: Terminal) => {
  const text = term.getSelection();
  if (text) void copyToClipboard(text);
};
const pasteClipboard = (term: Terminal) => void navigator.clipboard.readText().then((text) => text && term.paste(text), () => {});

// Ctrl+Shift+C and V (Cmd+C and V on macOS) copy and paste; Ctrl+C with a selection copies instead of interrupting.
function clipboardKey(term: Terminal, event: KeyboardEvent) {
  if (event.type !== "keydown") return true;
  const key = event.key.toLowerCase();
  const command = event.metaKey || (event.ctrlKey && event.shiftKey);
  if ((command || (event.ctrlKey && term.hasSelection())) && key === "c") {
    event.preventDefault();
    copySelection(term);
    term.clearSelection();
    return false;
  }
  if (command && key === "v") {
    event.preventDefault();
    pasteClipboard(term);
    return false;
  }
  return true;
}

function terminalMenu(term: Terminal, event: MouseEvent) {
  openContextMenu(event, [
    { label: "Copy", icon: "copy", disabled: !term.hasSelection(), action: () => copySelection(term) },
    { label: "Paste", action: () => pasteClipboard(term) },
    "separator",
    { label: "Select all", action: () => term.selectAll() },
    { label: "Clear", action: () => term.clear() },
  ]);
}

// Runs a Run tab's command again in the same tab.
export async function rerun(place: string, key: number) {
  const entry = live.get(key);
  const item = terminals[place]?.find((t) => t.key === key);
  if (entry?.process == null || !item?.command) return;
  entry.term.reset();
  entry.term.write(commandLine(item.command));
  try {
    await desktop!.code!.restartTerminal(entry.process);
    update(place, key, { running: true, exitCode: null });
  } catch (e) {
    entry.term.write(`\x1b[31m${desktopError(e).message}\x1b[0m\r\n`);
    update(place, key, { running: false });
  }
}

export function stopTerminal(key: number) {
  const process = live.get(key)?.process;
  if (process != null) desktop!.code!.killTerminal(process);
}

// Ends the terminal (and closes its window if it is out) and removes its tab.
export function closeTerminal(place: string, key: number) {
  const entry = live.get(key);
  if (entry?.process != null) {
    desktop!.code!.closeTerminal(entry.process);
    byProcess.delete(entry.process);
  }
  if (entry) disposeScreen(entry.term);
  live.delete(key);
  const rest = (terminals[place] ?? []).filter((t) => t.key !== key);
  setTerminals(place, rest);
  if (activeTerminal(place) === key) setActiveTerminal(place, rest.at(-1)?.key ?? null);
  if (!rest.length) showPanel(place, false);
}

// Puts a terminal's screen into the panel's host (opened there the first time) and fits it to the host's size.
export function attach(key: number, host: HTMLElement) {
  const entry = live.get(key);
  if (!entry) return;
  if (entry.element.parentElement !== host) host.replaceChildren(entry.element);
  if (!entry.opened) {
    entry.term.open(entry.element);
    entry.opened = true;
  }
  fitTerminal(key);
  entry.term.focus();
}

export function fitTerminal(key: number) {
  const entry = live.get(key);
  if (!entry?.opened || !entry.element.isConnected) return;
  try {
    entry.fit.fit();
  } catch {
    // Not laid out yet.
  }
}
