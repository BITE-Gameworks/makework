// The terminal panel under the editor: a tab per terminal or Run, the active one's screen, and its height. A tab can
// be popped out into a terminal window (the bar's button, its right-click menu, or dragged out of the window); while
// it is out, the panel says so in its place.
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { canPopOutWindows } from "../../../core/popout";
import { Icon } from "../../../theme/icons";
import { openContextMenu } from "../../../ui/contextMenu";
import ResizeHandle from "../../../ui/ResizeHandle";
import { newWindowEntry } from "../../../shell/windowMenu";
import { saveTerminalHeight, setTerminalHeight, terminalHeight } from "./panels";
import TabClose from "./TabClose";
import { activeTerminal, attach, closeTerminal, fitTerminal, moveBack, popOut, rerun, setActiveTerminal, stopTerminal, terminals, type CodeTerminal } from "./terminals";

// How far a pressed tab moves before it is being dragged rather than clicked.
const dragStart = 6;

export default function TerminalPanel(props: { place: string; onNew: () => void }) {
  let host!: HTMLDivElement;
  const list = () => terminals[props.place] ?? [];
  const active = () => list().find((t) => t.key === activeTerminal(props.place));
  createEffect(() => {
    const key = activeTerminal(props.place);
    if (key !== null && !active()?.away) requestAnimationFrame(() => attach(key, host));
  });
  const resize = new ResizeObserver(() => {
    const key = activeTerminal(props.place);
    if (key !== null) fitTerminal(key);
  });
  onMount(() => resize.observe(host));
  onCleanup(() => resize.disconnect());

  const out = (t: CodeTerminal, at?: { x: number; y: number }) => void popOut(props.place, t.key, at);

  // A tab dragged out of the window becomes a terminal window where it was let go. The pointer is captured once the
  // drag starts, so its release is seen even outside the window.
  const [dragged, setDragged] = createSignal<number | null>(null);
  let press: { key: number; pointerId: number; x: number; y: number } | null = null;
  const onPointerDown = (t: CodeTerminal, e: PointerEvent) => {
    if (e.button !== 0 || !canPopOutWindows()) return;
    press = { key: t.key, pointerId: e.pointerId, x: e.screenX, y: e.screenY };
  };
  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerId !== press?.pointerId || dragged() !== null) return;
    if (Math.hypot(e.screenX - press.x, e.screenY - press.y) < dragStart) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragged(press.key);
  };
  const onPointerUp = (t: CodeTerminal, e: PointerEvent) => {
    const wasDragged = dragged() === t.key;
    press = null;
    setDragged(null);
    if (!wasDragged) return;
    const outside = e.clientX < 0 || e.clientY < 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight;
    if (outside && !t.away) out(t, { x: e.screenX, y: e.screenY });
  };
  const cancelDrag = () => {
    press = null;
    setDragged(null);
  };

  const tabMenu = (t: CodeTerminal, e: MouseEvent) => openContextMenu(e, [
    t.away
      ? { label: "Move back", icon: "window-new", action: () => moveBack(t.key) }
      : newWindowEntry("Open in new window", () => out(t)),
    "separator",
    { label: "Close", icon: "close", action: () => closeTerminal(props.place, t.key) },
  ]);

  return (
    <section class="code-terminal" style={{ height: terminalHeight() === null ? undefined : `${terminalHeight()}px` }}>
      <ResizeHandle edge="top" label="Resize terminal" setWidth={setTerminalHeight} save={saveTerminalHeight} />
      <div class="code-terminal-bar">
        <div class="code-tabs code-terminal-tabs mw-scroll-fade">
          <For each={list()}>{(t) =>
            <button classList={{ "code-tab": true, active: activeTerminal(props.place) === t.key, dragging: dragged() === t.key }}
              title={t.away ? `${t.title} (in its own window)` : t.title}
              onClick={() => setActiveTerminal(props.place, t.key)}
              onAuxClick={(event) => event.button === 1 && closeTerminal(props.place, t.key)}
              onContextMenu={(event) => tabMenu(t, event)}
              onPointerDown={(event) => onPointerDown(t, event)} onPointerMove={onPointerMove}
              onPointerUp={(event) => onPointerUp(t, event)} onPointerCancel={cancelDrag}>
              <Icon name={t.away ? "window-new" : t.command ? "play" : "terminal"} size={14} /><span>{t.title}</span>
              <Show when={!t.running && t.exitCode !== null}><span class={t.exitCode === 0 ? "code-exit ok" : "code-exit failed"}>{t.exitCode}</span></Show>
              <TabClose onClose={() => closeTerminal(props.place, t.key)}><Icon name="close" size={12} /></TabClose>
            </button>
          }</For>
        </div>
        <Show when={active()?.command && !active()?.away}>
          <Show when={active()?.running} fallback={
            <button class="icon-button" title="Run again" aria-label="Run again" onClick={() => void rerun(props.place, active()!.key)}><Icon name="refresh" /></button>
          }>
            <button class="icon-button" title="Stop" aria-label="Stop" onClick={() => stopTerminal(active()!.key)}><Icon name="stop" /></button>
          </Show>
        </Show>
        <Show when={canPopOutWindows() && active() && !active()!.away}>
          <button class="icon-button" title="Open in new window" aria-label="Open in new window" onClick={() => out(active()!)}><Icon name="window-new" /></button>
        </Show>
        <button class="icon-button" title="New terminal" aria-label="New terminal" onClick={props.onNew}><Icon name="add" /></button>
      </div>
      <div class="code-terminal-host" ref={host} classList={{ hidden: !!active()?.away }} />
      <Show when={active()?.away}>
        <div class="code-terminal-away mw-fade-in">
          <p class="code-hint">This terminal is in its own window.</p>
          <div class="code-run-actions">
            <button class="mw-button mw-box" onClick={() => out(active()!)}>Show window</button>
            <button class="mw-button mw-box" onClick={() => moveBack(active()!.key)}>Move back</button>
          </div>
        </div>
      </Show>
    </section>
  );
}
