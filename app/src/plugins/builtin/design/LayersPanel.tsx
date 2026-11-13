import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { Icon } from "../../../theme/icons";
import { toggleLocked, toggleVisible } from "./actions";
import { layers, type Editor } from "./editor";
import { between, nodeIcon } from "./model";
import { createTreeStop, treeKeys, treeRow, treeRowOf } from "../../../ui/treeKeys";

type Drop = { id: number; where: "above" | "below" | "inside" };

// The layer tree, top layers first,'s layers list: select, rename, hide, lock, and drag to reorder or nest.
export default function LayersPanel(props: { editor: Editor; onContextMenu: (e: MouseEvent) => void }) {
  const ed = props.editor;
  const [collapsed, setCollapsed] = createSignal<Set<number>>(new Set());
  const [drop, setDrop] = createSignal<Drop | null>(null);
  const renaming = ed.renaming;
  const setRenaming = ed.setRenaming;
  let anchor: number | null = null;
  let list!: HTMLDivElement;

  const rows = createMemo(() => {
    const ids: number[] = [];
    const depth = new Map<number, number>();
    const walk = (parent: number | null, d: number) => {
      for (const id of [...ed.children(parent)].reverse()) {
        ids.push(id);
        depth.set(id, d);
        if (!collapsed().has(id)) walk(id, d + 1);
      }
    };
    walk(null, 0);
    return { ids, depth };
  });

  // Selecting on the canvas opens the frames around the layer and scrolls to it.
  createEffect(() => {
    const sel = ed.selected();
    const closed = sel.flatMap((id) => ed.ancestors(id)).filter((a) => collapsed().has(a));
    if (closed.length) setCollapsed(new Set([...collapsed()].filter((id) => !closed.includes(id))));
    const last = sel.at(-1);
    if (last !== undefined) queueMicrotask(() => list.querySelector(`[data-layer="${last}"]`)?.scrollIntoView({ block: "nearest" }));
  });

  const toggleOpen = (id: number) => {
    const next = new Set(collapsed());
    next.has(id) ? next.delete(id) : next.add(id);
    setCollapsed(next);
  };

  const treeStop = createTreeStop(() => rows().ids, () => ed.selected().at(-1));

  // A click on a row, or Enter on it: Shift selects the range from the last one, Ctrl adds or takes one.
  const click = (e: Pick<MouseEvent, "shiftKey" | "ctrlKey" | "metaKey">, id: number) => {
    if (e.shiftKey && anchor !== null) {
      const ids = rows().ids;
      const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y);
      if (a >= 0) return ed.select(ids.slice(a, b + 1));
    }
    anchor = id;
    if (e.ctrlKey || e.metaKey) ed.select(ed.selected().includes(id) ? ed.selected().filter((s) => s !== id) : [...ed.selected(), id]);
    else ed.select([id]);
  };

  const rename = (id: number, name: string) => {
    setRenaming(null);
    const n = ed.node(id);
    if (n && name.trim() && name.trim() !== n.name) ed.update(new Map([[id, { name: name.trim() }]]), "Rename layer");
  };

  const dropAt = (e: DragEvent, id: number): Drop | null => {
    const moving = ed.topSelected();
    if (moving.some((m) => m === id || ed.ancestors(id).includes(m))) return null;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const f = (e.clientY - r.top) / r.height;
    if (["frame", "group"].includes(ed.node(id)!.kind) && f > 0.25 && f < 0.75) return { id, where: "inside" };
    return { id, where: f < 0.5 ? "above" : "below" };
  };

  const finishDrop = (d: Drop) => {
    const target = ed.node(d.id)!;
    const parent = d.where === "inside" ? d.id : target.parentId;
    const moving = ed.topSelected().slice().sort((a, b) => rows().ids.indexOf(b) - rows().ids.indexOf(a));
    const siblings = ed.children(parent).filter((s) => !moving.includes(s));
    let below: number | undefined;
    let above: number | undefined;
    if (d.where === "inside") below = siblings.length ? ed.node(siblings.at(-1)!)!.z : undefined;
    else {
      const i = siblings.indexOf(d.id);
      const z = (j: number) => (j >= 0 && j < siblings.length ? ed.node(siblings[j])!.z : undefined);
      [below, above] = d.where === "above" ? [z(i), z(i + 1)] : [z(i - 1), z(i)];
    }
    // Spread the moved layers evenly between their new neighbours, bottom first.
    let lo = below;
    const zs = moving.map(() => {
      const z = between(lo, above);
      lo = z;
      return z;
    });
    ed.update(ed.reparentChanges(moving, parent, zs), `Move ${layers(moving.length)}`, "forward");
  };

  return (
    <aside class="design-panel design-layers mw-scroll-fade" aria-label="Layers" ref={list}>
      <header class="design-section-title"><span>Layers</span></header>
      <Show when={rows().ids.length === 0}><p class="design-hint">No layers yet.</p></Show>
      <div role="tree" aria-label="Layers" aria-multiselectable="true">
      <For each={rows().ids}>
        {(id) => {
          const n = () => ed.node(id)!;
          const hasChildren = () => ed.children(id).length > 0;
          return (
            <Show when={ed.node(id)}>
              <div class="design-layer" data-layer={id} draggable={ed.canEdit() && renaming() !== id}
                classList={{
                  selected: ed.selected().includes(id), hover: ed.hovered() === id, hidden: !n().props.visible,
                  locked: n().props.locked, component: n().props.main || n().props.instanceOf !== null,
                  "drop-above": drop()?.id === id && drop()!.where === "above",
                  "drop-below": drop()?.id === id && drop()!.where === "below",
                  "drop-inside": drop()?.id === id && drop()!.where === "inside",
                }}
                role="treeitem" aria-level={(rows().depth.get(id) ?? 0) + 1} aria-selected={ed.selected().includes(id)}
                aria-expanded={hasChildren() ? !collapsed().has(id) : undefined}
                tabIndex={treeStop.tabIndex(id)} ref={treeRow} onFocus={() => treeStop.focused(id)}
                onKeyDown={treeKeys({
                  activate: (e) => click(e, id), toggle: () => toggleOpen(id),
                  rename: () => ed.canEdit() && setRenaming(id),
                })}
                style={{ "--depth": rows().depth.get(id) ?? 0 }}
                onClick={(e) => click(e, id)}
                onDblClick={() => ed.canEdit() && setRenaming(id)}
                onPointerEnter={() => ed.setHovered(id)}
                onPointerLeave={() => ed.hovered() === id && ed.setHovered(null)}
                onContextMenu={(e) => {
                  if (!ed.selected().includes(id)) ed.select([id]);
                  props.onContextMenu(e);
                }}
                onDragStart={(e) => {
                  if (!ed.selected().includes(id)) ed.select([id]);
                  e.dataTransfer!.effectAllowed = "move";
                  e.dataTransfer!.setData("application/x-makework-layers", "");
                }}
                onDragOver={(e) => {
                  if (!e.dataTransfer?.types.includes("application/x-makework-layers")) return;
                  const d = dropAt(e, id);
                  setDrop(d);
                  if (d) e.preventDefault();
                }}
                onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && drop()?.id === id && setDrop(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  const d = drop();
                  setDrop(null);
                  if (d) finishDrop(d);
                }}
                onDragEnd={() => setDrop(null)}>
                <button class="design-layer-toggle" classList={{ empty: !hasChildren(), open: !collapsed().has(id) }} tabIndex={-1}
                  aria-label={collapsed().has(id) ? "Expand" : "Collapse"}
                  onClick={(e) => { e.stopPropagation(); if (hasChildren()) toggleOpen(id); }}>
                  <Icon name="collapsed" size={12} />
                </button>
                <Icon name={nodeIcon(n())} size={14} />
                <Show when={renaming() === id} fallback={<span class="design-layer-name">{n().name}</span>}>
                  <input class="design-layer-rename" value={n().name} ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => rename(id, e.currentTarget.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key !== "Enter" && e.key !== "Escape") return;
                      // Back to the row once the field is gone, so the keys go on in the tree.
                      const treeItem = treeRowOf(e.currentTarget);
                      if (e.key === "Enter") e.currentTarget.blur();
                      else setRenaming(null);
                      treeItem?.focus();
                    }} />
                </Show>
                <Show when={ed.holder(id)}>
                  {(who) => (
                    <span class="design-layer-holder" style={{ "--who": ed.users.get(who()).color || "var(--mw-text-muted)" }}
                      title={`${ed.users.get(who()).displayName} has this layer`} />
                  )}
                </Show>
                <span class="design-layer-actions">
                  <button class="icon-button" classList={{ on: n().props.locked }} title={n().props.locked ? "Unlock" : "Lock"}
                    aria-label={n().props.locked ? "Unlock" : "Lock"} disabled={!ed.canEdit()}
                    onClick={(e) => { e.stopPropagation(); toggleLocked(ed, [id]); }}>
                    <Icon name={n().props.locked ? "lock" : "unlock"} size={14} />
                  </button>
                  <button class="icon-button" classList={{ on: !n().props.visible }} title={n().props.visible ? "Hide" : "Show"}
                    aria-label={n().props.visible ? "Hide" : "Show"} disabled={!ed.canEdit()}
                    onClick={(e) => { e.stopPropagation(); toggleVisible(ed, [id]); }}>
                    <Icon name={n().props.visible ? "visible" : "hidden"} size={14} />
                  </button>
                </span>
              </div>
            </Show>
          );
        }}
      </For>
      </div>
    </aside>
  );
}
