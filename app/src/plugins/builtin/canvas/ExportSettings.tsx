import { Index, Show, createSignal } from "solid-js";
import { Icon } from "../../../theme/icons";
import Select from "../../../ui/Select";
import { exportFormats, exportScales, type ExportFormat, type ExportSetting } from "./export";

// The setting the add button makes: the next size up, in the last format.
export function nextExport(list: ExportSetting[]): ExportSetting {
  const last = list.at(-1);
  const scale = last ? exportScales.find((v) => v > last.scale) ?? last.scale : 1;
  return { scale, format: last?.format ?? "png", suffix: "" };
}

// One row per file to make: size, format, name suffix and remove.
export function ExportRows(props: { list: ExportSetting[]; disabled?: boolean; onChange: (list: ExportSetting[], label: string) => void }) {
  return (
    <Index each={props.list}>
      {(x, i) => {
        const edit = (part: Partial<ExportSetting>, label: string) =>
          props.onChange(props.list.map((e, j) => (j === i ? { ...e, ...part } : e)), label);
        return (
          <div class="canvas-export">
            <Select label="Size" value={x().scale} disabled={props.disabled}
              options={exportScales.map((v) => ({ value: v, label: `${v}x` }))} onChange={(scale) => edit({ scale }, "Export size")} />
            <Select<ExportFormat> label="Format" value={x().format} disabled={props.disabled}
              options={exportFormats} onChange={(format) => edit({ format }, "Export format")} />
            <input class="canvas-export-suffix" aria-label="Name suffix" placeholder="Suffix" value={x().suffix}
              disabled={props.disabled} onChange={(e) => edit({ suffix: e.currentTarget.value.trim() }, "Export suffix")}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
            <button class="icon-button" title="Remove export" aria-label="Remove export" disabled={props.disabled}
              onClick={() => props.onChange(props.list.filter((_, j) => j !== i), "Remove export")}>
              <Icon name="remove" />
            </button>
          </div>
        );
      }}
    </Index>
  );
}

export function ExportButton(props: { label: string; show: boolean; onExport: () => Promise<unknown> }) {
  const [exporting, setExporting] = createSignal(false);
  return (
    <Show when={props.show}>
      <button class="mw-button mw-box canvas-export-button" disabled={exporting()}
        onClick={async () => {
          setExporting(true);
          try {
            await props.onExport();
          } finally {
            setExporting(false);
          }
        }}>
        <Icon name="download" /> {exporting() ? "Exporting..." : props.label}
      </button>
    </Show>
  );
}
