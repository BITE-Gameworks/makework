import { For, Show, createSignal } from "solid-js";
import type { History } from "../core/history";
import { relativeTime } from "../core/time";
import { Icon } from "../theme/icons";
import Popover from "./Popover";
import "./HistoryControls.css";

// Undo, redo and the list of steps; clicking a step undoes or redoes everything up to it.
export default function HistoryControls(props: { history: History; onError: (e: unknown) => void }) {
  const h = () => props.history;
  const [open, setOpen] = createSignal(false);
  const last = () => h().entries()[h().position() - 1];
  const next = () => h().entries()[h().position()];
  const run = (action: Promise<void>) => void action.catch(props.onError);
  return (
    <>
      <button class="icon-button" title={last() ? `Undo ${last()!.label} (Ctrl+Z)` : "Nothing to undo"} aria-label="Undo"
        disabled={!h().canUndo() || h().busy()} onClick={() => run(h().undo())}>
        <Icon name="undo" />
      </button>
      <button class="icon-button" title={next() ? `Redo ${next()!.label} (Ctrl+Shift+Z)` : "Nothing to redo"} aria-label="Redo"
        disabled={!h().canRedo() || h().busy()} onClick={() => run(h().redo())}>
        <Icon name="redo" />
      </button>
      <div class="mw-popover-anchor">
        <button class="icon-button" title="History" aria-label="History" aria-expanded={open()} disabled={h().entries().length === 0}
          onClick={() => setOpen(!open())}>
          <Icon name="history" />
        </button>
        <Popover open={open()} onClose={() => setOpen(false)} label="History" placement="below" align="end">
          <ol class="mw-history mw-scroll-fade">
            <li classList={{ current: h().position() === 0 }}>
              <button disabled={h().busy()} onClick={() => run(h().goTo(0))}><Icon name="history" /> Start of session</button>
            </li>
            <For each={h().entries()}>
              {(entry, i) => (
                <li classList={{ current: h().position() === i() + 1, undone: i() >= h().position() }}>
                  <button disabled={h().busy()} onClick={() => run(h().goTo(i() + 1))} title={new Date(entry.at).toLocaleTimeString()}>
                    <Icon name={entry.icon ?? "history"} />
                    <span class="mw-history-label">{entry.label}</span>
                    <time>{relativeTime(new Date(entry.at).toISOString())}</time>
                  </button>
                </li>
              )}
            </For>
          </ol>
          <Show when={h().canRedo()}><p class="mw-history-note">Greyed steps are undone; doing something new drops them.</p></Show>
        </Popover>
      </div>
    </>
  );
}
