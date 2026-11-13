// A view for any workspace plugin without a UI, built from its describe output: its tables as
// grids (with an add form when it offers insert) and a form for each of its own functions.
import { For, Show, createSignal, onCleanup } from "solid-js";
import { ApiRequestError, userMessage, type PluginClient } from "../api/client";
import type { ApiValue, ArgInfo, ColumnType, PluginInfo, FunctionInfo, Row, TableInfo } from "../api/types";
import { createQuiet } from "./quiet";
import "./GenericView.css";

const dataFunctions = new Set(["read", "insert", "update"]);

export default function GenericView(props: { ext: PluginClient; info: PluginInfo }) {
  const has = (name: string) => props.info.functions.some((f) => f.name === name);
  const functions = () => props.info.functions.filter((f) => !dataFunctions.has(f.name));

  return (
    <div class="generic-view mw-fade-in">
      <header>
        <h2>{props.info.name} <span class="muted">{props.info.version}</span></h2>
        <p class="muted">{props.info.description}</p>
      </header>
      <Show when={has("read")}>
        <For each={props.info.tables}>
          {(table) => <TableSection ext={props.ext} table={table} canInsert={has("insert")} />}
        </For>
      </Show>
      <Show when={functions().length > 0}>
        <h3>Functions</h3>
        <For each={functions()}>{(fn) => <FunctionForm ext={props.ext} fn={fn} />}</For>
      </Show>
    </div>
  );
}

function TableSection(props: { ext: PluginClient; table: TableInfo; canInsert: boolean }) {
  const quiet = createQuiet(() => props.ext.active?.() ?? true);
  const [rows, setRows] = createSignal<Row[]>();
  const [error, setError] = createSignal<unknown>();
  let latest = 0;
  // Quiet while hidden, like plugins/live.ts: a generic view can even mount hidden (its describe answer or the
  // workspace's connect can come late), so the mount itself only asks; the load runs when the view shows.
  const load = async () => {
    const request = ++latest;
    try {
      const value = await props.ext.read(props.table.name);
      if (request !== latest) return;
      setRows(value);
      setError(undefined);
    } catch (e) {
      if (request === latest) setError(e);
    }
  };
  quiet.run(() => void load());
  onCleanup(props.ext.onEvent((event) => {
    if (event.table !== props.table.name) return;
    quiet.run(() => void load());
  }));
  const writable = () => props.table.columns.filter((c) => c.writable).map((c) => ({
    name: c.name, type: c.type, jsonType: c.jsonType, required: false, description: "",
  }));

  return (
    <section class="generic-section mw-box">
      <h3>{props.table.name}</h3>
      <Show when={!error()} fallback={<p class="warning">{userMessage(error())}</p>}>
        <div class="generic-table-wrap">
          <table class="generic-table">
            <thead>
              <tr><For each={props.table.columns}>{(c) => <th title={c.type}>{c.name}</th>}</For></tr>
            </thead>
            <tbody>
              <For each={rows() ?? []} fallback={<tr><td class="muted" colSpan={props.table.columns.length}>No rows</td></tr>}>
                {(row) => <tr><For each={props.table.columns}>{(c) => <td>{format(row[c.name])}</td>}</For></tr>}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
      <Show when={props.canInsert}>
        <ArgsForm args={writable()} submitLabel="Add row"
          run={(values) => props.ext.insert(props.table.name, values).then((id) => `Added row ${id}`)} />
      </Show>
    </section>
  );
}

function FunctionForm(props: { ext: PluginClient; fn: FunctionInfo }) {
  return (
    <section class="generic-section mw-box">
      <h3>{props.fn.name}</h3>
      <p class="muted">{props.fn.description}</p>
      <ArgsForm args={props.fn.args} submitLabel="Run"
        run={(args) => props.ext.call(props.fn.name, args).then((data) => JSON.stringify(data, null, 2))} />
    </section>
  );
}

function ArgsForm(props: { args: ArgInfo[]; submitLabel: string; run: (values: Record<string, ApiValue>) => Promise<string> }) {
  const [values, setValues] = createSignal<Record<string, ApiValue>>({});
  const [result, setResult] = createSignal<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = createSignal(false);

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      setResult({ ok: true, text: await props.run(values()) });
    } catch (e) {
      setResult({ ok: false, text: e instanceof ApiRequestError ? `${e.code}: ${e.message}` : userMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const set = (name: string, value: ApiValue) =>
    setValues((all) => {
      const next = { ...all };
      if (value === null) delete next[name];
      else next[name] = value;
      return next;
    });

  return (
    <form class="generic-form" onSubmit={submit}>
      <For each={props.args}>
        {(arg) => (
          <label class="generic-field" title={arg.description}>
            <span>{arg.name}{arg.required ? " *" : ""} <span class="muted">{arg.type}</span></span>
            <ArgInput type={arg.type} required={arg.required} onChange={(v) => set(arg.name, v)} />
          </label>
        )}
      </For>
      <button type="submit" class="mw-button primary mw-box" disabled={busy()}>{props.submitLabel}</button>
      <Show when={result()}>
        {(r) => <pre class="generic-result mw-box" classList={{ warning: !r().ok }}>{r().text}</pre>}
      </Show>
    </form>
  );
}

function ArgInput(props: { type: ColumnType; required: boolean; onChange: (value: ApiValue) => void }) {
  switch (props.type) {
    case "bool":
      return <input type="checkbox" onChange={(e) => props.onChange(e.currentTarget.checked)} />;
    case "int":
    case "bigint":
    case "decimal":
      return (
        <input class="mw-input mw-box" type="number" step={props.type === "decimal" ? "any" : "1"} required={props.required}
          onInput={(e) => props.onChange(e.currentTarget.value === "" ? null : Number(e.currentTarget.value))} />
      );
    case "timestamp":
      return (
        <input class="mw-input mw-box" type="datetime-local" required={props.required}
          onInput={(e) => props.onChange(e.currentTarget.value ? new Date(e.currentTarget.value).toISOString() : null)} />
      );
    default:
      return (
        <input class="mw-input mw-box" required={props.required}
          onInput={(e) => props.onChange(e.currentTarget.value === "" ? null : e.currentTarget.value)} />
      );
  }
}

function format(value: ApiValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T[\d:]+Z$/.test(value)) return new Date(value).toLocaleString();
  return String(value);
}
