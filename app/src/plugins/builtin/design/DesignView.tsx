import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import IconSearch from "./IconSearch";
import { fetchIcon } from "./iconify";
import { userMessage } from "../../../api/client";
import { setSynced } from "../../../core/content";
import { uploadAndPost } from "../../../core/files";
import { historyKeys } from "../../../core/history";
import { copyLink } from "../../../core/links";
import { Icon } from "../../../theme/icons";
import Collapse from "../../../ui/Collapse";
import HistoryControls from "../../../ui/HistoryControls";
import UploadList from "../../../ui/UploadList";
import type { ChannelContext, MenuEntry } from "../../types";
import {
  addVariant, combineAsVariants, copyText, createComponent, createInstance, detachInstances, duplicate, finishText, flip, frameSelection, groupSelection, ungroup, nudge, paste,
  resetOverrides, toggleLocked, toggleVisible, addNote, arrangeSelection, normalizable, normalizeSelection, rotateBy,
} from "./actions";
import type { Place } from "./ComponentSection";
import Player from "./Player";
import PrototypePanel from "./PrototypePanel";
import TabUnderline from "../../../ui/TabUnderline";
import { PaneButton, createPanes } from "../../../ui/narrowPanes";
import { narrow } from "../../../core/ui";
import Canvas, { type CanvasControls } from "./Canvas";
import ZoomBar from "../canvas/ZoomBar";
import { createEditor, layers, type PanelTab, type Tool } from "./editor";
import LayersPanel from "./LayersPanel";
import { removeNodes, restoreNodes } from "./data";
import { boxAt, defaultProps, solid, type Point } from "./model";
import PropertiesPanel from "./PropertiesPanel";
import Shortcuts from "./Shortcuts";
import { panelWidth, savePanelWidth, setPanelWidth } from "./panels";
import ResizeHandle from "../../../ui/ResizeHandle";
import { solidMount } from "../../solid";
import Select from "../../../ui/Select";
import "../views.css";
import "./design.css";
import { copyToClipboard } from "../../../ui/clipboard";

const tools: { id: Tool; icon: string; label: string; key: string }[] = [
  { id: "move", icon: "design-move", label: "Move", key: "V" },
  { id: "hand", icon: "design-hand", label: "Hand", key: "H" },
  { id: "frame", icon: "design-frame", label: "Frame", key: "F" },
  { id: "rect", icon: "design-rect", label: "Rectangle", key: "R" },
  { id: "ellipse", icon: "design-ellipse", label: "Ellipse", key: "O" },
  { id: "line", icon: "design-line", label: "Line", key: "L" },
  { id: "pen", icon: "design-pen", label: "Pen", key: "P" },
  { id: "pencil", icon: "design-pencil", label: "Pencil", key: "Shift+P" },
  { id: "text", icon: "design-text", label: "Text", key: "T" },
];
const shortcutsPanel = "design-shortcuts";
const panelTabs: { id: PanelTab; label: string }[] = [{ id: "design", label: "Design" }, { id: "prototype", label: "Prototype" }];
const toolKeys: Record<string, Tool> = { v: "move", h: "hand", f: "frame", a: "frame", r: "rect", o: "ellipse", l: "line", t: "text" };

