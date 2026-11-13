import { For, Index, Show, createSignal } from "solid-js";
import { Icon } from "../../../theme/icons";
import Popover from "../../../ui/Popover";
import type { Editor } from "./editor";
import { ColorField, NumberField, Section } from "./fields";

// The document's palettes and colors, shown when nothing is selected. Values are edited in the active palette.
export function PalettePanel(props: { editor: Editor }) {
  const ed = props.editor;
  const data = () => ed.palettes.value;
  const active = () => data().palettes.find((p) => p.id === ed.activePalette());
  const stored = () => ed.backgroundValue();
  const linked = () => (stored().startsWith("ref:") ? Number(stored().slice(4)) : null);
  const paletteDrag = listDrag("palette", () => data().palettes.map((p) => p.id), (id, before) => void ed.movePalette(id, before));
  const colorDrag = listDrag("color", () => data().colors.map((c) => c.id), (id, before) => void ed.moveColor(id, before));
  return (
    <>
      <Section title="Page">
        <div class="design-paint">
          <Show when={stored()} fallback={
            <button class="mw-button mw-box design-grow" title="The page follows the app theme. Click to pick a color."
              onClick={() => ed.setBackground("#1e1e1e")}>
              Theme background
            </button>
          }>
            <PaintColor editor={ed} color={ed.background() ?? "#1e1e1e"} colorRef={linked()}
              onPreview={(color) => ed.previewBackground(color)}
              onCommit={(color) => ed.setBackground(color)}
              onLink={(ref, color) => ed.setBackground(ref !== null ? `ref:${ref}` : color)} />
            <button class="icon-button" title="Use the app theme's background" aria-label="Use the theme's background"
              onClick={() => ed.setBackground("")}>
              <Icon name="remove" />
            </button>
          </Show>
        </div>
      </Section>
      <Section title="Palettes" actions={
        <button class="icon-button" title="New palette (a copy of the one shown)" aria-label="New palette"
          onClick={() => void ed.addPalette(`Palette ${data().palettes.length + 1}`)}>
          <Icon name="add" />
        </button>
      }>
        <Show when={active()} fallback={<p class="design-hint">Add colors below, then make palettes that give them other values.</p>}>
          <Index each={data().palettes}>
            {(palette, i) => (
              <div class="design-paint design-list-row" classList={{ "drop-above": paletteDrag.edge(palette().id) === "above", "drop-below": paletteDrag.edge(palette().id) === "below" }}
                onDragOver={(e) => paletteDrag.over(e, i)} onDrop={paletteDrag.drop}>
                <paletteDrag.Grip index={i} name={palette().name} />
                <button class="icon-button" classList={{ on: palette().id === ed.activePalette() }} title="Show this palette"
                  aria-label={`Show ${palette().name}`} aria-pressed={palette().id === ed.activePalette()}
                  onClick={() => ed.choosePalette(palette().id)}>
                  <Icon name={palette().id === ed.activePalette() ? "check" : "design-palette"} />
                </button>
                <input class="design-field-input design-grow" aria-label="Palette name" value={palette().name}
                  onChange={(e) => void ed.renamePalette(palette().id, e.currentTarget.value, palette().name)}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
                <button class="icon-button" title="Delete this palette" aria-label="Delete palette" disabled={data().palettes.length < 2}
                  onClick={() => void ed.removePalette(palette().id)}>
                  <Icon name="remove" />
                </button>
              </div>
            )}
          </Index>
        </Show>
      </Section>
      <Section title="Colors" actions={
        <button class="icon-button" title="New color" aria-label="New color"
          onClick={() => void ed.addColor(`Color ${data().colors.length + 1}`, "#808080")}>
          <Icon name="add" />
        </button>
      }>
        <Index each={data().colors}>
          {(color, i) => (
            <div class="design-paint design-list-row" classList={{ "drop-above": colorDrag.edge(color().id) === "above", "drop-below": colorDrag.edge(color().id) === "below" }}
              onDragOver={(e) => colorDrag.over(e, i)} onDrop={colorDrag.drop}>
              <colorDrag.Grip index={i} name={color().name} />
              <ColorField color={ed.colorValue(color().id) ?? "#000000"}
                onPreview={(value) => ed.previewColor(color().id, value)}
                onCommit={(value) => void ed.setColor(color().id, value)} />
              <input class="design-field-input design-color-label" aria-label="Color name" value={color().name}
                onChange={(e) => void ed.renameColor(color().id, e.currentTarget.value, color().name)}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
              <button class="icon-button" title="Delete color (layers keep its last value)" aria-label="Delete color"
                onClick={() => void ed.removeColor(color().id)}>
                <Icon name="remove" />
              </button>
            </div>
          )}
        </Index>
      </Section>
    </>
  );
}

