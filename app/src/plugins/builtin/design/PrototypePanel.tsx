import { For, Index, Show } from "solid-js";
import { Icon } from "../../../theme/icons";
import Select from "../../../ui/Select";
import { setProps, variantsOf } from "./actions";
import type { Editor } from "./editor";
import { NumberField, Section } from "./fields";
import { interaction, type Action, type Direction, type Easing, type Interaction, type OverlayPlace, type Scroll, type Transition } from "./model";
import { actionLabels, directional, directionLabels, easingLabels, overlayLabels, transitionLabels, triggerLabels } from "./prototype";

const options = <T extends string>(labels: Record<T, string>, only?: T[]) =>
  (Object.entries(labels) as [T, string][]).filter(([value]) => !only || only.includes(value)).map(([value, label]) => ({ value, label }));
const scrollLabels: Record<Scroll, string> = { none: "No scrolling", vertical: "Vertical", horizontal: "Horizontal", both: "Both directions" };
const opening: Transition[] = ["instant", "dissolve", "move-in", "slide-in"];

// The Prototype tab: what the selected layer does in play mode, and where to start playing.
export default function PrototypePanel(props: { editor: Editor; onPlay: (frame: number) => void }) {
  const ed = props.editor;
  const one = () => (ed.topSelected().length === 1 ? ed.node(ed.topSelected()[0]) : undefined);
  const frames = () => ed.children(null).filter((id) => ed.node(id)?.kind === "frame");
  const frameOptions = () => frames().map((id) => ({ value: id, label: ed.node(id)!.name }));
  // The variants the selected layer's component can change to: of the main it is in, or of the instance it is in.
  const variants = () => {
    const n = one();
    if (!n) return [];
    for (const id of [n.id, ...ed.ancestors(n.id)]) {
      const a = ed.node(id)!;
      const main = a.props.instanceOf ?? (a.props.main ? a.id : null);
      if (main !== null && ed.node(ed.node(main)?.parentId)?.props.variantSet) return variantsOf(ed, main);
    }
    return [];
  };
  const actions = (): Action[] => ["navigate", "back", "overlay", "close", ...(variants().length > 1 ? ["change-to" as const] : [])];
  const list = () => one()?.props.interactions ?? [];
  const save = (next: Interaction[], label: string) =>
    setProps(ed, label, () => ({ interactions: JSON.parse(JSON.stringify(next)) as Interaction[] }), "play");
  // A new interaction goes to the next frame to the right, a common first link.
  const nextFrame = () => {
    const own = one() ? [one()!.id, ...ed.ancestors(one()!.id)].find((id) => frames().includes(id)) : undefined;
    const others = frames().filter((id) => id !== own);
    const x = own !== undefined ? ed.worldBounds(own).left : -Infinity;
    return others.find((id) => ed.worldBounds(id).left > x) ?? others[0] ?? null;
  };
  const targetGone = (it: Interaction) =>
    (it.action === "navigate" || it.action === "overlay" || it.action === "change-to") && it.target !== null && !ed.node(it.target);

  return (
    <aside class="design-panel design-properties mw-scroll-fade" aria-label="Prototype">
      <Show when={one()} fallback={
        <Section title="Prototype">
          <p class="design-note">Pick a layer to say what it does when clicked, then play a frame to try it.</p>
          <For each={frames()}>
            {(id) => (
              <div class="design-component-row">
                <Icon name="design-frame" size={14} />
                <span class="design-component-name">{ed.node(id)?.name}</span>
                <button class="icon-button" title="Play from here" aria-label={`Play from ${ed.node(id)?.name}`} onClick={() => props.onPlay(id)}>
                  <Icon name="play" />
                </button>
              </div>
            )}
          </For>
        </Section>
      }>
        {(n) => (
          <fieldset class="design-fieldset" disabled={!ed.canEdit()}>
            <Section title="Interactions" actions={
              <button class="icon-button" title="Add interaction" aria-label="Add interaction"
                onClick={() => save([...list(), interaction(nextFrame())], "Add interaction")}>
                <Icon name="add" />
              </button>
            }>
              <Show when={list().length === 0}>
                <p class="design-note">Nothing happens to {n().name} in play mode yet.</p>
              </Show>
              <Index each={list()}>
                {(it, i) => {
                  const edit = (part: Partial<Interaction>, label: string) => save(list().map((x, j) => (j === i ? { ...x, ...part } : x)), label);
                  const transitions = () => (it().action === "overlay" ? opening : undefined);
                  const animated = () => it().action !== "back" && it().action !== "close";
                  return (
                    <div class="design-stack design-interaction">
                      <div class="design-paint">
                        <Select<Interaction["trigger"]> class="design-grow" label="Trigger" value={it().trigger} options={options(triggerLabels)}
                          onChange={(trigger) => edit({ trigger }, "Change trigger")} />
                        <button class="icon-button" title="Remove interaction" aria-label="Remove interaction"
                          onClick={() => save(list().filter((_, j) => j !== i), "Remove interaction")}>
                          <Icon name="remove" />
                        </button>
                      </div>
                      <Show when={it().trigger === "delay"}>
                        <div class="design-grid">
                          <NumberField label="Wait" title="Delay (ms)" suffix="ms" min={0} step={50} decimals={0} value={it().delay}
                            onCommit={(delay) => edit({ delay }, "Change delay")} />
                        </div>
                      </Show>
                      <div class="design-grid">
                        <Select<Action> label="Action" value={it().action} options={options(actionLabels, actions())}
                          onChange={(action) => edit({
                            action,
                            target: action === "change-to" ? variants().find((v) => v !== it().target) ?? null : action === "navigate" || action === "overlay"
                              ? (frames().includes(it().target ?? -1) ? it().target : nextFrame()) : it().target,
                            transition: action === "overlay" && !opening.includes(it().transition) ? "dissolve" : action === "change-to" ? "smart" : it().transition,
                          }, "Change action")} />
                        <Show when={it().action === "navigate" || it().action === "overlay"}>
                          <Select<number> label="Frame" placeholder="Pick a frame" value={it().target ?? null} search={frames().length > 12}
                            options={frameOptions()} onChange={(target) => edit({ target }, "Change destination")} />
                        </Show>
                        <Show when={it().action === "change-to"}>
                          <Select<number> label="Variant" placeholder="Pick a variant" value={it().target ?? null}
                            options={variants().map((id) => ({ value: id, label: ed.node(id)!.name }))} onChange={(target) => edit({ target }, "Change variant")} />
                        </Show>
                      </div>
                      <Show when={it().action === "overlay"}>
                        <div class="design-grid">
                          <Select<OverlayPlace> label="Overlay position" value={it().overlay} options={options(overlayLabels)}
                            onChange={(overlay) => edit({ overlay }, "Change overlay position")} />
                        </div>
                        <label class="design-check">
                          <input type="checkbox" checked={it().closeOutside} onChange={(e) => edit({ closeOutside: e.currentTarget.checked }, "Close on click outside")} />
                          Close when clicking outside
                        </label>
                        <label class="design-check">
                          <input type="checkbox" checked={it().backdrop} onChange={(e) => edit({ backdrop: e.currentTarget.checked }, "Overlay backdrop")} />
                          Darken behind
                        </label>
                      </Show>
                      <Show when={animated()}>
                        <div class="design-grid">
                          <Select<Transition> label="Animation" value={it().transition} options={options(transitionLabels, transitions())}
                            onChange={(transition) => edit({ transition }, "Change animation")} />
                          <Show when={directional(it().transition)}>
                            <Select<Direction> label="Direction" value={it().direction} options={options(directionLabels)}
                              onChange={(direction) => edit({ direction }, "Change direction")} />
                          </Show>
                        </div>
                        <Show when={it().transition !== "instant"}>
                          <div class="design-grid">
                            <NumberField label="Time" title="Duration (ms)" suffix="ms" min={0} step={10} decimals={0} value={it().duration}
                              onCommit={(duration) => edit({ duration }, "Change duration")} />
                            <Select<Easing> label="Easing" value={it().easing} options={options(easingLabels)}
                              onChange={(easing) => edit({ easing }, "Change easing")} />
                          </div>
                        </Show>
                      </Show>
                      <Show when={targetGone(it())}>
                        <p class="design-note warning">{it().action === "change-to" ? "That variant" : "That frame"} was deleted.</p>
                      </Show>
                    </div>
                  );
                }}
              </Index>
            </Section>
            <Show when={n().kind === "frame"}>
              <Section title="Scrolling">
                <Select<Scroll> label="Scrolling in play mode" value={n().props.scroll} options={options(scrollLabels)}
                  onChange={(scroll) => setProps(ed, "Scrolling of", () => ({ scroll }), "play")} />
                <p class="design-note">Content past the frame's edges scrolls in play mode.</p>
              </Section>
            </Show>
            <Show when={[n().id, ...ed.ancestors(n().id)].find((id) => frames().includes(id))}>
              {(frame) => (
                <div class="design-button-row design-play-row">
                  <button class="mw-button mw-box" onClick={() => props.onPlay(frame())}>
                    <Icon name="play" size={14} /> Play from {ed.node(frame())?.name}
                  </button>
                </div>
              )}
            </Show>
          </fieldset>
        )}
      </Show>
    </aside>
  );
}
