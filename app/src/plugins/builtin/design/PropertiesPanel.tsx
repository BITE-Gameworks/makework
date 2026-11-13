import { For, Index, Show } from "solid-js";
import { Icon } from "../../../theme/icons";
import { align, distribute, flip, propsChanges, setProps, textSize, type Align } from "./actions";
import { layers, type Editor } from "./editor";
import { NumberField, Section } from "./fields";
import { PaintColor, PalettePanel } from "./Palettes";
import SelectionColors from "./SelectionColors";
import GradientField, { PaintKind, firstStop } from "./GradientField";
import { ComponentList, ComponentSection, type Place } from "./ComponentSection";
import Select from "../../../ui/Select";
import Combobox from "../../../ui/Combobox";
import {
  cssGradient, effect, effectLabels, gradientOf, solid, stroke, type GradientKind, type Change, type DesignNode, type Effect, type EffectKind, type Paint, type Props, type Stroke,
  type ExportSetting, type StrokeAlign, type TextStyle, type HConstraint, type VConstraint,
} from "./model";
import { exportLayers } from "./export";
import { ExportButton, ExportRows, nextExport } from "../canvas/ExportSettings";

const fonts = ["Inter", "Roboto", "Open Sans", "Lato", "Montserrat", "Poppins", "Arial", "Helvetica", "Georgia",
  "Times New Roman", "Courier New", "Verdana", "Trebuchet MS", "system-ui", "serif", "sans-serif", "monospace"];
const weights = [[100, "Thin"], [200, "Extra light"], [300, "Light"], [400, "Regular"], [500, "Medium"],
  [600, "Semi bold"], [700, "Bold"], [800, "Extra bold"], [900, "Black"]] as const;
const hConstraints: { value: HConstraint; label: string }[] = [
  { value: "left", label: "Left" }, { value: "right", label: "Right" }, { value: "both", label: "Left and right" },
  { value: "center", label: "Center" }, { value: "scale", label: "Scale" },
];
const vConstraints: { value: VConstraint; label: string }[] = [
  { value: "top", label: "Top" }, { value: "bottom", label: "Bottom" }, { value: "both", label: "Top and bottom" },
  { value: "center", label: "Center" }, { value: "scale", label: "Scale" },
];
const alignButtons: [Align, string][] = [
  ["left", "Align left"], ["h-center", "Align horizontal centers"], ["right", "Align right"],
  ["top", "Align top"], ["v-center", "Align vertical centers"], ["bottom", "Align bottom"],
];