// A design document: frames, shapes, text and images on an endless page, a layers list and properties.
export default function DesignView(props: { context: ChannelContext }) {
  const ctx = props.context;
  // A design is only usable with its images, so opening one keeps the channel synced on this device.
  setSynced(ctx.workspace.id, { kind: "channel", id: ctx.channel.id }, true);
  const ed = createEditor(ctx);
  const panes = createPanes<"layers" | "properties">();
  const uploadPlace = `${ctx.workspace.id}:${ctx.channel.id}`;
  const [spaceDown, setSpaceDown] = createSignal(false);
  let canvas!: CanvasControls;
  let root!: HTMLDivElement;
  let picker!: HTMLInputElement;
  let menuAt: Point | null = null;

  const fail = (e: unknown) => ed.setError(e instanceof Error && !("code" in e) ? e.message : userMessage(e));
  const undoKeys = historyKeys(ctx.history, fail);

  const addImages = (files: File[], at: Point) => ed.run(async () => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) throw new Error("Only images can be added to a design.");
    const parent = ed.frameAt(at);
    let x = at.x;
    const ids: number[] = [];
    for (const file of images) {
      const id = await uploadAndPost(uploadPlace, file, async (upload) => {
        const natural = { w: upload.width ?? 300, h: upload.height ?? 200 };
        const scale = Math.min(1, 800 / Math.max(natural.w, natural.h));
        const width = natural.w * scale;
        const height = natural.h * scale;
        const box = boxAt({ origin: { x, y: at.y - height / 2 }, angle: 0 }, ed.world(parent), width, height);
        x += width + 20;
        const [added] = await ed.add([{
          kind: "image", name: file.name.replace(/\.[^.]+$/, ""), parent_id: parent, ...box, props: defaultProps("image"),
          url: upload.url, thumb: upload.thumb,
        }], "", false);
        return added;
      });
      if (id !== null && id !== undefined) ids.push(id);
    }
    if (ids.length === 0) return;
    ed.select(ids);
    ed.history.push({ label: `Add ${ids.length === 1 ? "image" : `${ids.length} images`}`, icon: "add",
      undo: () => removeNodes(ctx.api, ids), redo: () => restoreNodes(ctx.api, ids) });
  });

  // Pasted SVG markup becomes a vector layer at its own size; an icon (`fit`) at that size, its currentColor tinted
  // with the ink that reads where it lands (changed later like any color).
  const addSvg = (markup: string, at: Point, icon?: { name: string; fit: number }) => ed.run(async () => {
    const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
    const svg = doc.documentElement;
    if (svg.nodeName !== "svg") throw new Error("That isn't SVG.");
    const viewBox = (svg.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
    const parent = ed.frameAt(at);
    let width = Number.parseFloat(svg.getAttribute("width") ?? "") || viewBox[2] || 100;
    let height = Number.parseFloat(svg.getAttribute("height") ?? "") || viewBox[3] || 100;
    if (icon) {
      const ratio = (viewBox[2] || 1) / (viewBox[3] || 1);
      [width, height] = ratio >= 1 ? [icon.fit, icon.fit / ratio] : [icon.fit * ratio, icon.fit];
    }
    const tint = icon && markup.includes("currentColor") ? solid(ed.inkIn(parent)) : null;
    const box = boxAt({ origin: { x: at.x - width / 2, y: at.y - height / 2 }, angle: 0 }, ed.world(parent), width, height);
    const ids = await ed.add([{ kind: "svg", name: icon?.name ?? "Vector", parent_id: parent, ...box, props: { ...defaultProps("svg"), svg: markup, tint } }],
      icon ? `Add icon ${icon.name}` : "Paste vector");
    ed.select(ids);
  });

  const addIcon = (name: string, at: Point) => ed.run(async () => {
    await addSvg(await fetchIcon(name), at, { name: name.split(":")[1] ?? name, fit: 48 / ed.view().zoom });
  });
  // Icons picked in the panel go where "Add icon here" was chosen (each next one to the right), else the view's middle.
  let iconSpot: Point | null = null;
  const insertIcon = (name: string) => {
    const at = iconSpot ?? canvas.toWorld(canvas.center());
    if (iconSpot) iconSpot = { x: iconSpot.x + 56 / ed.view().zoom, y: iconSpot.y };
    void addIcon(name, at);
  };
  const iconsPanel = "design-icons";
  const iconsView = () => solidMount(() => <IconSearch canEdit={ed.canEdit()} onInsert={insertIcon} />);
  const toggleIcons = () => {
    iconSpot = null;
    ctx.toggleSidePanel(iconsPanel, "Icons", iconsView());
  };
  const iconsHere = (at: Point) => {
    iconSpot = at;
    if (!ctx.isSidePanelOpen(iconsPanel)) ctx.openSidePanel("Icons", iconsView(), iconsPanel);
  };

  const pasteText = async (text: string, at: Point) => {
    if (await paste(ed, text)) return;
    if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text)) await addSvg(text.trim(), at);
  };

  const pasteFromClipboard = (at: Point) => ed.run(async () => {
    const files: File[] = [];
    let text = "";
    for (const item of await navigator.clipboard.read()) {
      for (const type of item.types) {
        if (type.startsWith("image/") && type !== "image/svg+xml") files.push(new File([await item.getType(type)], `Pasted.${type.slice(6)}`, { type }));
        else if (type === "text/plain") text = await (await item.getType(type)).text();
      }
    }
    if (text) await pasteText(text, at);
    else if (files.length) await addImages(files, at);
    else throw new Error("There is nothing to paste.");
  });

  const copy = () => void copyToClipboard(copyText(ed));

  const zoomToSelection = () => {
    const rects = ed.topSelected().map(ed.worldBounds);
    if (rects.length) canvas.fit(rects);
  };
  const place: Place = {
    reveal: (ids) => {
      ed.select(ids);
      zoomToSelection();
    },
    center: () => canvas.toWorld(canvas.center()),
  };

  // Plays the page-level frame around the selection, else the first one.
  const pageFrame = (id: number) => [id, ...ed.ancestors(id)].reverse().find((a) => ed.node(a)?.kind === "frame");
  // A hint that goes away by itself, unlike errors from failed changes.
  const flash = (text: string) => {
    ed.setError(text);
    setTimeout(() => ed.error() === text && ed.setError(""), 4000);
  };
  const play = (frame?: number) => {
    if (ed.playing() !== null) return ed.setPlaying(null);
    const start = frame ?? ed.topSelected().map(pageFrame).find((id) => id !== undefined)
      ?? ed.children(null).find((id) => ed.node(id)!.kind === "frame" && ed.node(id)!.props.visible);
    if (start === undefined) return flash("Add a frame to play.");
    ed.setEditing(null);
    ed.setPlaying(start);
  };

  const menu = (e: MouseEvent) => {
    const has = ed.topSelected().length > 0;
    const many = ed.topSelected().length > 1;
    const can = ed.canEdit();
    const sel = () => ed.topSelected();
    const anyHidden = sel().some((id) => !ed.node(id)!.props.visible);
    const anyUnlocked = sel().some((id) => !ed.node(id)!.props.locked);
    const at = menuAt ?? canvas.toWorld(canvas.center());
    const text = !many && ed.node(sel()[0])?.kind === "text" ? sel()[0] : null;
    const entries: MenuEntry[] = has ? [
      ...(text !== null ? [{ label: "Edit text", icon: "design-text", disabled: !can, action: () => ed.setEditing(text) }, "separator" as const] : []),
      { label: "Copy", icon: "copy", action: copy },
      { label: "Paste", icon: "add", disabled: !can, action: () => void pasteFromClipboard(at) },
      { label: "Add icon here...", icon: "icons", disabled: !can, action: () => iconsHere(at) },
      { label: "Duplicate", icon: "copy", disabled: !can, action: () => void duplicate(ed) },
      { label: "Copy link", icon: "link", disabled: many, action: () => copyLink(ctx.linkTo({ kind: "node", id: sel()[0] })) },
      "separator",
      { label: "Bring to front", icon: "bring-to-front", disabled: !can, action: () => ed.reorder("front") },
      { label: "Bring forward", icon: "bring-to-front", disabled: !can, action: () => ed.reorder("forward") },
      { label: "Send backward", icon: "bring-to-front", disabled: !can, action: () => ed.reorder("backward") },
      { label: "Send to back", icon: "bring-to-front", disabled: !can, action: () => ed.reorder("back") },
      "separator",
      { label: "Flip horizontal", icon: "flip-h", disabled: !can, action: () => flip(ed, "x") },
      { label: "Flip vertical", icon: "flip-v", disabled: !can, action: () => flip(ed, "y") },
      { label: "Rotate 90°", icon: "rotate", disabled: !can, action: () => rotateBy(ed, 90) },
      ...(many ? [arrangeEntry(can)] : []),
      { label: "Group selection", icon: "design-group", disabled: !can, action: () => void groupSelection(ed) },
      ...(sel().some((id) => ed.node(id)!.kind === "group") ? [{ label: "Ungroup", icon: "design-ungroup", disabled: !can, action: () => void ungroup(ed) }] : []),
      { label: "Frame selection", icon: "design-frame", disabled: !can, action: () => void frameSelection(ed) },
      ...componentEntries(),
      { label: anyHidden ? "Show" : "Hide", icon: anyHidden ? "visible" : "hidden", disabled: !can, action: () => toggleVisible(ed) },
      { label: anyUnlocked ? "Lock" : "Unlock", icon: anyUnlocked ? "lock" : "unlock", disabled: !can, action: () => toggleLocked(ed) },
      { label: "Zoom to selection", icon: "fullscreen", action: zoomToSelection },
      "separator",
      { label: many ? `Delete ${layers(sel().length)}` : "Delete", icon: "delete", danger: true, disabled: !can, action: () => ed.remove(sel()) },
    ] : [
      { label: "Add note here", icon: "diagram-note", disabled: !can, action: () => void addNote(ed, at) },
      { label: "Paste", icon: "add", disabled: !can, action: () => void pasteFromClipboard(at) },
      { label: "Add images...", icon: "image", disabled: !can, action: () => picker.click() },
      { label: "Add icon here...", icon: "icons", disabled: !can, action: () => iconsHere(at) },
      "separator",
      { label: "Select all", icon: "check", disabled: ed.children(null).length === 0, action: () => ed.select(ed.children(null)) },
      { label: "Fit everything", icon: "fit-all", action: () => canvas.fit() },
      { label: "Actual size", icon: "zoom-in", action: () => canvas.zoomTo(1) },
    ];
    ctx.openContextMenu(e, entries);
  };

  // Arranging and normalizing two or more layers, like a reference board.
  const arrangeItems = (can: boolean): MenuEntry[] => {
    const sizing = normalizable(ed).length < 2 || !can;
    return [
      { label: "Arrange optimally", icon: "layout-grid", disabled: !can, action: () => arrangeSelection(ed, "optimal") },
      { label: "Arrange in a row", icon: "arrange-row", disabled: !can, action: () => arrangeSelection(ed, "horizontal") },
      { label: "Arrange in a column", icon: "arrange-column", disabled: !can, action: () => arrangeSelection(ed, "vertical") },
      { label: "Arrange in a grid", icon: "view-grid", disabled: !can, action: () => arrangeSelection(ed, "grid") },
      "separator",
      { label: "Same height", icon: "normalize-height", disabled: sizing, action: () => normalizeSelection(ed, "height") },
      { label: "Same width", icon: "normalize-width", disabled: sizing, action: () => normalizeSelection(ed, "width") },
      { label: "Same size", icon: "normalize-size", disabled: sizing, action: () => normalizeSelection(ed, "size") },
    ];
  };
  const arrangeEntry = (can: boolean): MenuEntry => ({ label: "Arrange", icon: "layout-grid", items: arrangeItems(can) });

  const componentEntries = (): MenuEntry[] => {
    const sel = ed.topSelected();
    const can = ed.canEdit();
    const one = sel.length === 1 ? ed.node(sel[0]) : undefined;
    const instances = sel.filter((id) => ed.node(id)!.props.instanceOf !== null);
    const changed = sel.some((id) => (ed.node(id)!.props.instanceOf !== null ? ed.instanceLayers(id) : [id])
      .some((l) => ed.node(l)!.props.overrides.length > 0));
    return [
      ...(one?.props.main
        ? [{ label: "Create instance", icon: "design-instance", disabled: !can, action: () => void createInstance(ed, one.id) }]
        : sel.every((id) => ed.instanceOf(id) === null)
          ? [{ label: "Create component", icon: "design-component", disabled: !can, action: () => void createComponent(ed) }] : []),
      ...(one && one.props.instanceOf !== null && ed.node(one.props.instanceOf)?.props.main
        ? [{ label: "Go to main component", icon: "design-component", action: () => place.reveal([one.props.instanceOf!]) }] : []),
      ...(sel.length > 1 && sel.every((id) => ed.node(id)!.props.main)
        ? [{ label: "Combine as variants", icon: "design-component", disabled: !can, action: () => void combineAsVariants(ed) }] : []),
      ...(one?.props.main && ed.node(one.parentId)?.props.variantSet
        ? [{ label: "Add variant", icon: "add", disabled: !can, action: () => void addVariant(ed, one.id) }] : []),
      ...(changed ? [{ label: "Reset overrides", icon: "undo", disabled: !can, action: () => resetOverrides(ed) }] : []),
      ...(instances.length ? [{ label: "Detach instance", icon: "design-detach", disabled: !can, action: () => detachInstances(ed) }] : []),
    ];
  };

  const editingText = (e: Event) => {
    const el = e.target as HTMLElement;
    return !!el.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])");
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (editingText(e)) return;
    // The canvas first: while the pen draws, undo takes back its last point.
    if (ed.canEdit() && canvas.key(e)) return e.preventDefault();
    undoKeys(e);
    if (e.defaultPrevented) return;
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    const can = ed.canEdit();
    const sel = ed.topSelected();
    const handled = () => e.preventDefault();
    if (k === " ") { setSpaceDown(true); handled(); }
    else if ((k === "delete" || k === "backspace") && sel.length && can) { ed.remove(sel); handled(); }
    else if (k === "escape") {
      if (ed.tool() !== "move") ed.setTool("move");
      else if (sel.length === 1 && ed.node(sel[0])!.parentId !== null) ed.select([ed.node(sel[0])!.parentId!]);
      else ed.select([]);
    }
    else if (mod && k === "a") { ed.select(sel.length ? ed.children(ed.node(sel[0])!.parentId) : ed.children(null)); handled(); }
    else if (mod && k === "d" && can) { void duplicate(ed); handled(); }
    else if (mod && e.altKey && k === "g" && can) { void frameSelection(ed); handled(); }
    else if (mod && e.altKey && k === "k" && sel.length && can) { void createComponent(ed); handled(); }
    else if (mod && e.altKey && k === "b" && sel.length && can) { detachInstances(ed); handled(); }
    else if (mod && e.altKey && k === "enter") { play(); handled(); }
    else if (mod && e.shiftKey && k === "g" && can) { void ungroup(ed); handled(); }
    else if (mod && k === "g" && can) { void groupSelection(ed); handled(); }
    else if (mod && e.shiftKey && k === "h" && can) { toggleVisible(ed); handled(); }
    else if (mod && e.shiftKey && k === "l" && can) { toggleLocked(ed); handled(); }
    else if (mod && (e.key === "]" || e.key === "}") && can) { ed.reorder(e.shiftKey ? "front" : "forward"); handled(); }
    else if (mod && (e.key === "[" || e.key === "{") && can) { ed.reorder(e.shiftKey ? "back" : "backward"); handled(); }
    else if (mod && (k === "0")) { canvas.zoomTo(1); handled(); }
    else if (e.shiftKey && (e.code === "Digit1")) { canvas.fit(); handled(); }
    else if (e.shiftKey && (e.code === "Digit2")) { zoomToSelection(); handled(); }
    else if (e.shiftKey && (e.code === "Digit0")) { canvas.zoomTo(1); handled(); }
    else if (k === "+" || k === "=") { canvas.zoomBy(1.25); handled(); }
    else if (k === "-") { canvas.zoomBy(1 / 1.25); handled(); }
    else if (k.startsWith("arrow") && sel.length && can) {
      const step = e.shiftKey ? 10 : 1;
      nudge(ed, { x: k === "arrowleft" ? -step : k === "arrowright" ? step : 0, y: k === "arrowup" ? -step : k === "arrowdown" ? step : 0 });
      handled();
    }
    else if (e.key === "F2" && sel.length === 1 && can) { ed.setRenaming(sel[0]); handled(); }
    else if (k === "enter" && sel.length === 1) {
      const n = ed.node(sel[0])!;
      if (e.shiftKey) { if (n.parentId !== null) ed.select([n.parentId]); }
      else if ((n.kind === "text" || n.kind === "path") && can) ed.setEditing(n.id);
      else if (ed.children(n.id).length) ed.select(ed.children(n.id));
      handled();
    }
    else if (!mod && !e.altKey && e.shiftKey && (k === "h" || k === "v") && sel.length && can) { flip(ed, k === "h" ? "x" : "y"); handled(); }
    else if (!mod && !e.altKey && !e.shiftKey && k === "n" && can) { void addNote(ed, canvas.toWorld(canvas.center())); handled(); }
    else if (!mod && e.altKey && !e.shiftKey && k === "r" && sel.length && can) { rotateBy(ed, 90); handled(); }
    else if (!mod && !e.altKey && k === "p" && can) ed.setTool(e.shiftKey ? "pencil" : "pen");
    else if (!mod && !e.altKey && toolKeys[k] && (can || toolKeys[k] === "move" || toolKeys[k] === "hand")) ed.setTool(toolKeys[k]);
  };

  // A followed link: select the layer and frame it once the document is loaded.
  let handled: unknown = null;
  createEffect(() => {
    const target = ctx.target();
    if (target?.kind !== "node" || target === handled || !ed.live.loaded) return;
    handled = target;
    const id = Number(target.id);
    if (!ed.node(id)) return ed.setError("That layer is no longer in this design.");
    ed.select([id]);
    queueMicrotask(zoomToSelection);
  });

  onMount(() => {
    const onKeyUp = (e: KeyboardEvent) => e.key === " " && setSpaceDown(false);
    const here = (e: Event) => root.contains(document.activeElement) && !editingText(e);
    const onCopy = (e: ClipboardEvent) => {
      if (!here(e) || ed.topSelected().length === 0) return;
      e.preventDefault();
      e.clipboardData?.setData("text/plain", copyText(ed));
    };
    const onCut = (e: ClipboardEvent) => {
      if (!here(e) || ed.topSelected().length === 0 || !ed.canEdit()) return;
      onCopy(e);
      ed.remove(ed.topSelected(), "Cut");
    };
    // Linux pastes the selected text on a middle click, which pans here.
    let middleAt = -Infinity;
    const onMiddle = (e: PointerEvent) => e.button === 1 && (middleAt = performance.now());
    const onPaste = (e: ClipboardEvent) => {
      if (!here(e) || !ed.canEdit()) return;
      if (performance.now() - middleAt < 500) return e.preventDefault();
      e.preventDefault();
      const at = canvas.toWorld(canvas.center());
      const files = [...(e.clipboardData?.files ?? [])];
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text) void ed.run(() => pasteText(text, at));
      else if (files.length) void addImages(files, at);
    };
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("copy", onCopy);
    window.addEventListener("cut", onCut);
    window.addEventListener("paste", onPaste);
    window.addEventListener("pointerdown", onMiddle, true);
    window.addEventListener("pointerup", onMiddle, true);
    onCleanup(() => {
      window.removeEventListener("pointerdown", onMiddle, true);
      window.removeEventListener("pointerup", onMiddle, true);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("copy", onCopy);
      window.removeEventListener("cut", onCut);
      window.removeEventListener("paste", onPaste);
    });
  });

  return (
    <div class="view design" role="presentation" ref={root} onKeyDown={onKeyDown}>
      <header class="view-header">
        <div class="view-tools mw-box" role="toolbar" aria-label="Tools">
          <For each={tools}>
            {(t) => (
              <button class="icon-button" classList={{ on: ed.tool() === t.id }} title={`${t.label} (${t.key})`} aria-label={t.label}
                aria-pressed={ed.tool() === t.id} disabled={!ed.canEdit() && t.id !== "move" && t.id !== "hand"}
                onClick={() => ed.setTool(t.id)}>
                <Icon name={t.icon} />
              </button>
            )}
          </For>
          <button class="icon-button" title="Add images" aria-label="Add images" disabled={!ed.canEdit()} onClick={() => picker.click()}>
            <Icon name="image" />
          </button>
          <button class="icon-button" title="Arrange (2 or more selected)" aria-label="Arrange" disabled={!ed.canEdit() || ed.topSelected().length < 2}
            onClick={(e) => ctx.openContextMenu(e, arrangeItems(ed.canEdit()))}>
            <Icon name="layout-grid" />
          </button>
          <button class="icon-button" title="Add note (N)" aria-label="Add note" disabled={!ed.canEdit()}
            onClick={() => void addNote(ed, canvas.toWorld(canvas.center()))}>
            <Icon name="diagram-note" />
          </button>
          <button class="icon-button" classList={{ on: ctx.isSidePanelOpen(iconsPanel) }} title="Icons" aria-label="Icons"
            aria-expanded={ctx.isSidePanelOpen(iconsPanel)} onClick={toggleIcons}>
            <Icon name="icons" />
          </button>
        </div>
        <Show when={ed.palettes.value.palettes.length > 1}>
          <div class="view-tools mw-box">
            <Select class="design-palette-switch" label="Palette shown (for everyone)" value={ed.activePalette()}
              prefix={<Icon name="design-palette" size={14} />}
              options={ed.palettes.value.palettes.map((p) => ({ value: p.id, label: p.name }))} onChange={ed.choosePalette} />
          </div>
        </Show>
        <div class="view-tools view-history mw-box">
          <HistoryControls history={ctx.history} onError={fail} />
        </div>
        <Show when={narrow()}>
          <div class="view-tools mw-box">
            <PaneButton panes={panes} pane="layers" icon="design-group" label="Layers" />
            <PaneButton panes={panes} pane="properties" icon="settings" label="Properties" />
          </div>
        </Show>
        <div class="view-tools mw-box">
          <button class="icon-button" classList={{ on: ed.playing() !== null }} title="Play (Ctrl+Alt+Enter)" aria-label="Play"
            aria-pressed={ed.playing() !== null} onClick={() => play()}>
            <Icon name="play" />
          </button>
        </div>
        <input ref={picker} type="file" accept="image/*" multiple hidden onChange={(e) => {
          void addImages([...(e.currentTarget.files ?? [])], canvas.toWorld(canvas.center()));
          e.currentTarget.value = "";
        }} />
      </header>
      <Collapse open={!!ed.error()}><p class="view-error">{ed.error()}</p></Collapse>
      <div class="design-body">
        <div class="design-side" classList={panes.classes("layers", "left")} style={{ width: panelWidth("layers") ? `${panelWidth("layers")}px` : undefined }}>
          <LayersPanel editor={ed} onContextMenu={(e) => { menuAt = null; menu(e); }} />
          <ResizeHandle edge="right" label="Resize layers" setWidth={(w) => setPanelWidth("layers", w)} save={() => savePanelWidth("layers")} />
        </div>
        <div class="design-stage">
          <Canvas editor={ed} context={ctx} spaceDown={spaceDown()} controls={(c) => (canvas = c)}
            onContextMenu={(e, at) => { menuAt = at; menu(e); }}
            onFiles={(files, at) => void addImages(files, at)}
            onIcon={(name, at) => void addIcon(name, at)}
            onFinishText={(id, text, isNew) => finishText(ed, id, text, isNew)} />
          <ZoomBar zoom={ed.view().zoom} onZoomOut={() => canvas.zoomBy(1 / 1.25)} onZoomIn={() => canvas.zoomBy(1.25)}
            onActual={() => canvas.zoomTo(1)} onFit={() => canvas.fit()} fitLabel="Fit everything"
            keys={{ out: "-", in: "+", actual: "Shift+0", fit: "Shift+1" }} />
          <button class="design-help icon-button mw-box" classList={{ on: ctx.isSidePanelOpen(shortcutsPanel) }}
            title="Shortcuts" aria-label="Shortcuts" aria-expanded={ctx.isSidePanelOpen(shortcutsPanel)}
            onClick={() => ctx.toggleSidePanel(shortcutsPanel, "Shortcuts", solidMount(() => <Shortcuts />))}>
            <Icon name="help" />
          </button>
          <div class="design-uploads" onPointerDown={(e) => e.stopPropagation()}>
            <UploadList place={uploadPlace} />
          </div>
          <Show when={!ed.canEdit()}>
            <p class="design-readonly">You can look but not edit: you need the "Edit content" permission.</p>
          </Show>
        </div>
        <div class="design-side" classList={panes.classes("properties", "right")} style={{ width: panelWidth("properties") ? `${panelWidth("properties")}px` : undefined }}>
          <div class="design-side-column">
            <nav class="settings-tabs design-tabs" aria-label="Panels">
              <For each={panelTabs}>
                {(t) => (
                  <button class="settings-tab" classList={{ active: ed.panelTab() === t.id }} aria-current={ed.panelTab() === t.id}
                    onClick={() => ed.setPanelTab(t.id)}>
                    {t.label}
                  </button>
                )}
              </For>
              <TabUnderline active={ed.panelTab()} />
            </nav>
            <Show when={ed.panelTab() === "prototype"} fallback={<PropertiesPanel editor={ed} place={place} />}>
              <PrototypePanel editor={ed} onPlay={(frame) => play(frame)} />
            </Show>
          </div>
          <ResizeHandle edge="left" label="Resize properties" setWidth={(w) => setPanelWidth("properties", w)} save={() => savePanelWidth("properties")} />
        </div>
        <Show when={ed.playing()}>
          {(start) => <Player editor={ed} start={start()} onClose={() => {
            ed.setPlaying(null);
            root.querySelector<HTMLElement>(".design-board")?.focus({ preventScroll: true });
          }} />}
        </Show>
      </div>
    </div>
  );
}
