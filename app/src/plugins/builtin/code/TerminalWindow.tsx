// A terminal window: one code channel terminal popped out of its panel (desktop). It opens no workspace and needs no
// sign-in; it takes the running terminal over from the main process and shows it until it is moved back or the window
// is closed, which both return it to its panel (electron/codeTools.js).
import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { userMessage } from "../../../api/client";
import { desktop, desktopError, type TerminalState } from "../../../core/desktop";
import WindowControls, { hasWindowControls } from "../../../shell/WindowControls";
import { Icon } from "../../../theme/icons";
import ContextMenu from "../../../ui/ContextMenuHost";
import { commandLine, createScreen, disposeScreen, exitLine, fillScreen, type Screen } from "./terminals";
import "./code.css";

export default function TerminalWindow(props: { id: number }) {
  const code = desktop!.code!;
  const [state, setState] = createSignal<TerminalState | null>(null);
  const [error, setError] = createSignal("");
  let host!: HTMLDivElement;
  let screen: Screen | undefined;

  const fit = () => {
    try {
      screen?.fit.fit();
    } catch {
      // Not laid out yet.
    }
  };
  const resize = new ResizeObserver(fit);
  const stop = code.onTerminal((id, event) => {
    if (id !== props.id || !screen) return;
    if (event.data !== undefined) screen.term.write(event.data);
    if (event.exit !== undefined) {
      screen.term.write(exitLine(event.exit));
      setState((s) => s && { ...s, running: false, exitCode: event.exit! });
    }
  });
  onMount(async () => {
    try {
      screen = await createScreen(() => props.id);
      const taken = await code.adoptTerminal(props.id);
      document.title = taken.title;
      setState(taken);
      host.replaceChildren(screen.element);
      screen.term.open(screen.element);
      fillScreen(screen.term, taken);
      fit();
      code.resizeTerminal(props.id, screen.term.cols, screen.term.rows);
      screen.term.focus();
      resize.observe(host);
    } catch (e) {
      setError(userMessage(desktopError(e)));
    }
  });
  onCleanup(() => {
    stop();
    resize.disconnect();
    if (screen) disposeScreen(screen.term);
  });

  const runAgain = async () => {
    const command = state()?.command;
    if (!screen || !command) return;
    screen.term.reset();
    screen.term.write(commandLine(command));
    try {
      await code.restartTerminal(props.id);
      setState((s) => s && { ...s, running: true, exitCode: null });
    } catch (e) {
      screen.term.write(`\x1b[31m${desktopError(e).message}\x1b[0m\r\n`);
      setState((s) => s && { ...s, running: false });
    }
  };

  return (
    <div class="code-terminal-window" classList={{ "has-window-controls": hasWindowControls }}>
      <div class="code-terminal-bar" data-drag-region>
        <Icon name={state()?.command ? "play" : "terminal"} size={14} />
        <span class="code-terminal-window-title" data-drag-region>{state()?.title ?? "Terminal"}</span>
        <Show when={!state()?.running && state()?.exitCode != null}>
          <span class={state()!.exitCode === 0 ? "code-exit ok" : "code-exit failed"}>{state()!.exitCode}</span>
        </Show>
        <Show when={state()?.command}>
          <Show when={state()?.running} fallback={
            <button class="icon-button" title="Run again" aria-label="Run again" onClick={() => void runAgain()}><Icon name="refresh" /></button>
          }>
            <button class="icon-button" title="Stop" aria-label="Stop" onClick={() => code.killTerminal(props.id)}><Icon name="stop" /></button>
          </Show>
        </Show>
        <Show when={state()}>
          <button class="icon-button" title="Move back to its panel" aria-label="Move back" onClick={() => code.returnTerminal(props.id)}><Icon name="window-new" /></button>
        </Show>
      </div>
      <Show when={error()}><p class="code-note">{error()}</p></Show>
      <div class="code-terminal-host" ref={host} />
      <ContextMenu />
      <WindowControls />
    </div>
  );
}