export default function PropertiesPanel(props: { editor: Editor; place: Place }) {
  const ed = props.editor;
  const nodes = () => ed.topSelected().map((id) => ed.node(id)!).filter(Boolean);
  const first = () => nodes()[0];
  // The value all selected layers share, else null ("Mixed").
  const common = <T,>(get: (n: DesignNode) => T): T | null => {
    const list = nodes();
    if (list.length === 0) return null;
    const v = get(list[0]);
    return list.every((n) => JSON.stringify(get(n)) === JSON.stringify(v)) ? v : null;
  };
  const has = (...kinds: DesignNode["kind"][]) => nodes().length > 0 && nodes().every((n) => kinds.includes(n.kind));
  const any = (...kinds: DesignNode["kind"][]) => nodes().some((n) => kinds.includes(n.kind));

  // Number fields: a preview while scrubbing, then one recorded change.
  const each = (change: (n: DesignNode, v: number) => Change) => (v: number) =>
    new Map(nodes().map((n) => [n.id, change(n, v)]));
  const numberProps = (label: string, change: (n: DesignNode, v: number) => Change) => ({
    onPreview: (v: number) => ed.preview(each(change)(v)),
    onCommit: (v: number) => ed.update(each(change)(v), `${label} ${layers(nodes().length)}`),
  });
  const sized = (n: DesignNode, width: number, height: number): Change => {
    if (n.kind !== "text") return { width: Math.max(n.kind === "line" ? 0.01 : 1, width), height: n.kind === "line" ? 0 : Math.max(1, height) };
    // A new height fixes the box; a new width keeps auto height growing, and turns auto width into it.
    const sizing = Math.abs(height - n.height) > 1e-6 ? "fixed" : n.props.sizing === "width" ? "height" : n.props.sizing;
    const p = { ...n.props, sizing } as const;
    return { props: p, ...textSize(p, Math.max(1, width), Math.max(1, height)) };
  };

  const propsField = (label: string, part: (n: DesignNode, v: number) => Partial<Props>) => ({
    onPreview: (v: number) => ed.preview(propsChanges(ed, (n) => part(n, v))),
    onCommit: (v: number) => setProps(ed, label, (n) => part(n, v)),
  });
  const textStyle = (label: string, part: (v: number) => Partial<TextStyle>) =>
    propsField(label, (n, v) => ({ textStyle: { ...n.props.textStyle, ...part(v) } }));
  const setTextStyle = (label: string, part: Partial<TextStyle>) =>
    setProps(ed, label, (n) => (n.kind === "text" ? { textStyle: { ...n.props.textStyle, ...part } } : null), "design-text");

  // Paint lists: edits replace the list on every selected layer.
  const paintList = (key: "fills" | "strokes") => (first()?.props[key] ?? []) as (Paint | Stroke)[];
  const setPaints = (key: "fills" | "strokes", list: (Paint | Stroke)[], label: string, previewOnly = false) => {
    const change = () => ({ [key]: JSON.parse(JSON.stringify(list)) }) as Partial<Props>;
    if (previewOnly) ed.preview(propsChanges(ed, change));
    else setProps(ed, label, change);
  };
  const editPaint = (key: "fills" | "strokes", i: number, part: Partial<Stroke>, label: string, previewOnly = false) =>
    setPaints(key, paintList(key).map((p, j) => (j === i ? { ...p, ...part } : p)), label, previewOnly);

  // Export settings: edits replace the list on every selected layer, like paints.
  const exportList = () => first()?.props.exports ?? [];
  const setExports = (list: ExportSetting[], label: string) =>
    setProps(ed, label, () => ({ exports: JSON.parse(JSON.stringify(list)) as ExportSetting[] }), "download");

  const effectList = () => first()?.props.effects ?? [];
  const setEffects = (list: Effect[], label: string, previewOnly = false) => {
    const change = () => ({ effects: JSON.parse(JSON.stringify(list)) as Effect[] });
    if (previewOnly) ed.preview(propsChanges(ed, change));
    else setProps(ed, label, change, "design-effects");
  };

  // Solid fills turn into gradients from their color, gradients back into their first stop.
  const setFillKind = (i: number, paint: Paint, kind: GradientKind | "solid") => {
    if (kind === "solid") return paint.gradient && editPaint("fills", i, { gradient: null, color: firstStop(paint.gradient).color }, "Use a solid fill");
    if (paint.gradient?.kind === kind) return;
    const gradient = paint.gradient ? { ...paint.gradient, kind } : gradientOf(kind, ed.resolve(paint));
    editPaint("fills", i, { gradient, color: firstStop(gradient).color, ref: null }, kind === "linear" ? "Use a linear gradient" : "Use a radial gradient");
  };
  const PaintRows = (p: { kind: "fills"; noun: string }) => (
    <Index each={paintList(p.kind)}>
      {(paint, i) => (
        <div class="design-fill-row">
          <div class="design-paint">
            <Show when={paint().gradient} fallback={
              <PaintColor editor={ed} color={paint().color} colorRef={paint().ref} opacity={paint().opacity}
                onPreview={(color, opacity) => editPaint(p.kind, i, { color, opacity }, "", true)}
                onCommit={(color, opacity) => editPaint(p.kind, i, { color, opacity }, `Change ${p.noun}`)}
                onLink={(ref, color) => editPaint(p.kind, i, { ref, color }, ref ? `Link ${p.noun} color` : `Detach ${p.noun} color`)} />
            }>
              {(g) => (
                <div class="design-color">
                  <span class="design-swatch mw-box gradient" style={{ "--gradient": cssGradient(g(), paint().opacity) }} />
                  <PaintKind value={g().kind} onChange={(kind) => setFillKind(i, paint(), kind)} />
                  <NumberField label="%" title="Opacity (%)" value={paint().opacity} scale={100} decimals={0} min={0} max={1}
                    onPreview={(opacity) => editPaint(p.kind, i, { opacity }, "", true)} onCommit={(opacity) => editPaint(p.kind, i, { opacity }, `Change ${p.noun}`)} />
                </div>
              )}
            </Show>
            <Show when={!paint().gradient}>
              <button class="icon-button" title="Use a gradient" aria-label="Use a gradient" onClick={() => setFillKind(i, paint(), "linear")}>
                <Icon name="design-gradient" />
              </button>
            </Show>
            <button class="icon-button" title={paint().visible ? `Hide ${p.noun}` : `Show ${p.noun}`} aria-label="Visibility"
              onClick={() => editPaint(p.kind, i, { visible: !paint().visible }, paint().visible ? `Hide ${p.noun}` : `Show ${p.noun}`)}>
              <Icon name={paint().visible ? "visible" : "hidden"} />
            </button>
            <button class="icon-button" title={`Remove ${p.noun}`} aria-label={`Remove ${p.noun}`}
              onClick={() => setPaints(p.kind, paintList(p.kind).filter((_, j) => j !== i), `Remove ${p.noun}`)}>
              <Icon name="remove" />
            </button>
          </div>
          <Show when={paint().gradient}>
            {(g) => (
              <GradientField gradient={g()} opacity={paint().opacity}
                onPreview={(gradient) => editPaint(p.kind, i, { gradient, color: firstStop(gradient).color }, "", true)}
                onCommit={(gradient, label) => editPaint(p.kind, i, { gradient, color: firstStop(gradient).color }, label)} />
            )}
          </Show>
        </div>
      )}
    </Index>
  );

  return (
    <aside class="design-panel design-properties mw-scroll-fade" aria-label="Properties">
      <Show when={nodes().length > 0} fallback={<>
        <fieldset class="design-fieldset" disabled={!ed.canEdit()}>
          <PalettePanel editor={ed} />
        </fieldset>
        <ComponentList editor={ed} place={props.place} />
      </>}>
        <fieldset class="design-fieldset" disabled={!ed.canEdit()}>
          <div class="design-align-row">
            <For each={alignButtons}>
              {([how, title]) => (
                <button class="icon-button" title={title} aria-label={title}
                  disabled={nodes().length === 1 && first()!.parentId === null} onClick={() => align(ed, how)}>
                  <Icon name={`align-${how}`} />
                </button>
              )}
            </For>
            <button class="icon-button" title="Distribute horizontal spacing" aria-label="Distribute horizontally"
              disabled={nodes().length < 3} onClick={() => distribute(ed, "x")}><Icon name="distribute-h" /></button>
            <button class="icon-button" title="Distribute vertical spacing" aria-label="Distribute vertically"
              disabled={nodes().length < 3} onClick={() => distribute(ed, "y")}><Icon name="distribute-v" /></button>
            <button class="icon-button" title="Flip horizontal (Shift+H)" aria-label="Flip horizontal" onClick={() => flip(ed, "x")}><Icon name="flip-h" /></button>
            <button class="icon-button" title="Flip vertical (Shift+V)" aria-label="Flip vertical" onClick={() => flip(ed, "y")}><Icon name="flip-v" /></button>
          </div>

          <Section title={nodes().length === 1 ? first()!.name : `${nodes().length} layers`}>
            <div class="design-grid">
              <NumberField label="X" title="X, from the left of its frame" value={common((n) => n.x)} {...numberProps("Move", (_, v) => ({ x: v }))} />
              <NumberField label="Y" title="Y, from the top of its frame" value={common((n) => n.y)} {...numberProps("Move", (_, v) => ({ y: v }))} />
              <NumberField label="W" title="Width" min={0} value={common((n) => n.width)} {...numberProps("Resize", (n, v) => sized(n, v, n.height))} />
              <Show when={!any("line")} fallback={<span />}>
                <NumberField label="H" title="Height" min={1} value={common((n) => n.height)}
                  {...numberProps("Resize", (n, v) => sized(n, n.width, v))} />
              </Show>
              <NumberField label={<Icon name="rotate" size={12} />} title="Rotation (degrees)" suffix="°" value={common((n) => n.rotation)}
                {...numberProps("Rotate", (_, v) => ({ rotation: v }))} />
            </div>
            <Show when={has("rect", "frame", "image", "svg")}>
              <div class="design-corners">
                <Show when={common((n) => n.props.radii !== null) === true} fallback={
                  <NumberField label={<Icon name="design-radius" size={12} />} title="Corner size" min={0} value={common((n) => n.props.radius)}
                    {...propsField("Corners of", (_, v) => ({ radius: v, radii: null }))} />
                }>
                  <div class="design-grid">
                    <For each={["Top left", "Top right", "Bottom right", "Bottom left"]}>
                      {(title, i) => (
                        <NumberField label={["↖", "↗", "↘", "↙"][i()]} title={`${title} corner`} min={0}
                          value={common((n) => (n.props.radii ?? [])[i()] ?? n.props.radius)}
                          {...propsField("Corner of", (n, v) => {
                            const r = n.props.radius;
                            const radii = [...(n.props.radii ?? [r, r, r, r])] as [number, number, number, number];
                            radii[i()] = v;
                            return { radii };
                          })} />
                      )}
                    </For>
                  </div>
                </Show>
                <button class="icon-button" classList={{ on: common((n) => n.props.radii !== null) === true }}
                  title="Each corner its own size" aria-label="Each corner its own size"
                  onClick={() => {
                    const each = common((n) => n.props.radii !== null) !== true;
                    setProps(ed, each ? "Separate corners of" : "Same corners for", (n) => each
                      ? { radii: [n.props.radius, n.props.radius, n.props.radius, n.props.radius] }
                      : { radius: n.props.radii?.[0] ?? n.props.radius, radii: null }, "design-corners-each");
                  }}>
                  <Icon name="design-corners-each" />
                </button>
                <button class="icon-button" classList={{ on: common((n) => n.props.corners) === "cut" }}
                  title="Cut corners (straight bevels)" aria-label="Cut corners"
                  onClick={() => {
                    const cut = common((n) => n.props.corners) !== "cut";
                    setProps(ed, cut ? "Cut corners of" : "Round corners of", () => ({ corners: cut ? "cut" : "round" }), "design-corners-cut");
                  }}>
                  <Icon name="design-corners-cut" />
                </button>
              </div>
            </Show>
            <Show when={has("frame")}>
              <label class="design-check">
                <input type="checkbox" checked={common((n) => n.props.clip) ?? false}
                  onChange={(e) => setProps(ed, e.currentTarget.checked ? "Clip content" : "Show overflow", () => ({ clip: e.currentTarget.checked }), "design-clip")} />
                Clip content
              </label>
            </Show>
          </Section>

          <ComponentSection editor={ed} place={props.place} />

          <Show when={nodes().every((n) => ed.node(n.parentId)?.kind === "frame" && !ed.node(n.parentId)!.props.variantSet)}>
            <Section title="Constraints">
              <div class="design-grid">
                <Select<HConstraint> label="Horizontal constraint" placeholder="Mixed" value={common((n) => n.props.constraints.h)}
                  options={hConstraints} onChange={(h) => setProps(ed, "Constraints of", (n) => ({ constraints: { ...n.props.constraints, h } }), "design-frame")} />
                <Select<VConstraint> label="Vertical constraint" placeholder="Mixed" value={common((n) => n.props.constraints.v)}
                  options={vConstraints} onChange={(v) => setProps(ed, "Constraints of", (n) => ({ constraints: { ...n.props.constraints, v } }), "design-frame")} />
              </div>
            </Section>
          </Show>

          <Show when={nodes().every((n) => n.kind === "svg" && n.props.tint) && first()?.props.tint}>
            {(tint) => (
              <Section title="Color">
                <div class="design-paint">
                  <PaintColor editor={ed} color={tint().color} colorRef={tint().ref} opacity={tint().opacity}
                    onPreview={(color, opacity) => ed.preview(propsChanges(ed, (n) => (n.props.tint ? { tint: { ...n.props.tint, color, opacity } } : null)))}
                    onCommit={(color, opacity) => setProps(ed, "Recolor", (n) => (n.props.tint ? { tint: { ...n.props.tint, color, opacity } } : null), "design-palette")}
                    onLink={(ref, color) => setProps(ed, ref ? "Link color of" : "Detach color of",
                      (n) => (n.props.tint ? { tint: { ...n.props.tint, ref, color } } : null), "design-palette")} />
                </div>
              </Section>
            )}
          </Show>

          <Section title="Layer">
            <div class="design-grid">
              <NumberField label={<Icon name="design-opacity" size={12} />} title="Opacity" value={common((n) => n.props.opacity)}
                scale={100} decimals={0} min={0} max={1} suffix="%" {...propsField("Opacity of", (_, v) => ({ opacity: v }))} />
            </div>
          </Section>

          <Show when={any("text")}>
            <Section title="Text">
              <textarea class="design-field-input design-text-input" aria-label="Text" rows={3} spellcheck={false}
                placeholder={common((n) => n.props.text) === null ? "Mixed" : ""}
                value={common((n) => (n.kind === "text" ? n.props.text : null)) ?? ""}
                onInput={(e) => {
                  const text = e.currentTarget.value;
                  ed.preview(propsChanges(ed, (n) => (n.kind === "text" ? { text } : null)));
                }}
                onChange={(e) => {
                  const text = e.currentTarget.value;
                  if (text.trim()) setProps(ed, "Edit text", (n) => (n.kind === "text" ? { text } : null), "design-text");
                  else ed.clearPreview(nodes().map((n) => n.id));
                }} />
              <Combobox class="design-wide" label="Font" placeholder="Mixed" suggestions={fonts}
                value={common((n) => (n.kind === "text" ? n.props.textStyle.family : null)) ?? ""}
                itemStyle={(f) => ({ "font-family": `"${f}", sans-serif` })}
                onCommit={(family) => family.trim() && setTextStyle("Change font of", { family: family.trim() })} />
              <div class="design-grid">
                <Select label="Weight" placeholder="Mixed" value={common((n) => (n.kind === "text" ? n.props.textStyle.weight : null))}
                  options={weights.map(([w, label]) => ({ value: w as number, label }))}
                  onChange={(weight) => setTextStyle("Change weight of", { weight })} />
                <NumberField label="Size" title="Font size" min={1} value={common((n) => (n.kind === "text" ? n.props.textStyle.size : null))}
                  {...textStyle("Font size of", (v) => ({ size: v }))} />
                <NumberField label="Line" title="Line height, times the font size (0 for automatic)" min={0} step={0.1}
                  value={common((n) => (n.kind === "text" ? n.props.textStyle.lineHeight : null))} {...textStyle("Line height of", (v) => ({ lineHeight: v }))} />
                <NumberField label="Spacing" title="Letter spacing (px)" step={0.1}
                  value={common((n) => (n.kind === "text" ? n.props.textStyle.letterSpacing : null))} {...textStyle("Letter spacing of", (v) => ({ letterSpacing: v }))} />
              </div>
              <div class="design-button-row">
                <For each={[["left", "text-left"], ["center", "text-center"], ["right", "text-right"]] as const}>
                  {([a, icon]) => (
                    <button class="icon-button" classList={{ on: common((n) => n.props.textStyle.align) === a }} title={`Align text ${a}`}
                      aria-label={`Align text ${a}`} onClick={() => setTextStyle("Align text of", { align: a })}>
                      <Icon name={icon} />
                    </button>
                  )}
                </For>
                <span class="design-spacer" />
                <For each={[["italic", "format-italic", "Italic"], ["underline", "format-underline", "Underline"],
                  ["strike", "format-strike", "Strikethrough"]] as const}>
                  {([key, icon, title]) => (
                    <button class="icon-button" classList={{ on: common((n) => n.props.textStyle[key]) === true }} title={title} aria-label={title}
                      onClick={() => setTextStyle(title, { [key]: common((n) => n.props.textStyle[key]) !== true })}>
                      <Icon name={icon} />
                    </button>
                  )}
                </For>
              </div>
              <div class="design-button-row">
                <For each={[["top", "text-top"], ["middle", "text-middle"], ["bottom", "text-bottom"]] as const}>
                  {([v, icon]) => (
                    <button class="icon-button" classList={{ on: common((n) => n.props.textStyle.verticalAlign) === v }}
                      title={`Align text to the ${v} (fixed size boxes)`} aria-label={`Align text to the ${v}`}
                      onClick={() => setTextStyle("Align text of", { verticalAlign: v })}>
                      <Icon name={icon} />
                    </button>
                  )}
                </For>
                <span class="design-spacer" />
                <For each={[["width", "design-auto-width", "Auto width"], ["height", "design-auto-height", "Auto height (wraps)"],
                  ["fixed", "design-fixed-size", "Fixed size"]] as const}>
                  {([sizing, icon, title]) => (
                    <button class="icon-button" classList={{ on: common((n) => n.props.sizing) === sizing }} title={title} aria-label={title}
                      onClick={() => setProps(ed, `${title} for`, (n) => (n.kind === "text" ? { sizing } : null), icon)}>
                      <Icon name={icon} />
                    </button>
                  )}
                </For>
              </div>
            </Section>
          </Show>

          <Show when={!any("line", "group")}>
            <Section title="Fill" actions={
              <button class="icon-button" title="Add fill" aria-label="Add fill"
                onClick={() => setPaints("fills", [solid(paintList("fills").length ? "#000000" : "#d9d9d9", paintList("fills").length ? 0.2 : 1), ...paintList("fills")], "Add fill")}>
                <Icon name="add" />
              </button>
            }>
              <PaintRows kind="fills" noun="fill" />
            </Section>
          </Show>

          <Show when={!any("group")}>
          <Section title="Stroke" actions={
            <button class="icon-button" title="Add stroke" aria-label="Add stroke"
              onClick={() => setPaints("strokes", [...paintList("strokes"), stroke(ed.inkIn(first()!.parentId), any("line", "text", "path") ? "center" : "inside")], "Add stroke")}>
              <Icon name="add" />
            </button>
          }>
            <Index each={paintList("strokes") as Stroke[]}>
              {(s, i) => (
                <div class="design-stack">
                  <div class="design-paint">
                    <PaintColor editor={ed} color={s().color} colorRef={s().ref} opacity={s().opacity}
                      onPreview={(color, opacity) => editPaint("strokes", i, { color, opacity }, "", true)}
                      onCommit={(color, opacity) => editPaint("strokes", i, { color, opacity }, "Change stroke")}
                      onLink={(ref, color) => editPaint("strokes", i, { ref, color }, ref ? "Link stroke color" : "Detach stroke color")} />
                    <button class="icon-button" title={s().visible ? "Hide stroke" : "Show stroke"} aria-label="Visibility"
                      onClick={() => editPaint("strokes", i, { visible: !s().visible }, s().visible ? "Hide stroke" : "Show stroke")}>
                      <Icon name={s().visible ? "visible" : "hidden"} />
                    </button>
                    <button class="icon-button" title="Remove stroke" aria-label="Remove stroke"
                      onClick={() => setPaints("strokes", paintList("strokes").filter((_, j) => j !== i), "Remove stroke")}>
                      <Icon name="remove" />
                    </button>
                  </div>
                  <div class="design-grid">
                    <NumberField label="W" title="Stroke width" min={0} step={0.5} value={s().width}
                      onPreview={(v) => editPaint("strokes", i, { width: v }, "", true)}
                      onCommit={(v) => editPaint("strokes", i, { width: v }, "Stroke width")} />
                    <Show when={!any("line", "text", "path")}>
                      <Select<StrokeAlign> label="Stroke position" value={s().align}
                        options={[{ value: "inside", label: "Inside" }, { value: "center", label: "Center" }, { value: "outside", label: "Outside" }]}
                        onChange={(align) => editPaint("strokes", i, { align }, "Stroke position")} />
                    </Show>
                  </div>
                </div>
              )}
            </Index>
          </Section>
          </Show>

          <Section title="Effects" actions={
            <button class="icon-button" title="Add effect" aria-label="Add effect"
              onClick={() => setEffects([...effectList(), effect("drop-shadow")], "Add effect")}>
              <Icon name="add" />
            </button>
          }>
            <Index each={effectList()}>
              {(fx, i) => {
                const edit = (part: Partial<Effect>, label: string, previewOnly = false) =>
                  setEffects(effectList().map((e, j) => (j === i ? { ...e, ...part } : e)), label, previewOnly);
                const field = (key: "x" | "y" | "blur" | "spread", label: string, title: string, min?: number) => (
                  <NumberField label={label} title={title} min={min} value={fx()[key]}
                    onPreview={(v) => edit({ [key]: v }, "", true)} onCommit={(v) => edit({ [key]: v }, `Change ${effectLabels[fx().kind].toLowerCase()}`)} />
                );
                const shadow = () => fx().kind === "drop-shadow" || fx().kind === "inner-shadow";
                return (
                  <div class="design-stack">
                    <div class="design-paint">
                      <Select<EffectKind> class="design-grow" label="Effect" value={fx().kind}
                        options={(Object.entries(effectLabels) as [EffectKind, string][]).map(([value, label]) => ({ value, label }))}
                        onChange={(kind) => edit({ ...effect(kind), visible: fx().visible }, `Change effect to ${effectLabels[kind].toLowerCase()}`)} />
                      <button class="icon-button" title={fx().visible ? "Hide effect" : "Show effect"} aria-label="Visibility"
                        onClick={() => edit({ visible: !fx().visible }, fx().visible ? "Hide effect" : "Show effect")}>
                        <Icon name={fx().visible ? "visible" : "hidden"} />
                      </button>
                      <button class="icon-button" title="Remove effect" aria-label="Remove effect"
                        onClick={() => setEffects(effectList().filter((_, j) => j !== i), "Remove effect")}>
                        <Icon name="remove" />
                      </button>
                    </div>
                    <div class="design-grid">
                      <Show when={shadow()}>
                        {field("x", "X", "Offset right")}
                        {field("y", "Y", "Offset down")}
                      </Show>
                      {field("blur", "Blur", "Blur radius", 0)}
                      <Show when={shadow()}>
                        {field("spread", "Spread", "Spread (rounded shapes only)")}
                      </Show>
                    </div>
                    <Show when={shadow()}>
                      <div class="design-paint">
                        <PaintColor editor={ed} color={fx().color} colorRef={fx().ref} opacity={fx().opacity}
                          onPreview={(color, opacity) => edit({ color, opacity }, "", true)}
                          onCommit={(color, opacity) => edit({ color, opacity }, "Shadow color")}
                          onLink={(ref, color) => edit({ ref, color }, ref ? "Link shadow color" : "Detach shadow color")} />
                      </div>
                    </Show>
                  </div>
                );
              }}
            </Index>
          </Section>
          <SelectionColors editor={ed} />
        </fieldset>

        <Section title="Export" actions={
          <button class="icon-button" title="Add export" aria-label="Add export" disabled={!ed.canEdit()}
            onClick={() => setExports([...exportList(), nextExport(exportList())], "Add export")}>
            <Icon name="add" />
          </button>
        }>
          <ExportRows list={exportList()} disabled={!ed.canEdit()} onChange={setExports} />
          <ExportButton show={exportList().length > 0}
            label={nodes().length === 1 ? `Export ${first()!.name}` : `Export ${nodes().length} layers`}
            onExport={() => ed.run(() => exportLayers(ed, nodes().map((n) => n.id)))} />
        </Section>
      </Show>
    </aside>
  );
}
