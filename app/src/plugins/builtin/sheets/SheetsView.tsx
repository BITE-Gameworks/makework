import { For, Show, createEffect, on, createMemo, createSignal, onCleanup } from "solid-js";
import type { ChannelContext } from "../../types";
import { Icon } from "../../../theme/icons";
import { cellAddress, columnIndex, columnName, FormulaBook, type CellValue } from "./formula";
import { colWidth, rowHeight, createWorkbook, deleteCols, deleteRows, deleteRule, deleteSheet, insertCols, insertRows, moveSheet, renameSheet, setCells, setRule, setSheet, type CellStyle, type SheetRule } from "./data";
import ConfirmPrompt from "../../../ui/ConfirmPrompt";
import Select from "../../../ui/Select";
import Popover from "../../../ui/Popover";
import ColorSwatches from "../../../ui/ColorSwatches";
import Skeleton from "../../../ui/Skeleton";
import type { MenuEntry } from "../../../ui/contextMenu";
import { tagColors } from "../../../system/tasks";
import { saveBlob } from "../../../ui/download";
import { exportWorkbook, importWorkbook, safeWorkbookName, type SheetFileFormat } from "./transfer";
import "./sheets.css";
import { copyToClipboard } from "../../../ui/clipboard";

const rowHead = 52;
const colHead = 30;
const gridLimitRows = 100_000;
const gridLimitCols = 1_000;
const maxPasteCharacters = 1_000_000;
const cellConflictWindowMs = 5_000;
const cellConflictDisplayMs = 10_000;
const currencyCodes = typeof Intl.supportedValuesOf === "function"
  ? Intl.supportedValuesOf("currency")
  : ["AUD", "BRL", "CAD", "CHF", "CNY", "DKK", "EUR", "GBP", "HKD", "INR", "JPY", "KRW", "MXN", "NOK", "NZD", "PLN", "SEK", "SGD", "USD", "ZAR"];
const currencyNames = new Intl.DisplayNames(undefined, { type: "currency" });
const currencyOptions = currencyCodes.map((value) => ({
  value, label: `${currencyNames.of(value) ?? value} (${value})`,
}));

