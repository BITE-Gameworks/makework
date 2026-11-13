// One open design document: its layers, what is selected, unsaved previews and every change with undo.
import { batch, createEffect, createMemo, createSignal, on } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { userMessage } from "../../../api/client";
import type { ApiValue } from "../../../api/types";
import type { History, HistoryEntry } from "../../../core/history";
import { encodeEmoji } from "../../../markdown/emoji";
import type { ChannelContext } from "../../types";
import { theme } from "../../../theme/store";
import type { Viewport } from "../canvas/camera";
export type { Viewport } from "../canvas/camera";
import { overridesAfter, syncInstances } from "./components";
import { resizeInside } from "./constraints";
import { addNodes, createNodes, createPage, createPalettes, removeNodes, restoreNodes, setPage, setPalette, updateNodes, type NewNode } from "./data";
import {
  between, boxAt, boundsOf, compose, cornersOf, identity, inkFor, invert, localTransform, sameValue, union,
  type Change, type DesignNode, type Fields, type Point, type Rect, type Resolve, type Rigid,
} from "./model";

export type Tool = "move" | "hand" | "frame" | "rect" | "ellipse" | "line" | "text" | "pen" | "pencil";
export type PanelTab = "design" | "prototype";

// A member's hold on a layer: since when (their clock) they have had it selected.
interface Claim {
  userId: number;
  at: number;
}
const earlier = (a: Claim, b: Claim) => a.at < b.at || (a.at === b.at && a.userId < b.userId);

const viewports = new Map<string, Viewport>();

export type Editor = ReturnType<typeof createEditor>;

