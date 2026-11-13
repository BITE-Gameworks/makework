// Search icons on Iconify (iconify.ts: Lucide, Phosphor, Material Symbols, game-icons and many more sets) and add
// them to the design: click adds one, dragging puts it where it is dropped. The licenses of the sets in the results
// are listed under them.
import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import { Icon } from "../../../theme/icons";
import Select from "../../../ui/Select";
import Skeleton from "../../../ui/Skeleton";
import { loadIcons, searchIcons, type IconSet } from "./iconify";
import { focusWhenShown } from "../../../ui/focus";

export const iconDragType = "application/x-makework-icon";

const sets = [
  { value: "", label: "All icon sets" },
  { value: "lucide", label: "Lucide" },
  { value: "ph", label: "Phosphor" },
  { value: "material-symbols", label: "Material Symbols" },
  { value: "tabler", label: "Tabler" },
  { value: "mdi", label: "Material Design" },
  { value: "game-icons", label: "Game icons" },
  { value: "fluent-emoji-flat", label: "Fluent emoji" },
  { value: "logos", label: "Logos" },
];

// Full-color sets show as they are; the rest take the theme's text color.
export const coloredIcon = (name: string) => /^(logos|fluent-emoji|noto|twemoji|flat-color-icons|skill-icons|vscode-icons)/.test(name);
const dataUrl = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

export default function IconSearch(props: { onInsert: (name: string) => void; canEdit: boolean }) {
  const [query, setQuery] = createSignal("");
  const [set, setSet] = createSignal("");
  const [results, setResults] = createSignal<{ name: string; svg: string }[]>([]);
  const [licenses, setLicenses] = createSignal<Record<string, IconSet>>({});
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  let latest = 0;

  createEffect(on([query, set], ([q, prefix]) => {
    const text = q.trim();
    if (!text) {
      latest++;
      setResults([]);
      setBusy(false);
      setError("");
      return;
    }
    const request = ++latest;
    const timer = setTimeout(async () => {
      setBusy(true);
      try {
        const found = await searchIcons(text, prefix, 96);
        const svgs = await loadIcons(found.icons);
        if (request !== latest) return;
        setResults(found.icons.filter((name) => svgs.has(name)).map((name) => ({ name, svg: svgs.get(name)! })));
        setLicenses(found.sets);
        setError("");
      } catch {
        if (request === latest) setError("Icons couldn't be searched. Check the connection, or wait a moment and try again.");
      } finally {
        if (request === latest) setBusy(false);
      }
    }, 350);
    onCleanup(() => clearTimeout(timer));
  }));

  // The sets in the results, with their licenses.
  const shownSets = () => {
    const ids = new Set(results().map((r) => r.name.split(":")[0]));
    return [...ids].map((id) => ({ id, ...(licenses()[id] ?? { name: id, license: "See iconify.design", licenseUrl: `https://icon-sets.iconify.design/${id}/` }) }));
  };

  return (
    <div class="design-icons">
      <label class="channel-search mw-box">
        <input placeholder="Search icons..." value={query()} aria-label="Search icons"
          ref={focusWhenShown}
          onInput={(e) => setQuery(e.currentTarget.value)} onKeyDown={(e) => e.key === "Escape" && setQuery("")} />
        <Icon name="search" />
      </label>
      <Select label="Icon set" value={set()} options={sets} onChange={setSet} />
      <Show when={!props.canEdit}><p class="hint">You need the "Edit content" permission to add icons.</p></Show>
      <Show when={error()}><p class="warning">{error()}</p></Show>
      <Show when={!busy() || results().length > 0} fallback={<Skeleton kind="grid" header={false} />}>
        <Show when={results().length > 0} fallback={
          <p class="hint">{query().trim() ? (busy() || error() ? "" : "No icons found.") : "Type what you're looking for: arrow, tree, sword, cloud..."}</p>
        }>
          <div class="design-icon-grid mw-scroll-fade">
            <For each={results()}>
              {(icon) => (
                <button class="design-icon-result mw-box" title={icon.name} aria-label={`Add ${icon.name}`} disabled={!props.canEdit}
                  draggable={props.canEdit} onClick={() => props.onInsert(icon.name)}
                  onDragStart={(e) => {
                    e.dataTransfer?.setData(iconDragType, icon.name);
                    if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
                  }}>
                  <Show when={coloredIcon(icon.name)} fallback={<span class="design-icon-mask" style={{ "--icon": dataUrl(icon.svg) }} />}>
                    <span class="design-icon-image" style={{ "background-image": dataUrl(icon.svg) }} />
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
      </Show>
      <div class="design-icon-licenses">
        <Show when={shownSets().length > 0}>
          <p class="hint">Licenses of these icons:</p>
          <ul>
            <For each={shownSets()}>
              {(s) => <li><span>{s.name}</span> <a href={s.licenseUrl} target="_blank" rel="noreferrer">{s.license}</a></li>}
            </For>
          </ul>
        </Show>
        <p class="hint">Searches come from iconify.design.</p>
      </div>
    </div>
  );
}