type Address = { row: number; col: number };
const keyOf = ({ row, col }: Address) => `${row}:${col}`;
const addressName = ({ row, col }: Address) => cellAddress(row, col);
const decodeRange = (text: string) => {
  const m = /^([A-Z]{1,3})(\d+)(?::([A-Z]{1,3})(\d+))?$/.exec(text.toUpperCase());
  if (!m) return null;
  return { a: { row: Number(m[2]) - 1, col: columnIndex(m[1]) }, b: { row: Number(m[4] ?? m[2]) - 1, col: columnIndex(m[3] ?? m[1]) } };
};
// Calendar cells all sit in column A (rows by date), so this range is every calendar cell.
const allCalendarCells = "A1:A1000000";
const cellIn = (at: Address, range: string) => {
  const decoded = decodeRange(range);
  return !!decoded && at.row >= Math.min(decoded.a.row, decoded.b.row) && at.row <= Math.max(decoded.a.row, decoded.b.row)
    && at.col >= Math.min(decoded.a.col, decoded.b.col) && at.col <= Math.max(decoded.a.col, decoded.b.col);
};
const showValue = (value: CellValue, style: CellStyle = {}) => {
  if (value == null) return "";
  if (value instanceof Error) return value.message;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number") {
    if (style.format === "percent") return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value * 100)}%`;
    if (style.format === "currency") return new Intl.NumberFormat(undefined, { style: "currency", currency: style.currency ?? "USD" }).format(value);
    if (style.format === "number") return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
  }
  return String(value);
};
const monthKey = (date: Date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
const contrastingText = (color: string) => {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return "var(--mw-text)";
  const channels = [0, 2, 4].map((index) => Number.parseInt(match[1].slice(index, index + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 > 0.179 ? "#000000" : "#ffffff";
};
const stateRecord = (value: import("../../../core/presence").PresenceState | null) =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, import("../../../core/presence").PresenceState> : {};

// Numbers and amounts line up on the right unless the cell says otherwise.
const looksNumeric = (text: unknown) => typeof text === "string" && /^-?[$€£¥]?-?\d[\d,. ]*%?$/.test(text.trim());

export default function SheetsView(props: { context: ChannelContext }) {
  const { context } = props;
  const api = context.api;
  const workbook = createWorkbook(api, context.channel.id);
  const [selectedId, setSelectedId] = createSignal<number>();
  const selectedSheet = createMemo(() => workbook.value.find((sheet) => sheet.id === selectedId()) ?? workbook.value[0]);
  const cellsByAddress = createMemo(() => new Map((selectedSheet()?.cells ?? []).map((cell) => [`${cell.row}:${cell.col}`, cell])));
  const formulaBook = createMemo(() => new FormulaBook(
    workbook.value.map((sheet) => ({ id: sheet.id, name: sheet.name })),
    workbook.value.flatMap((sheet) => sheet.cells.map((cell) => ({ sheetId: sheet.id, row: cell.row, col: cell.col, value: cell.value }))),
  ));
  const [selected, setSelected] = createSignal<Address>({ row: 0, col: 0 });
  const [rangeStart, setRangeStart] = createSignal<Address>({ row: 0, col: 0 });
  const [multiSelected, setMultiSelected] = createSignal<Address[]>([]);
  const [editing, setEditing] = createSignal(false);
  const [formulaText, setFormulaText] = createSignal("");
  const [error, setError] = createSignal("");
  const [sizeOpen, setSizeOpen] = createSignal(false);
  const [colorOpen, setColorOpen] = createSignal<"text" | "background" | null>(null);
  const [conditionalOpen, setConditionalOpen] = createSignal(false);
  const [conditionalCondition, setConditionalCondition] = createSignal(">=10");
  const [conditionalColor, setConditionalColor] = createSignal(tagColors[0] ?? "#ffff00");
  const [confirmId, setConfirmId] = createSignal<number>();
  const [structureDelete, setStructureDelete] = createSignal<{ axis: "row" | "column"; at: number }>();
  const [renamingId, setRenamingId] = createSignal<number>();
  const [renameText, setRenameText] = createSignal("");
  const [calendarMonth, setCalendarMonth] = createSignal(monthKey(new Date()));
  const [windowRange, setWindowRange] = createSignal({ firstRow: 0, lastRow: 30, firstCol: 0, lastCol: 12 });
  const [dragging, setDragging] = createSignal(false);
  const [resizeDrag, setResizeDrag] = createSignal<{
    axis: "row" | "column"; index: number; start: number; size: number; next: number;
  }>();
  const [transferOpen, setTransferOpen] = createSignal<"import" | "export" | null>(null);
  const [cellConflicts, setCellConflicts] = createSignal(new Set<string>());
  const conflictTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let scroller!: HTMLDivElement;
  let cellEditor!: HTMLInputElement | undefined;
  let formulaEditor!: HTMLInputElement;
  let renameInput!: HTMLInputElement;
  let tabs!: HTMLDivElement;
  let cursorOverlay!: HTMLDivElement;
  let importInput!: HTMLInputElement;
  let redrawCursors: (() => void) | undefined;

  const conflictKey = (sheetId: number, at: Address) => `${sheetId}:${keyOf(at)}`;
  const markConflict = (sheetId: number, at: Address, broadcast = false) => {
    const key = conflictKey(sheetId, at);
    setCellConflicts((current) => new Set(current).add(key));
    clearTimeout(conflictTimers.get(key));
    conflictTimers.set(key, setTimeout(() => {
      conflictTimers.delete(key);
      setCellConflicts((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }, cellConflictDisplayMs));
    if (broadcast) context.events.send({
      kind: "sheet-cell-conflict", sheet: sheetId, cell: keyOf(at), at: Date.now(),
    });
  };
  const stopConflictEvents = context.events.listen((_userId, message) => {
    const event = stateRecord(message);
    if (event.kind !== "sheet-cell-conflict" || typeof event.sheet !== "number" || typeof event.cell !== "string"
      || typeof event.at !== "number" || Math.abs(Date.now() - event.at) > cellConflictWindowMs) return;
    const match = /^(\d+):(\d+)$/.exec(event.cell);
    if (match) markConflict(event.sheet, { row: Number(match[1]), col: Number(match[2]) });
  });
  onCleanup(() => {
    stopConflictEvents();
    for (const timer of conflictTimers.values()) clearTimeout(timer);
    conflictTimers.clear();
  });

  const sheet = selectedSheet;
  const canEditSheet = () => context.can("edit_content") && !sheet()?.locked;
  const currentCell = () => cellsByAddress().get(keyOf(selected()));
  const raw = (at: Address) => cellsByAddress().get(keyOf(at))?.value ?? "";
  const getValue = (at: Address) => formulaBook().get(sheet()?.id ?? 0, at.row, at.col);
  const selectionEnd = () => selected();
  const selection = () => {
    const a = rangeStart();
    const b = selectionEnd();
    return {
      top: Math.min(a.row, b.row), bottom: Math.max(a.row, b.row),
      left: Math.min(a.col, b.col), right: Math.max(a.col, b.col),
    };
  };
  const isSelected = (at: Address) => {
    if (multiSelected().length) return multiSelected().some((cell) => keyOf(cell) === keyOf(at));
    const rect = selection();
    return at.row >= rect.top && at.row <= rect.bottom && at.col >= rect.left && at.col <= rect.right;
  };
  const selectionCellCount = () => {
    if (multiSelected().length) return multiSelected().length;
    const rect = selection();
    return (rect.bottom - rect.top + 1) * (rect.right - rect.left + 1);
  };
  const selectionCells = (limit = 500): Address[] | null => {
    if (selectionCellCount() > limit) return null;
    if (multiSelected().length) return multiSelected();
    const r = selection();
    const cells: Address[] = [];
    for (let row = r.top; row <= r.bottom; row++) for (let col = r.left; col <= r.right; col++) cells.push({ row, col });
    return cells;
  };
  // In calendar mode the sheet's own style (calendar.cellStyle) sits under every cell's style.
  const sheetStyle = (): CellStyle => sheet()?.mode === "calendar" ? (sheet()?.calendar.cellStyle as CellStyle | undefined) ?? {} : {};
  const styleAt = (at: Address): CellStyle => ({ ...sheetStyle(), ...cellsByAddress().get(keyOf(at))?.style });
  // While "All cells" is on, the toolbar shows and changes the sheet's style instead of the selection's.
  const [allCells, setAllCells] = createSignal(false);
  const formattingAll = () => allCells() && sheet()?.mode === "calendar";
  const shownStyle = () => formattingAll() ? sheetStyle() : styleAt(selected());
  const formulaValue = (at: Address) => {
    const value = getValue(at);
    return showValue(value, styleAt(at));
  };
  const sizeRows = () => Math.min(sheet()?.rows ?? gridLimitRows, gridLimitRows);
  const sizeCols = () => Math.min(sheet()?.cols ?? gridLimitCols, gridLimitCols);
  const dimensions = createMemo(() => {
    const current = sheet();
    const resize = resizeDrag();
    const rows = Array.from({ length: sizeRows() }, (_, index) => {
      const value = resize?.axis === "row" && resize.index === index ? resize.next : Number(current?.row_heights[index]) || rowHeight;
      return Math.max(20, Math.min(200, value));
    });
    const cols = Array.from({ length: sizeCols() }, (_, index) => {
      const value = resize?.axis === "column" && resize.index === index ? resize.next : Number(current?.col_widths[index]) || colWidth;
      return Math.max(48, Math.min(600, value));
    });
    const positions = (values: number[]) => {
      const result = new Array<number>(values.length + 1);
      result[0] = 0;
      for (let i = 0; i < values.length; i++) result[i + 1] = result[i] + values[i];
      return result;
    };
    return { rows, cols, rowPositions: positions(rows), colPositions: positions(cols) };
  });
  const indexAt = (positions: number[], offset: number) => {
    let low = 0;
    let high = positions.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (positions[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return Math.min(positions.length - 2, low);
  };
  const sizeLabel = () => sheet()?.mode === "calendar"
    ? `${sheet()?.calendar.itemsPerDay ?? 4} cells/day`
    : sheet()?.rows == null && sheet()?.cols == null ? "no limit" : `${sheet()?.rows ?? "any"} × ${sheet()?.cols ?? "any"}`;
  const gridBoundsLabel = () => sheet()?.rows != null && sheet()?.cols != null
    ? `A1:${cellAddress(sheet()!.rows! - 1, sheet()!.cols! - 1)}`
    : `${sheet()?.rows ?? "Unlimited"} rows × ${sheet()?.cols ?? "Unlimited"} columns`;
  const activeRule = (at: Address) => [...(sheet()?.rules ?? [])].reverse().find((rule) => cellIn(at, rule.range));
  const conditionalCellStyle = (at: Address) => {
    const value = Number(getValue(at));
    for (const candidate of sheet()?.rules.filter((item) => item.kind === "conditional" && cellIn(at, item.range)) ?? []) {
      const condition = /^(>=|<=|<>|=|>|<)\s*(-?\d+(?:\.\d+)?)$/.exec(String(candidate.config.condition ?? ""));
      if (!condition || !Number.isFinite(value)) continue;
      const target = Number(condition[2]);
      const matches = condition[1] === ">=" ? value >= target : condition[1] === "<=" ? value <= target
        : condition[1] === ">" ? value > target : condition[1] === "<" ? value < target
          : condition[1] === "<>" ? value !== target : value === target;
      if (matches) return candidate.config.style as CellStyle | undefined;
    }
    return undefined;
  };
  const cellVisualStyle = (at: Address) => {
    const style = { ...styleAt(at), ...conditionalCellStyle(at) };
    const align = style.align ?? (looksNumeric(formulaValue(at)) ? "right" : undefined);
    return {
      color: style.color ?? (style.background ? contrastingText(style.background) : undefined),
      background: style.background,
      "font-weight": style.bold ? "bold" : undefined,
      "font-style": style.italic ? "italic" : undefined,
      "text-decoration": [style.underline && "underline", style.strike && "line-through"].filter(Boolean).join(" ") || undefined,
      "text-align": align,
      "justify-content": align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start",
      "align-items": style.verticalAlign === "top" ? "flex-start" : style.verticalAlign === "bottom" ? "flex-end" : "center",
    };
  };
  const lockedBy = (at: Address) => context.presence.others().some((other) =>
    stateRecord(other.state).editing === `${sheet()?.id}:${keyOf(at)}`);

  createEffect(() => {
    if (!workbook.loaded || workbook.value.length || !context.can("edit_content")) return;
    void api.call("add-sheet", { channel_id: context.channel.id, name: "Sheet 1" }).catch((e) => setError((e as Error).message));
  });

  createEffect(() => {
    const current = currentCell();
    setFormulaText(current?.value ?? "");
  });

  const updatePresence = () => context.presence.set({
    selection: { sheet: sheet()?.id ?? 0, start: rangeStart(), end: selected(), cells: multiSelected() },
    ...(editing() && { editing: `${sheet()?.id}:${keyOf(selected())}` }),
  });

  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    try { setError(""); await action(); return true; }
    catch (e) { setError((e as Error).message); return false; }
  };

  const exportFile = (format: SheetFileFormat) => {
    try {
      saveBlob(exportWorkbook(workbook.value, format, selectedSheet()?.id ?? 0),
        `${safeWorkbookName(context.channel.name)}.${format}`);
      setTransferOpen(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const importFile = async (file: File) => {
    try {
      const imported = importWorkbook(new Uint8Array(await file.arrayBuffer()), file.name, workbook.value.map((item) => item.name));
      for (const incoming of imported) {
        const { id } = await api.call<{ id: number }>("add-sheet", {
          channel_id: context.channel.id, name: incoming.name,
        });
        for (let start = 0; start < incoming.cells.length; start += 400) {
          await setCells(api, id, incoming.cells.slice(start, start + 400));
        }
      }
      await workbook.refresh();
      if (imported.length) setSelectedId(workbook.value.at(-imported.length)?.id);
      setTransferOpen(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const snapshot = (addresses: Address[]) => addresses.map((at) => {
    const cell = cellsByAddress().get(keyOf(at));
    return { row: at.row, col: at.col, value: cell?.value ?? null, style: cell?.style ?? null };
  });

  const saveChanges = async (changes: { row: number; col: number; value?: string | null; style?: CellStyle | null }[], label: string) => {
    if (!sheet() || !changes.length) return;
    if (!canEditSheet()) { setError("This sheet is locked or you don't have permission to edit it."); return; }
    const sheetId = sheet()!.id;
    const simultaneous = changes.filter((change) => lockedBy(change));
    simultaneous.forEach((at) => markConflict(sheetId, at, true));
    const before = snapshot(changes);
    await setCells(api, sheetId, changes);
    context.history.push({
      label,
      undo: () => setCells(api, sheetId, before),
      redo: () => setCells(api, sheetId, changes),
    });
  };

  const commit = async (value = formulaText()) => {
    if (!sheet()) return;
    const at = selected();
    const old = currentCell()?.value ?? "";
    setEditing(false);
    updatePresence();
    if (old !== value) await run(() => saveChanges([{ ...at, value: value || null }], "Edit cells"));
  };

  const selectCell = (at: Address, extend = false) => {
    if (lockedBy(at)) return;
    if (editing()) void commit();
    setMultiSelected([]);
    if (!extend) setRangeStart(at);
    setSelected(at);
    setFormulaText(raw(at));
    setEditing(false);
    updatePresence();
  };

  const toggleMultiCell = (at: Address) => {
    if (lockedBy(at)) return;
    if (editing()) void commit();
    const current = multiSelected().length ? multiSelected() : selectionCells();
    if (!current) { setError("Use Ctrl-click on selections of up to 500 cells at a time."); return; }
    const exists = current.some((cell) => keyOf(cell) === keyOf(at));
    if (!exists && current.length >= 500) { setError("Select up to 500 separate cells at a time."); return; }
    const next = exists ? current.filter((cell) => keyOf(cell) !== keyOf(at)) : [...current, at];
    setMultiSelected(next);
    if (!next.length) setRangeStart(at);
    setSelected(at);
    setFormulaText(raw(at));
    setEditing(false);
    updatePresence();
  };

  const beginEdit = (value?: string) => {
    if (!sheet() || lockedBy(selected()) || !canEditSheet()) return;
    setEditing(true);
    setFormulaText(value ?? raw(selected()));
    updatePresence();
    requestAnimationFrame(() => cellEditor?.focus());
  };

  const formatCells = async (addresses: Address[], change: Partial<CellStyle>) => {
    const changes = addresses.map((at) => {
      const style = { ...cellsByAddress().get(keyOf(at))?.style };
      for (const [key, value] of Object.entries(change)) {
        if (value === undefined) delete style[key as keyof CellStyle];
        else (style as Record<string, unknown>)[key] = value;
      }
      return { ...at, style: Object.keys(style).length ? style : null };
    });
    await run(() => saveChanges(changes, "Format cells"));
  };
  const formatSelection = async (change: Partial<CellStyle>) => {
    if (formattingAll()) {
      const style: Record<string, unknown> = { ...sheetStyle() };
      for (const [key, value] of Object.entries(change)) {
        if (value === undefined) delete style[key];
        else style[key] = value;
      }
      await run(() => setSheet(api, sheet()!.id, { calendar: { ...sheet()!.calendar, cellStyle: style } }));
      return;
    }
    const addresses = selectionCells();
    if (!addresses) { setError("Format a selection of up to 500 cells at a time."); return; }
    await formatCells(addresses, change);
  };

  const beginResize = (event: PointerEvent, axis: "row" | "column", index: number, size: number) => {
    if (!canEditSheet()) return;
    event.preventDefault();
    event.stopPropagation();
    setResizeDrag({
      axis, index, start: axis === "row" ? event.clientY : event.clientX, size, next: size,
    });
  };
  const finishResize = () => {
    const drag = resizeDrag();
    if (!drag) return;
    const current = sheet();
    if (!current) { setResizeDrag(undefined); return; }
    const key = drag.axis === "row" ? "row_heights" : "col_widths";
    const values = { ...current[key], [drag.index]: drag.next };
    void run(() => setSheet(api, current.id, { [key]: values })).then(() => setResizeDrag(undefined));
  };
  const moveResize = (event: PointerEvent) => {
    const drag = resizeDrag();
    if (!drag) return;
    const delta = (drag.axis === "row" ? event.clientY : event.clientX) - drag.start;
    const min = drag.axis === "row" ? 20 : 48;
    const max = drag.axis === "row" ? 200 : 600;
    setResizeDrag({ ...drag, next: Math.max(min, Math.min(max, drag.size + delta)) });
  };

  const handleScroll = () => {
    if (!scroller) return;
    redrawCursors?.();
    const metrics = dimensions();
    const firstRow = Math.max(0, indexAt(metrics.rowPositions, Math.max(0, scroller.scrollTop - colHead)) - 3);
    const firstCol = Math.max(0, indexAt(metrics.colPositions, Math.max(0, scroller.scrollLeft - rowHead)) - 2);
    const lastRow = Math.min(sizeRows(), indexAt(metrics.rowPositions, Math.max(0, scroller.scrollTop - colHead) + scroller.clientHeight) + 5);
    const lastCol = Math.min(sizeCols(), indexAt(metrics.colPositions, Math.max(0, scroller.scrollLeft - rowHead) + scroller.clientWidth) + 4);
    setWindowRange({
      firstRow, lastRow,
      firstCol, lastCol,
    });
  };

  const visibleRows = () => Array.from({ length: Math.max(0, windowRange().lastRow - windowRange().firstRow) }, (_, i) => i + windowRange().firstRow);
  const visibleCols = () => Array.from({ length: Math.max(0, windowRange().lastCol - windowRange().firstCol) }, (_, i) => i + windowRange().firstCol);
  const shownRows = visibleRows;
  const shownCols = visibleCols;
  const remoteSelection = (row: number, col: number) => context.presence.others().some(({ state }) => {
    const rect = stateRecord(state).selection as { sheet?: number; start?: Address; end?: Address; cells?: Address[] } | undefined;
    if (rect?.sheet === sheet()?.id && rect.cells?.some((cell) => cell.row === row && cell.col === col)) return true;
    return rect?.sheet === sheet()?.id && !!rect.start && !!rect.end
      && row >= Math.min(rect.start.row, rect.end.row) && row <= Math.max(rect.start.row, rect.end.row)
      && col >= Math.min(rect.start.col, rect.end.col) && col <= Math.max(rect.start.col, rect.end.col);
  });

  const onGridKey = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      void (event.shiftKey ? context.history.redo() : context.history.undo()).catch((e) => setError((e as Error).message));
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "y") {
      event.preventDefault();
      void context.history.redo().catch((e) => setError((e as Error).message));
      return;
    }
    const at = selected();
    let next: Address | undefined;
    if (event.key === "ArrowDown") next = { row: Math.min(sizeRows() - 1, at.row + 1), col: at.col };
    else if (event.key === "ArrowUp") next = { row: Math.max(0, at.row - 1), col: at.col };
    else if (event.key === "ArrowRight" || event.key === "Tab") next = { row: at.row, col: Math.min(sizeCols() - 1, at.col + 1) };
    else if (event.key === "ArrowLeft") next = { row: at.row, col: Math.max(0, at.col - 1) };
    else if (event.key === "Enter") next = { row: Math.min(sizeRows() - 1, at.row + (event.shiftKey ? -1 : 1)), col: at.col };
    if (next) {
      event.preventDefault();
      selectCell(next, event.shiftKey);
      return;
    }
    if (event.key === "F2") { event.preventDefault(); beginEdit(); return; }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      if (!canEditSheet()) return;
      const addresses = selectionCells();
      if (!addresses) { setError("Clear a selection of up to 500 cells at a time."); return; }
      void saveChanges(addresses.map((cell) => ({ ...cell, value: null })), "Clear cells").catch((e) => setError((e as Error).message));
      return;
    }
    if ((event.ctrlKey || event.metaKey) && ["b", "i", "u"].includes(event.key.toLowerCase())) {
      event.preventDefault();
      const key = event.key.toLowerCase() === "b" ? "bold" : event.key.toLowerCase() === "i" ? "italic" : "underline";
      void formatSelection({ [key]: !shownStyle()[key as keyof CellStyle] } as Partial<CellStyle>);
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      beginEdit(event.key);
    }
  };

  const copy = (event: ClipboardEvent) => {
    const addresses = selectionCells(100_000);
    if (!addresses) { setError("Copy a selection of up to 100,000 cells at a time."); event.preventDefault(); return; }
    const values = addresses.map((at) => raw(at)).join("\t");
    event.clipboardData?.setData("text/plain", values);
    event.preventDefault();
  };

  const paste = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData("text/plain");
    if (text === undefined || !sheet()) return;
    event.preventDefault();
    if (!canEditSheet()) return;
    if (text.length > maxPasteCharacters) { setError("Paste up to 1,000,000 characters at a time."); return; }
    const rows = text.replaceAll("\r\n", "\n").replace(/\n$/, "").split("\n").map((line) => line.split("\t"));
    if (rows.reduce((count, row) => count + row.length, 0) > 500) { setError("Paste up to 500 cells at a time."); return; }
    const changes = rows.flatMap((row, r) => row.map((value, c) => ({ row: selected().row + r, col: selected().col + c, value: value || null })));
    if (changes.some((at) => at.row >= sizeRows() || at.col >= sizeCols())) { setError("Paste would go outside the sheet's size limits."); return; }
    void run(() => saveChanges(changes, "Paste cells"));
  };

  const addRow = (at = selected().row + 1) => run(() => insertRows(api, sheet()!.id, at));
  const addCol = (at = selected().col + 1) => run(() => insertCols(api, sheet()!.id, at));
  const clearCell = (at: Address) => run(() => saveChanges([{ ...at, value: null }], "Clear cell"));
  const copyCell = async (at: Address) => {
    await copyToClipboard(raw(at));
  };
  const confirmStructureDelete = (axis: "row" | "column", at: number) => setStructureDelete({ axis, at });
  const rangeLabel = (start: Address, end = start) => {
    const address = (cell: Address) => {
      let n = cell.col + 1;
      let name = "";
      while (n > 0) { name = String.fromCodePoint(65 + (n - 1) % 26) + name; n = Math.floor((n - 1) / 26); }
      return `${name}${cell.row + 1}`;
    };
    return `${address(start)}:${address(end)}`;
  };
  // What field types and conditional formatting apply to: every calendar cell while "All cells" is on, else the
  // selected range.
  const targetRange = () => {
    if (formattingAll()) return allCalendarCells;
    const r = selection();
    return rangeLabel({ row: r.top, col: r.left }, { row: r.bottom, col: r.right });
  };
  const targetRule = () => formattingAll()
    ? sheet()?.rules.find((rule) => rule.range === allCalendarCells)
    : activeRule(selected());
  const setTargetRule = (kind: SheetRule["kind"]) => {
    const config = kind === "dropdown" ? { options: ["Option 1", "Option 2"] } : {};
    const active = targetRule();
    return run(async () => {
      if (active) await deleteRule(api, active.id);
      await setRule(api, sheet()!.id, targetRange(), kind, config);
      if (kind === "date") await formatSelection({ format: "date" });
    });
  };
  const configureConditional = (at: Address) => {
    const existing = activeRule(at);
    setConditionalCondition(String(existing?.config.condition ?? ">=10"));
    setConditionalColor(String((existing?.config.style as CellStyle | undefined)?.background ?? tagColors[0] ?? "#ffff00"));
    setConditionalOpen(true);
  };
  const cellMenu = (event: MouseEvent, at: Address) => {
    if (!isSelected(at)) selectCell(at);
    const editable = canEditSheet();
    const style = cellsByAddress().get(keyOf(at))?.style ?? {};
    const rule = activeRule(at);
    const styleEntries: MenuEntry[] = [
      { label: style.bold ? "Remove bold" : "Bold", icon: "format-bold", action: () => void formatSelection({ bold: !style.bold }), disabled: !editable },
      { label: style.italic ? "Remove italic" : "Italic", icon: "format-italic", action: () => void formatSelection({ italic: !style.italic }), disabled: !editable },
      { label: style.underline ? "Remove underline" : "Underline", icon: "format-underline", action: () => void formatSelection({ underline: !style.underline }), disabled: !editable },
      { label: style.strike ? "Remove strikethrough" : "Strikethrough", icon: "format-strike", action: () => void formatSelection({ strike: !style.strike }), disabled: !editable },
      {
        label: "Text color", icon: "text-color", items: [
          { label: "Default", action: () => void formatSelection({ color: undefined }) },
          ...tagColors.map((color) => ({ label: color, swatch: color, action: () => void formatSelection({ color }) })),
        ], disabled: !editable,
      },
      {
        label: "Cell background", icon: "cell-background", items: [
          { label: "Default", action: () => void formatSelection({ background: undefined }) },
          ...tagColors.map((color) => ({ label: color, swatch: color, action: () => void formatSelection({ background: color }) })),
        ], disabled: !editable,
      },
    ];
    const fieldTypes: SheetRule["kind"][] = ["dropdown", "number", "date", "checkbox", "conditional"];
    const fieldLabels: Record<SheetRule["kind"], string> = {
      dropdown: "Make dropdown", number: "Make number", date: "Make date", checkbox: "Make checkbox", conditional: "Conditional formatting",
    };
    const entries: MenuEntry[] = [
      { label: `Edit ${addressName(at)}`, icon: "rename", action: () => beginEdit(), disabled: !editable },
      { label: "Copy value", icon: "copy", action: () => void copyCell(at) },
      { label: "Clear cell", icon: "delete", danger: true, action: () => void clearCell(at), disabled: !editable || !raw(at) },
      "separator",
      { label: "Style", icon: "design-palette", items: styleEntries, disabled: !editable },
      { label: "Field type", icon: "format-code", items: fieldTypes.map((kind) => ({
        label: fieldLabels[kind], action: () => kind === "conditional"
          ? configureConditional(at) : void setTargetRule(kind),
      })), disabled: !editable },
      { label: "Remove field type", icon: "delete", action: () => {
        const rule = activeRule(at);
        if (rule) void run(() => deleteRule(api, rule.id));
      }, disabled: !editable || !activeRule(at) },
    ];
    if (sheet()?.mode !== "calendar") entries.push(
      "separator",
      { label: "Insert row above", icon: "add", action: () => void addRow(at.row), disabled: !editable },
      { label: "Delete row", icon: "delete", danger: true, action: () => confirmStructureDelete("row", at.row), disabled: !editable || sizeRows() <= 1 },
      { label: "Insert column left", icon: "add", action: () => void addCol(at.col), disabled: !editable },
      { label: "Delete column", icon: "delete", danger: true, action: () => confirmStructureDelete("column", at.col), disabled: !editable || sizeCols() <= 1 },
    );
    if (rule?.kind === "dropdown") {
      const dropdownOptions = createSignal((rule.config.options as (string | { value: string; label: string })[])
        .map((option) => typeof option === "string" ? option : option.label).join(", "));
      entries.splice(6, 0, {
        render: () => <div class="mw-sheets-context-options">
          <label>Dropdown options<input aria-label={`Dropdown options for ${addressName(at)}`} value={dropdownOptions[0]()}
            onInput={(e) => dropdownOptions[1](e.currentTarget.value)} /></label>
          <button type="button" class="mw-box" disabled={!editable} onClick={() => {
            const options = dropdownOptions[0]().split(",").map((option) => option.trim()).filter(Boolean);
            if (!options.length) { setError("A dropdown needs at least one option."); return; }
            void run(async () => {
              await setRule(api, sheet()!.id, rule.range, "dropdown", { ...rule.config, options }, rule.id);
              await workbook.refresh();
            });
          }}>Save options</button>
        </div>,
      });
    }
    context.openContextMenu(event, entries);
  };
  const chooseFieldOrFormat = (value: string) => {
    if (["number", "percent", "currency"].includes(value)) {
      const active = targetRule();
      void run(async () => {
        if (active) await deleteRule(api, active.id);
        await formatSelection({ format: value as CellStyle["format"] });
      });
      return;
    }
    if (value === "conditional") {
      configureConditional(selected());
      return;
    }
    void setTargetRule(value as SheetRule["kind"]);
  };

  // Browsing months is each reader's own: it changes nothing in the sheet, so everyone may (readers too).
  const changeMonth = (delta: number) => {
    const [year, month] = calendarMonth().split("-").map(Number);
    setCalendarMonth(monthKey(new Date(Date.UTC(year, month - 1 + delta, 1))));
  };

  // A calendar cell is named by its day and place in it ("Oct 28, 2"); its A1 address means nothing to the reader.
  const perDay = () => Math.max(1, Math.min(20, Number(sheet()?.calendar.itemsPerDay ?? 4)));
  const selectedName = () => {
    if (sheet()?.mode !== "calendar") return addressName(selected());
    const row = selected().row;
    const date = new Date(Math.floor(row / perDay()) * 86_400_000);
    return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}, ${row % perDay() + 1}`;
  };
  // The selection stays in the month shown: today's first cell, or the month's first.
  createEffect(on([() => sheet()?.mode, calendarMonth], ([mode, shown]) => {
    if (mode !== "calendar") return;
    const [year, month] = shown.split("-").map(Number);
    const first = Date.UTC(year, month - 1, 1) / 86_400_000;
    const last = Date.UTC(year, month, 0) / 86_400_000;
    const day = Math.floor(selected().row / perDay());
    if (day >= first && day <= last) return;
    const now = new Date();
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000;
    selectCell({ row: (today >= first && today <= last ? today : first) * perDay(), col: 0 });
  }));
  const calendarDays = () => {
    const [year, month] = calendarMonth().split("-").map(Number);
    const firstWeekday = Number(sheet()?.calendar.firstWeekday ?? 1);
    const itemsPerDay = Math.max(1, Math.min(20, Number(sheet()?.calendar.itemsPerDay ?? 4)));
    const first = new Date(Date.UTC(year, month - 1, 1));
    const offset = (first.getUTCDay() - firstWeekday + 7) % 7;
    const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const weeks = Math.ceil((offset + count) / 7);
    return Array.from({ length: weeks * 7 }, (_, i) => {
      const date = new Date(Date.UTC(year, month - 1, i - offset + 1));
      const day = date.getUTCDate();
      const currentMonth = date.getUTCMonth() === month - 1;
      const epochDay = Math.floor(date.getTime() / 86_400_000);
      return { date, day, currentMonth, col: i % 7, week: Math.floor(i / 7), epochDay, itemsPerDay };
    });
  };

  // The size fields of this view's popover (refs: with several sheets open, ids in the page would repeat).
  let rowLimitInput: HTMLInputElement | undefined;
  let colLimitInput: HTMLInputElement | undefined;
  let itemsPerDayInput: HTMLInputElement | undefined;
  const saveLimits = () => {
    const rowLimit = (rowLimitInput?.value ?? "").trim();
    const colLimit = (colLimitInput?.value ?? "").trim();
    if (rowLimit && (!/^\d+$/.test(rowLimit) || Number(rowLimit) < 1 || Number(rowLimit) > gridLimitRows)) {
      setError(`Rows must be between 1 and ${gridLimitRows.toLocaleString()}.`);
      return;
    }
    if (colLimit && (!/^\d+$/.test(colLimit) || Number(colLimit) < 1 || Number(colLimit) > gridLimitCols)) {
      setError(`Columns must be between 1 and ${gridLimitCols.toLocaleString()}.`);
      return;
    }
    void run(() => setSheet(api, sheet()!.id, {
      ...(rowLimit ? { rows: Number(rowLimit), unlimited_rows: false } : { unlimited_rows: true }),
      ...(colLimit ? { cols: Number(colLimit), unlimited_cols: false } : { unlimited_cols: true }),
    })).then((saved) => { if (saved) setSizeOpen(false); });
  };
  const saveItemsPerDay = () => {
    const value = Number(itemsPerDayInput?.value);
    if (!Number.isInteger(value) || value < 1 || value > 20) {
      setError("Cells per day must be between 1 and 20.");
      return;
    }
    void run(() => setSheet(api, sheet()!.id, {
      calendar: { ...sheet()!.calendar, itemsPerDay: value },
    })).then((saved) => { if (saved) setSizeOpen(false); });
  };
  const applyConditionalRule = () => {
    const condition = conditionalCondition().trim();
    if (!/^(>=|<=|<>|=|>|<)\s*[-+]?\d+(?:\.\d+)?$/.test(condition)) {
      setError("Enter a comparison followed by a number, such as >=10 or <0.");
      return;
    }
    const range = targetRange();
    const active = targetRule();
    void run(async () => {
      if (active && active.kind !== "conditional") await deleteRule(api, active.id);
      await setRule(api, sheet()!.id, range, "conditional", {
        condition,
        style: { background: conditionalColor() },
      }, active?.kind === "conditional" ? active.id : undefined);
      await workbook.refresh();
      setConditionalOpen(false);
    });
  };

  const duplicateSheet = async (id: number) => {
    const source = workbook.value.find((item) => item.id === id);
    if (!source) return;
    const { id: newId } = await api.call<{ id: number }>("add-sheet", { channel_id: context.channel.id, name: `${source.name} copy` });
    for (let i = 0; i < source.cells.length; i += 500)
      await setCells(api, newId, source.cells.slice(i, i + 500).map((cell) => ({ row: cell.row, col: cell.col, value: cell.value, style: cell.style })));
    for (const rule of source.rules) await setRule(api, newId, rule.range, rule.kind, rule.config);
    setSelectedId(newId);
  };

  const reorder = (from: number, to: number) => {
    const ordered = [...workbook.value].sort((a, b) => a.z - b.z || a.id - b.id);
    const index = ordered.findIndex((item) => item.id === from);
    const target = ordered.findIndex((item) => item.id === to);
    if (index < 0 || target < 0 || index === target) return;
    const [moved] = ordered.splice(index, 1);
    ordered.splice(target, 0, moved);
    const position = ordered.findIndex((item) => item.id === moved.id);
    const before = ordered[position - 1]?.z;
    const after = ordered[position + 1]?.z;
    void run(() => moveSheet(api, moved.id, before === undefined ? (after ?? 1) - 1 : after === undefined ? before + 1 : (before + after) / 2));
  };

  createEffect(() => {
    const stopDragging = () => setDragging(false);
    const onMouseMove = (event: MouseEvent) => {
      if (!dragging()) return;
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(
        ".mw-sheets-cell[data-row][data-col], .mw-sheets-calendar-cell[data-row][data-col]",
      );
      if (!target) return;
      const at = { row: Number(target.dataset.row), col: Number(target.dataset.col) };
      if (Number.isInteger(at.row) && Number.isInteger(at.col) && keyOf(at) !== keyOf(selected())) selectCell(at, true);
    };
    const onPointerMove = (event: PointerEvent) => moveResize(event);
    const onPointerUp = () => finishResize();
    window.addEventListener("mouseup", stopDragging);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    onCleanup(() => {
      window.removeEventListener("mouseup", stopDragging);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    });
  });

  createEffect(() => {
    if (!sheet() || !scroller || !cursorOverlay) return;
    // Read only so the effect runs again for another sheet.
    void sheet()?.id;
    scroller.scrollTop = 0;
    scroller.scrollLeft = 0;
    setSelected({ row: 0, col: 0 });
    setRangeStart({ row: 0, col: 0 });
    setMultiSelected([]);
    setEditing(false);
    handleScroll();
    const resizeObserver = new ResizeObserver(handleScroll);
    resizeObserver.observe(scroller);
    requestAnimationFrame(handleScroll);
    const remove = context.cursors.draw(cursorOverlay, ({ x, y }) => ({
      x: rowHead + x * colWidth,
      y: colHead + y * rowHeight,
    }));
    redrawCursors = remove.redraw;
    onCleanup(() => { resizeObserver.disconnect(); remove.remove(); redrawCursors = undefined; });
  });

  let linkedTargetChecked = false;
  createEffect(() => {
    if (!workbook.loaded) return;
    if (linkedTargetChecked) return;
    linkedTargetChecked = true;
    const target = context.target();
    const found = target?.kind === "cell" ? workbook.value.flatMap((item) => item.cells).find((cell) => cell.id === Number(target.id)) : undefined;
    if (found) { setSelectedId(found.sheet_id); selectCell({ row: found.row, col: found.col }); }
  });

  // A calendar opens on the current month. (`calendar.month` was the month an editor paged to last, for everyone;
  // browsing is each reader's own now, so older sheets' saved month is no longer read.)

  return (
    <div class="mw-sheets">
      <header class="mw-sheets-toolbar">
        <Show when={sheet()}>
          {(current) => <>
            <Select value={current().mode} options={[
              { value: "grid", label: "Table", icon: "channel-table" },
              { value: "calendar", label: "Calendar", icon: "channel-stats" },
            ]} disabled={!canEditSheet()} onChange={(mode) => void run(() => setSheet(api, current().id, { mode }))} label="Sheet type" />
            <div class="mw-sheets-toolbar-group">
              <For each={[
                ["left", "text-left", "Align left"], ["center", "text-center", "Align center"], ["right", "text-right", "Align right"],
              ] as const}>{([value, icon, label]) =>
                <button type="button" class="icon-button mw-sheets-format-button"
                  classList={{ on: (shownStyle().align ?? "left") === value }}
                  title={label} aria-label={label} disabled={!canEditSheet()}
                  onClick={() => void formatSelection({ align: value })}><Icon name={icon} /></button>
              }</For>
              <span class="mw-sheets-toolbar-divider" />
              <For each={[
                ["top", "text-top", "Align top"], ["middle", "text-middle", "Align middle"], ["bottom", "text-bottom", "Align bottom"],
              ] as const}>{([value, icon, label]) =>
                <button type="button" class="icon-button mw-sheets-format-button"
                  classList={{ on: (shownStyle().verticalAlign ?? "middle") === value }}
                  title={label} aria-label={label} disabled={!canEditSheet()}
                  onClick={() => void formatSelection({ verticalAlign: value })}><Icon name={icon} /></button>
              }</For>
              <span class="mw-sheets-toolbar-divider" />
              <For each={[
                ["bold", "format-bold", "Bold"], ["italic", "format-italic", "Italic"],
                ["underline", "format-underline", "Underline"], ["strike", "format-strike", "Strikethrough"],
              ] as const}>{([key, icon, label]) =>
                <button type="button" class="icon-button mw-sheets-format-button"
                  classList={{ on: shownStyle()[key] === true }}
                  title={label} aria-label={label} disabled={!canEditSheet()}
                  onClick={() => void formatSelection({ [key]: !shownStyle()[key] })}><Icon name={icon} /></button>
              }</For>
            </div>
            <div class="mw-popover-anchor mw-sheets-toolbar-anchor">
              <button type="button" class="icon-button mw-sheets-format-button" title="Text color" aria-label="Text color"
                disabled={!canEditSheet()} onClick={() => setColorOpen(colorOpen() === "text" ? null : "text")}>
                <Icon name="text-color" /><span class="mw-sheets-color-bar" style={{ background: shownStyle().color || "var(--mw-text)" }} />
              </button>
              <Popover open={colorOpen() === "text"} onClose={() => setColorOpen(null)} label="Text color">
                <div class="mw-sheets-popover-content">
                  <strong>Text color</strong>
                  <ColorSwatches colors={tagColors} value={shownStyle().color ?? ""}
                    onPick={(color) => { void formatSelection({ color: color || undefined }); setColorOpen(null); }}
                    label="Text color" none custom small disabled={!canEditSheet()} />
                </div>
              </Popover>
            </div>
            <div class="mw-popover-anchor mw-sheets-toolbar-anchor">
              <button type="button" class="icon-button mw-sheets-format-button" title="Cell background" aria-label="Cell background"
                disabled={!canEditSheet()} onClick={() => setColorOpen(colorOpen() === "background" ? null : "background")}>
                <Icon name="cell-background" /><span class="mw-sheets-color-bar" style={{ background: shownStyle().background || "var(--mw-dark)" }} />
              </button>
              <Popover open={colorOpen() === "background"} onClose={() => setColorOpen(null)} label="Cell background">
                <div class="mw-sheets-popover-content">
                  <strong>Cell background</strong>
                  <ColorSwatches colors={tagColors} value={shownStyle().background ?? ""}
                    onPick={(color) => { void formatSelection({ background: color || undefined }); setColorOpen(null); }}
                    label="Cell background" none custom small disabled={!canEditSheet()} />
                </div>
              </Popover>
            </div>
            <div class="mw-popover-anchor mw-sheets-toolbar-anchor">
              <Select value={targetRule()?.kind ?? shownStyle().format ?? "number"} options={[
                { value: "number", label: "Number" }, { value: "percent", label: "Percent" }, { value: "currency", label: "Currency" },
                { value: "date", label: "Date" }, { value: "dropdown", label: "Dropdown" },
                { value: "checkbox", label: "Checkbox" }, { value: "conditional", label: "Conditional formatting" },
              ]} disabled={!canEditSheet()} onChange={chooseFieldOrFormat} label="Field type and number format" />
              <Popover open={conditionalOpen()} onClose={() => setConditionalOpen(false)} label="Conditional formatting">
                <div class="mw-sheets-popover-content">
                  <strong>Format cells when their value matches</strong>
                  <small>Enter a comparison and number, for example <code>&gt;=10</code> highlights values of 10 or more.</small>
                  <label>Condition<input aria-label="Conditional formatting condition" value={conditionalCondition()}
                    onInput={(event) => setConditionalCondition(event.currentTarget.value)} placeholder=">=10" /></label>
                  <ColorSwatches colors={tagColors} value={conditionalColor()} onPick={setConditionalColor}
                    label="Highlight color" small />
                  <button type="button" class="mw-box" disabled={!canEditSheet()} onClick={applyConditionalRule}>
                    Apply to selection
                  </button>
                </div>
              </Popover>
            </div>
            <Show when={shownStyle().format === "currency"}>
              <Select value={shownStyle().currency ?? "USD"} options={currencyOptions} search
                disabled={!canEditSheet()} onChange={(currency) => void formatSelection({ currency })} label="Currency" />
            </Show>
            <div class="mw-popover-anchor mw-sheets-toolbar-anchor">
              <button type="button" class="mw-button mw-box mw-sheets-transfer" disabled={!workbook.loaded} title="Import / export"
                onClick={() => setTransferOpen(transferOpen() === "import" ? null : "import")}><Icon name="download" /><span>Import / export</span></button>
              <Popover open={transferOpen() !== null} onClose={() => setTransferOpen(null)} label="Import and export">
                <div class="mw-sheets-popover-content">
                  <strong>Workbook files</strong>
                  <button type="button" class="mw-box" disabled={!canEditSheet()} onClick={() => importInput.click()}>Import workbook...</button>
                  <input ref={importInput} type="file" hidden accept=".xlsx,.xls,.ods,.csv"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (file) void importFile(file);
                    }} />
                  <small>Import creates one sheet for each worksheet. CSV creates one sheet.</small>
                  <For each={[
                    ["xlsx", "Excel workbook (.xlsx)"], ["xls", "Excel 97-2003 (.xls)"],
                    ["ods", "OpenDocument spreadsheet (.ods)"], ["csv", "Comma-separated values (.csv)"],
                  ] as const}>{([format, label]) =>
                    <button type="button" class="mw-box" onClick={() => exportFile(format)}>Export {label}</button>
                  }</For>
                </div>
              </Popover>
            </div>
          </>}
        </Show>
      </header>
      <div class="mw-sheets-formula">
        <code>{selectedName()}</code>
        <input ref={formulaEditor} aria-label="Formula bar" value={formulaText()} disabled={!canEditSheet()}
          onInput={(e) => setFormulaText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void commit(); }
            if (e.key === "Escape") { setFormulaText(raw(selected())); formulaEditor.blur(); }
          }} />
      </div>
      <Show when={workbook.error}>
        <div class="mw-sheets-error">{String(workbook.error)}</div>
      </Show>
      <Show when={error()}><div class="mw-sheets-error" role="status">{error()}</div></Show>
      <Show when={sheet()?.mode === "calendar"} fallback={
        <Show when={sheet()} fallback={<Skeleton kind="grid" header={false} />}>
        {(current) => <div class="mw-sheets-scroller" role="region" aria-label="Sheet cells" ref={scroller} tabIndex={0} onMouseDown={() => scroller.focus()} onMouseUp={() => setDragging(false)} onScroll={handleScroll} onKeyDown={onGridKey}
          onCopy={copy} onPaste={paste}>
          <div class="mw-sheets-grid-space" style={{
            width: `${rowHead + dimensions().colPositions[sizeCols()] + (current().cols != null && sizeCols() < gridLimitCols ? dimensions().cols.at(-1) ?? colWidth : 0)}px`,
            height: `${colHead + dimensions().rowPositions[sizeRows()] + (current().rows != null && sizeRows() < gridLimitRows ? dimensions().rows.at(-1) ?? rowHeight : 0)}px`,
          }}>
            {/* The headers ride in sticky strips: positioned from scroll events, they lagged behind touch scrolling. */}
            <div class="mw-sheets-head-strip top">
            <For each={shownCols()}>{(col) => <div class="mw-sheets-col-head" style={{
              left: `${rowHead + dimensions().colPositions[col]}px`,
              width: `${dimensions().cols[col]}px`,
            }}>
              {columnName(col)}
              <button type="button" class="mw-sheets-resize mw-sheets-resize-col" aria-label={`Resize column ${columnName(col)}`}
                disabled={!canEditSheet()} onPointerDown={(event) => beginResize(event, "column", col, dimensions().cols[col])} />
            </div>}</For>
            <Show when={current().cols != null && sizeCols() < gridLimitCols}>
              <button type="button" class="mw-sheets-edge-add mw-sheets-add-column mw-box" aria-label="Add column"
                title={`Add column after ${columnName(sizeCols() - 1)}`}
                disabled={!canEditSheet()} style={{
                  left: `${rowHead + dimensions().colPositions[sizeCols()]}px`, top: "0px",
                  width: `${dimensions().cols.at(-1) ?? colWidth}px`,
                }}
                onClick={() => void addCol(sizeCols())}><Icon name="add" /></button>
            </Show>
            </div>
            <div class="mw-sheets-head-strip left">
            <For each={shownRows()}>{(row) => <div class="mw-sheets-row-head" style={{
              top: `${colHead + dimensions().rowPositions[row]}px`,
              height: `${dimensions().rows[row]}px`,
            }}>
              {row + 1}
              <button type="button" class="mw-sheets-resize mw-sheets-resize-row" aria-label={`Resize row ${row + 1}`}
                disabled={!canEditSheet()} onPointerDown={(event) => beginResize(event, "row", row, dimensions().rows[row])} />
            </div>}</For>
            <Show when={current().rows != null && sizeRows() < gridLimitRows}>
              <button type="button" class="mw-sheets-edge-add mw-sheets-add-row mw-box" aria-label="Add row"
                title={`Add row after ${sizeRows()}`} disabled={!canEditSheet()}
                style={{
                  left: "0px", top: `${colHead + dimensions().rowPositions[sizeRows()]}px`,
                  height: `${dimensions().rows.at(-1) ?? rowHeight}px`,
                }}
                onClick={() => void addRow(sizeRows())}><Icon name="add" /></button>
            </Show>
            </div>
            <div class="mw-sheets-grid-corner" />
            <For each={shownRows()}>{(row) => <For each={shownCols()}>{(col) => {
              const at = { row, col };
              const cell = () => cellsByAddress().get(keyOf(at));
              const rule = () => activeRule(at);
              const options = () => Array.isArray(rule()?.config.options) ? rule()!.config.options as (string | { value: string; label: string; color?: string })[] : [];
              const checked = () => ["TRUE", "true", "1"].includes(raw(at));
              const own = () => context.presence.others().find((member) => stateRecord(member.state).editing === `${current().id}:${keyOf(at)}`);
              const ownProfile = () => own() ? context.users.get(own()!.userId) : null;
              const inputStyle = () => ({
                left: `${rowHead + dimensions().colPositions[col]}px`,
                top: `${colHead + dimensions().rowPositions[row]}px`,
                width: `${dimensions().cols[col]}px`,
                height: `${dimensions().rows[row]}px`,
                ...cellVisualStyle(at),
              });
              const selectedCell = () => selected().row === row && selected().col === col;
              const inSelection = () => {
                if (multiSelected().length) return multiSelected().some((cell) => keyOf(cell) === keyOf(at));
                const rect = selection();
                return row >= rect.top && row <= rect.bottom && col >= rect.left && col <= rect.right;
              };
              return (
                <div class="mw-sheets-cell" role="presentation" classList={{
                  selected: selectedCell(), "in-range": inSelection(), locked: !!own(),
                  "remote-range": remoteSelection(row, col), conflict: cellConflicts().has(conflictKey(current().id, at)),
                }}
                  title={cellConflicts().has(conflictKey(current().id, at)) ? "Recent simultaneous edit" : undefined}
                  style={{ ...inputStyle(), "z-index": selectedCell() ? 6 : undefined }}
                  data-row={row} data-col={col}
                  onMouseDown={(e) => {
                    if (e.ctrlKey || e.metaKey) { toggleMultiCell(at); return; }
                    if (e.shiftKey) selectCell(at, true); else selectCell(at);
                    setDragging(true);
                  }}
                  onContextMenu={(e) => cellMenu(e, at)}
                  onMouseEnter={() => { if (dragging()) selectCell(at, true); }}
                  onDblClick={() => beginEdit()}
                  onMouseMove={(e) => { const box = scroller.getBoundingClientRect(); context.cursors.move({ x: (e.clientX - box.left + scroller.scrollLeft - rowHead) / colWidth, y: (e.clientY - box.top + scroller.scrollTop - colHead) / rowHeight }); }}
                  onMouseLeave={() => context.cursors.move(null)}>
                  <Show when={ownProfile()}>{(person) => <span class="mw-sheets-lock" title={`${person().displayName} is editing`}>{person().displayName}</span>}</Show>
                  <Show when={rule()?.kind === "date" || cell()?.style.format === "date"} fallback={
                    <Show when={rule()?.kind === "dropdown"} fallback={
                      <Show when={rule()?.kind === "checkbox"} fallback={
                        <Show when={selectedCell() && editing()} fallback={<span>{formulaValue(at)}</span>}>
                          <input ref={(element) => { if (selectedCell()) cellEditor = element; }} aria-label={`Edit ${addressName(at)}`}
                            type="text" value={formulaText()} onInput={(e) => setFormulaText(e.currentTarget.value)}
                            onMouseDown={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") { e.preventDefault(); void commit().then(() => selectCell({ row: row + 1, col })); }
                              if (e.key === "Escape") { setEditing(false); setFormulaText(raw(at)); updatePresence(); }
                            }}
                            onBlur={() => { if (editing() && selectedCell()) void commit(); }} />
                        </Show>
                      }>
                        <button type="button" role="checkbox" class="mw-sheets-checkbox" disabled={!canEditSheet()} aria-label={`Toggle ${addressName(at)}`} aria-checked={checked()}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={() => void run(() => saveChanges([{ ...at, value: checked() ? "FALSE" : "TRUE" }], "Toggle checkbox"))}>
                          <Icon name={checked() ? "check" : "close"} size={14} />
                        </button>
                      </Show>
                    }>
                      <Select value={raw(at)} options={options().map((option) => typeof option === "string"
                        ? { value: option, label: option }
                        : { value: option.value, label: option.label, icon: undefined })}
                        disabled={!canEditSheet()}
                        onChange={(value) => void run(() => saveChanges([{ ...at, value }], "Choose dropdown value"))}
                        label={`Choose ${addressName(at)}`} />
                    </Show>
                  }>
                    <input type="date" aria-label={`Choose date for ${addressName(at)}`}
                      value={/^\d{4}-\d{2}-\d{2}$/.test(raw(at)) ? raw(at) : ""}
                      disabled={!canEditSheet()} onMouseDown={(event) => event.stopPropagation()}
                      onChange={(event) => void run(() => saveChanges([{ ...at, value: event.currentTarget.value || null }], "Set date"))} />
                  </Show>
                </div>
              );
            }}</For>}</For>
            <div class="mw-sheets-cursor-layer" ref={cursorOverlay} />
          </div>
        </div>}
        </Show>
      }>
        <div class="mw-sheets-calendar-grid">
          <For each={calendarDays()}>{(day) =>
            <section classList={{ outside: !day.currentMonth, picked: Math.floor(selected().row / day.itemsPerDay) === day.epochDay, today: monthKey(day.date) === monthKey(new Date()) && day.day === new Date().getUTCDate() }}
              style={{ "grid-column": `${day.col + 1}`, "grid-row": `${day.week + 1}` }}>
              <strong title={day.date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}>
                <span class="day-short">{day.date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", timeZone: "UTC" })}</span>
                <span class="day-long">{day.date.toLocaleDateString(undefined, { weekday: "short", month: "long", day: "numeric", timeZone: "UTC" })}</span>
              </strong>
              <For each={Array.from({ length: day.itemsPerDay }, (_, slot) => slot)}>
                {(slot) => {
                  const address = { row: day.epochDay * day.itemsPerDay + slot, col: 0 };
                  const rule = () => activeRule(address);
                  const selectedCell = () => selected().row === address.row && selected().col === address.col;
                  const inSelection = () => {
                    if (multiSelected().length) return multiSelected().some((item) => keyOf(item) === keyOf(address));
                    const bounds = selection();
                    return address.row >= bounds.top && address.row <= bounds.bottom && address.col >= bounds.left && address.col <= bounds.right;
                  };
                  const cellStyle = () => cellVisualStyle(address);
                  // Formatted while not being edited, like grid cells.
                  const [focused, setFocused] = createSignal(false);
                  const save = (value: string | null) =>
                    void run(() => saveChanges([{ ...address, value: value || null }], "Edit calendar item"));
                  const options = () => Array.isArray(rule()?.config.options)
                    ? rule()!.config.options as (string | { value: string; label: string })[] : [];
                  return <div class="mw-sheets-calendar-cell" role="presentation" classList={{
                    selected: selectedCell(), "in-range": inSelection(),
                    conflict: cellConflicts().has(conflictKey(sheet()!.id, address)),
                  }} style={cellStyle()} data-row={address.row} data-col="0"
                    title={cellConflicts().has(conflictKey(sheet()!.id, address)) ? "Recent simultaneous edit" : undefined}
                    onMouseDown={(event) => {
                      if (event.ctrlKey || event.metaKey) toggleMultiCell(address);
                      else {
                        selectCell(address, event.shiftKey);
                        setDragging(true);
                      }
                    }}
                    onMouseEnter={() => { if (dragging()) selectCell(address, true); }}
                    onMouseUp={() => setDragging(false)}
                    onContextMenu={(event) => cellMenu(event, address)}>
                    <Show when={rule()?.kind === "date" || styleAt(address).format === "date"} fallback={
                      <Show when={rule()?.kind === "dropdown"} fallback={
                        <Show when={rule()?.kind === "checkbox"} fallback={
                          <input aria-label={`${day.date.toISOString().slice(0, 10)} item ${slot + 1}`}
                            value={focused() ? raw(address) : formulaValue(address)} disabled={!canEditSheet()} onFocus={() => {
                              setFocused(true);
                              if (keyOf(selected()) !== keyOf(address)) selectCell(address);
                            }}
                            onBlur={() => setFocused(false)}
                            onChange={(event) => save(event.currentTarget.value)} />
                        }>
                          <button type="button" role="checkbox" class="mw-sheets-checkbox" disabled={!canEditSheet()}
                            aria-label={`Toggle ${addressName(address)}`} aria-checked={["TRUE", "true", "1"].includes(raw(address))}
                            onClick={() => save(["TRUE", "true", "1"].includes(raw(address)) ? "FALSE" : "TRUE")}>
                            <Icon name={["TRUE", "true", "1"].includes(raw(address)) ? "check" : "close"} size={14} />
                          </button>
                        </Show>
                      }>
                        <Select value={raw(address)} options={options().map((option) => typeof option === "string"
                          ? { value: option, label: option } : { value: option.value, label: option.label })}
                          disabled={!canEditSheet()} onChange={save} label={`Choose ${addressName(address)}`} />
                      </Show>
                    }>
                      <input type="date" aria-label={`${day.date.toISOString().slice(0, 10)} item ${slot + 1}`}
                        value={/^\d{4}-\d{2}-\d{2}$/.test(raw(address)) ? raw(address) : ""}
                        disabled={!canEditSheet()} onFocus={() => {
                          if (keyOf(selected()) !== keyOf(address)) selectCell(address);
                        }}
                        onChange={(event) => save(event.currentTarget.value)} />
                    </Show>
                  </div>;
                }}
              </For>
            </section>
          }</For>
        </div>
      </Show>
      <div class="mw-sheets-tabs" ref={tabs}>
        <div class="mw-sheets-tab-strip">
          <For each={[...workbook.value].sort((a, b) => a.z - b.z || a.id - b.id)}>{(item) =>
            <div class="mw-sheets-tab-wrap" draggable={context.can("edit_content") && !item.locked} onDragStart={(e) => e.dataTransfer?.setData("text/plain", String(item.id))}
              onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); reorder(Number(e.dataTransfer?.getData("text/plain")), item.id); }}>
              <Show when={renamingId() === item.id} fallback={
                <button type="button" class="mw-sheets-tab mw-box" classList={{ active: selectedSheet()?.id === item.id }} onClick={() => setSelectedId(item.id)}
                  onDblClick={() => { if (context.can("edit_content") && !item.locked) { setRenamingId(item.id); setRenameText(item.name); } }}
                  onContextMenu={(e) => {
                    if (!context.can("edit_content")) return;
                    e.preventDefault();
                    context.openContextMenu(e, [
                      { label: "Duplicate sheet", icon: "copy", action: () => void run(() => duplicateSheet(item.id)) },
                      { label: "Rename sheet", icon: "rename", action: () => { setRenamingId(item.id); setRenameText(item.name); }, disabled: item.locked },
                      "separator",
                      { label: "Delete sheet", icon: "delete", danger: true, action: () => setConfirmId(item.id), disabled: item.locked },
                    ]);
                  }} style={{ "border-bottom-color": item.color || undefined }}>{item.name}</button>
              }>
                <input ref={(element) => { renameInput = element; element.focus(); }}
                  aria-label="Sheet name" value={renameText()} disabled={!context.can("edit_content") || item.locked} onInput={(e) => setRenameText(e.currentTarget.value)}
                  onBlur={() => {
                    const name = renameText().trim();
                    if (name && name !== item.name) void run(() => renameSheet(api, item.id, name));
                    setRenamingId(undefined);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") { setRenameText(item.name); renameInput.blur(); }
                  }} />
              </Show>
              <button type="button" class="mw-sheets-lock-toggle mw-box" title={item.locked ? "Unlock sheet" : "Lock sheet"}
                aria-label={item.locked ? `Unlock ${item.name}` : `Lock ${item.name}`}
                disabled={item.locked ? !context.can("manage_channels") : !context.can("edit_content")}
                onClick={() => void run(() => setSheet(api, item.id, { locked: !item.locked }))}>
                <Icon name={item.locked ? "lock" : "unlock"} size={14} />
              </button>
            </div>
          }</For>
          <button type="button" class="mw-sheets-add mw-box" aria-label="Add sheet" disabled={!context.can("edit_content")} onClick={() =>
            void run(async () => {
              const { id } = await api.call<{ id: number }>("add-sheet", { channel_id: context.channel.id, name: `Sheet ${workbook.value.length + 1}` });
              setSelectedId(id);
            })}><Icon name="add" /></button>
        </div>
        <div class="mw-popover-anchor mw-sheets-size-control">
          <button type="button" class="mw-box" onClick={() => setSizeOpen((open) => !open)}>Size: {sizeLabel()}</button>
          <Popover open={sizeOpen() && !!sheet()} onClose={() => setSizeOpen(false)} label="Sheet size">
            <div class="mw-sheets-popover-content">
              <Show when={sheet()?.mode === "calendar"}>
                <label>Cells per day<input ref={itemsPerDayInput} type="number" min="1" max="20"
                  value={String(sheet()?.calendar.itemsPerDay ?? 4)} disabled={!canEditSheet()} /></label>
                <small>Changing this remaps existing calendar items by date.</small>
                <button type="button" class="mw-box" disabled={!canEditSheet()} onClick={saveItemsPerDay}>Apply calendar size</button>
              </Show>
              <Show when={sheet()?.mode !== "calendar"}>
                <strong>Grid bounds: {gridBoundsLabel()}</strong>
                <small>New sheets start at 1,000 rows × 26 columns. Blank values mean unlimited; the grid view caps at 100,000 × 1,000.</small>
                <label>Grid rows<input ref={rowLimitInput} type="number" min="1" max={gridLimitRows} value={sheet()?.rows ?? ""} placeholder="Unlimited" disabled={!canEditSheet()} /></label>
                <label>Grid columns<input ref={colLimitInput} type="number" min="1" max={gridLimitCols} value={sheet()?.cols ?? ""} placeholder="Unlimited" disabled={!canEditSheet()} /></label>
                <button type="button" class="mw-box" disabled={!canEditSheet()} onClick={saveLimits}>Apply size limits</button>
              </Show>
            </div>
          </Popover>
        </div>
        <Show when={sheet()?.mode === "calendar"}>
          <div class="mw-sheets-calendar">
            <button type="button" class="mw-box" title="Previous month" aria-label="Previous month" onClick={() => changeMonth(-1)}><Icon name="back" /></button>
            <button type="button" class="mw-box" title="Next month" aria-label="Next month" onClick={() => changeMonth(1)}><Icon name="forward" /></button>
            <button type="button" class="mw-box" onClick={() => setCalendarMonth(monthKey(new Date()))}>Today</button>
            <button type="button" class="mw-box" classList={{ on: allCells() }} aria-pressed={allCells()} disabled={!canEditSheet()}
              title="While on, the toolbar formats every calendar cell" onClick={() => setAllCells((on) => !on)}>
              <Icon name="layout-grid" size={14} /> All cells
            </button>
            <span>{(() => {
              const [year, month] = calendarMonth().split("-").map(Number);
              return `${year} ${new Date(Date.UTC(year, month - 1, 1)).toLocaleString(undefined, { month: "long", timeZone: "UTC" })}`;
            })()}</span>
          </div>
        </Show>
      </div>
      <ConfirmPrompt open={!!confirmId()} question="Delete this sheet and its cells and rules?" confirmLabel="Delete"
        onConfirm={() => {
          const id = confirmId();
          if (id) void run(() => deleteSheet(api, id));
          setConfirmId(undefined);
        }} onCancel={() => setConfirmId(undefined)} />
      <ConfirmPrompt open={!!structureDelete()} question={structureDelete()?.axis === "row"
        ? `Delete row ${Number(structureDelete()?.at ?? 0) + 1} and shift cells up?`
        : `Delete column ${columnName(Number(structureDelete()?.at ?? 0))} and shift cells left?`}
        confirmLabel="Delete" onConfirm={() => {
          const pending = structureDelete();
          setStructureDelete(undefined);
          if (pending) void run(() => pending.axis === "row"
            ? deleteRows(api, sheet()!.id, pending.at)
            : deleteCols(api, sheet()!.id, pending.at));
        }} onCancel={() => setStructureDelete(undefined)} />
    </div>
  );
}