export function createEditor(ctx: ChannelContext) {
  const api = ctx.api;
  const channelId = ctx.channel.id;
  const key = `${ctx.workspace.id}:${channelId}`;
  const live = createNodes(api, channelId);
  // Changes shown here before the workspace has them: gestures in progress and saves on their way.
  const [draft, setDraft] = createStore<Record<number, Change>>({});
  const [selected, setSelected] = createSignal<number[]>([]);
  const [hovered, setHovered] = createSignal<number | null>(null);
  const [tool, setTool] = createSignal<Tool>("move");
  const [editing, setEditing] = createSignal<number | null>(null);
  const [renaming, setRenaming] = createSignal<number | null>(null);
  const [error, setError] = createSignal("");
  const [panelTab, setPanelTab] = createSignal<PanelTab>("design");
  // The page-level frame play mode shows first, null while not playing.
  const [playing, setPlaying] = createSignal<number | null>(null);
  const viewSaved = viewports.has(key);
  const [view, setView] = createSignal<Viewport>(viewports.get(key) ?? { x: 0, y: 0, zoom: 1 });
  createEffect(() => viewports.set(key, view()));

  const canEdit = () => ctx.can("edit_content");

  // Document colors and palettes. Which palette is shown is the document's (design_pages.palette_id), the same
  // for everyone; a choice shows here at once and goes to the others with the save.
  const palettes = createPalettes(api, channelId);
  const page = createPage(api, channelId);
  const [paletteDraft, setPaletteDraft] = createSignal<number | null>(null);
  createEffect(() => {
    if (paletteDraft() !== null && paletteDraft() === page.value.palette) setPaletteDraft(null);
  });
  const activePalette = () => {
    const list = palettes.value.palettes;
    const chosen = paletteDraft() ?? page.value.palette;
    return list.find((p) => p.id === chosen)?.id ?? list[0]?.id ?? null;
  };
  const choosePalette = (id: number) => {
    if (id === activePalette()) return;
    setPaletteDraft(id);
    void run(async () => {
      try {
        await setPalette(api, channelId, id);
      } catch (e) {
        setPaletteDraft(null);
        throw e;
      }
    });
  };
  // Color values being picked, shown before they are saved: "palette:color" -> #rrggbb.
  const [colorDraft, setColorDraft] = createSignal<Record<string, string>>({});
  const colorValue = (colorId: number, paletteId = activePalette()): string | undefined =>
    paletteId === null ? undefined : colorDraft()[`${paletteId}:${colorId}`] ?? palettes.value.values[paletteId]?.[colorId];
  const resolve: Resolve = (c) => (c.ref != null ? colorValue(c.ref) ?? c.color : c.color);

  // The page background: "" (the app theme's), #rrggbb or ref:<color id>, with a preview while picking.
  const [backgroundDraft, setBackgroundDraft] = createSignal<string | null>(null);
  const backgroundValue = () => backgroundDraft() ?? page.value.background;
  createEffect(() => {
    if (backgroundDraft() !== null && backgroundDraft() === page.value.background) setBackgroundDraft(null);
  });
  // The background as a color to paint, or null for the theme's.
  const background = (): string | null => {
    const v = backgroundValue();
    if (!v) return null;
    return v.startsWith("ref:") ? colorValue(Number(v.slice(4))) ?? null : v;
  };
  const saveBackground = async (value: string) => {
    setBackgroundDraft(value);
    try {
      await setPage(api, channelId, value);
    } catch (e) {
      setBackgroundDraft(null);
      throw e;
    }
  };
  const colorName = (id: number) => palettes.value.colors.find((c) => c.id === id)?.name;

  const serverById = createMemo(() => new Map(live.value.map((n) => [n.id, n])));

  const node = (id: number | null | undefined): DesignNode | undefined => {
    if (id === null || id === undefined) return undefined;
    const n = serverById().get(id);
    if (!n) return undefined;
    const d = draft[id];
    return d ? { ...n, ...d } : n;
  };

  // Children per parent (null for the page), bottom to top. Layers whose parent is gone are left out.
  const tree = createMemo(() => {
    const ids = serverById();
    const map = new Map<number | null, { id: number; z: number }[]>();
    for (const n of live.value) {
      const d = draft[n.id];
      const parent = d?.parentId !== undefined ? d.parentId : n.parentId;
      if (parent !== null && !ids.has(parent)) continue;
      const list = map.get(parent) ?? [];
      list.push({ id: n.id, z: d?.z ?? n.z });
      map.set(parent, list);
    }
    return new Map([...map].map(([parent, list]) => [parent, list.toSorted((a, b) => a.z - b.z || a.id - b.id).map((c) => c.id)]));
  });
  const children = (parent: number | null) => tree().get(parent) ?? [];

  const isShown = (id: number): boolean => {
    for (let n = node(id); n; n = node(n.parentId)) {
      if (!n.props.visible) return false;
      if (n.parentId === null) return children(null).includes(n.id);
    }
    return false;
  };

  const ancestors = (id: number): number[] => {
    const list: number[] = [];
    for (let n = node(node(id)?.parentId); n; n = node(n.parentId)) list.push(n.id);
    return list;
  };
  const descendants = (id: number): number[] => children(id).flatMap((c) => [c, ...descendants(c)]);

  // The instance a layer is in or is, else null.
  const instanceOf = (id: number): number | null => {
    for (let n = node(id); n; n = node(n.parentId)) if (n.props.instanceOf !== null) return n.id;
    return null;
  };
  // A layer inside an instance that follows a layer of the main component.
  const isCopy = (id: number) => node(id)?.props.master != null && instanceOf(id) !== null && instanceOf(id) !== id;
  // The layers that make up an instance: itself and its copies, not instances placed inside it.
  const instanceLayers = (id: number): number[] => [id, ...children(id).flatMap(function walk(c): number[] {
    const n = node(c)!;
    if (n.props.instanceOf !== null) return [];
    return [...(n.props.master !== null ? [c] : []), ...children(c).flatMap(walk)];
  })];
  const mains = createMemo(() => live.value.filter((n) => n.props.main).map((n) => n.id));
  const instancesOf = (main: number) => live.value.filter((n) => n.props.instanceOf === main).map((n) => n.id);

  const world = (id: number | null): Rigid => {
    const n = node(id);
    return n ? compose(world(n.parentId), localTransform(n)) : identity;
  };
  const worldBounds = (id: number): Rect => {
    const n = node(id)!;
    return boundsOf(cornersOf(world(id), n.width, n.height));
  };
  const selectionBounds = () => union(topSelected().map(worldBounds));

  // The selection without layers whose ancestor is selected too, in page order.
  const topSelected = createMemo(() => {
    const set = new Set(selected());
    return selected().filter((id) => node(id) && !ancestors(id).some((a) => set.has(a)));
  });

  // Previews and saves end once the workspace has the same values, so nothing jumps back while saving.
  createEffect(() => {
    const done: number[] = [];
    for (const [id, change] of Object.entries(draft)) {
      const n = serverById().get(Number(id));
      if (!n || Object.entries(change).every(([k, v]) => sameValue(n[k as keyof Fields], v))) done.push(Number(id));
    }
    if (done.length) setDraft(produce((d) => done.forEach((id) => delete d[id])));
  });
  // Drop selections of layers someone deleted.
  createEffect(() => {
    const ids = serverById();
    if (selected().some((id) => !ids.has(id))) setSelected(selected().filter((id) => ids.has(id)));
    if (editing() !== null && !ids.has(editing()!)) setEditing(null);
  });

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      setError("");
    } catch (e) {
      setError(e instanceof Error && !("code" in e) ? e.message : userMessage(e));
    }
  };

  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  const preview = (changes: Map<number, Change>) =>
    setDraft(produce((d) => changes.forEach((c, id) => free(id) && (d[id] = { ...d[id], ...clone(c) }))));
  const clearPreview = (ids: Iterable<number>) => setDraft(produce((d) => { for (const id of ids) delete d[id]; }));

  // One member at a time controls a layer: whoever selected it first, or a layer around it or inside it (moving
  // a frame moves what is inside). Members who may edit send when they selected each layer with their selection;
  // when two selected at about the same time, every member agrees on the earlier one and the other lets go.
  const [since, setSince] = createSignal(new Map<number, number>());
  createEffect(() => ctx.presence.set(canEdit()
    ? { sel: selected(), at: selected().map((id) => since().get(id) ?? 0) }
    : { sel: selected() }));
  const claimsAround = (claims: (Claim & { id: number })[]) => {
    const map = new Map<number, Claim>();
    for (const c of claims) {
      if (!serverById().has(c.id)) continue;
      for (const id of [c.id, ...descendants(c.id), ...ancestors(c.id)]) {
        const prev = map.get(id);
        if (!prev || earlier(c, prev)) map.set(id, { userId: c.userId, at: c.at });
      }
    }
    return map;
  };
  const held = createMemo(() => claimsAround(ctx.presence.others().flatMap((o) => {
    const state = o.state as { sel?: number[]; at?: number[] } | null;
    if (!Array.isArray(state?.sel) || !Array.isArray(state?.at)) return [];
    return state.sel.map((id, i) => ({ id, userId: o.userId, at: Number(state.at![i]) || 0 }));
  })));
  const mine = createMemo(() => claimsAround(selected().map((id) => ({ id, userId: ctx.users.me() ?? 0, at: since().get(id) ?? Infinity }))));
  // The member who controls a layer when it isn't us, else null.
  const holder = (id: number): number | null => {
    const theirs = held().get(id);
    if (!theirs) return null;
    const ours = mine().get(id);
    return ours && earlier(ours, theirs) ? null : theirs.userId;
  };
  const free = (id: number) => holder(id) === null;
  createEffect(() => {
    const lost = selected().filter((id) => !free(id));
    if (lost.length === 0) return;
    clearPreview(lost);
    setSelected(selected().filter((id) => free(id)));
    if (editing() !== null && !free(editing()!)) setEditing(null);
  });

  // Brings instances up to date after this member's changes (components.ts). One pass at a time, each reading the
  // rows as they are, so a pass never adds what an earlier one did; instances inside mains take a few passes.
  const hasInstances = createMemo(() => live.value.some((n) => n.props.instanceOf !== null));
  let syncQueue = Promise.resolve();
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  const syncSoon = (always = false) => {
    if (!canEdit() || !(always || hasInstances())) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncQueue = syncQueue.then(() => syncInstances(api, channelId)).catch((e: unknown) => void setError(e instanceof Error && !("code" in e) ? e.message : userMessage(e)));
    }, 50);
  };
  // Someone without the app (an agent) may have changed a main: the first member to open the document catches up.
  createEffect(on(() => live.loaded, (loaded) => loaded && syncSoon()));

  // Every recorded change, and its undo and redo, ends with a sync.
  const history: History = {
    ...ctx.history,
    push: (entry: HistoryEntry) => {
      ctx.history.push({
        ...entry,
        undo: async () => { await entry.undo(); syncSoon(); },
        redo: async () => { await entry.redo(); syncSoon(); },
      });
      syncSoon();
    },
  };

  // Changes to layers in an instance add what they change to the layer's overrides, which then stop following the main.
  const withOverrides = (changes: Map<number, Change>) => {
    for (const [id, change] of changes) {
      const n = serverById().get(id);
      if (!n || !(n.props.instanceOf !== null || isCopy(id))) continue;
      const overrides = overridesAfter(n, change, n.props.instanceOf !== null);
      if (overrides) change.props = { ...(change.props ?? clone(n.props)), overrides };
    }
    return changes;
  };

  // A frame resized from the panel or the canvas keeps its layers to their constraints. Instances get theirs from the sync.
  const withConstraints = (changes: Map<number, Change>) => {
    for (const [id, c] of [...changes]) {
      const n = serverById().get(id);
      if (n?.kind !== "frame" || (c.width === undefined && c.height === undefined) || instanceOf(id) !== null) continue;
      const to = { width: c.width ?? n.width, height: c.height ?? n.height };
      for (const [child, box] of resizeInside(id, "frame", n, to, children, (k) => serverById().get(k)))
        if (!changes.has(child)) changes.set(child, box);
    }
    return changes;
  };

  const save = async (changes: Map<number, Change>) => {
    preview(changes);
    try {
      await updateNodes(api, changes);
    } catch (e) {
      clearPreview(changes.keys());
      throw e;
    }
  };

  // The workspace's current values of the fields a change touches, for undo.
  const before = (changes: Map<number, Change>) => new Map([...changes].map(([id, change]) => {
    const n = serverById().get(id)!;
    return [id, clone(Object.fromEntries(Object.keys(change).map((k) => [k, n[k as keyof Fields]]))) as Change];
  }));

  // Groups always fit what is in them. Given changes (and layers being removed), adds the groups around them that
  // need a new box, and moves their children by as much the other way so nothing moves on the page.
  const fitGroups = (changes: Map<number, Change>, removed = new Set<number>(), seeds: number[] = []): Map<number, Change> => {
    const out = new Map([...changes].map(([id, c]) => [id, { ...c }]));
    const merged = (id: number | null | undefined) => {
      const n = node(id);
      return n && out.has(n.id) ? { ...n, ...out.get(n.id) } : n;
    };
    const queue: number[] = [];
    const queueParents = (id: number) => {
      for (const p of [node(id)?.parentId, out.get(id)?.parentId])
        if (p != null && merged(p)?.kind === "group" && !removed.has(p) && !queue.includes(p)) queue.push(p);
    };
    [...changes.keys(), ...removed, ...seeds].forEach(queueParents);
    seeds.forEach((g) => merged(g)?.kind === "group" && !queue.includes(g) && queue.push(g));
    while (queue.length) {
      queue.sort((a, b) => ancestors(b).length - ancestors(a).length);
      const g = queue.shift()!;
      const group = merged(g)!;
      const kids = [...new Set([...children(g), ...[...out].filter(([, c]) => c.parentId === g).map(([id]) => id)])]
        .filter((id) => !removed.has(id) && merged(id)?.parentId === g);
      if (kids.length === 0) continue;
      const box = union(kids.map((id) => {
        const k = merged(id)!;
        return boundsOf(cornersOf(localTransform(k), k.width, k.height));
      }))!;
      const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
      if (near(box.left, 0) && near(box.top, 0) && near(box.right, group.width) && near(box.bottom, group.height)) continue;
      const placed = compose(localTransform(group), { origin: { x: box.left, y: box.top }, angle: 0 });
      out.set(g, { ...out.get(g), ...boxAt(placed, identity, box.right - box.left, box.bottom - box.top) });
      for (const id of kids) {
        const k = merged(id)!;
        out.set(id, { ...out.get(id), x: k.x - box.left, y: k.y - box.top });
      }
      queueParents(g);
    }
    return out;
  };

  // Saves changes and records them for undo; `old` defaults to what the workspace has.
  // `constrained`: false keeps what is inside resized frames where it is.
  const update = (changes: Map<number, Change>, label: string, icon = "rename", old?: Map<number, Change>, constrained = true) => {
    const asked = new Map([...changes].filter(([id]) => serverById().has(id) && free(id)).map(([id, c]) => [id, clone(c)]));
    if (asked.size === 0 || !canEdit()) return void clearPreview(changes.keys());
    const real = withOverrides(fitGroups(constrained ? withConstraints(asked) : asked));
    const undoTo = new Map([...before(real), ...(old ? [...old].filter(([id]) => real.has(id)) : [])]);
    void run(() => save(real));
    history.push({ label, icon, undo: () => save(undoTo), redo: () => save(real) });
  };

  const add = async (nodes: NewNode[], label: string, record = true) => {
    if (!canEdit()) return [];
    const ids = await addNodes(api, channelId, nodes);
    if (record) history.push({ label, icon: "add", undo: () => removeNodes(api, ids), redo: () => restoreNodes(api, ids) });
    return ids;
  };

  const remove = (asked: number[], label = "Delete") => {
    const kept = asked.filter((id) => isCopy(id) && !asked.includes(instanceOf(id)!));
    const ids = asked.filter((id) => free(id) && !kept.includes(id));
    if (kept.length && ids.length === 0) return setError("Layers in an instance follow its main component: hide them instead, or detach the instance.");
    const gone = new Set(ids.flatMap((id) => [id, ...descendants(id)]));
    if (gone.size === 0 || !canEdit()) return;
    // A group left empty goes too.
    for (let grew = true; grew;) {
      grew = false;
      for (const id of [...gone]) {
        const p = node(node(id)?.parentId);
        if (p?.kind === "group" && !gone.has(p.id) && children(p.id).every((c) => gone.has(c))) {
          gone.add(p.id);
          grew = true;
        }
      }
    }
    const all = [...gone];
    const fits = fitGroups(new Map(), gone);
    const unfit = before(fits);
    setSelected(selected().filter((id) => !gone.has(id)));
    const apply = async () => {
      await removeNodes(api, all);
      if (fits.size) await save(fits);
    };
    const revert = async () => {
      await restoreNodes(api, all);
      if (unfit.size) await save(unfit);
    };
    void run(apply);
    history.push({ label: `${label} ${layers(ids.length)}`, icon: "delete", undo: revert, redo: apply });
  };

  // Moves layers into another parent at the top, keeping where they are on the page.
  const reparentChanges = (ids: number[], parent: number | null, z?: number[]): Map<number, Change> => {
    const target = world(parent);
    let top = Math.max(0, ...children(parent).map((c) => node(c)!.z));
    return new Map(ids.map((id, i) => {
      const n = node(id)!;
      return [id, { ...boxAt(world(id), target, n.width, n.height), parentId: parent, z: z?.[i] ?? ++top }];
    }));
  };

  // The deepest visible frame at a page point, top layers first, skipping the given layers and their contents.
  const frameAt = (p: Point, skip = new Set<number>()): number | null => {
    const search = (parent: number | null): number | null => {
      for (const id of [...children(parent)].reverse()) {
        const n = node(id)!;
        if (skip.has(id) || !n.props.visible || n.kind !== "frame") continue;
        const local = invert(world(id), p);
        if (local.x < 0 || local.y < 0 || local.x > n.width || local.y > n.height) continue;
        return search(id) ?? id;
      }
      return null;
    };
    return search(null);
  };

  // Where a layer goes among its siblings: one step up or down, or to the top or bottom.
  const reorder = (how: "forward" | "backward" | "front" | "back") => {
    const changes = new Map<number, Change>();
    for (const id of topSelected()) {
      const n = node(id)!;
      const siblings = children(n.parentId).filter((s) => !changes.has(s) && (s === id || !selected().includes(s)));
      const i = siblings.indexOf(id);
      const z = (j: number) => (j >= 0 && j < siblings.length ? node(siblings[j])!.z : undefined);
      const next =
        how === "front" ? (i === siblings.length - 1 ? null : between(z(siblings.length - 1), undefined)) :
        how === "back" ? (i === 0 ? null : between(undefined, z(0))) :
        how === "forward" ? (i === siblings.length - 1 ? null : between(z(i + 1), z(i + 2))) :
        (i === 0 ? null : between(z(i - 2), z(i - 1)));
      if (next !== null) changes.set(id, { z: next });
    }
    const labels = { forward: "Bring forward", backward: "Send backward", front: "Bring to front", back: "Send to back" };
    if (changes.size) update(changes, labels[how], "bring-to-front");
  };

  // A color that reads on what a new layer inside `parent` is drawn on: the nearest frame with a solid fill,
  // else the app's page (white in dark themes).
  const inkIn = (parent: number | null): string => {
    for (let n = node(parent); n; n = node(n.parentId)) {
      const fill = n.kind === "frame" ? n.props.fills.find((f) => f.visible && f.opacity >= 0.5) : undefined;
      if (fill) return inkFor(resolve(fill));
    }
    const page = background();
    if (page) return inkFor(page);
    return theme().scheme === "dark" ? "#ffffff" : "#000000";
  };

  // Palette changes, each recorded for undo.
  const palettesApi = (action: string, args: Record<string, ApiValue>) => api.call<{ id?: number }>(action, args);
  const record = (label: string, undo: () => Promise<unknown>, redo: () => Promise<unknown>) =>
    ctx.history.push({ label, icon: "design-palette", undo, redo });
  const setBackground = (value: string) => {
    const old = page.value.background;
    if (!canEdit() || value === old) return void setBackgroundDraft(null);
    void run(() => saveBackground(value));
    record(value ? "Change background" : "Use the theme's background", () => saveBackground(old), () => saveBackground(value));
  };
  const addColor = (name: string, value: string) => run(async () => {
    const { id } = await palettesApi("add-color", { channel_id: channelId, name: encodeEmoji(name), value });
    record(`Add color ${name}`, () => palettesApi("remove-color", { id: id! }), () => palettesApi("restore-color", { id: id! }));
  });
  const removeColor = (id: number) => run(async () => {
    await palettesApi("remove-color", { id });
    record(`Delete color ${colorName(id) ?? ""}`.trim(), () => palettesApi("restore-color", { id }), () => palettesApi("remove-color", { id }));
  });
  const renameThing = (what: "color" | "palette", id: number, name: string, old: string) => run(async () => {
    if (!name.trim() || name === old) return;
    const rename = (to: string) => palettesApi(`rename-${what}`, { id, name: encodeEmoji(to) });
    await rename(name);
    record(`Rename ${what}`, () => rename(old), () => rename(name));
  });
  // Puts a color or palette before another one in its list, or last.
  const moveThing = (what: "color" | "palette", id: number, before: number | null) => run(async () => {
    const list = what === "color" ? palettes.value.colors : palettes.value.palettes;
    const item = list.find((c) => c.id === id);
    const rest = list.filter((c) => c.id !== id);
    const i = before === null ? rest.length : rest.findIndex((c) => c.id === before);
    if (!item || i < 0 || list.indexOf(item) === i) return;
    const z = between(rest[i - 1]?.z, rest[i]?.z);
    const old = item.z;
    const move = (to: number) => palettesApi(`move-${what}`, { id, z: to });
    await move(z);
    record(`Move ${what} ${item.name}`, () => move(old), () => move(z));
  });
  const previewColor = (colorId: number, value: string) => {
    const p = activePalette();
    if (p !== null) setColorDraft({ ...colorDraft(), [`${p}:${colorId}`]: value });
  };
  const setColor = (colorId: number, value: string) => run(async () => {
    const paletteId = activePalette();
    if (paletteId === null) return;
    const old = palettes.value.values[paletteId]?.[colorId];
    const save = (v: string) => palettesApi("set-color", { palette_id: paletteId, color_id: colorId, value: v });
    try {
      await save(value);
    } finally {
      const { [`${paletteId}:${colorId}`]: _, ...rest } = colorDraft();
      setColorDraft(rest);
    }
    if (old && old !== value) record(`Change ${colorName(colorId) ?? "color"}`, () => save(old), () => save(value));
  });
  const addPalette = (name: string) => run(async () => {
    const { id } = await palettesApi("add-palette", { channel_id: channelId, name: encodeEmoji(name), copy_from: activePalette() });
    choosePalette(id!);
    record(`Add palette ${name}`, () => palettesApi("remove-palette", { id: id! }), () => palettesApi("restore-palette", { id: id! }));
  });
  const removePalette = (id: number) => run(async () => {
    await palettesApi("remove-palette", { id });
    record("Delete palette", () => palettesApi("restore-palette", { id }), () => palettesApi("remove-palette", { id }));
  });

  const select = (wanted: number[]) => batch(() => {
    const ids = wanted.filter(free);
    const times = since();
    const now = Date.now();
    setSince(new Map(ids.map((id) => [id, times.get(id) ?? now])));
    setSelected(ids);
    if (editing() !== null && !ids.includes(editing()!)) setEditing(null);
  });

  return {
    live, node, children, tree, isShown, ancestors, descendants, world, worldBounds, selectionBounds,
    selected, select, topSelected, hovered, setHovered, tool, setTool, editing, setEditing, error, setError,
    view, setView, canEdit, run, preview, clearPreview, update, add, remove, reparentChanges, frameAt, reorder,
    draft, serverById, viewSaved, save, api, history, fitGroups, syncSoon,
    instanceOf, isCopy, instanceLayers, mains, instancesOf, panelTab, setPanelTab, playing, setPlaying,
    inkIn, renaming, setRenaming, holder, free, users: ctx.users,
    background, backgroundValue, previewBackground: setBackgroundDraft, setBackground,
    palettes, activePalette, choosePalette, resolve, colorValue, colorName, previewColor, setColor, addColor, removeColor,
    renameColor: (id: number, name: string, old: string) => renameThing("color", id, name, old),
    renamePalette: (id: number, name: string, old: string) => renameThing("palette", id, name, old),
    addPalette, removePalette,
    moveColor: (id: number, before: number | null) => moveThing("color", id, before),
    movePalette: (id: number, before: number | null) => moveThing("palette", id, before),
  };
}

export const layers = (n: number) => (n === 1 ? "layer" : `${n} layers`);
