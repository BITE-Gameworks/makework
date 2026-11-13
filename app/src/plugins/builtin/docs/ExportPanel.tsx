import { For, Show, createEffect, createSignal } from "solid-js";
import { Icon } from "../../../theme/icons";
import Collapse from "../../../ui/Collapse";
import type { DocPage } from "./data";

// The side panel that exports pages: the tree with a checkbox per page. Ticking a page ticks its sub-pages too.
export default function ExportPanel(props: {
  rows: () => { page: DocPage; depth: number }[];
  descendants: (id: number) => number[];
  initial: number[];
  onExport: (ids: Set<number>) => Promise<string>;
}) {
  const [selected, setSelected] = createSignal(new Set(props.initial));
  const [busy, setBusy] = createSignal(false);
  const [note, setNote] = createSignal("");
  // Pages deleted since they were ticked don't count.
  const chosen = () => new Set(props.rows().map((r) => r.page.id).filter((id) => selected().has(id)));
  const toggle = (id: number) => {
    const on = !selected().has(id);
    const next = new Set(selected());
    for (const x of [id, ...props.descendants(id)]) on ? next.add(x) : next.delete(x);
    setSelected(next);
  };
  const partly = (id: number) => !selected().has(id) && props.descendants(id).some((x) => selected().has(x));
  const run = async () => {
    setBusy(true);
    try {
      setNote(await props.onExport(chosen()));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="docs-export">
      <div class="docs-export-tools">
        <button class="mw-button mw-box" onClick={() => setSelected(new Set(props.rows().map((r) => r.page.id)))}>All</button>
        <button class="mw-button mw-box" onClick={() => setSelected(new Set<number>())}>None</button>
      </div>
      <ul class="docs-export-list mw-scroll-fade" aria-label="Pages to export">
        <For each={props.rows()} fallback={<li class="docs-hint">No pages yet.</li>}>
          {(row) => (
            <li style={{ "--depth": row.depth }}>
              <label>
                <input type="checkbox" checked={selected().has(row.page.id)} onChange={() => toggle(row.page.id)}
                  ref={(el) => createEffect(() => (el.indeterminate = partly(row.page.id)))} />
                <Icon name="docs-page" size={14} />
                <span>{row.page.title}</span>
              </label>
            </li>
          )}
        </For>
      </ul>
      <Collapse open={!!note()}><p class="view-note">{note()}</p></Collapse>
      <button class="mw-button primary mw-box" disabled={busy() || chosen().size === 0} onClick={() => void run()}>
        <Show when={busy()} fallback={<Icon name="download" />}><span class="mw-spinner" /></Show>
        {chosen().size === 1 ? "Export 1 page" : `Export ${chosen().size} pages`}
      </button>
    </div>
  );
}
