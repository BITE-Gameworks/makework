// Components as linked copies (ADR 0020): an instance's layers are ordinary layers that copy the main component's,
// so everything else (selecting, editing text, exports, the disk view) treats them like any layer. Whoever changes
// a document brings its instances up to date with `planSync`, which only ever reads the current rows.
import type { PluginClient } from "../../../api/client";
import { constrain, scaled, type Size } from "./constraints";
import { addNodes, listNodes, removeNodes, updateNodes, type NewNode } from "./data";
import type { Change, DesignNode, Props } from "./model";

// Props kept per layer, never taken from the main.
export const ownKeys = new Set<string>(["main", "instanceOf", "master", "overrides"]);
// Fields a copy takes from its main layer unless overridden. An instance itself only takes the size.
export const copiedFields = ["name", "x", "y", "width", "height", "rotation", "z"] as const;
const rootFields = ["width", "height"] as const;

export interface SyncPlan {
  add: NewNode[];
  update: Map<number, Change>;
  remove: number[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export const isEmpty = (plan: SyncPlan) => plan.add.length === 0 && plan.update.size === 0 && plan.remove.length === 0;

// The props a copy has after following `from`, or null when nothing changes.
function followProps(copy: Props, from: Props, overrides: string[]): Props | null {
  let next: Props | null = null;
  for (const key of Object.keys(from) as (keyof Props)[]) {
    if (ownKeys.has(key) || overrides.includes(key) || same(copy[key], from[key])) continue;
    next ??= { ...copy };
    (next as unknown as Record<string, unknown>)[key] = clone(from[key]);
  }
  return next;
}

// A new copy of a main's layer: the main's props with the copy's own.
export const copyProps = (from: Props, master: number | null, instanceOf: number | null = null): Props =>
  ({ ...clone(from), main: false, instanceOf, master, overrides: [] });

// What makes every instance in `nodes` (a document's live layers) match its main component. Layers keep their
// constraints when an instance is sized differently from its main. A copy whose main layer is gone takes over the
// main layer with the same name path that has no copy yet (another variant's "Label"), keeping its overrides.
export function planSync(nodes: DesignNode[]): SyncPlan {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map<number, DesignNode[]>();
  for (const n of nodes) if (n.parentId !== null) (kids.get(n.parentId) ?? kids.set(n.parentId, []).get(n.parentId)!).push(n);
  for (const list of kids.values()) list.sort((a, b) => a.z - b.z || a.id - b.id);
  const within = (id: number, ancestor: number) => {
    for (let n = byId.get(id); n; n = n.parentId === null ? undefined : byId.get(n.parentId)) if (n.id === ancestor) return true;
    return false;
  };
  const subtree = (id: number): number[] => (kids.get(id) ?? []).flatMap((c) => [c.id, ...subtree(c.id)]);

  const plan: SyncPlan = { add: [], update: new Map(), remove: [] };
  const reused = new Set<number>();
  const removeWithin = (id: number) => plan.remove.push(id, ...subtree(id));
  for (const instance of nodes) {
    const main = instance.props.instanceOf === null ? undefined : byId.get(instance.props.instanceOf);
    if (!main?.props.main || within(instance.id, main.id) || within(main.id, instance.id)) continue;
    const inMain = new Set(subtree(main.id));

    const root: Change = {};
    for (const f of rootFields) if (!instance.props.overrides.includes(f) && !same(instance[f], main[f])) root[f] = main[f];
    const rootProps = followProps(instance.props, main.props, instance.props.overrides);
    if (rootProps) root.props = rootProps;
    if (Object.keys(root).length) plan.update.set(instance.id, root);

    // The copies by the main's layer they follow, and the ones left without one by name path. Instances placed
    // inside this one keep their own.
    const copies = new Map<number, DesignNode>();
    const orphans = new Map<string, DesignNode>();
    const collect = (id: number, prefix: string) => {
      for (const c of kids.get(id) ?? []) {
        const path = `${prefix}${c.name}`;
        if (c.props.master !== null) {
          if (copies.has(c.props.master)) removeWithin(c.id);
          else copies.set(c.props.master, c);
          if (!inMain.has(c.props.master) && !orphans.has(path)) orphans.set(path, c);
        }
        if (c.props.instanceOf === null) collect(c.id, `${path}/`);
      }
    };
    collect(instance.id, "");

    const wanted = new Set<number>();
    const size = (n: { width: number; height: number }) => ({ width: n.width, height: n.height });
    type Parent = { id?: number; ref?: string; group: boolean; from: Size; to: Size };
    const place = (mainParent: number, parent: Parent, prefix: string) => {
      for (const d of kids.get(mainParent) ?? []) {
        wanted.add(d.id);
        const path = `${prefix}${d.name}`;
        const box = constrain(d, parent.group ? scaled : d.props.constraints, parent.from, parent.to);
        if (d.kind === "line") box.height = d.height;
        let c = copies.get(d.id);
        const orphan = c ? undefined : orphans.get(path);
        if (orphan?.kind === d.kind) {
          orphans.delete(path);
          reused.add(orphan.id);
          c = orphan;
        }
        if (!c) {
          const ref = `${instance.id}:${d.id}`;
          plan.add.push({
            ref, parent_id: parent.id, parent_ref: parent.ref, kind: d.kind, name: d.name, z: d.z,
            ...box, rotation: d.rotation, props: copyProps(d.props, d.id), url: d.url, thumb: d.thumb,
          });
          place(d.id, { ref, group: d.kind === "group", from: size(d), to: size(box) }, `${path}/`);
          continue;
        }
        const wantedValue = (f: typeof copiedFields[number]) => (f in box ? box[f as keyof typeof box] : d[f]);
        const change: Change = {};
        for (const f of copiedFields)
          if (!c.props.overrides.includes(f) && !same(c[f], wantedValue(f))) (change as Record<string, unknown>)[f] = wantedValue(f);
        if (parent.id !== undefined && c.parentId !== parent.id) change.parentId = parent.id;
        const props = followProps(c.props, d.props, c.props.overrides);
        if (props || c === orphan) change.props = { ...(props ?? c.props), master: d.id };
        if (Object.keys(change).length) plan.update.set(c.id, change);
        const now = { width: change.width ?? c.width, height: change.height ?? c.height };
        place(d.id, { id: c.id, group: d.kind === "group", from: size(d), to: now }, `${path}/`);
      }
    };
    place(main.id, { id: instance.id, group: false, from: size(main), to: { width: root.width ?? instance.width, height: root.height ?? instance.height } }, "");
    for (const [master, c] of copies) if (!wanted.has(master) && !reused.has(c.id)) removeWithin(c.id);
  }
  plan.remove = [...new Set(plan.remove)].filter((id) => !reused.has(id));
  for (const id of plan.remove) plan.update.delete(id);
  return plan;
}

// Runs sync passes until nothing is left to do; instances inside mains take a few.
export async function syncInstances(api: PluginClient, channelId: number) {
  for (let pass = 0; pass < 4; pass++) {
    const plan = planSync(await listNodes(api, channelId));
    if (isEmpty(plan)) return;
    if (plan.remove.length) await removeNodes(api, plan.remove);
    if (plan.update.size) await updateNodes(api, plan.update);
    if (plan.add.length) await addNodes(api, channelId, plan.add);
  }
}

// Variants: the mains in a variant set, named "Property=Value, Other=Value".
export function variantValues(name: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const part of name.split(",")) {
    const [key, ...rest] = part.split("=");
    if (key.trim() && rest.length) values[key.trim()] = rest.join("=").trim();
  }
  return values;
}

export const variantName = (values: Record<string, string>) => Object.entries(values).map(([k, v]) => `${k}=${v}`).join(", ");

// Every property of a set's variants with the values it takes, in the order first seen.
export function variantProperties(names: string[]): [string, string[]][] {
  const props = new Map<string, string[]>();
  for (const name of names)
    for (const [k, v] of Object.entries(variantValues(name))) {
      const list = props.get(k) ?? props.set(k, []).get(k)!;
      if (!list.includes(v)) list.push(v);
    }
  return [...props];
}

// The variant with `key` set to `value` that keeps the most other values, or null.
export function pickVariant(variants: { id: number; name: string }[], current: string, key: string, value: string): number | null {
  const want = { ...variantValues(current), [key]: value };
  let best: { id: number; score: number } | null = null;
  for (const v of variants) {
    const values = variantValues(v.name);
    if (values[key] !== value) continue;
    const score = Object.entries(want).filter(([k, x]) => values[k] === x).length;
    if (!best || score > best.score) best = { id: v.id, score };
  }
  return best?.id ?? null;
}

// The changed fields and props a change makes to a layer in an instance, added to its overrides. Null when none.
export function overridesAfter(n: DesignNode, change: Change, isRoot: boolean): string[] | null {
  const keys = new Set(n.props.overrides);
  const before = keys.size;
  for (const f of isRoot ? rootFields : copiedFields) if (f in change && !same(change[f], n[f])) keys.add(f);
  if (change.props)
    for (const k of Object.keys(change.props) as (keyof Props)[]) if (!ownKeys.has(k) && !same(change.props[k], n.props[k])) keys.add(k);
  return keys.size === before ? null : [...keys];
}
