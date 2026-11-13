import { Index, Show, createMemo } from "solid-js";
import { layers, type Editor } from "./editor";
import { Section } from "./fields";
import type { Change, Effect, Paint, Props } from "./model";
import { PaintColor } from "./Palettes";

type Slot = { id: number; list: "fills" | "strokes" | "effects" | "tint"; index: number };
interface ColorGroup {
  color: string;
  ref: number | null;
  opacity: number;
  slots: Slot[];
}

// Every color used in the selection and inside it, the same ones listed once; changing one changes it everywhere.
export default function SelectionColors(props: { editor: Editor }) {
  const ed = props.editor;
  const ids = () => ed.topSelected().flatMap((id) => [id, ...ed.descendants(id)]);
  const groups = createMemo(() => {
    const found = new Map<string, ColorGroup>();
    const add = (id: number, list: Slot["list"], index: number, c: { color: string; ref?: number | null; opacity: number }) => {
      const ref = c.ref != null && ed.colorName(c.ref) !== undefined ? c.ref : null;
      const key = `${ref !== null ? `ref:${ref}` : ed.resolve(c).toLowerCase()}/${c.opacity}`;
      const group = found.get(key) ?? { color: ed.resolve({ color: c.color, ref }), ref, opacity: c.opacity, slots: [] };
      group.slots.push({ id, list, index });
      found.set(key, group);
    };
    for (const id of ids()) {
      const n = ed.node(id);
      if (!n) continue;
      n.props.fills.forEach((f, i) => !f.gradient && add(id, "fills", i, f));
      n.props.strokes.forEach((s, i) => add(id, "strokes", i, s));
      n.props.effects.forEach((e, i) => (e.kind === "drop-shadow" || e.kind === "inner-shadow") && add(id, "effects", i, e));
      if (n.props.tint) add(id, "tint", 0, n.props.tint);
    }
    return [...found.values()];
  });

  // The change for every layer holding one of the group's colors.
  const changesFor = (group: ColorGroup, part: Partial<Paint & Effect>): Map<number, Change> => {
    const props = new Map<number, Props>();
    for (const slot of group.slots) {
      const n = ed.node(slot.id);
      if (!n) continue;
      const p = props.get(slot.id) ?? (JSON.parse(JSON.stringify(n.props)) as Props);
      Object.assign(slot.list === "tint" ? p.tint! : p[slot.list][slot.index], part);
      props.set(slot.id, p);
    }
    return new Map([...props].map(([id, p]) => [id, { props: p }]));
  };
  const preview = (group: ColorGroup, part: Partial<Paint>) => ed.preview(changesFor(group, part));
  const commit = (group: ColorGroup, part: Partial<Paint>, label: string) => {
    const changes = changesFor(group, part);
    ed.update(changes, `${label} in ${layers(changes.size)}`, "design-palette");
  };

  return (
    <Show when={groups().length > 1 || (groups().length > 0 && ids().length > 1)}>
      <Section title="Selection colors">
        <Index each={groups()}>
          {(g) => (
            <div class="design-paint">
              <PaintColor editor={ed} color={g().color} colorRef={g().ref} opacity={g().opacity}
                onPreview={(color, opacity) => preview(g(), { color, opacity })}
                onCommit={(color, opacity) => commit(g(), { color, opacity }, "Change color")}
                onLink={(ref, color) => commit(g(), { ref, color }, ref ? "Link color" : "Detach color")} />
            </div>
          )}
        </Index>
      </Section>
    </Show>
  );
}
