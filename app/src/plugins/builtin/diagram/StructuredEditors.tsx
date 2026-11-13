// Editing a structured shape's rows (rows.ts): the line typed over a row on the canvas, and the rows list in the
// properties panel. The view does the saving (with undo and the shape's height); these only say what was asked.
import { For, Show } from "solid-js";
import { Icon } from "../../../theme/icons";
import Select from "../../../ui/Select";
import type { DiagramRow, DiagramShape, RowSection, StructuredKind } from "./model";
import { rowHeight, rowText, structuredItems, structureLayout, structureOf } from "./rows";
import { focusWhenShown } from "../../../ui/focus";

// What is being typed on the canvas: a row (rowId), or a new one in a section after a row (or first).
export interface RowEdit {
  shapeId: number;
  rowId: number | null;
  section: RowSection;
  after?: number;
}

const sectionNames: Record<RowSection, string> = { attributes: "attribute", operations: "operation", literals: "literal", columns: "column" };

// The input over a row of a shape on the canvas. Enter saves and goes on to a new row below, Escape leaves it as it
// was, Backspace in an empty row removes it; leaving the field saves.
export function RowInput(props: {
  shape: DiagramShape;
  rows: readonly DiagramRow[];
  edit: RowEdit;
  onSave: (text: string, next: boolean) => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  const row = () => props.rows.find((item) => item.id === props.edit.rowId);
  const top = () => {
    const layout = structureLayout(props.shape, props.rows);
    const placed = layout.compartments.flatMap((c) => c.rows);
    const at = placed.find((item) => item.row.id === (props.edit.rowId ?? props.edit.after));
    if (at) return props.edit.rowId !== null ? at.y : at.y + at.h;
    const compartment = layout.compartments.find((c) => c.section === props.edit.section) ?? layout.compartments[0];
    return (compartment?.y ?? layout.header.h) + 2;
  };
  let done = false;
  return (
    <input class="diagram-row-input" aria-label={`${sectionNames[props.edit.section]} of ${props.shape.text}`} ref={focusWhenShown}
      placeholder={props.shape.kind.startsWith("db-") ? "name type PK" : props.edit.section === "literals" ? "VALUE" : "+ name: Type"}
      value={row() ? rowText(row()!, props.shape.kind) : ""} style={{ top: `${top()}px`, height: `${rowHeight}px` }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        const value = event.currentTarget.value;
        if (event.key === "Enter") {
          done = true;
          props.onSave(value, true);
        } else if (event.key === "Escape") {
          done = true;
          props.onCancel();
        } else if (event.key === "Backspace" && value === "") {
          event.preventDefault();
          done = true;
          props.onRemove();
        }
      }}
      onBlur={(event) => {
        if (!done) props.onSave(event.currentTarget.value, false);
      }} />
  );
}

// The kinds a structured shape can be changed to: its own family (classes, or tables).
const familyOf = (kind: StructuredKind) => structuredItems.filter((item) => item.kind.slice(0, 3) === kind.slice(0, 3));

const markChoices = (kind: StructuredKind) => kind.startsWith("db-")
  ? [{ mark: "pk", label: "PK", title: "Primary key" }, { mark: "fk", label: "FK", title: "Foreign key" },
    { mark: "uq", label: "UQ", title: "Unique" }, { mark: "nn", label: "NN", title: "Not null" }]
  : [{ mark: "static", label: "static", title: "Static (underlined)" }, { mark: "abstract", label: "abstract", title: "Abstract (italic)" }];

// The panel's part for a structured shape: its kind, and each section's rows with their marks, order and removal.
export function StructuredPanel(props: {
  shape: DiagramShape;
  rows: readonly DiagramRow[];
  disabled: boolean;
  onKind: (kind: StructuredKind) => void;
  onText: (row: DiagramRow, text: string) => void;
  onMark: (row: DiagramRow, mark: string, on: boolean) => void;
  onMove: (row: DiagramRow, by: -1 | 1) => void;
  onRemove: (row: DiagramRow) => void;
  onAdd: (section: RowSection) => void;
}) {
  const kind = () => props.shape.kind as StructuredKind;
  const sections = () => structureOf(kind())?.sections ?? [];
  const inSection = (section: RowSection) => props.rows.filter((row) => row.section === section).sort((a, b) => a.z - b.z || a.id - b.id);
  return (
    <>
      <label class="diagram-property">Kind
        <Select label="Kind" value={kind()} options={familyOf(kind()).map((item) => ({ value: item.kind, label: item.label }))}
          disabled={props.disabled} onChange={(value) => props.onKind(value)} />
      </label>
      <For each={sections()}>
        {(section) => (
          <div class="diagram-rows">
            <div class="diagram-rows-title">{`${sectionNames[section][0].toUpperCase()}${sectionNames[section].slice(1)}s`}</div>
            <For each={inSection(section)}>
              {(row, index) => (
                <div class="diagram-row-item">
                  <input class="mw-input mw-box" value={rowText(row, kind())} disabled={props.disabled} aria-label={sectionNames[section]}
                    onChange={(event) => props.onText(row, event.currentTarget.value)} />
                  <div class="diagram-row-tools">
                    <For each={markChoices(kind())}>
                      {(choice) => (
                        <button class="mw-button mw-box diagram-row-mark" classList={{ active: row.marks.includes(choice.mark) }} disabled={props.disabled}
                          title={choice.title} aria-pressed={row.marks.includes(choice.mark)}
                          onClick={() => props.onMark(row, choice.mark, !row.marks.includes(choice.mark))}>{choice.label}</button>
                      )}
                    </For>
                    <button class="icon-button" title="Move up" aria-label="Move up" disabled={props.disabled || index() === 0}
                      onClick={() => props.onMove(row, -1)}><Icon name="sort-up" /></button>
                    <button class="icon-button" title="Move down" aria-label="Move down" disabled={props.disabled || index() === inSection(section).length - 1}
                      onClick={() => props.onMove(row, 1)}><Icon name="sort-down" /></button>
                    <button class="icon-button" title="Remove" aria-label="Remove" disabled={props.disabled}
                      onClick={() => props.onRemove(row)}><Icon name="close" /></button>
                  </div>
                </div>
              )}
            </For>
            <Show when={!props.disabled}>
              <button class="mw-button mw-box" onClick={() => props.onAdd(section)}><Icon name="add" /> Add {sectionNames[section]}</button>
            </Show>
          </div>
        )}
      </For>
    </>
  );
}