// Rows put in a new place by dragging their grip, or with the arrow keys on it. `move` puts an id before another
// (null: last).
function listDrag(kind: string, ids: () => number[], move: (id: number, before: number | null) => void) {
  const type = `application/x-makework-${kind}`;
  const [target, setTarget] = createSignal<{ id: number; edge: "above" | "below"; before: number | null } | null>(null);
  let dragged: number | null = null;
  const end = () => {
    dragged = null;
    setTarget(null);
  };
  return {
    edge: (id: number) => (target()?.id === id ? target()!.edge : null),
    over: (e: DragEvent, index: number) => {
      if (dragged === null || !e.dataTransfer?.types.includes(type)) return;
      e.preventDefault();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const above = e.clientY < r.top + r.height / 2;
      const id = ids()[index];
      setTarget({ id, edge: above ? "above" : "below", before: above ? id : ids()[index + 1] ?? null });
    },
    drop: (e: DragEvent) => {
      const t = target();
      if (dragged !== null && t) {
        e.preventDefault();
        move(dragged, t.before);
      }
      end();
    },
    Grip: (p: { index: number; name: string }) => (
      <button class="design-grip" draggable={true} title="Drag to reorder (or arrow keys)" aria-label={`Move ${p.name}`}
        onDragStart={(e) => {
          dragged = ids()[p.index];
          e.dataTransfer!.effectAllowed = "move";
          e.dataTransfer!.setData(type, "");
          const row = e.currentTarget.parentElement;
          if (row) e.dataTransfer!.setDragImage(row, 8, row.offsetHeight / 2);
        }}
        onDragEnd={end}
        onKeyDown={(e) => {
          const list = ids();
          const i = p.index;
          if (e.key === "ArrowUp" && i > 0) move(list[i], list[i - 1]);
          else if (e.key === "ArrowDown" && i < list.length - 1) move(list[i], list[i + 2] ?? null);
          else return;
          e.preventDefault();
        }}>
        <Icon name="grip" size={12} />
      </button>
    ),
  };
}

// A paint's color: its own, or linked to a document color whose value follows the active palette.
export function PaintColor(props: {
  editor: Editor;
  color: string;
  colorRef?: number | null;
  opacity?: number;
  onPreview: (color: string, opacity: number) => void;
  onCommit: (color: string, opacity: number) => void;
  onLink: (ref: number | null, color: string) => void;
}) {
  const ed = props.editor;
  const [open, setOpen] = createSignal(false);
  const name = () => (props.colorRef != null ? ed.colorName(props.colorRef) : undefined);
  const shown = () => ed.resolve({ color: props.color, ref: props.colorRef });
  return (
    <>
      <Show when={name()} fallback={
        <ColorField color={props.color} opacity={props.opacity} onPreview={props.onPreview} onCommit={props.onCommit} />
      }>
        <div class="design-color linked">
          <span class="design-swatch mw-box" style={{ "--swatch": shown(), "--alpha": props.opacity ?? 1 }} />
          <span class="design-color-name" title="Follows the active palette">{name()}</span>
          <Show when={props.opacity !== undefined}>
            <NumberField label="%" title="Opacity (%)" value={props.opacity!} scale={100} decimals={0} min={0} max={1}
              onPreview={(v) => props.onPreview(props.color, v)} onCommit={(v) => props.onCommit(props.color, v)} />
          </Show>
        </div>
      </Show>
      <div class="mw-popover-anchor">
        <button class="icon-button" classList={{ on: !!name() || open() }} title="Use a document color" aria-label="Use a document color"
          aria-expanded={open()} onClick={() => setOpen(!open())}>
          <Icon name="design-palette" />
        </button>
        <Popover open={open()} onClose={() => setOpen(false)} label="Document colors" placement="below" align="end">
          <div class="design-color-menu">
            <For each={ed.palettes.value.colors} fallback={<p class="design-hint">No colors yet: add them under Colors with nothing selected.</p>}>
              {(c) => (
                <button class="mw-menu-item" classList={{ on: c.id === props.colorRef }} onClick={() => {
                  props.onLink(c.id, ed.colorValue(c.id) ?? props.color);
                  setOpen(false);
                }}>
                  <span class="design-swatch mw-box" style={{ "--swatch": ed.colorValue(c.id) ?? "#000000", "--alpha": 1 }} />
                  {c.name}
                </button>
              )}
            </For>
            <Show when={name()}>
              <button class="mw-menu-item" onClick={() => {
                props.onLink(null, shown());
                setOpen(false);
              }}>
                <Icon name="design-detach" /> Detach
              </button>
            </Show>
          </div>
        </Popover>
      </div>
    </>
  );
}
